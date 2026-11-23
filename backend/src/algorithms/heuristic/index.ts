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
 * Baseline 2: Independent Deadline / Priority-Urgency Heuristic
 * Scores targets by urgency (priority / remaining slack until deadline) and selects
 * the earliest satellite window that has subsequent downlink contact available before horizon end.
 */
export function runDeadlineHeuristicBaseline(
  bundle: PropagationBundle,
  computeBudgetMs = 2000,
): SolverRunResult {
  const t0 = performance.now();
  const { targetNameMap, stationNameMap } = buildNameMaps(bundle);

  // Precompute last downlink end time per satellite for lookahead check
  const satLatestDlEnd = new Map<string, number>();
  const satTotalDlCap = new Map<string, number>();
  for (const dl of bundle.downlinkWindows) {
    satLatestDlEnd.set(dl.satId, Math.max(satLatestDlEnd.get(dl.satId) ?? 0, dl.endSec));
    satTotalDlCap.set(dl.satId, (satTotalDlCap.get(dl.satId) ?? 0) + dl.maxVolumeGb);
  }

  // Group feasible windows by target
  const windowsByTarget = new Map<string, ObservationWindow[]>();
  for (const w of bundle.observationWindows) {
    if (w.startSec + w.requiredObsSec > Math.min(w.endSec, w.deadlineSec)) continue;
    const arr = windowsByTarget.get(w.targetId) ?? [];
    arr.push(w);
    windowsByTarget.set(w.targetId, arr);
  }

  // Sort targets by urgency = priority * (1 + scarcityBonus) / normalized deadline
  const orderedTargets = bundle.scenario.targets
    .filter((t) => (windowsByTarget.get(t.id)?.length ?? 0) > 0)
    .slice()
    .sort((a, b) => {
      const countA = windowsByTarget.get(a.id)!.length;
      const countB = windowsByTarget.get(b.id)!.length;
      const urgA = (a.priority * (1 + 1 / Math.sqrt(countA))) / Math.max(600, a.deadlineSec);
      const urgB = (b.priority * (1 + 1 / Math.sqrt(countB))) / Math.max(600, b.deadlineSec);
      if (Math.abs(urgB - urgA) > 1e-12) return urgB - urgA;
      return a.deadlineSec - b.deadlineSec;
    });

  const satObsMap = new Map<string, ObservationWindow[]>();
  const satSchedules = new Map<string, ScheduledAction[]>();
  for (const sat of bundle.satellites) {
    satObsMap.set(sat.satId, []);
    satSchedules.set(sat.satId, []);
  }

  let timedOut = false;
  for (const tgt of orderedTargets) {
    if (performance.now() - t0 > computeBudgetMs) {
      timedOut = true;
      break;
    }
    const wins = (windowsByTarget.get(tgt.id) ?? []).slice().sort((a, b) => {
      // Prefer windows that precede a satellite's downlink contact and have lower off-nadir angle
      const hasDlA = (satLatestDlEnd.get(a.satId) ?? 0) > a.endSec + 60 ? 1 : 0;
      const hasDlB = (satLatestDlEnd.get(b.satId) ?? 0) > b.endSec + 60 ? 1 : 0;
      if (hasDlB !== hasDlA) return hasDlB - hasDlA;
      const capA = satTotalDlCap.get(a.satId) ?? 0;
      const capB = satTotalDlCap.get(b.satId) ?? 0;
      if (Math.abs(capB - capA) > 20) return capB - capA;
      return a.startSec - b.startSec;
    });

    for (const win of wins) {
      const currentObs = satObsMap.get(win.satId)!;
      const trialObs = [...currentObs, win];
      const result = buildFeasibleSatelliteSchedule(
        bundle,
        win.satId,
        trialObs,
        undefined,
        targetNameMap,
        stationNameMap,
      );
      if (result) {
        satObsMap.set(win.satId, trialObs);
        satSchedules.set(win.satId, result.actions);
        break;
      }
    }
  }

  const allActions: ScheduledAction[] = [];
  for (const actions of satSchedules.values()) {
    allActions.push(...actions);
  }
  allActions.sort((a, b) => a.startSec - b.startSec);

  const runtimeMs = +(performance.now() - t0).toFixed(2);
  const verification = verifyScheduleIndependently(bundle, allActions);

  return {
    algorithmId: 'deadline_heuristic',
    algorithmLabel: 'Deadline-Urgency & Scarcity Heuristic',
    scenarioHash: bundle.scenarioHash,
    seed: bundle.scenario.seed,
    status: timedOut ? 'TIMEOUT' : 'FEASIBLE_INCUMBENT',
    solverReportedObjective: verification.verifiedDeterministicObjective,
    dualUpperBound: null,
    optimalityGapPct: null,
    runtimeMs,
    computeBudgetMs,
    notes: [
      'Prioritizes targets by deadline urgency weighted by inverse visibility-window count.',
      'Selects satellites with available post-capture downlink contact capacity.',
    ],
    actions: allActions,
    verification,
  };
}
