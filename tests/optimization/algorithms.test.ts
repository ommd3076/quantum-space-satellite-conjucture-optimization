import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresetScenarios } from '../../backend/src/scenarios/presets';
import { propagateAndAnalyzeScenario } from '../../backend/src/geometry/access';
import { runAllAlgorithmsOnBundle } from '../../backend/src/algorithms/runner';
import { verifyScheduleIndependently } from '../../backend/src/validation/verifier';
import { runPairedExperimentBatch } from '../../experiments/runner';

test('All 5 algorithms produce independently verified feasible schedules on frozen small scenario', () => {
  const presets = createPresetScenarios();
  const bundle = propagateAndAnalyzeScenario(presets.exact_small_12_3_1);

  assert.ok(bundle.observationWindows.length > 0, 'Expected non-zero observation windows');
  assert.ok(bundle.downlinkWindows.length > 0, 'Expected non-zero downlink contacts');

  const results = runAllAlgorithmsOnBundle(bundle, 1000);
  assert.equal(results.length, 5);

  for (const res of results) {
    assert.equal(
      res.verification.verifiedFeasible,
      true,
      `Algorithm ${res.algorithmId} produced violations: ${JSON.stringify(res.verification.violations)}`,
    );
    assert.equal(res.verification.violationCount, 0);
    assert.ok(res.verification.verifiedDeterministicObjective > 0, `${res.algorithmId} should score > 0`);
    assert.equal(res.scenarioHash, bundle.scenarioHash);
  }

  // Exact solver must report dual upper bound >= verified objective
  const exact = results.find((r) => r.algorithmId === 'exact_bnb')!;
  assert.ok(exact.dualUpperBound !== null);
  assert.ok(exact.dualUpperBound >= exact.verification.verifiedDeterministicObjective - 1e-6);
});

test('All 5 algorithms achieve 0 independent verifier violations on 24-satellite reference scenario', () => {
  const presets = createPresetScenarios();
  const bundle = propagateAndAnalyzeScenario(presets.reference_24_6_1);
  const results = runAllAlgorithmsOnBundle(bundle, 800);
  for (const res of results) {
    assert.equal(
      res.verification.violationCount,
      0,
      `${res.algorithmId} violations: ${JSON.stringify(res.verification.violations)}`,
    );
    assert.equal(res.verification.verifiedFeasible, true);
  }
});

test('Independent verifier actively catches injected timing and storage violations', () => {
  const presets = createPresetScenarios();
  const bundle = propagateAndAnalyzeScenario(presets.exact_small_12_3_1);
  const results = runAllAlgorithmsOnBundle(bundle, 500);
  const greedy = results[0];
  assert.ok(greedy.actions.length > 0);

  // Tamper with first action to violate window bounds
  const tampered = greedy.actions.map((a, idx) =>
    idx === 0 ? { ...a, startSec: a.startSec - 1000, endSec: a.endSec + 1000 } : a,
  );
  const report = verifyScheduleIndependently(bundle, tampered);
  assert.equal(report.verifiedFeasible, false);
  assert.ok(report.violationCount > 0);
});

test('Paired multi-seed experiment runner computes real 95% CIs and component ablations', () => {
  const presets = createPresetScenarios();
  const batch = runPairedExperimentBatch({
    baseScenario: presets.exact_small_12_3_1,
    seeds: [101, 202, 303],
    computeBudgetMs: 400,
    includeAblations: true,
    includeExactSolver: false,
  });

  assert.equal(batch.seeds.length, 3);
  assert.equal(batch.summaryByAlgorithm.length, 7); // 3 baselines + proposed_full + 3 ablations
  for (const sum of batch.summaryByAlgorithm) {
    assert.equal(sum.violationRuns, 0, `${sum.algorithmKey} had violations in batch`);
    assert.equal(sum.validFeasibleRuns, 3);
  }
});
