"""Comprehensive pytest suite covering Milestones 1-5 of Constellation Lab Python/C++ backend."""
from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.access.geometry import (
    VERIFIED_GROUND_STATIONS,
    compute_refined_access_windows_for_subset,
    generate_synthetic_eo_targets,
)
from app.api.main import app
from app.catalogs.celestrak import parse_gp_csv_snapshot
from app.maneuvers.impulsive import ImpulsiveBurnSpec, simulate_impulsive_maneuvers
from app.optimization.solvers import (
    DEFAULT_RESOURCE_CONFIG,
    run_scheduling_benchmark_suite,
    verify_schedule_independently,
)
from app.propagation.sgp4_engine import build_satrecs_from_omm, propagate_catalog_at_epochs
from app.propagation.synthetic_50k import (
    SyntheticConstellationCatalog,
    coe_to_eci_si_vectorized,
    propagate_synthetic_single_epoch,
)
from app.screening.conjunction import screen_proximity_epoch
from app.validation.verifier import (
    check_maneuver_vis_viva_and_tsiolkovsky,
    check_rk4_vs_scipy_dop853,
    check_synthetic_50k_uniqueness_and_invariants,
    check_vallado_sgp4_reference,
)


def test_vallado_2006_sgp4_independent_reference():
    res = check_vallado_sgp4_reference()
    assert res["passed"] is True, res
    assert res["sgp4_cpp_accelerated"] is True
    assert res["metrics"]["position_error_m"] < 1.0


def test_cross_propagator_rk4_vs_scipy_dop853():
    res = check_rk4_vs_scipy_dop853()
    assert res["passed"] is True, res
    assert res["metrics"]["rk4_vs_dop853_max_pos_error_m"] < 1.0


def test_impulsive_maneuver_vis_viva_and_tsiolkovsky():
    res = check_maneuver_vis_viva_and_tsiolkovsky()
    assert res["passed"] is True, res
    assert res["metrics"]["vis_viva_a_error_m"] < 0.5
    assert res["metrics"]["tsiolkovsky_propellant_error_g"] < 0.5


def test_maneuver_rejects_excess_propellant_burn():
    r0 = np.array([6_928_137.0, 0.0, 0.0])
    v0 = np.array([0.0, 7585.0, 0.0])
    with pytest.raises(ValueError, match="exceeding remaining propellant"):
        simulate_impulsive_maneuvers(
            sat_id="SYN-TEST",
            r0_eci_m=r0,
            v0_eci_m_s=v0,
            epoch_utc=datetime(2026, 11, 23, 0, 0, 0, tzinfo=timezone.utc),
            burns=[ImpulsiveBurnSpec(t_burn_sec=60.0, frame="RTN", dv_m_s=(0.0, 5000.0, 0.0))],
            wet_mass_kg=250.0,
            dry_mass_kg=240.0,
            isp_s=220.0,
        )


def test_omm_csv_deduplication_and_six_digit_id_support():
    sample_csv = (
        "OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,"
        "ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,CLASSIFICATION_TYPE,NORAD_CAT_ID,"
        "ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT\n"
        "ISS (ZARYA),1998-067A,2026-11-22T12:00:00.000000,15.50123456,0.0005123,51.6412,120.1,45.2,10.0,0,U,25544,999,45000,0.00012,0.00001,0\n"
        "ISS (ZARYA),1998-067A,2026-11-22T18:00:00.000000,15.50123456,0.0005123,51.6412,120.1,45.2,15.0,0,U,25544,999,45004,0.00012,0.00001,0\n"
        "COSMOS 1408 DEB,1982-092AA,2026-11-01T00:00:00.000000,15.20000000,0.0021000,82.5600,10.0,20.0,30.0,0,U,123456,999,12000,0.00020,0.00002,0\n"
    )
    recs, prov = parse_gp_csv_snapshot(
        sample_csv,
        group="unit_test",
        source_provider="UnitTest",
        source_url="https://example.invalid",
        retrieved_at_utc="2026-11-23T00:00:00+00:00",
        snapshot_file="test.csv",
        status="RETRIEVED_LIVE",
        reference_now_utc=datetime(2026, 11, 23, 0, 0, 0, tzinfo=timezone.utc),
    )
    assert prov.actual_ingested_raw == 3
    assert prov.deduplicated_count == 2
    assert prov.duplicate_records_removed == 1
    assert prov.classification_counts["PAYLOAD"] == 1
    assert prov.classification_counts["DEBRIS"] == 1
    assert prov.stale_count_gt_7d == 1
    assert any(r["NORAD_CAT_ID"] == "123456" for r in recs)

    satrecs, valid_meta, fails = build_satrecs_from_omm(recs)
    assert len(fails) == 0
    prop = propagate_catalog_at_epochs(satrecs, valid_meta, [datetime(2026, 11, 23, 0, 0, 0, tzinfo=timezone.utc)])
    assert prop["actual_propagated"] == 2
    assert prop["failed_count"] == 0


