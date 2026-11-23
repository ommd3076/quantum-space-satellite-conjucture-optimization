import { performance } from 'node:perf_hooks';
import { verifyScheduleIndependently } from '../../validation/verifier';
import { buildFeasibleSatelliteSchedule, buildNameMaps } from '../shared/timeline';
import type {
  ObservationWindow,
  PropagationBundle,
  ProposedAblationFlags,
  ScheduledAction,
  SolverRunResult,
} from '../../types';

export const DEFAULT_PROPOSED_FLAGS: ProposedAblationFlags = {
  useRiskAware: true,
  useShadowPricing: true,
  useIncrementalRepair: true,
};

/**
 * Candidate Research Algorithm: SRA-RHR
 * (Submodular Risk-Aware Rolling-Horizon with Downlink Shadow Pricing & Constraint-Preserving Incremental Repair)
 *
 * Scientific Status: CANDIDATE RESEARCH SYNTHESIS (NOVELTY UNESTABLISHED / SUBJECT TO FALSIFICATION).
 * Strictly causal: never peeks at realized cloud/outage outcomes before event completion.
 * Supports independent toggling of all 3 mechanisms for mandatory ablation studies:
 *   1. useRiskAware: Marginal submodular cloud-survival utility + high-value backup coverage
 *      when residual cloud-failure risk exceeds threshold.
 *   2. useShadowPricing: Dynamic dual scarcity pricing on satellite remaining downlink capacity
 *      (penalizing data volume on satellites with scarce future non-outage expected downlink).
 *   3. useIncrementalRepair: Event-triggered constraint-preserving 1-for-1 swap & eject-insert
 *      repair triggered on affected satellites after observed cloud failure or station outage.
 */
