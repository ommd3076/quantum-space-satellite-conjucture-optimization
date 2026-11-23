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
 * Baseline 1: Deterministic Feasible Greedy Scheduler
 * Sorts all valid observation windows by priority-to-data-volume density (priority / dataVolumeGb),
 * breaking ties by earliest start time. Assigns each target at most once and verifies exact
 * per-satellite battery, storage, slew, and downlink feasibility before committing.
 */
export function runGreedyBaseline(
  bundle: PropagationBundle,
  computeBudgetMs = 2000,
): SolverRunResult {
  const t0 = performance.now();
  const { targetNameMap, stationNameMap } = buildNameMaps(bundle);

  // Filter windows that can complete before target deadline
  const candidates = bundle.observationWindows
    .filter((w) => w.startSec + w.requiredObsSec <= Math.min(w.endSec, w.deadlineSec))
    .slice()
    .sort((a, b) => {
      const scoreA = a.targetPriority / Math.max(1, a.dataVolumeGb);
      const scoreB = b.targetPriority / Math.max(1, b.dataVolumeGb);
      if (Math.abs(scoreB - scoreA) > 1e-9) return scoreB - scoreA;
      return a.startSec - b.startSec;
    });

  const assignedTargets = new Set<string>();
  const satObsMap = new Map<string, ObservationWindow[]>();
  const satSchedules = new Map<string, ScheduledAction[]>();
  for (const sat of bundle.satellites) {
    satObsMap.set(sat.satId, []);
    satSchedules.set(sat.satId, []);
  }

  let timedOut = false;
  for (const win of candidates) {
    if (performance.now() - t0 > computeBudgetMs) {
      timedOut = true;
      break;
    }
    if (assignedTargets.has(win.targetId)) continue;

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
      assignedTargets.add(win.targetId);
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
    algorithmId: 'greedy',
    algorithmLabel: 'Deterministic Greedy (Priority / Volume)',
    scenarioHash: bundle.scenarioHash,
    seed: bundle.scenario.seed,
    status: timedOut ? 'TIMEOUT' : 'FEASIBLE_INCUMBENT',
    solverReportedObjective: verification.verifiedDeterministicObjective,
    dualUpperBound: null,
    optimalityGapPct: null,
    runtimeMs,
    computeBudgetMs,
    notes: [
      'Deterministic single-pass constructive greedy sorted by priority / dataVolumeGb.',
      'Does not inspect stochastic cloud realizations or reserve downlink capacity proactively.',
    ],
    actions: allActions,
    verification,
  };
}
