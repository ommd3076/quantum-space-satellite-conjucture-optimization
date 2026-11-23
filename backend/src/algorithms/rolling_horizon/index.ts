import { performance } from 'node:perf_hooks';
import { verifyScheduleIndependently } from '../../validation/verifier';
import { buildFeasibleSatelliteSchedule, buildNameMaps } from '../shared/timeline';
import type {
  ObservationWindow,
  PropagationBundle,
  ScheduledAction,
  SolverRunResult,
} from '../../types';

/**
 * Baseline 4: Standard Rolling-Horizon / Receding-Horizon Scheduler
 * Divides planning horizon into receding decision epochs (step ΔW = 1800 s, lookahead W = 3600 s).
 * At each decision epoch t_k:
 * - Strictly causal: only observes realized cloud failures of observations that ENDED before t_k.
 * - Re-opens failed targets for future re-observation in [t_k, t_k + W].
 * - Commits observations whose start falls in [t_k, t_k + ΔW) using standard priority/volume greedy within the slice.
 */
export function runRollingHorizonBaseline(
  bundle: PropagationBundle,
  computeBudgetMs = 2000,
): SolverRunResult {
  const t0 = performance.now();
  const { targetNameMap, stationNameMap } = buildNameMaps(bundle);
  const horizonSec = bundle.scenario.horizonSec;
  const stepSec = Math.max(1200, Math.round(horizonSec / 12)); // e.g., 1800s for 6h horizon
  const lookaheadSec = stepSec * 2;

  const satCommittedObs = new Map<string, ObservationWindow[]>();
  const satSchedules = new Map<string, ScheduledAction[]>();
  for (const sat of bundle.satellites) {
    satCommittedObs.set(sat.satId, []);
    satSchedules.set(sat.satId, []);
  }

  // Targets currently satisfied (either pending execution or succeeded without cloud block)
  const satisfiedTargets = new Set<string>();
  const checkedCompletedWindows = new Set<string>();
  let replanningTriggers = 0;
  let timedOut = false;

  for (let epochT = 0; epochT < horizonSec; epochT += stepSec) {
    if (performance.now() - t0 > computeBudgetMs) {
      timedOut = true;
      break;
    }

    // 1. Causal feedback: inspect observations that finished strictly before epochT
    for (const obsList of satCommittedObs.values()) {
      for (const w of obsList) {
        if (w.startSec + w.requiredObsSec <= epochT && !checkedCompletedWindows.has(w.windowId)) {
          checkedCompletedWindows.add(w.windowId);
          if (w.realizedCloudBlocked) {
            // Cloud obscured this pass! Re-open target for future re-observation if not already succeeded
            const anotherSucceeded = Array.from(satCommittedObs.values()).some((list) =>
              list.some(
                (other) =>
                  other.targetId === w.targetId &&
                  other.windowId !== w.windowId &&
                  !other.realizedCloudBlocked,
              ),
            );
            if (!anotherSucceeded) {
              satisfiedTargets.delete(w.targetId);
              replanningTriggers++;
            }
          }
        }
      }
    }

    // 2. Gather candidate windows starting in [epochT, epochT + lookaheadSec)
    const sliceEnd = Math.min(horizonSec, epochT + lookaheadSec);
    const commitEnd = Math.min(horizonSec, epochT + stepSec);

    const sliceCandidates = bundle.observationWindows
      .filter(
        (w) =>
          w.startSec >= epochT &&
          w.startSec < sliceEnd &&
          w.startSec + w.requiredObsSec <= Math.min(w.endSec, w.deadlineSec) &&
          !satisfiedTargets.has(w.targetId),
      )
      .slice()
      .sort((a, b) => {
        const sA = a.targetPriority / Math.max(1, a.dataVolumeGb);
        const sB = b.targetPriority / Math.max(1, b.dataVolumeGb);
        if (Math.abs(sB - sA) > 1e-9) return sB - sA;
        return a.startSec - b.startSec;
      });

    // Solve local lookahead tentatively, then freeze/commit tasks starting in [epochT, commitEnd)
    const tempSatObs = new Map<string, ObservationWindow[]>();
    for (const [sid, list] of satCommittedObs.entries()) {
      tempSatObs.set(sid, [...list]);
    }
    const tempAssigned = new Set<string>(satisfiedTargets);

    for (const w of sliceCandidates) {
      if (tempAssigned.has(w.targetId)) continue;
      const cur = tempSatObs.get(w.satId)!;
      const trial = [...cur, w];
      const built = buildFeasibleSatelliteSchedule(
        bundle,
        w.satId,
        trial,
        undefined,
        targetNameMap,
        stationNameMap,
      );
      if (built) {
        tempSatObs.set(w.satId, trial);
        tempAssigned.add(w.targetId);
      }
    }

    // Commit only windows starting within [epochT, commitEnd)
    for (const [sid, list] of tempSatObs.entries()) {
      const prevCommitted = satCommittedObs.get(sid)!;
      const prevIds = new Set(prevCommitted.map((o) => o.windowId));
      const newlyCommitted = list.filter((o) => !prevIds.has(o.windowId) && o.startSec < commitEnd);
      if (newlyCommitted.length > 0) {
        const nextCommitted = [...prevCommitted, ...newlyCommitted];
        const built = buildFeasibleSatelliteSchedule(
          bundle,
          sid,
          nextCommitted,
          undefined,
          targetNameMap,
          stationNameMap,
        );
        if (built) {
          satCommittedObs.set(sid, nextCommitted);
          satSchedules.set(sid, built.actions);
          for (const nc of newlyCommitted) {
            satisfiedTargets.add(nc.targetId);
          }
        }
      }
    }
  }

  const allActions: ScheduledAction[] = [];
  for (const acts of satSchedules.values()) allActions.push(...acts);
  allActions.sort((a, b) => a.startSec - b.startSec);

  const runtimeMs = +(performance.now() - t0).toFixed(2);
  const verification = verifyScheduleIndependently(bundle, allActions);

  return {
    algorithmId: 'rolling_horizon',
    algorithmLabel: 'Standard Rolling-Horizon (Receding Window)',
    scenarioHash: bundle.scenarioHash,
    seed: bundle.scenario.seed,
    status: timedOut ? 'TIMEOUT' : 'FEASIBLE_INCUMBENT',
    solverReportedObjective: verification.verifiedDeterministicObjective,
    dualUpperBound: null,
    optimalityGapPct: null,
    runtimeMs,
    computeBudgetMs,
    repairEventsTriggered: replanningTriggers,
    notes: [
      `Receding horizon with step ΔW=${stepSec}s and lookahead W=${lookaheadSec}s.`,
      `Causally detected ${replanningTriggers} post-capture cloud failures and re-opened affected targets in subsequent slices.`,
    ],
    actions: allActions,
    verification,
  };
}
