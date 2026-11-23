#!/usr/bin/env python3
"""Headless CLI: Run reproducible scheduling experiment (OR-Tools CP-SAT + baselines + independent verifier)."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.access.geometry import (
    VERIFIED_GROUND_STATIONS,
    compute_refined_access_windows_for_subset,
    generate_synthetic_eo_targets,
)
from app.optimization.solvers import run_scheduling_benchmark_suite
from app.propagation.synthetic_50k import SyntheticConstellationCatalog


def main() -> None:
    parser = argparse.ArgumentParser(description="Run reproducible scheduling benchmark with OR-Tools CP-SAT.")
    parser.add_argument("--sats", type=int, default=24)
    parser.add_argument("--targets", type=int, default=30)
    parser.add_argument("--horizon-sec", type=float, default=21600.0)
    parser.add_argument("--seed", type=int, default=20261123)
    parser.add_argument("--time-limit", type=float, default=2.0)
    args = parser.parse_args()

    cat = SyntheticConstellationCatalog(seed=args.seed)
    ctrl_idx = [int(i) for i in np.where(cat.controllable_mask)[0][: args.sats]]
    targets = generate_synthetic_eo_targets(args.targets, seed=args.seed, horizon_sec=args.horizon_sec)
    access = compute_refined_access_windows_for_subset(
        cat, ctrl_idx, targets, VERIFIED_GROUND_STATIONS, horizon_sec=args.horizon_sec, seed=args.seed
    )
    report = run_scheduling_benchmark_suite(access, time_limit_sec=args.time_limit, seed=args.seed)

    # Compact summary for CLI output (full schedule saved to experiments/results/<exp_id>.json)
    summary = {
        "experiment_id": report["experiment_id"],
        "artifact_file": report.get("artifact_file"),
        "scope_disclosure": report["scope_disclosure"],
        "algorithms": [
            {
                "algorithm_id": r["algorithm_id"],
                "novelty_status": r["novelty_status"],
                "solver_status": r["solver_status"],
                "verified_feasible": r["verification"]["verified_feasible"],
                "violations": r["verification"]["violation_count"],
                "deterministic_utility": r["verification"]["verified_deterministic_utility"],
                "realized_clear_utility": r["verification"]["verified_realized_clear_utility"],
                "best_bound": r["best_objective_bound"],
                "gap_pct": r["optimality_gap_pct"],
                "wall_time_ms": r["wall_time_ms"],
            }
            for r in report["results"]
        ],
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
