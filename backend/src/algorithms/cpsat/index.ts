import { performance } from 'node:perf_hooks';
import { verifyScheduleIndependently } from '../../validation/verifier';
import { buildFeasibleSatelliteSchedule, buildNameMaps } from '../shared/timeline';
import { runDeadlineHeuristicBaseline } from '../heuristic';
import type {
  ObservationWindow,
  PropagationBundle,
  ScheduledAction,
  SolverRunResult,
  SolverStatus,
} from '../../types';

/**
 * Baseline 3: Exact / Bounded Branch-and-Bound Combinatorial Solver (MILP / CP-style)
 * Searches binary target-to-opportunity assignments across the constellation with:
 * - Admissible dual upper bound: sum of remaining achievable target priorities capped by
 *   aggregate constellation remaining storage+downlink capacity (valid relaxation upper bound).
 * - Warm-start incumbent from feasible heuristic so a valid lower bound exists immediately.
 * - Strict wall-clock computeBudgetMs limit: proves OPTIMAL (gap = 0%) when the search tree
 *   exhausts; otherwise returns FEASIBLE_INCUMBENT with certified dualUpperBound and optimalityGapPct.
 */
export function runExactBranchAndBoundBaseline(
  bundle: PropagationBundle,
  computeBudgetMs = 2000,
): SolverRunResult {
  const t0 = performance.now();
  const { targetNameMap, stationNameMap } = buildNameMaps(bundle);
  const res = bundle.scenario.resources;

  // Group feasible windows by target
  const windowsByTarget = new Map<string, ObservationWindow[]>();
  for (const w of bundle.observationWindows) {
    if (w.startSec + w.requiredObsSec > Math.min(w.endSec, w.deadlineSec)) continue;
    const arr = windowsByTarget.get(w.targetId) ?? [];
    arr.push(w);
    windowsByTarget.set(w.targetId, arr);
  }

  // Sort targets descending by priority so tight bounds are discovered early
  const activeTargets = bundle.scenario.targets
    .filter((t) => (windowsByTarget.get(t.id)?.length ?? 0) > 0)
    .slice()
    .sort((a, b) => b.priority - a.priority);

  // Suffix priority sums for fast admissible relaxation bound
  const nT = activeTargets.length;
  const suffixMaxPriority = new Float64Array(nT + 1);
  for (let i = nT - 1; i >= 0; i--) {
    suffixMaxPriority[i] = suffixMaxPriority[i + 1] + activeTargets[i].priority;
  }

  // Per-satellite total downlink + initial free storage capacity bound (admissible upper bound on capturable Gb)
  const satMaxDataCap = new Map<string, number>();
  for (const sat of bundle.satellites) {
    const dlCap = bundle.downlinkWindows
      .filter((d) => d.satId === sat.satId)
      .reduce((s, d) => s + d.maxVolumeGb, 0);
    satMaxDataCap.set(sat.satId, res.storageCapacityGb + dlCap);
  }
  const totalConstellationDataCap = Array.from(satMaxDataCap.values()).reduce((s, v) => s + v, 0);

  // Warm start using heuristic baseline (within 20% of budget)
  const warmStart = runDeadlineHeuristicBaseline(bundle, Math.min(350, computeBudgetMs * 0.25));
  let bestObj = warmStart.verification.verifiedFeasible
    ? warmStart.verification.verifiedDeterministicObjective
    : 0;
  let bestActions: ScheduledAction[] = warmStart.verification.verifiedFeasible
    ? warmStart.actions
    : [];

  // Tightest global admissible upper bound: cannot exceed total priority of all accessible targets
  // nor fractional knapsack bound under total constellation data capacity
  const computeCapacityRelaxedUpperBound = (startIdx: number, remainingDataCap: number): number => {
    let cap = Math.max(0, remainingDataCap);
    let ub = 0;
    // Targets from startIdx..nT-1 sorted by priority/volume density
    const rem = activeTargets.slice(startIdx).sort(
      (a, b) => b.priority / Math.max(0.5, b.dataVolumeGb) - a.priority / Math.max(0.5, a.dataVolumeGb),
    );
    for (const t of rem) {
      if (cap >= t.dataVolumeGb) {
        ub += t.priority;
        cap -= t.dataVolumeGb;
      } else if (cap > 0) {
        ub += t.priority * (cap / Math.max(0.5, t.dataVolumeGb));
        break;
      } else {
        break;
      }
    }
    return Math.min(suffixMaxPriority[startIdx], ub);
  };

  let globalDualUpperBound = computeCapacityRelaxedUpperBound(0, totalConstellationDataCap);

  // Branch-and-bound state
  const satObsMap = new Map<string, ObservationWindow[]>();
  const satActionsCache = new Map<string, ScheduledAction[]>();
  const satDeliveredMap = new Map<string, number>();
  for (const sat of bundle.satellites) {
    satObsMap.set(sat.satId, []);
    satActionsCache.set(sat.satId, []);
    satDeliveredMap.set(sat.satId, 0);
  }

  let nodesExplored = 0;
  let timedOut = false;
  let bestNodeBound = bestObj;

  // Limit candidate windows per target in exact search to top-K best windows per target if huge,
  // while keeping exact completeness when all windows fit.
  const isFullExactDomain = activeTargets.every((t) => (windowsByTarget.get(t.id)?.length ?? 0) <= 6) && nT <= 28;
  const maxBranchPerTarget = isFullExactDomain ? 6 : 3;

  const evaluateCurrentPartial = (
    satObs: Map<string, ObservationWindow[]>,
    satActs: Map<string, ScheduledAction[]>,
  ): { obj: number; actions: ScheduledAction[] } => {
    const actions: ScheduledAction[] = [];
    for (const arr of satActs.values()) actions.push(...arr);
    // Exact deterministic objective calculation matching verifier
    let obj = 0;
    for (const [satId, obsList] of satObs.entries()) {
      const satActList = satActs.get(satId)!;
      const totalDl = satActList
        .filter((a) => a.type === 'downlink')
        .reduce((s, a) => s + Math.max(0, -a.dataDeltaGb), 0);
      let remDl = totalDl;
      const ordered = obsList.slice().sort((a, b) => a.startSec - b.startSec);
      for (const o of ordered) {
        if (remDl >= o.dataVolumeGb - 1e-6) {
          remDl -= o.dataVolumeGb;
          obj += o.targetPriority;
        } else {
          obj += o.targetPriority * res.captureCreditFraction;
        }
      }
    }
    return { obj: +obj.toFixed(4), actions };
  };

  const dfs = (idx: number, currentUsedDataGb: number) => {
    if (timedOut) return;
    nodesExplored++;
    if ((nodesExplored & 31) === 0 && performance.now() - t0 > computeBudgetMs) {
      timedOut = true;
      return;
    }

    const currentEval = evaluateCurrentPartial(satObsMap, satActionsCache);
    if (currentEval.obj > bestObj + 1e-6) {
      bestObj = currentEval.obj;
      bestActions = currentEval.actions.slice().sort((a, b) => a.startSec - b.startSec);
    }

    if (idx >= nT) return;

    const remUb = computeCapacityRelaxedUpperBound(idx, totalConstellationDataCap - currentUsedDataGb);
    const optimisticBound = currentEval.obj + remUb;
    if (optimisticBound <= bestObj + 1e-6) {
      return; // Prune by admissible dual bound
    }
    if (optimisticBound > bestNodeBound) {
      bestNodeBound = optimisticBound;
    }

    const tgt = activeTargets[idx];
    const wins = (windowsByTarget.get(tgt.id) ?? [])
      .slice()
      .sort((a, b) => a.startSec - b.startSec)
      .slice(0, maxBranchPerTarget);

    // Branch 1..K: assign target to a feasible satellite window
    for (const w of wins) {
      if (timedOut) return;
      const prevObs = satObsMap.get(w.satId)!;
      const prevActs = satActionsCache.get(w.satId)!;
      const trialObs = [...prevObs, w];
      const built = buildFeasibleSatelliteSchedule(
        bundle,
        w.satId,
        trialObs,
        undefined,
        targetNameMap,
        stationNameMap,
      );
      if (built) {
        satObsMap.set(w.satId, trialObs);
        satActionsCache.set(w.satId, built.actions);
        dfs(idx + 1, currentUsedDataGb + w.dataVolumeGb);
        satObsMap.set(w.satId, prevObs);
        satActionsCache.set(w.satId, prevActs);
      }
    }

    // Branch 0: skip target
    if (!timedOut) {
      dfs(idx + 1, currentUsedDataGb);
    }
  };

  // Run Branch-and-Bound only if warm start didn't already hit global upper bound
  if (bestObj < globalDualUpperBound - 1e-6) {
    dfs(0, 0);
  }

  const runtimeMs = +(performance.now() - t0).toFixed(2);
  const verification = verifyScheduleIndependently(bundle, bestActions);
  const verifiedObj = verification.verifiedDeterministicObjective;

  // Dual upper bound certification
  let certifiedUpperBound = Math.max(verifiedObj, globalDualUpperBound);
  if (!timedOut && isFullExactDomain) {
    certifiedUpperBound = verifiedObj;
  }

  const gapPct =
    certifiedUpperBound > 1e-6
      ? +Math.max(0, (100 * (certifiedUpperBound - verifiedObj)) / certifiedUpperBound).toFixed(2)
      : 0;

  let status: SolverStatus;
  if (!verification.verifiedFeasible) {
    status = 'FAILED';
  } else if (!timedOut && isFullExactDomain && gapPct <= 0.01) {
    status = 'OPTIMAL';
  } else if (timedOut) {
    status = 'FEASIBLE_INCUMBENT';
  } else {
    status = gapPct <= 0.01 ? 'OPTIMAL' : 'FEASIBLE_INCUMBENT';
  }

  const notes: string[] = [
    `Explored ${nodesExplored} branch-and-bound nodes within ${computeBudgetMs} ms budget.`,
    status === 'OPTIMAL'
      ? 'Search tree exhausted on full exact domain; proven global optimality (0.00% gap) under deterministic objective.'
      : isFullExactDomain
        ? `Time budget reached before tree exhaustion; returning best feasible incumbent with admissible dual upper bound ${certifiedUpperBound.toFixed(1)} (${gapPct}% gap).`
        : `Large instance (${nT} targets); branching capped at top-${maxBranchPerTarget} windows/target, returning incumbent with relaxed dual bound ${certifiedUpperBound.toFixed(1)} (${gapPct}% gap).`,
  ];

  return {
    algorithmId: 'exact_bnb',
    algorithmLabel: 'Exact / Bounded Branch-and-Bound (MILP-Style)',
    scenarioHash: bundle.scenarioHash,
    seed: bundle.scenario.seed,
    status,
    solverReportedObjective: verifiedObj,
    dualUpperBound: +certifiedUpperBound.toFixed(2),
    optimalityGapPct: gapPct,
    runtimeMs,
    computeBudgetMs,
    nodesExplored,
    notes,
    actions: bestActions,
    verification,
  };
}