export function runProposedSraRhr(
  bundle: PropagationBundle,
  computeBudgetMs = 2000,
  flags: ProposedAblationFlags = DEFAULT_PROPOSED_FLAGS,
): SolverRunResult {
  const t0 = performance.now();
  const { targetNameMap, stationNameMap } = buildNameMaps(bundle);
  const horizonSec = bundle.scenario.horizonSec;
  const res = bundle.scenario.resources;
  const stepSec = Math.max(900, Math.round(horizonSec / 16)); // finer receding cadence
  const lookaheadSec = stepSec * 3;

  // Track committed observations per satellite
  const satCommittedObs = new Map<string, ObservationWindow[]>();
  const satSchedules = new Map<string, ScheduledAction[]>();
  for (const sat of bundle.satellites) {
    satCommittedObs.set(sat.satId, []);
    satSchedules.set(sat.satId, []);
  }

  // Track known-failed downlink contacts (strictly causal: only known after contact starts/fails)
  const observedFailedContacts = new Set<string>();
  const checkedCompletedObs = new Set<string>();
  // Track per-target scheduled attempts and confirmed successes
  const targetConfirmedSuccess = new Set<string>();
  const targetActiveAttempts = new Map<string, ObservationWindow[]>();

  let repairEventsTriggered = 0;
  let timedOut = false;

  // Helper: remaining expected downlink capacity for satellite s after time t
  const expectedRemainingDownlinkGb = (satId: string, afterSec: number): number => {
    let cap = 0;
    for (const dl of bundle.downlinkWindows) {
      if (dl.satId !== satId || dl.endSec <= afterSec) continue;
      if (observedFailedContacts.has(dl.contactId)) continue;
      const usableFrac =
        dl.startSec >= afterSec ? 1 : (dl.endSec - afterSec) / Math.max(1, dl.durationSec);
      cap += dl.maxVolumeGb * usableFrac * (1 - dl.outageProb);
    }
    return cap;
  };

  // Helper: estimate current buffered data on satellite s from committed obs vs expected prior downlinks
  const estimatedBufferedGb = (satId: string, atSec: number): number => {
    const acts = satSchedules.get(satId) ?? [];
    let buf = res.storageInitialGb;
    for (const a of acts) {
      if (a.startSec > atSec) break;
      if (a.type === 'observation') {
        buf += a.dataDeltaGb;
      } else if (!observedFailedContacts.has(a.windowId)) {
        buf = Math.max(0, buf + a.dataDeltaGb);
      }
    }
    return buf;
  };

  // Helper: submodular marginal expected survival probability gain for target i
  const marginalSuccessGain = (win: ObservationWindow): number => {
    if (targetConfirmedSuccess.has(win.targetId)) return 0;
    const active = targetActiveAttempts.get(win.targetId) ?? [];
    if (!flags.useRiskAware) {
      // Standard single-attempt mode without risk-aware submodular backup
      return active.length === 0 ? 1.0 : 0;
    }
    // Cap backups per target at 2 to prevent storage flooding
    if (active.length >= 2) return 0;
    // Joint residual failure probability across already-scheduled attempts
    let jointFailProb = 1.0;
    for (const prev of active) {
      jointFailProb *= prev.cloudProb;
    }
    // Only schedule a backup if residual failure risk is meaningful (>= 0.25)
    if (active.length >= 1 && jointFailProb < 0.25) return 0;
    return jointFailProb * (1 - win.cloudProb);
  };

  // Helper: compute composite utility score for candidate observation window
  const scoreWindow = (win: ObservationWindow, epochT: number): number => {
    const gain = marginalSuccessGain(win);
    if (gain <= 1e-6) return -1;

    const expectedReward = win.targetPriority * gain;
    const slack = Math.max(300, win.deadlineSec - epochT);
    const urgencyFactor = 1 + 0.35 * (horizonSec / Math.max(horizonSec * 0.25, slack));

    // Downlink shadow pricing penalty
    let shadowPenalty = 1.0;
    if (flags.useShadowPricing) {
      const remDlCap = expectedRemainingDownlinkGb(win.satId, win.endSec);
      const curBuf = estimatedBufferedGb(win.satId, win.startSec);
      if (remDlCap < win.dataVolumeGb * 0.5) {
        // Severely penalize capturing data onto a satellite with virtually no remaining downlink
        shadowPenalty = 0.08;
      } else {
        const utilizationRatio = (curBuf + win.dataVolumeGb) / Math.max(1, remDlCap);
        const scarcityDual = Math.max(0, utilizationRatio - 0.55);
        shadowPenalty = 1 / (1 + 2.4 * scarcityDual * scarcityDual);
      }
    }

    const volCost = Math.pow(Math.max(1.5, win.dataVolumeGb), 0.72);
    return (expectedReward * urgencyFactor * shadowPenalty) / volCost;
  };

  // Helper: allowed downlink set (excluding only already-causally-observed failed contacts?
  // Note: schedule actions cannot delete already-committed past contacts; verifier enforces bounds on all contacts.
  // So for building satellite schedules we always allow valid contacts, while shadow pricing accounts for outageProb.)
  for (let epochT = 0; epochT < horizonSec; epochT += stepSec) {
    if (performance.now() - t0 > computeBudgetMs) {
      timedOut = true;
      break;
    }

    const affectedTargetsForRepair = new Set<string>();
    const affectedSatsForRepair = new Set<string>();

    // 1. Causal feedback strictly for events that COMPLETED before epochT
    for (const [satId, obsList] of satCommittedObs.entries()) {
      for (const w of obsList) {
        if (w.startSec + w.requiredObsSec <= epochT && !checkedCompletedObs.has(w.windowId)) {
          checkedCompletedObs.add(w.windowId);
          if (w.realizedCloudBlocked) {
            // Remove failed attempt from active attempts so target regains full marginal value
            const prev = targetActiveAttempts.get(w.targetId) ?? [];
            targetActiveAttempts.set(
              w.targetId,
              prev.filter((o) => o.windowId !== w.windowId),
            );
            if (!targetConfirmedSuccess.has(w.targetId)) {
              affectedTargetsForRepair.add(w.targetId);
              affectedSatsForRepair.add(satId);
            }
          } else {
            targetConfirmedSuccess.add(w.targetId);
          }
        }
      }
    }

    // Causal ground-station outage detection for contacts that started before epochT
    for (const dl of bundle.downlinkWindows) {
      if (dl.endSec <= epochT && dl.realizedOutage && !observedFailedContacts.has(dl.contactId)) {
        observedFailedContacts.add(dl.contactId);
        affectedSatsForRepair.add(dl.satId);
      }
    }

    // 2. Mechanism C: Constraint-Preserving Incremental Repair (only if enabled & events occurred)
    if (flags.useIncrementalRepair && affectedTargetsForRepair.size > 0) {
      repairEventsTriggered++;
      // Try 1-for-1 swap or direct insertion for high-priority failed targets in remaining horizon
      const repairTargets = Array.from(affectedTargetsForRepair)
        .map((tid) => bundle.scenario.targets.find((t) => t.id === tid)!)
        .filter(Boolean)
        .sort((a, b) => b.priority - a.priority);

      for (const tgt of repairTargets) {
        if (performance.now() - t0 > computeBudgetMs) {
          timedOut = true;
          break;
        }
        const repairWins = bundle.observationWindows
          .filter(
            (w) =>
              w.targetId === tgt.id &&
              w.startSec >= epochT &&
              w.startSec + w.requiredObsSec <= Math.min(w.endSec, w.deadlineSec),
          )
          .sort((a, b) => scoreWindow(b, epochT) - scoreWindow(a, epochT));

        let repaired = false;
        for (const rw of repairWins) {
          const curObs = satCommittedObs.get(rw.satId)!;
          if (curObs.some((o) => o.windowId === rw.windowId)) continue;

          // Attempt direct constraint-preserving insertion
          const directTrial = [...curObs, rw];
          const builtDirect = buildFeasibleSatelliteSchedule(
            bundle,
            rw.satId,
            directTrial,
            undefined,
            targetNameMap,
            stationNameMap,
          );
          if (builtDirect) {
            satCommittedObs.set(rw.satId, directTrial);
            satSchedules.set(rw.satId, builtDirect.actions);
            const active = targetActiveAttempts.get(rw.targetId) ?? [];
            targetActiveAttempts.set(rw.targetId, [...active, rw]);
            repaired = true;
            break;
          }

          // Attempt 1-for-1 swap against a lower-value FUTURE uncommitted/pending observation on same satellite
          const futureLow = curObs
            .filter(
              (o) =>
                o.startSec >= epochT &&
                o.targetPriority * (1 - o.cloudProb) < rw.targetPriority * (1 - rw.cloudProb) * 0.85,
            )
            .sort((a, b) => a.targetPriority - b.targetPriority);

          for (const victim of futureLow) {
            const swapTrial = curObs.filter((o) => o.windowId !== victim.windowId).concat(rw);
            const builtSwap = buildFeasibleSatelliteSchedule(
              bundle,
              rw.satId,
              swapTrial,
              undefined,
              targetNameMap,
              stationNameMap,
            );
            if (builtSwap) {
              satCommittedObs.set(rw.satId, swapTrial);
              satSchedules.set(rw.satId, builtSwap.actions);
              const vAct = targetActiveAttempts.get(victim.targetId) ?? [];
              targetActiveAttempts.set(
                victim.targetId,
                vAct.filter((o) => o.windowId !== victim.windowId),
              );
              const rAct = targetActiveAttempts.get(rw.targetId) ?? [];
              targetActiveAttempts.set(rw.targetId, [...rAct, rw]);
              repaired = true;
              break;
            }
          }
          if (repaired) break;
        }
      }
    }

    // 3. Receding-horizon planning for [epochT, epochT + lookaheadSec)
    const sliceEnd = Math.min(horizonSec, epochT + lookaheadSec);
    const commitEnd = Math.min(horizonSec, epochT + stepSec);

    const committedWinIds = new Set<string>();
    for (const list of satCommittedObs.values()) {
      for (const o of list) committedWinIds.add(o.windowId);
    }

    const candidates = bundle.observationWindows
      .filter(
        (w) =>
          w.startSec >= epochT &&
          w.startSec < sliceEnd &&
          w.startSec + w.requiredObsSec <= Math.min(w.endSec, w.deadlineSec) &&
          !committedWinIds.has(w.windowId) &&
          marginalSuccessGain(w) > 1e-6,
      )
      .slice();

    // Iterative greedy selection within the slice recomputing dynamic marginal gains
    // (critical for submodular backup discounting & shadow pricing accuracy)
    const remaining = new Set(candidates);
    const maxSelectionsPerSlice = Math.max(12, bundle.satellites.length * 2);

    for (let pick = 0; pick < maxSelectionsPerSlice && remaining.size > 0; pick++) {
      if (performance.now() - t0 > computeBudgetMs) {
        timedOut = true;
        break;
      }

      let bestWin: ObservationWindow | null = null;
      let bestScore = 0;

      for (const w of remaining) {
        const sc = scoreWindow(w, epochT);
        if (sc > bestScore) {
          bestScore = sc;
          bestWin = w;
        }
      }

      if (!bestWin || bestScore <= 0) break;
      remaining.delete(bestWin);

      // Commit windows inside the active receding commit horizon (or urgent high-value backups)
      if (bestWin.startSec >= commitEnd && bestWin.deadlineSec > commitEnd + stepSec) {
        continue;
      }

      const curObs = satCommittedObs.get(bestWin.satId)!;
      const trialObs = [...curObs, bestWin];
      const built = buildFeasibleSatelliteSchedule(
        bundle,
        bestWin.satId,
        trialObs,
        undefined,
        targetNameMap,
        stationNameMap,
      );
      if (built) {
        satCommittedObs.set(bestWin.satId, trialObs);
        satSchedules.set(bestWin.satId, built.actions);
        const active = targetActiveAttempts.get(bestWin.targetId) ?? [];
        targetActiveAttempts.set(bestWin.targetId, [...active, bestWin]);
      }
    }
  }

  const allActions: ScheduledAction[] = [];
  for (const acts of satSchedules.values()) allActions.push(...acts);
  allActions.sort((a, b) => a.startSec - b.startSec);

  const runtimeMs = +(performance.now() - t0).toFixed(2);
  const verification = verifyScheduleIndependently(bundle, allActions);

  const activeModes: string[] = [];
  if (flags.useRiskAware) activeModes.push('SubmodularRisk');
  if (flags.useShadowPricing) activeModes.push('DownlinkShadowPrice');
  if (flags.useIncrementalRepair) activeModes.push('IncrementalRepair');
  const labelSuffix =
    activeModes.length === 3
      ? 'Full'
      : activeModes.length === 0
        ? 'All Mechanisms Off'
        : activeModes.join(' + ');

  return {
    algorithmId: 'proposed',
    algorithmLabel: `SRA-RHR Candidate (${labelSuffix})`,
    ablationFlags: { ...flags },
    scenarioHash: bundle.scenarioHash,
    seed: bundle.scenario.seed,
    status: timedOut ? 'TIMEOUT' : 'FEASIBLE_INCUMBENT',
    solverReportedObjective: verification.verifiedDeterministicObjective,
    dualUpperBound: null,
    optimalityGapPct: null,
    runtimeMs,
    computeBudgetMs,
    repairEventsTriggered,
    notes: [
      `Candidate research synthesis (novelty unestablished): [${labelSuffix}].`,
      `Strictly causal feedback: zero lookahead leakage on cloud/outage realizations; ${repairEventsTriggered} repair cycles triggered.`,
    ],
    actions: allActions,
    verification,
  };
}
