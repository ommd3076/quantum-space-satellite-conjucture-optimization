"""FastAPI Scientific Computation Service for Constellation Lab.

Exposes strictly separated REAL_CATALOG (CelesTrak/Space-Track GP/OMM + C++ SGP4)
and SYNTHETIC_50K (50,000 uniquely initialized hypothetical spacecraft) modes,
impulsive delta-v maneuvers, bisection-refined access windows, broad/narrow proximity
screening, Google OR-Tools CP-SAT + baseline scheduling, independent validation,
and asynchronous benchmark jobs.
"""
from __future__ import annotations

import base64
import json
import os
import platform
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Literal, Optional, Tuple

import numpy as np
import ortools
import psutil
import pyarrow
import scipy
import sgp4
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sgp4.api import Satrec, accelerated

from app.access.geometry import (
    VERIFIED_GROUND_STATIONS,
    compute_refined_access_windows_for_subset,
    generate_synthetic_eo_targets,
)
from app.catalogs.celestrak import (
    ALLOWED_CELESTRAK_GROUPS,
    CatalogProvenance,
    ingest_celestrak_group,
    ingest_spacetrack_gp,
    provenance_to_dict,
)
from app.config import ARTIFACTS_DIR, EXPERIMENTS_RESULTS_DIR, FRAME_FIDELITY_NOTE
from app.jobs.manager import JobManager
from app.maneuvers.impulsive import ImpulsiveBurnSpec, simulate_impulsive_maneuvers
from app.optimization.solvers import run_scheduling_benchmark_suite
from app.propagation.sgp4_engine import (
    build_satrecs_from_omm,
    ecef_km_to_threejs_float32,
    propagate_catalog_at_epochs,
    propagate_single_catalog_object_track,
)
from app.propagation.synthetic_50k import (
    SyntheticConstellationCatalog,
    coe_to_eci_si_vectorized,
    estimate_memory_plan,
    inspect_synthetic_object,
    propagate_synthetic_single_epoch,
    run_50k_chunked_benchmark,
)
from app.screening.conjunction import screen_proximity_epoch
from app.validation.verifier import run_full_validation_suite