def test_synthetic_50k_uniqueness_and_proximity_screening():
    cat = SyntheticConstellationCatalog(seed=20261123)
    check = check_synthetic_50k_uniqueness_and_invariants(cat)
    assert check["passed"] is True

    r_eci_km, v_eci_km_s, r_ecef_km = propagate_synthetic_single_epoch(cat, t_offset_sec=300.0)
    assert r_eci_km.shape == (50_000, 3)
    assert np.all(np.isfinite(r_ecef_km))

    scr = screen_proximity_epoch(cat.sat_ids, r_eci_km, v_eci_km_s, threshold_km=5.0)
    assert scr["objects_screened"] == 50_000
    assert scr["naive_all_pairs_avoided"] == 50_000 * 49_999 // 2
    assert "DETERMINISTIC_GEOMETRIC_SCREENING_ONLY" in scr["disclaimer"]


def test_refined_access_ortools_cpsat_and_independent_verifier():
    cat = SyntheticConstellationCatalog(seed=20261123)
    ctrl_idx = [int(i) for i in np.where(cat.controllable_mask)[0][:12]]
    targets = generate_synthetic_eo_targets(18, seed=20261123, horizon_sec=14400.0)
    access = compute_refined_access_windows_for_subset(
        cat, ctrl_idx, targets, VERIFIED_GROUND_STATIONS, horizon_sec=14400.0, coarse_step_sec=30.0
    )
    assert len(access["observation_windows"]) > 0
    assert len(access["downlink_windows"]) > 0

    report = run_scheduling_benchmark_suite(access, time_limit_sec=2.0, seed=20261123, save_artifact=False)
    assert len(report["results"]) == 5
    cpsat = next(r for r in report["results"] if r["algorithm_id"] == "ortools_cpsat")
    assert cpsat["solver_status"] in ("OPTIMAL", "FEASIBLE")
    for r in report["results"]:
        assert r["verification"]["verified_feasible"] is True, r["verification"]["violations"]
        assert r["verification"]["violation_count"] == 0

    # Inject a deliberate violation to prove independent verifier catches it
    tampered = list(cpsat["scheduled_observations"])
    if tampered:
        bad = dict(tampered[0])
        bad["start_sec"] -= 500.0
        bad["end_sec"] += 500.0
        tampered[0] = bad
        check_bad = verify_schedule_independently(
            access["observation_windows"],
            access["downlink_windows"],
            tampered,
            cpsat["scheduled_downlinks"],
            DEFAULT_RESOURCE_CONFIG,
        )
        assert check_bad["verified_feasible"] is False
        assert check_bad["violation_count"] > 0


def test_fastapi_endpoints_smoke():
    client = TestClient(app)
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "CONNECTED"
    assert body["packages"]["sgp4_cpp_accelerated"] is True
    assert body["synthetic_50k_count"] == 50_000

    sf = client.get("/synthetic/frame?t_offset_sec=0")
    assert sf.status_code == 200
    sfb = sf.json()
    assert sfb["counts"]["synthetic_propagated"] == 50_000
    assert sfb["counts"]["rendered"] == 50_000
    assert len(sfb["positions_f32_b64"]) > 100_000
