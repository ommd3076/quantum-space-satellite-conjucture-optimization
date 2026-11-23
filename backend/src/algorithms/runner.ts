import { runGreedyBaseline } from './greedy';
import { runDeadlineHeuristicBaseline } from './heuristic';
import { runExactBranchAndBoundBaseline } from './cpsat';
import { runRollingHorizonBaseline } from './rolling_horizon';
import { DEFAULT_PROPOSED_FLAGS, runProposedSraRhr } from './proposed';
import type {
  AlgorithmId,
  PropagationBundle,
  ProposedAblationFlags,
  SolverRunResult,
} from '../types';

export function runAlgorithm(
  algorithmId: AlgorithmId,
  bundle: PropagationBundle,
  computeBudgetMs = 2000,
  ablationFlags?: ProposedAblationFlags,
): SolverRunResult {
  switch (algorithmId) {
    case 'greedy':
      return runGreedyBaseline(bundle, computeBudgetMs);
    case 'deadline_heuristic':
      return runDeadlineHeuristicBaseline(bundle, computeBudgetMs);
    case 'exact_bnb':
      return runExactBranchAndBoundBaseline(bundle, computeBudgetMs);
    case 'rolling_horizon':
      return runRollingHorizonBaseline(bundle, computeBudgetMs);
    case 'proposed':
      return runProposedSraRhr(bundle, computeBudgetMs, ablationFlags ?? DEFAULT_PROPOSED_FLAGS);
    default:
      throw new Error(`Unsupported algorithmId: ${String(algorithmId)}`);
  }
}

export function runAllAlgorithmsOnBundle(
  bundle: PropagationBundle,
  computeBudgetMs = 1500,
  ablationFlags: ProposedAblationFlags = DEFAULT_PROPOSED_FLAGS,
): SolverRunResult[] {
  const ids: AlgorithmId[] = [
    'greedy',
    'deadline_heuristic',
    'exact_bnb',
    'rolling_horizon',
    'proposed',
  ];
  return ids.map((id) => runAlgorithm(id, bundle, computeBudgetMs, ablationFlags));
}
