#!/usr/bin/env python3
"""Headless CLI: Fetch & cache real CelesTrak GP/OMM CSV snapshot with provenance and SGP4 verification."""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.catalogs.celestrak import ingest_celestrak_group, provenance_to_dict
from app.propagation.sgp4_engine import build_satrecs_from_omm, propagate_catalog_at_epochs


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch real CelesTrak GP/OMM CSV catalog and run C++ SGP4 propagation check.")
    parser.add_argument("--group", default="active", help="CelesTrak GP group (e.g., active, stations, starlink, planet)")
    parser.add_argument("--force-refresh", action="store_true", help="Force live refresh (still respects 10-min cooldown)")
    args = parser.parse_args()

    records, prov = ingest_celestrak_group(group=args.group, force_refresh=args.force_refresh)
    satrecs, valid_meta, init_failures = build_satrecs_from_omm(records)
    prop = propagate_catalog_at_epochs(satrecs, valid_meta, [datetime.now(timezone.utc)])

    summary = {
        "provenance": provenance_to_dict(prov),
        "sgp4_initialized": len(satrecs),
        "sgp4_init_failures": len(init_failures),
        "actual_propagated": prop["actual_propagated"],
        "propagation_failed": prop["failed_count"],
        "error_code_histogram": prop["error_code_histogram"],
        "sgp4_cpp_accelerated": prop["sgp4_cpp_accelerated"],
        "wall_time_ms": prop["wall_time_ms"],
        "throughput_states_per_sec": prop["throughput_states_per_sec"],
    }
    print(json.dumps(summary, indent=2))
    if prov.status == "DATA_NOT_RETRIEVED":
        sys.exit(2)


if __name__ == "__main__":
    main()
