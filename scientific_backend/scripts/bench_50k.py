#!/usr/bin/env python3
"""Headless CLI: Run the 50,000-object chunked propagation stress benchmark & record hardware metrics."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.propagation.synthetic_50k import (
    SyntheticConstellationCatalog,
    run_50k_chunked_benchmark,
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Execute 50,000-object synthetic propagation stress test.")
    parser.add_argument("--horizon-sec", type=float, default=86400.0, help="Horizon in seconds (default 86400 = 24h)")
    parser.add_argument("--step-sec", type=float, default=300.0, help="Sampling step in seconds (default 300 = 5m)")
    parser.add_argument("--chunk-size", type=int, default=5000, help="Objects per memory-bounded chunk")
    parser.add_argument("--fidelity", choices=["j2_secular_kepler", "j2_rk4_numerical"], default="j2_secular_kepler")
    parser.add_argument("--no-parquet", action="store_true", help="Skip Parquet streaming output")
    parser.add_argument("--tag", default="bench_50k")
    args = parser.parse_args()

    cat = SyntheticConstellationCatalog(seed=20261123)
    report = run_50k_chunked_benchmark(
        catalog=cat,
        horizon_sec=args.horizon_sec,
        step_sec=args.step_sec,
        chunk_size=args.chunk_size,
        fidelity=args.fidelity,
        write_parquet=not args.no_parquet,
        artifact_tag=args.tag,
    )
    # Trim random_audit_snapshots for clean stdout (full list saved in JSON report artifact)
    out = dict(report)
    out["random_audit_snapshots_count"] = len(report.get("random_audit_snapshots", []))
    out.pop("random_audit_snapshots", None)
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
