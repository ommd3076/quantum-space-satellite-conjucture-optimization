import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { propagateAndAnalyzeScenario } from '../backend/src/geometry/access';
import { runAlgorithm } from '../backend/src/algorithms/runner';
import { generateSyntheticTargets } from '../backend/src/scenarios/presets';
import { sha256Canonical } from '../backend/src/scenarios/prng';
import type {
  AlgorithmId,
  ExperimentBatchResult,
  ProposedAblationFlags,
  ScenarioConfig,
  SolverSummaryStats,
} from '../backend/src/types';

/** Two-tailed 95% Student-t critical values for df = 1..30 (exact tables), falling back to 1.96 */
function tCritical95(df: number): number {
  const table: Record<number, number> = {
    1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
    6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
    11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131,
    16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086,
  };
  if (df <= 0) return 0;
  return table[df] ?? (df < 30 ? 2.05 : 1.96);
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function sampleStd(arr: number[]): number {
  if (arr.length <= 1) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) * (v - m), 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function ci95HalfWidth(arr: number[]): number {
  if (arr.length <= 1) return 0;
  return (tCritical95(arr.length - 1) * sampleStd(arr)) / Math.sqrt(arr.length);
}

interface SolverSpec {
  key: string;
  label: string;
  algorithmId: AlgorithmId;
  ablationFlags?: ProposedAblationFlags;
}

export function runPairedExperimentBatch(params: {
  baseScenario: ScenarioConfig;
  seeds: number[];
  computeBudgetMs: number;
  includeAblations: boolean;
  includeExactSolver: boolean;
  suiteName?: string;
}): ExperimentBatchResult {
  const {
    baseScenario,
    seeds,
    computeBudgetMs,
    includeAblations,
    includeExactSolver,
    suiteName = baseScenario.name,
  } = params;

  const cleanSeeds = seeds.slice(0, 12); // bound compute for responsive API while remaining statistically meaningful
  if (cleanSeeds.length < 2) {
    throw new Error('Experiment batch requires at least 2 independent seeds for confidence intervals.');
  }

  const specs: SolverSpec[] = [
    { key: 'greedy', label: 'Deterministic Greedy', algorithmId: 'greedy' },
    { key: 'deadline_heuristic', label: 'Deadline-Urgency Heuristic', algorithmId: 'deadline_heuristic' },
    ...(includeExactSolver
      ? [{ key: 'exact_bnb', label: 'Exact / Bounded B&B', algorithmId: 'exact_bnb' as AlgorithmId }]
      : []),
    { key: 'rolling_horizon', label: 'Standard Rolling-Horizon', algorithmId: 'rolling_horizon' },
    {
      key: 'proposed_full',
      label: 'SRA-RHR (Full Candidate)',
      algorithmId: 'proposed',
      ablationFlags: { useRiskAware: true, useShadowPricing: true, useIncrementalRepair: true },
    },
  ];

  if (includeAblations) {
    specs.push(
      {
        key: 'ablation_no_risk',
        label: 'Ablation: SRA-RHR (-NoRisk)',
        algorithmId: 'proposed',
        ablationFlags: { useRiskAware: false, useShadowPricing: true, useIncrementalRepair: true },
      },
      {
        key: 'ablation_no_shadow',
        label: 'Ablation: SRA-RHR (-NoShadowPrice)',
        algorithmId: 'proposed',
        ablationFlags: { useRiskAware: true, useShadowPricing: false, useIncrementalRepair: true },
      },
      {
        key: 'ablation_no_repair',
        label: 'Ablation: SRA-RHR (-NoRepair)',
        algorithmId: 'proposed',
        ablationFlags: { useRiskAware: true, useShadowPricing: true, useIncrementalRepair: false },
      },
    );
  }

  const rawRuns: ExperimentBatchResult['rawRuns'] = [];
  const baseScenarioHash = sha256Canonical(baseScenario);

  for (const seed of cleanSeeds) {
    // Re-generate deterministic target priority/deadline/cloud realization per seed while holding orbital geometry fixed
    const seededScenario: ScenarioConfig = {
      ...baseScenario,
      seed,
      targets: generateSyntheticTargets(
        baseScenario.targets.length,
        seed,
        baseScenario.horizonSec,
        1.0,
        1.0,
      ),
    };
    const bundle = propagateAndAnalyzeScenario(seededScenario);

    for (const spec of specs) {
      const res = runAlgorithm(spec.algorithmId, bundle, computeBudgetMs, spec.ablationFlags);
      rawRuns.push({
        seed,
        algorithmKey: spec.key,
        label: spec.label,
        status: res.status,
        verifiedFeasible: res.verification.verifiedFeasible,
        violationCount: res.verification.violationCount,
        deterministicObj: res.verification.verifiedDeterministicObjective,
        realizedObj: res.verification.verifiedRealizedObjective,
        onTimeDeliveryRate: res.verification.onTimeDeliveryRate,
        meanLatencySec: res.verification.meanDataLatencySec,
        runtimeMs: res.runtimeMs,
        optimalityGapPct: res.optimalityGapPct,
        repairEventsTriggered: res.repairEventsTriggered ?? 0,
      });
    }
  }

  // Reference baseline for paired statistics: Standard Rolling-Horizon
  const rhBySeed = new Map<number, number>();
  for (const r of rawRuns) {
    if (r.algorithmKey === 'rolling_horizon' && r.verifiedFeasible) {
      rhBySeed.set(r.seed, r.realizedObj);
    }
  }

  const summaryByAlgorithm: SolverSummaryStats[] = specs.map((spec) => {
    const runs = rawRuns.filter((r) => r.algorithmKey === spec.key);
    const valid = runs.filter((r) => r.verifiedFeasible);
    const detVals = valid.map((r) => r.deterministicObj);
    const realVals = valid.map((r) => r.realizedObj);
    const onTimeVals = valid.map((r) => r.onTimeDeliveryRate);
    const runtimeVals = runs.map((r) => r.runtimeMs);
    const latVals = valid.map((r) => r.meanLatencySec);

    let pairedDeltaVsRH: number | null = null;
    let pairedCi95VsRH: number | null = null;
    let cohensDVsRH: number | null = null;

    if (spec.key !== 'rolling_horizon') {
      const diffs: number[] = [];
      for (const r of valid) {
        const rhVal = rhBySeed.get(r.seed);
        if (rhVal !== undefined) {
          diffs.push(r.realizedObj - rhVal);
        }
      }
      if (diffs.length >= 2) {
        const dMean = mean(diffs);
        const dStd = sampleStd(diffs);
        pairedDeltaVsRH = +dMean.toFixed(2);
        pairedCi95VsRH = +ci95HalfWidth(diffs).toFixed(2);
        cohensDVsRH = dStd > 1e-9 ? +(dMean / dStd).toFixed(3) : dMean === 0 ? 0 : null;
      }
    }

    return {
      algorithmKey: spec.key,
      label: spec.label,
      runs: runs.length,
      validFeasibleRuns: valid.length,
      violationRuns: runs.filter((r) => !r.verifiedFeasible).length,
      timeoutRuns: runs.filter((r) => r.status === 'TIMEOUT').length,
      meanDeterministicObj: +mean(detVals).toFixed(2),
      stdDeterministicObj: +sampleStd(detVals).toFixed(2),
      ci95DeterministicObj: +ci95HalfWidth(detVals).toFixed(2),
      meanRealizedObj: +mean(realVals).toFixed(2),
      stdRealizedObj: +sampleStd(realVals).toFixed(2),
      ci95RealizedObj: +ci95HalfWidth(realVals).toFixed(2),
      minRealizedObj: realVals.length > 0 ? +Math.min(...realVals).toFixed(2) : 0,
      maxRealizedObj: realVals.length > 0 ? +Math.max(...realVals).toFixed(2) : 0,
      meanOnTimeRate: +mean(onTimeVals).toFixed(4),
      meanRuntimeMs: +mean(runtimeVals).toFixed(2),
      meanLatencySec: +mean(latVals).toFixed(1),
      pairedDeltaVsRH,
      pairedCi95VsRH,
      cohensDVsRH,
    };
  });

  const proposedSummary = summaryByAlgorithm.find((s) => s.algorithmKey === 'proposed_full');
  const zeroViolations = (proposedSummary?.violationRuns ?? 1) === 0;
  const delta = proposedSummary?.pairedDeltaVsRH ?? null;
  const ci = proposedSummary?.pairedCi95VsRH ?? null;
  const strictlyPositiveCi95 = delta !== null && ci !== null && delta - ci > 0;

  let verdict: ExperimentBatchResult['hypothesisCheck']['verdict'];
  let explanation: string;
  if (!zeroViolations) {
    verdict = 'INVALID_VIOLATION';
    explanation = `Falsified: SRA-RHR incurred ${proposedSummary?.violationRuns} independently verified constraint violation(s).`;
  } else if (strictlyPositiveCi95) {
    verdict = 'SUPPORTED_ON_BATCH';
    explanation = `Paired realized utility vs. Rolling Horizon is +${delta?.toFixed(2)} ± ${ci?.toFixed(2)} (95% CI strictly > 0) with 0 violations across ${cleanSeeds.length} seeds. Note: valid only on this tested scenario suite; does not prove universal dominance.`;
  } else {
    verdict = 'FALSIFIED_OR_INCONCLUSIVE';
    explanation = `Paired realized utility vs. Rolling Horizon is ${delta !== null ? (delta >= 0 ? '+' : '') + delta.toFixed(2) : 'N/A'} ± ${ci?.toFixed(2) ?? 'N/A'} (95% CI includes 0 or is negative). Logged transparently without cherry-picking.`;
  }

  const batchId = `EXP-${Date.now().toString(36).toUpperCase()}`;
  const result: ExperimentBatchResult = {
    batchId,
    executedAtIso: new Date().toISOString(),
    baseScenarioHash,
    suiteName,
    seeds: cleanSeeds,
    computeBudgetMs,
    includeAblations,
    summaryByAlgorithm,
    rawRuns,
    hypothesisCheck: {
      proposedVsRhDelta: delta,
      proposedVsRhCi95: ci,
      strictlyPositiveCi95,
      zeroViolations,
      verdict,
      explanation,
    },
    environment: {
      nodeVersion: process.version,
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
    },
  };

  // Persist raw experimental artifact to experiments/outputs/
  try {
    const outDir = path.resolve(process.cwd(), 'experiments/outputs');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, `${batchId}.json`),
      JSON.stringify(result, null, 2),
      'utf8',
    );
  } catch {
    // Non-fatal if filesystem write restricted
  }

  return result;
}
