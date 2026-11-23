"""C++-accelerated SGP4/SDP4 batch propagation engine for REAL_CATALOG GP/OMM records.

Preserves SGP4 mean-element semantics, TEME output frame, and WGS-72 gravity model.
Reports EVERY propagator return/error code explicitly — never drops failed objects silently.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from sgp4 import omm
from sgp4.api import SGP4_ERRORS, Satrec, SatrecArray, accelerated

from app.config import FRAME_FIDELITY_NOTE, R_EARTH_EQ_KM
from app.frames.transforms import (
    datetime_to_jd_fr,
    ecef_to_geodetic_batch,
    eci_to_ecef_batch,
    jd_array_to_gmst_rad,
)


def build_satrecs_from_omm(
    records: List[Dict[str, Any]],
) -> Tuple[List[Satrec], List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Initialize sgp4 Satrec objects from OMM CSV dicts, recording every parse error."""
    satrecs: List[Satrec] = []
    valid_meta: List[Dict[str, Any]] = []
    init_failures: List[Dict[str, Any]] = []

    for rec in records:
        try:
            sat = Satrec()
            omm.initialize(sat, rec)
            if sat.error != 0:
                init_failures.append({
                    "norad_cat_id": rec.get("NORAD_CAT_ID"),
                    "object_name": rec.get("OBJECT_NAME"),
                    "error_code": int(sat.error),
                    "error_message": SGP4_ERRORS.get(int(sat.error), f"SGP4 init error {sat.error}"),
                })
                continue
            satrecs.append(sat)
            valid_meta.append(rec)
        except Exception as exc:
            init_failures.append({
                "norad_cat_id": rec.get("NORAD_CAT_ID"),
                "object_name": rec.get("OBJECT_NAME"),
                "error_code": -1,
                "error_message": str(exc),
            })

    return satrecs, valid_meta, init_failures


def propagate_catalog_at_epochs(
    satrecs: List[Satrec],
    records: List[Dict[str, Any]],
    epochs_utc: List[datetime],
) -> Dict[str, Any]:
    """Batch-propagate all SGP4 objects at given UTC epochs via C++ SatrecArray.

    Returns
    -------
    dict with:
      - r_teme_km: ndarray (N, T, 3) float64
      - v_teme_km_s: ndarray (N, T, 3) float64
      - r_ecef_km: ndarray (N, T, 3) float64
      - error_codes: ndarray (N, T) int32
      - error_code_histogram: dict[int, int]
      - valid_object_mask: ndarray (N,) bool (all epochs error == 0 & finite)
      - actual_propagated: int
      - failed_count: int
      - wall_time_ms: float
      - throughput_states_per_sec: float
      - sgp4_cpp_accelerated: bool
    """
    t0 = time.perf_counter()
    n_obj = len(satrecs)
    n_t = len(epochs_utc)

    if n_obj == 0 or n_t == 0:
        return {
            "r_teme_km": np.zeros((0, n_t, 3), dtype=np.float64),
            "v_teme_km_s": np.zeros((0, n_t, 3), dtype=np.float64),
            "r_ecef_km": np.zeros((0, n_t, 3), dtype=np.float64),
            "error_codes": np.zeros((0, n_t), dtype=np.int32),
            "error_code_histogram": {},
            "valid_object_mask": np.zeros((0,), dtype=bool),
            "actual_propagated": 0,
            "failed_count": 0,
            "wall_time_ms": 0.0,
            "throughput_states_per_sec": 0.0,
            "sgp4_cpp_accelerated": bool(accelerated),
            "frame_note": FRAME_FIDELITY_NOTE,
        }

    jd_arr = np.empty(n_t, dtype=np.float64)
    fr_arr = np.empty(n_t, dtype=np.float64)
    for idx, dt in enumerate(epochs_utc):
        jd_arr[idx], fr_arr[idx] = datetime_to_jd_fr(dt)

    sat_array = SatrecArray(satrecs)
    e_codes, r_teme, v_teme = sat_array.sgp4(jd_arr, fr_arr)
    # Shapes: e_codes (N, T), r_teme (N, T, 3), v_teme (N, T, 3)

    # Convert TEME -> ECEF via IAU-82 GMST (simplified EOP, explicitly documented)
    gmst_rad = jd_array_to_gmst_rad(jd_arr + fr_arr)  # (T,)
    r_ecef = eci_to_ecef_batch(r_teme, gmst_rad[np.newaxis, :])

    # Validate finite values and error == 0
    finite_mask = np.all(np.isfinite(r_teme), axis=-1) & np.all(np.isfinite(v_teme), axis=-1)
    ok_sample_mask = (e_codes == 0) & finite_mask
    valid_obj_mask = np.all(ok_sample_mask, axis=1)

    # Error code histogram across all object-time samples
    uniq_codes, counts = np.unique(e_codes, return_counts=True)
    histogram = {int(c): int(cnt) for c, cnt in zip(uniq_codes, counts)}

    wall_ms = (time.perf_counter() - t0) * 1000.0
    total_samples = n_obj * n_t
    throughput = total_samples / max(wall_ms / 1000.0, 1e-9)

    return {
        "r_teme_km": r_teme,
        "v_teme_km_s": v_teme,
        "r_ecef_km": r_ecef,
        "error_codes": e_codes,
        "error_code_histogram": histogram,
        "valid_object_mask": valid_obj_mask,
        "actual_propagated": int(np.sum(valid_obj_mask)),
        "failed_count": int(n_obj - np.sum(valid_obj_mask)),
        "wall_time_ms": round(wall_ms, 3),
        "throughput_states_per_sec": round(throughput, 1),
        "sgp4_cpp_accelerated": bool(accelerated),
        "frame_note": FRAME_FIDELITY_NOTE,
    }


