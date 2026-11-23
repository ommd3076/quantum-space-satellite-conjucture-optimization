#!/usr/bin/env python3
"""Headless CLI: Run independent orbital validation checks (Vallado SGP4, DOP853 cross-check, Maneuver, 50k)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.propagation.synthetic_50k import SyntheticConstellationCatalog
from app.validation.verifier import run_full_validation_suite


def main() -> None:
    cat = SyntheticConstellationCatalog(seed=20261123)
    report = run_full_validation_suite(cat)
    print(json.dumps(report, indent=2))
    if report["executed_checks_passed"] != report["executed_checks_count"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