app = FastAPI(
    title="Constellation Lab — Python/C++ Scientific Service",
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class _ServiceState:
    def __init__(self) -> None:
        self.synthetic_catalog = SyntheticConstellationCatalog(seed=20261123)
        self.jobs = JobManager()
        # Cached REAL_CATALOG state per group
        self.real_group: Optional[str] = None
        self.real_provenance: Optional[CatalogProvenance] = None
        self.real_records: List[Dict[str, Any]] = []
        self.real_satrecs: List[Satrec] = []
        self.real_init_failures: List[Dict[str, Any]] = []
        self.real_id_to_index: Dict[str, int] = {}
        self.last_validation: Optional[Dict[str, Any]] = None
        self.last_50k_bench: Optional[Dict[str, Any]] = None

    def ensure_real_catalog_loaded(self, group: str = "active", force_refresh: bool = False) -> Dict[str, Any]:
        if not force_refresh and self.real_group == group and self.real_provenance is not None:
            return self.real_summary()

        recs, prov = ingest_celestrak_group(group=group, force_refresh=force_refresh)
        satrecs, valid_meta, init_failures = build_satrecs_from_omm(recs)
        self.real_group = group
        self.real_provenance = prov
        self.real_records = valid_meta
        self.real_satrecs = satrecs
        self.real_init_failures = init_failures
        self.real_id_to_index = {
            str(r["NORAD_CAT_ID"]): i for i, r in enumerate(valid_meta)
        }
        return self.real_summary()

    def real_summary(self) -> Dict[str, Any]:
        if self.real_provenance is None:
            return {
                "mode": "REAL_CATALOG",
                "status": "NOT_INGESTED_YET",
                "actual_ingested_raw": 0,
                "deduplicated_count": 0,
                "sgp4_initialized_count": 0,
                "sgp4_init_failed_count": 0,
                "classification_counts": {"PAYLOAD": 0, "ROCKET_BODY": 0, "DEBRIS": 0, "UNKNOWN": 0},
            }
        d = provenance_to_dict(self.real_provenance)
        d["mode"] = "REAL_CATALOG"
        d["sgp4_initialized_count"] = len(self.real_satrecs)
        d["sgp4_init_failed_count"] = len(self.real_init_failures)
        d["sgp4_init_failures_sample"] = self.real_init_failures[:15]
        d["sgp4_cpp_accelerated"] = bool(accelerated)
        d["frame_note"] = FRAME_FIDELITY_NOTE
        return d


STATE = _ServiceState()


# --- Request Models ---

class CatalogIngestRequest(BaseModel):
    provider: Literal["celestrak", "spacetrack"] = "celestrak"
    group: str = "active"
    force_refresh: bool = False
    spacetrack_limit: int = Field(default=5000, ge=1, le=25000)


class BurnSpecIn(BaseModel):
    t_burn_sec: float = Field(ge=0.0, le=86400.0)
    frame: Literal["RTN", "ECI"] = "RTN"
    dv_m_s: Tuple[float, float, float]
    label: str = "Impulsive Burn"


class ManeuverRequest(BaseModel):
    sat_id: str
    burns: List[BurnSpecIn] = Field(min_length=1, max_length=6)
    horizon_sec: float = Field(default=10800.0, ge=600.0, le=86400.0)
    sample_step_sec: float = Field(default=60.0, ge=10.0, le=300.0)
    wet_mass_kg: float = Field(default=250.0, gt=1.0, le=20000.0)
    dry_mass_kg: float = Field(default=220.0, gt=0.5, le=19999.0)
    isp_s: float = Field(default=220.0, gt=20.0, le=5000.0)


class Bench50kRequest(BaseModel):
    horizon_sec: float = Field(default=86400.0, ge=600.0, le=86400.0)
    step_sec: float = Field(default=300.0, ge=60.0, le=1800.0)
    chunk_size: int = Field(default=5000, ge=500, le=25000)
    fidelity: Literal["j2_secular_kepler", "j2_rk4_numerical"] = "j2_secular_kepler"
    write_parquet: bool = True


class ScreeningRequest(BaseModel):
    mode: Literal["REAL_CATALOG", "SYNTHETIC_50K"] = "SYNTHETIC_50K"
    t_offset_sec: float = Field(default=0.0, ge=-86400.0, le=86400.0)
    threshold_km: float = Field(default=5.0, gt=0.1, le=200.0)
    narrow_window_sec: float = Field(default=30.0, ge=1.0, le=300.0)


class OptimizationRequest(BaseModel):
    controllable_sat_count: int = Field(default=24, ge=4, le=96)
    target_count: int = Field(default=30, ge=6, le=60)
    horizon_sec: float = Field(default=21600.0, ge=3600.0, le=43200.0)
    coarse_step_sec: float = Field(default=30.0, ge=10.0, le=120.0)
    max_off_nadir_deg: float = Field(default=30.0, ge=10.0, le=55.0)
    cpsat_time_limit_sec: float = Field(default=2.0, ge=0.2, le=15.0)
    seed: int = 20261123


# --- Endpoints ---

@app.get("/health")
def health() -> Dict[str, Any]:
    proc = psutil.Process(os.getpid())
    return {
        "status": "CONNECTED",
        "service": "constellation-lab-python-science",
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "python_version": platform.python_version(),
        "packages": {
            "numpy": np.__version__,
            "scipy": scipy.__version__,
            "sgp4": sgp4.__version__,
            "sgp4_cpp_accelerated": bool(accelerated),
            "pyarrow": pyarrow.__version__,
            "ortools": ortools.__version__,
        },
        "hardware": {
            "cpu_cores": os.cpu_count(),
            "total_ram_gb": round(psutil.virtual_memory().total / (1024 ** 3), 2),
            "process_rss_mb": round(proc.memory_info().rss / (1024 * 1024), 2),
        },
        "synthetic_50k_ready": STATE.synthetic_catalog.count == 50_000,
        "synthetic_50k_count": STATE.synthetic_catalog.count,
        "real_catalog_loaded": STATE.real_provenance is not None and STATE.real_provenance.status != "DATA_NOT_RETRIEVED",
        "real_catalog_group": STATE.real_group,
        "real_catalog_count": len(STATE.real_satrecs),
        "frame_note": FRAME_FIDELITY_NOTE,
    }


@app.get("/catalog/groups")
def list_catalog_groups() -> Dict[str, Any]:
    return {"groups": ALLOWED_CELESTRAK_GROUPS}


@app.post("/catalog/ingest")
def ingest_catalog(req: CatalogIngestRequest) -> Dict[str, Any]:
    if req.provider == "spacetrack":
        recs, prov = ingest_spacetrack_gp(limit=req.spacetrack_limit)
        satrecs, valid_meta, init_failures = build_satrecs_from_omm(recs)
        STATE.real_group = "spacetrack_gp"
        STATE.real_provenance = prov
        STATE.real_records = valid_meta
        STATE.real_satrecs = satrecs
        STATE.real_init_failures = init_failures
        STATE.real_id_to_index = {str(r["NORAD_CAT_ID"]): i for i, r in enumerate(valid_meta)}
        return STATE.real_summary()

    try:
        return STATE.ensure_real_catalog_loaded(group=req.group, force_refresh=req.force_refresh)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/catalog/summary")
def catalog_summary() -> Dict[str, Any]:
    return STATE.real_summary()


@app.get("/catalog/frame")
def catalog_frame(
    group: str = Query(default="active"),
    t_offset_sec: float = Query(default=0.0, ge=-86400.0, le=86400.0),
    classification: Optional[Literal["ALL", "PAYLOAD", "ROCKET_BODY", "DEBRIS", "UNKNOWN"]] = Query(default="ALL"),
    epoch_utc: Optional[str] = Query(default=None),
) -> Dict[str, Any]:
    """Propagate real catalog objects via C++ SGP4 SatrecArray and return Float32 Three.js frame + exact counts."""
    try:
        STATE.ensure_real_catalog_loaded(group=group, force_refresh=False)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    prov = STATE.real_provenance
    if prov is None or prov.status == "DATA_NOT_RETRIEVED":
        return {
            "mode": "REAL_CATALOG",
            "status": "DATA_NOT_RETRIEVED",
            "provenance": provenance_to_dict(prov) if prov else None,
            "counts": {
                "actual_ingested_raw": 0,
                "actual_propagated": 0,
                "failed": 0,
                "stale_gt_7d": 0,
                "rendered": 0,
            },
            "positions_f32_b64": "",
            "object_ids": [],
            "classifications": [],
        }

    base_dt = (
        datetime.fromisoformat(epoch_utc.replace("Z", "+00:00")).astimezone(timezone.utc)
        if epoch_utc
        else datetime.now(timezone.utc)
    )
    eval_dt = base_dt + timedelta(seconds=float(t_offset_sec))

    # Apply explicit classification filter WITHOUT relabeling debris as payloads
    if classification and classification != "ALL":
        sel_idx = [
            i for i, r in enumerate(STATE.real_records)
            if r.get("OBJECT_CLASSIFICATION") == classification
        ]
    else:
        sel_idx = list(range(len(STATE.real_records)))

    sel_satrecs = [STATE.real_satrecs[i] for i in sel_idx]
    sel_records = [STATE.real_records[i] for i in sel_idx]

    prop = propagate_catalog_at_epochs(sel_satrecs, sel_records, [eval_dt])
    valid_mask = prop["valid_object_mask"]
    r_ecef_valid = prop["r_ecef_km"][valid_mask, 0, :]  # (M, 3)

    three_f32 = ecef_km_to_threejs_float32(r_ecef_valid)
    pos_b64 = base64.b64encode(three_f32.tobytes()).decode("ascii")

    valid_ids = [str(sel_records[i]["NORAD_CAT_ID"]) for i in range(len(sel_records)) if valid_mask[i]]
    valid_names = [str(sel_records[i]["OBJECT_NAME"]) for i in range(len(sel_records)) if valid_mask[i]]
    cls_code_map = {"PAYLOAD": 0, "ROCKET_BODY": 1, "DEBRIS": 2, "UNKNOWN": 3}
    valid_cls_codes = [
        cls_code_map.get(str(sel_records[i].get("OBJECT_CLASSIFICATION", "UNKNOWN")), 3)
        for i in range(len(sel_records))
        if valid_mask[i]
    ]

    return {
        "mode": "REAL_CATALOG",
        "status": prov.status,
        "group": group,
        "classification_filter": classification or "ALL",
        "eval_epoch_utc": eval_dt.isoformat(),
        "t_offset_sec": float(t_offset_sec),
        "propagator": "SGP4/SDP4 (C++ SatrecArray, WGS-72)",
        "sgp4_cpp_accelerated": prop["sgp4_cpp_accelerated"],
        "frame": "TEME -> ECEF -> Three.js Y-up Earth-radii (Float32 display; Float64 server)",
        "frame_note": FRAME_FIDELITY_NOTE,
        "wall_time_ms": prop["wall_time_ms"],
        "throughput_states_per_sec": prop["throughput_states_per_sec"],
        "provenance": provenance_to_dict(prov),
        "counts": {
            "actual_ingested_raw": prov.actual_ingested_raw,
            "deduplicated": prov.deduplicated_count,
            "filtered_eligible": len(sel_records),
            "actual_propagated": prop["actual_propagated"],
            "failed": prop["failed_count"] + len(STATE.real_init_failures),
            "stale_gt_7d": prov.stale_count_gt_7d,
            "rendered": len(valid_ids),
        },
        "error_code_histogram": prop["error_code_histogram"],
        "positions_f32_b64": pos_b64,
        "object_ids": valid_ids,
        "object_names": valid_names,
        "classification_codes": valid_cls_codes,
    }


@app.get("/catalog/object/{norad_cat_id}")
def catalog_object_detail(
    norad_cat_id: str,
    t_offset_sec: float = Query(default=0.0, ge=-86400.0, le=86400.0),
    epoch_utc: Optional[str] = Query(default=None),
) -> Dict[str, Any]:
    if norad_cat_id not in STATE.real_id_to_index:
        raise HTTPException(status_code=404, detail=f"NORAD_CAT_ID '{norad_cat_id}' not in currently loaded catalog.")
    idx = STATE.real_id_to_index[norad_cat_id]
    base_dt = (
        datetime.fromisoformat(epoch_utc.replace("Z", "+00:00")).astimezone(timezone.utc)
        if epoch_utc
        else datetime.now(timezone.utc)
    )
    eval_dt = base_dt + timedelta(seconds=float(t_offset_sec))
    return propagate_single_catalog_object_track(
        STATE.real_satrecs[idx], STATE.real_records[idx], eval_dt
    )


@app.get("/synthetic/summary")
def synthetic_summary() -> Dict[str, Any]:
    summary = STATE.synthetic_catalog.summary()
    summary["memory_plan_24h_5min"] = estimate_memory_plan(STATE.synthetic_catalog.count, 289, 5000)
    summary["memory_plan_24h_1min"] = estimate_memory_plan(STATE.synthetic_catalog.count, 1441, 2500)
    summary["last_benchmark"] = STATE.last_50k_bench
    return summary


@app.get("/synthetic/frame")
def synthetic_frame(
    t_offset_sec: float = Query(default=0.0, ge=-86400.0, le=86400.0),
    fidelity: Literal["j2_secular_kepler", "j2_rk4_numerical"] = Query(default="j2_secular_kepler"),
    shell_filter: Optional[str] = Query(default=None),
) -> Dict[str, Any]:
    """Propagate all 50,000 unique hypothetical spacecraft at t_offset_sec and return binary Float32 frame."""
    t0 = time.perf_counter()
    cat = STATE.synthetic_catalog
    _, _, r_ecef_km = propagate_synthetic_single_epoch(cat, t_offset_sec=t_offset_sec, fidelity=fidelity)

    valid_mask = np.all(np.isfinite(r_ecef_km), axis=1)
    n_valid = int(np.sum(valid_mask))
    n_failed = int(cat.count - n_valid)

    if shell_filter and shell_filter != "ALL":
        shell_id_map = {sh.shell_id: idx for idx, sh in enumerate(cat.shells)}
        if shell_filter not in shell_id_map:
            raise HTTPException(status_code=400, detail=f"Unknown shell_filter '{shell_filter}'")
        render_mask = valid_mask & (cat.shell_indices == shell_id_map[shell_filter])
    else:
        render_mask = valid_mask

    r_render = r_ecef_km[render_mask]
    three_f32 = ecef_km_to_threejs_float32(r_render)
    shell_u8 = cat.shell_indices[render_mask].astype(np.uint8)
    ctrl_u8 = cat.controllable_mask[render_mask].astype(np.uint8)
    render_indices = np.where(render_mask)[0]

    # Send compact base64 binary arrays (50,000 * 12 bytes = 600 KB raw -> ~800 KB b64, parses in <3 ms in browser)
    pos_b64 = base64.b64encode(three_f32.tobytes()).decode("ascii")
    shell_b64 = base64.b64encode(shell_u8.tobytes()).decode("ascii")
    ctrl_b64 = base64.b64encode(ctrl_u8.tobytes()).decode("ascii")

    # Send sample controllable satellite IDs for quick inspector selection
    ctrl_indices = np.where(cat.controllable_mask & render_mask)[0][:120]
    sample_ctrl_ids = [cat.sat_ids[int(i)] for i in ctrl_indices]

    wall_ms = (time.perf_counter() - t0) * 1000.0
    eval_dt = cat.epoch_utc + timedelta(seconds=float(t_offset_sec))

    return {
        "mode": "SYNTHETIC_50K",
        "status": "COMPUTED",
        "provenance": "HYPOTHETICAL_SIMULATED_CONSTELLATION (NOT REAL ACTIVE SATELLITES)",
        "config_hash": cat.config_hash,
        "seed": cat.seed,
        "epoch_utc": cat.epoch_utc.isoformat(),
        "eval_epoch_utc": eval_dt.isoformat(),
        "t_offset_sec": float(t_offset_sec),
        "propagator": (
            "Vectorized J2 Secular + Newton-Raphson Kepler (SI internal)"
            if fidelity == "j2_secular_kepler"
            else "Vectorized Cartesian Two-Body + J2 RK4 (SI internal)"
        ),
        "frame": "ECI(J2000-aligned) -> ECEF(IAU-82 GMST) -> Three.js Y-up Earth-radii (Float32 display)",
        "frame_note": FRAME_FIDELITY_NOTE,
        "wall_time_ms": round(wall_ms, 2),
        "throughput_states_per_sec": round(cat.count / max(wall_ms / 1000.0, 1e-9), 1),
        "counts": {
            "actual_ingested_raw": 0,
            "synthetic_configured": cat.count,
            "synthetic_propagated": n_valid,
            "failed": n_failed,
            "controllable_total": int(np.sum(cat.controllable_mask)),
            "rendered": int(len(render_indices)),
        },
        "positions_f32_b64": pos_b64,
        "shell_u8_b64": shell_b64,
        "controllable_u8_b64": ctrl_b64,
        "sample_controllable_ids": sample_ctrl_ids,
        "shell_filter": shell_filter or "ALL",
    }


@app.get("/synthetic/object/{sat_id}")
def synthetic_object_detail(
    sat_id: str,
    t_offset_sec: float = Query(default=0.0, ge=-86400.0, le=86400.0),
) -> Dict[str, Any]:
    try:
        return inspect_synthetic_object(STATE.synthetic_catalog, sat_id, t_offset_sec=t_offset_sec)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.get("/synthetic/object-by-index/{index}")
def synthetic_object_by_index(
    index: int,
    t_offset_sec: float = Query(default=0.0, ge=-86400.0, le=86400.0),
) -> Dict[str, Any]:
    cat = STATE.synthetic_catalog
    if index < 0 or index >= cat.count:
        raise HTTPException(status_code=404, detail=f"Index {index} out of [0, {cat.count - 1}]")
    return inspect_synthetic_object(cat, cat.sat_ids[index], t_offset_sec=t_offset_sec)


@app.post("/maneuvers/simulate")
def simulate_maneuver_endpoint(req: ManeuverRequest) -> Dict[str, Any]:
    """Execute translational impulsive delta-v maneuver on a CONTROLLABLE synthetic spacecraft."""
    cat = STATE.synthetic_catalog
    if req.sat_id not in cat.id_to_index:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Spacecraft '{req.sat_id}' not found in SYNTHETIC_50K catalog. "
                "Real catalog SGP4 objects cannot be directly maneuver-edited."
            ),
        )
    idx = cat.id_to_index[req.sat_id]
    if not bool(cat.controllable_mask[idx]):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Spacecraft '{req.sat_id}' is designated background traffic (non-controllable). "
                "Select a controllable synthetic spacecraft for orbital maneuvers."
            ),
        )

    r0_m, v0_m_s = coe_to_eci_si_vectorized(
        cat.a_m[idx:idx + 1],
        cat.e[idx:idx + 1],
        cat.inc_rad[idx:idx + 1],
        cat.raan0_rad[idx:idx + 1],
        cat.argp0_rad[idx:idx + 1],
        cat.m0_rad[idx:idx + 1],
    )
    burns = [
        ImpulsiveBurnSpec(
            t_burn_sec=b.t_burn_sec,
            frame=b.frame,
            dv_m_s=b.dv_m_s,
            label=b.label,
        )
        for b in req.burns
    ]
    try:
        return simulate_impulsive_maneuvers(
            sat_id=req.sat_id,
            r0_eci_m=r0_m[0],
            v0_eci_m_s=v0_m_s[0],
            epoch_utc=cat.epoch_utc,
            burns=burns,
            horizon_sec=req.horizon_sec,
            sample_step_sec=req.sample_step_sec,
            wet_mass_kg=req.wet_mass_kg,
            dry_mass_kg=req.dry_mass_kg,
            isp_s=req.isp_s,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/screening/run")
def run_screening(req: ScreeningRequest) -> Dict[str, Any]:
    if req.mode == "REAL_CATALOG":
        if not STATE.real_satrecs:
            STATE.ensure_real_catalog_loaded("active", force_refresh=False)
        if not STATE.real_satrecs:
            raise HTTPException(status_code=503, detail="REAL_CATALOG data not retrieved; cannot run screening.")
        eval_dt = datetime.now(timezone.utc) + timedelta(seconds=req.t_offset_sec)
        prop = propagate_catalog_at_epochs(STATE.real_satrecs, STATE.real_records, [eval_dt])
        ids = [f"{r['NORAD_CAT_ID']} ({r['OBJECT_NAME']})" for r in STATE.real_records]
        res = screen_proximity_epoch(
            ids,
            prop["r_teme_km"][:, 0, :],
            prop["v_teme_km_s"][:, 0, :],
            threshold_km=req.threshold_km,
            narrow_window_sec=req.narrow_window_sec,
        )
        res["mode"] = "REAL_CATALOG"
        res["frame"] = "TEME (km, km/s)"
        return res

    cat = STATE.synthetic_catalog
    r_eci_km, v_eci_km_s, _ = propagate_synthetic_single_epoch(cat, t_offset_sec=req.t_offset_sec)
    res = screen_proximity_epoch(
        cat.sat_ids,
        r_eci_km,
        v_eci_km_s,
        threshold_km=req.threshold_km,
        narrow_window_sec=req.narrow_window_sec,
    )
    res["mode"] = "SYNTHETIC_50K"
    res["frame"] = "ECI J2000-aligned (km, km/s)"
    return res


@app.post("/optimization/solve")
def solve_optimization(req: OptimizationRequest) -> Dict[str, Any]:
    """Compute bisection-refined access windows on a controllable subset and run OR-Tools CP-SAT + baselines."""
    cat = STATE.synthetic_catalog
    ctrl_indices = np.where(cat.controllable_mask)[0]
    chosen = [int(i) for i in ctrl_indices[: req.controllable_sat_count]]
    targets = generate_synthetic_eo_targets(
        count=req.target_count, seed=req.seed, horizon_sec=req.horizon_sec
    )
    access_bundle = compute_refined_access_windows_for_subset(
        catalog=cat,
        sat_indices=chosen,
        targets=targets,
        stations=VERIFIED_GROUND_STATIONS,
        horizon_sec=req.horizon_sec,
        coarse_step_sec=req.coarse_step_sec,
        max_off_nadir_deg=req.max_off_nadir_deg,
        seed=req.seed,
    )
    opt_report = run_scheduling_benchmark_suite(
        access_bundle=access_bundle,
        time_limit_sec=req.cpsat_time_limit_sec,
        seed=req.seed,
        save_artifact=True,
    )
    return {
        "access_summary": {
            "sat_count_analyzed": access_bundle["sat_count_analyzed"],
            "target_count": access_bundle["target_count"],
            "station_count": access_bundle["station_count"],
            "horizon_sec": access_bundle["horizon_sec"],
            "horizon_refinement": access_bundle["horizon_refinement"],
            "observation_windows_count": len(access_bundle["observation_windows"]),
            "downlink_windows_count": len(access_bundle["downlink_windows"]),
        },
        "ground_stations": VERIFIED_GROUND_STATIONS,
        "optimization": opt_report,
    }


@app.get("/validation/run")
def run_validation() -> Dict[str, Any]:
    report = run_full_validation_suite(STATE.synthetic_catalog)
    STATE.last_validation = report
    return report


@app.post("/jobs/bench50k")
def submit_bench50k_job(req: Bench50kRequest) -> Dict[str, Any]:
    def _task(progress_cb, cancel_check) -> Dict[str, Any]:
        report = run_50k_chunked_benchmark(
            catalog=STATE.synthetic_catalog,
            horizon_sec=req.horizon_sec,
            step_sec=req.step_sec,
            chunk_size=req.chunk_size,
            fidelity=req.fidelity,
            write_parquet=req.write_parquet,
            progress_cb=progress_cb,
            cancel_check=cancel_check,
        )
        STATE.last_50k_bench = report
        return report

    return STATE.jobs.submit("BENCH_50K_PROPAGATION", req.model_dump(), _task)


@app.get("/jobs")
def list_jobs() -> Dict[str, Any]:
    return {"jobs": STATE.jobs.list_jobs()}


@app.get("/jobs/{job_id}")
def get_job(job_id: str) -> Dict[str, Any]:
    job = STATE.jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found.")
    return job


@app.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> Dict[str, Any]:
    job = STATE.jobs.cancel(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found.")
    return job


@app.get("/artifacts")
def list_artifacts() -> Dict[str, Any]:
    art_files = []
    for base_dir, kind in ((ARTIFACTS_DIR, "propagation_artifact"), (EXPERIMENTS_RESULTS_DIR, "experiment_result")):
        if base_dir.exists():
            for p in sorted(base_dir.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
                if p.is_file():
                    art_files.append({
                        "name": p.name,
                        "kind": kind,
                        "size_bytes": p.stat().st_size,
                        "modified_utc": datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc).isoformat(),
                    })
    return {"artifacts": art_files[:50]}