def ecef_km_to_threejs_float32(r_ecef_km: np.ndarray) -> np.ndarray:
    """Convert ECEF (km) shape (N, 3) -> Three.js right-handed Y-up Earth-radii Float32 (N, 3).

    Mapping matches existing frontend EarthGlobe3D.tsx:
      Three.X = ECEF.X / R_EARTH_EQ_KM
      Three.Y = ECEF.Z / R_EARTH_EQ_KM   (North pole +Y)
      Three.Z = -ECEF.Y / R_EARTH_EQ_KM  (Right-handed 90 deg E -> -Z)
    """
    out = np.empty((r_ecef_km.shape[0], 3), dtype=np.float32)
    inv_r = np.float32(1.0 / R_EARTH_EQ_KM)
    out[:, 0] = r_ecef_km[:, 0].astype(np.float32) * inv_r
    out[:, 1] = r_ecef_km[:, 2].astype(np.float32) * inv_r
    out[:, 2] = -r_ecef_km[:, 1].astype(np.float32) * inv_r
    return out


def propagate_single_catalog_object_track(
    sat: Satrec,
    rec: Dict[str, Any],
    epoch_utc: datetime,
    num_points: int = 96,
) -> Dict[str, Any]:
    """Compute one full orbital period trajectory + current state for an inspected real object."""
    mean_motion_rev_day = float(rec.get("MEAN_MOTION", "15.0"))
    period_sec = 86400.0 / max(mean_motion_rev_day, 0.05)
    period_sec = min(period_sec, 86400.0)  # Cap track visualization to 1 day for GEO/HEO

    offsets_sec = np.linspace(0.0, period_sec, num_points, dtype=np.float64)
    jd0, fr0 = datetime_to_jd_fr(epoch_utc)
    jd_arr = np.full(num_points, jd0, dtype=np.float64)
    fr_arr = fr0 + offsets_sec / 86400.0

    sat_arr = SatrecArray([sat])
    e_codes, r_teme, v_teme = sat_arr.sgp4(jd_arr, fr_arr)
    e_codes = e_codes[0]
    r_teme = r_teme[0]
    v_teme = v_teme[0]

    gmst_rad = jd_array_to_gmst_rad(jd_arr + fr_arr)
    r_ecef = eci_to_ecef_batch(r_teme, gmst_rad)
    lat_deg, lon_deg, alt_km = ecef_to_geodetic_batch(r_ecef)

    err0 = int(e_codes[0])
    r0 = r_teme[0]
    v0 = v_teme[0]
    speed_km_s = float(np.linalg.norm(v0)) if err0 == 0 else None

    track_three = ecef_km_to_threejs_float32(r_ecef).tolist()

    return {
        "mode": "REAL_CATALOG",
        "norad_cat_id": rec.get("NORAD_CAT_ID"),
        "object_name": rec.get("OBJECT_NAME"),
        "object_id": rec.get("OBJECT_ID"),
        "classification": rec.get("OBJECT_CLASSIFICATION"),
        "source_provider": rec.get("PROVENANCE_SOURCE"),
        "source_url": rec.get("PROVENANCE_URL"),
        "element_epoch_utc": rec.get("EPOCH"),
        "element_age_hours": rec.get("ELEMENT_AGE_HOURS"),
        "is_stale_gt_7d": rec.get("IS_STALE_GT_7D"),
        "propagator": "SGP4/SDP4 (C++ SatrecArray, WGS-72)",
        "frame": "TEME -> ECEF (IAU-82 GMST simplified EOP)",
        "sgp4_error_code": err0,
        "sgp4_error_message": "OK" if err0 == 0 else SGP4_ERRORS.get(err0, f"Error {err0}"),
        "eval_epoch_utc": epoch_utc.isoformat(),
        "orbital_period_sec": round(period_sec, 2),
        "omm_elements": {
            "mean_motion_rev_day": float(rec["MEAN_MOTION"]),
            "eccentricity": float(rec["ECCENTRICITY"]),
            "inclination_deg": float(rec["INCLINATION"]),
            "ra_of_asc_node_deg": float(rec["RA_OF_ASC_NODE"]),
            "arg_of_pericenter_deg": float(rec["ARG_OF_PERICENTER"]),
            "mean_anomaly_deg": float(rec["MEAN_ANOMALY"]),
            "bstar": float(rec["BSTAR"]),
        },
        "state": {
            "r_teme_km": [round(float(x), 4) for x in r0] if err0 == 0 else None,
            "v_teme_km_s": [round(float(x), 6) for x in v0] if err0 == 0 else None,
            "r_ecef_km": [round(float(x), 4) for x in r_ecef[0]] if err0 == 0 else None,
            "lat_deg": round(float(lat_deg[0]), 4) if err0 == 0 else None,
            "lon_deg": round(float(lon_deg[0]), 4) if err0 == 0 else None,
            "alt_km": round(float(alt_km[0]), 3) if err0 == 0 else None,
            "speed_km_s": round(speed_km_s, 5) if speed_km_s is not None else None,
        },
        "track_threejs": track_three,
        "maneuver_note": (
            "Real catalog objects are uncontrolled observational records; "
            "SGP4 TLE/OMM records are never edited directly."
        ),
    }
