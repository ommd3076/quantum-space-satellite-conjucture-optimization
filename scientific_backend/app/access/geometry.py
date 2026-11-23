"""Ellipsoidal access-window computation with bisection horizon-crossing refinement.

Computes satellite-to-ground station contacts and satellite-to-target observation windows
using WGS84 geodetic coordinates and off-nadir sensor FOV limits, refining rise/set crossings
to < 0.25 s precision rather than accepting coarse grid step endpoints.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Callable, Dict, List, Tuple

import numpy as np

from app.config import R_EARTH_EQ_M
from app.frames.transforms import (
    compute_site_visibility_batch,
    datetime_to_jd_fr,
    eci_to_ecef_batch,
    jd_array_to_gmst_rad,
)
from app.propagation.synthetic_50k import (
    SyntheticConstellationCatalog,
    propagate_j2_secular_chunk,
)

# Real public ground-station coordinates (VERIFIED_SOURCE: public agency station coordinates;
# downlink rate & outage rates are explicitly labeled SYNTHETIC_ASSUMPTION).
VERIFIED_GROUND_STATIONS: List[Dict[str, Any]] = [
    {
        "id": "GS-SVALBARD",
        "name": "Svalbard Satellite Station (SvalSat)",
        "lat_deg": 78.2298,
        "lon_deg": 15.4078,
        "alt_km": 0.458,
        "min_elevation_deg": 5.0,
        "downlink_rate_gbps": 0.8,
        "coord_provenance": "VERIFIED_SOURCE (KSAT SvalSat published site coordinates)",
        "link_provenance": "SYNTHETIC_ASSUMPTION (nominal X-band 800 Mbps)",
    },
    {
        "id": "GS-TROLL",
        "name": "Troll Satellite Station (Antarctica)",
        "lat_deg": -72.0117,
        "lon_deg": 2.5350,
        "alt_km": 1.275,
        "min_elevation_deg": 5.0,
        "downlink_rate_gbps": 0.8,
        "coord_provenance": "VERIFIED_SOURCE (KSAT TrollSat published site coordinates)",
        "link_provenance": "SYNTHETIC_ASSUMPTION (nominal X-band 800 Mbps)",
    },
    {
        "id": "GS-KIRUNA",
        "name": "ESA Kiruna Station (Sweden)",
        "lat_deg": 67.8571,
        "lon_deg": 20.9643,
        "alt_km": 0.402,
        "min_elevation_deg": 5.0,
        "downlink_rate_gbps": 0.6,
        "coord_provenance": "VERIFIED_SOURCE (ESA ESTRACK Kiruna site coordinates)",
        "link_provenance": "SYNTHETIC_ASSUMPTION (nominal X-band 600 Mbps)",
    },
    {
        "id": "GS-FAIRBANKS",
        "name": "Fairbanks Gilmore Creek (Alaska)",
        "lat_deg": 64.9780,
        "lon_deg": -147.5000,
        "alt_km": 0.340,
        "min_elevation_deg": 5.0,
        "downlink_rate_gbps": 0.6,
        "coord_provenance": "VERIFIED_SOURCE (NOAA/NASA Fairbanks station coordinates)",
        "link_provenance": "SYNTHETIC_ASSUMPTION (nominal X-band 600 Mbps)",
    },
    {
        "id": "GS-WALLOPS",
        "name": "NASA Wallops Flight Facility",
        "lat_deg": 37.9402,
        "lon_deg": -75.4664,
        "alt_km": 0.012,
        "min_elevation_deg": 7.5,
        "downlink_rate_gbps": 0.6,
        "coord_provenance": "VERIFIED_SOURCE (NASA Wallops published coordinates)",
        "link_provenance": "SYNTHETIC_ASSUMPTION (nominal X-band 600 Mbps)",
    },
    {
        "id": "GS-CANBERRA",
        "name": "Canberra Deep Space Comm. Complex",
        "lat_deg": -35.4014,
        "lon_deg": 148.9817,
        "alt_km": 0.680,
        "min_elevation_deg": 7.5,
        "downlink_rate_gbps": 0.6,
        "coord_provenance": "VERIFIED_SOURCE (NASA/CSIRO CDSCC published coordinates)",
        "link_provenance": "SYNTHETIC_ASSUMPTION (nominal X-band 600 Mbps)",
    },
]


def generate_synthetic_eo_targets(
    count: int = 30,
    seed: int = 20261123,
    horizon_sec: float = 21600.0,
) -> List[Dict[str, Any]]:
    """Generate deterministic hypothetical Earth-observation targets (SYNTHETIC_ASSUMPTION)."""
    rng = np.random.default_rng(seed)
    regions = [
        ("Disaster-Cluster", 35.0, 139.0, 8.0, 9.0, 0.25),
        ("High-Latitude", 64.0, 18.0, 12.0, 6.0, 0.35),
        ("Mid-Latitude", 40.0, -98.0, 14.0, 5.0, 0.20),
        ("Equatorial", 2.0, 22.0, 12.0, 7.0, 0.45),
    ]
    targets: List[Dict[str, Any]] = []
    for i in range(count):
        reg_name, lat_c, lon_c, spread, base_pri, base_cloud = regions[i % len(regions)]
        lat = float(np.clip(lat_c + rng.uniform(-spread, spread), -78.0, 78.0))
        lon = float(((lon_c + rng.uniform(-spread * 1.6, spread * 1.6) + 180.0) % 360.0) - 180.0)
        priority = round(float(base_pri + rng.uniform(-1.5, 2.5)), 2)
        duration_sec = float(rng.choice([25.0, 35.0, 45.0]))
        data_vol_gb = round(float(duration_sec * 0.12), 2)
        deadline_sec = round(float(rng.uniform(0.35, 0.98) * horizon_sec), 1)
        targets.append({
            "id": f"TGT-{i + 1:03d}",
            "name": f"{reg_name} Site {i + 1}",
            "region": reg_name,
            "lat_deg": round(lat, 4),
            "lon_deg": round(lon, 4),
            "priority": priority,
            "required_duration_sec": duration_sec,
            "data_volume_gb": data_vol_gb,
            "deadline_sec": deadline_sec,
            "cloud_prob_synthetic": round(float(np.clip(base_cloud + rng.uniform(-0.1, 0.2), 0.05, 0.85)), 3),
            "provenance": "SYNTHETIC_ASSUMPTION",
        })
    return targets


def _bisect_crossing(
    predicate_fn: Callable[[float], bool],
    t_false: float,
    t_true: float,
    tol_sec: float = 0.25,
) -> float:
    """Refine visibility boundary crossing between t_false and t_true to < tol_sec via bisection."""
    lo, hi = t_false, t_true
    for _ in range(14):
        if abs(hi - lo) <= tol_sec:
            break
        mid = 0.5 * (lo + hi)
        if predicate_fn(mid):
            hi = mid
        else:
            lo = mid
    return hi


def compute_refined_access_windows_for_subset(
    catalog: SyntheticConstellationCatalog,
    sat_indices: List[int],
    targets: List[Dict[str, Any]],
    stations: List[Dict[str, Any]],
    horizon_sec: float = 21600.0,
    coarse_step_sec: float = 30.0,
    max_off_nadir_deg: float = 30.0,
    seed: int = 20261123,
) -> Dict[str, Any]:
    """Compute horizon-refined observation & downlink access windows for a controllable subset."""
    n_sats = len(sat_indices)
    idx_arr = np.array(sat_indices, dtype=np.int64)
    a_m = catalog.a_m[idx_arr]
    e = catalog.e[idx_arr]
    inc = catalog.inc_rad[idx_arr]
    raan0 = catalog.raan0_rad[idx_arr]
    argp0 = catalog.argp0_rad[idx_arr]
    m0 = catalog.m0_rad[idx_arr]

    t_grid = np.arange(0.0, horizon_sec + 1e-6, coarse_step_sec, dtype=np.float64)
    if t_grid[-1] < horizon_sec:
        t_grid = np.append(t_grid, horizon_sec)

    r_eci_m, _ = propagate_j2_secular_chunk(a_m, e, inc, raan0, argp0, m0, t_grid)
    r_eci_km = r_eci_m * 1e-3

    jd0, fr0 = datetime_to_jd_fr(catalog.epoch_utc)
    gmst_arr = jd_array_to_gmst_rad(jd0 + fr0 + t_grid / 86400.0)
    r_ecef_km = eci_to_ecef_batch(r_eci_km, gmst_arr[np.newaxis, :])  # (N, T, 3)

    def eval_single_sat_ecef(local_i: int, t_sec: float) -> np.ndarray:
        r_m_1, _ = propagate_j2_secular_chunk(
            a_m[local_i:local_i + 1],
            e[local_i:local_i + 1],
            inc[local_i:local_i + 1],
            raan0[local_i:local_i + 1],
            argp0[local_i:local_i + 1],
            m0[local_i:local_i + 1],
            np.array([t_sec], dtype=np.float64),
        )
        gmst_1 = jd_array_to_gmst_rad(np.array([jd0 + fr0 + t_sec / 86400.0]))
        return eci_to_ecef_batch(r_m_1[0, 0] * 1e-3, gmst_1[0])

    rng = np.random.default_rng(seed ^ 0x51A7)
    obs_windows: List[Dict[str, Any]] = []
    dl_windows: List[Dict[str, Any]] = []
    obs_id = 0
    dl_id = 0

    for local_i, global_idx in enumerate(sat_indices):
        sat_id = catalog.sat_ids[global_idx]
        sat_ecef_traj = r_ecef_km[local_i]  # (T, 3)

        # 1. Target observation windows with bisection horizon refinement
        for tgt in targets:
            el_deg, off_deg, _ = compute_site_visibility_batch(
                sat_ecef_traj, tgt["lat_deg"], tgt["lon_deg"], 0.0
            )
            vis = (el_deg > 0.0) & (off_deg <= max_off_nadir_deg)
            if not np.any(vis):
                continue

            # Identify contiguous True runs
            padded = np.concatenate([[False], vis, [False]])
            starts = np.where(padded[1:] & ~padded[:-1])[0]
            ends = np.where(~padded[1:] & padded[:-1])[0] - 1

            def tgt_pred(t_val: float, li: int = local_i, lat: float = tgt["lat_deg"], lon: float = tgt["lon_deg"]) -> bool:
                p = eval_single_sat_ecef(li, t_val)
                el_v, off_v, _ = compute_site_visibility_batch(p, lat, lon, 0.0)
                return bool(el_v > 0.0 and off_v <= max_off_nadir_deg)

            for s_i, e_i in zip(starts.tolist(), ends.tolist()):
                t_start = (
                    _bisect_crossing(tgt_pred, float(t_grid[s_i - 1]), float(t_grid[s_i]))
                    if s_i > 0
                    else float(t_grid[0])
                )
                t_end = (
                    _bisect_crossing(tgt_pred, float(t_grid[e_i + 1]), float(t_grid[e_i]))
                    if e_i + 1 < len(t_grid)
                    else float(t_grid[-1])
                )
                dur = t_end - t_start
                if dur >= float(tgt["required_duration_sec"]):
                    obs_id += 1
                    min_off = float(np.min(off_deg[s_i:e_i + 1]))
                    max_el = float(np.max(el_deg[s_i:e_i + 1]))
                    cloud_blocked = bool(rng.random() < float(tgt["cloud_prob_synthetic"]))
                    obs_windows.append({
                        "window_id": f"OBS-{obs_id:05d}",
                        "sat_id": sat_id,
                        "target_id": tgt["id"],
                        "start_sec": round(t_start, 2),
                        "end_sec": round(t_end, 2),
                        "duration_sec": round(dur, 2),
                        "min_off_nadir_deg": round(min_off, 2),
                        "max_elevation_deg": round(max_el, 2),
                        "priority": float(tgt["priority"]),
                        "required_duration_sec": float(tgt["required_duration_sec"]),
                        "data_volume_gb": float(tgt["data_volume_gb"]),
                        "deadline_sec": float(tgt["deadline_sec"]),
                        "cloud_prob_synthetic": float(tgt["cloud_prob_synthetic"]),
                        "realized_cloud_blocked_synthetic": cloud_blocked,
                        "refinement_tol_sec": 0.25,
                    })

        # 2. Ground-station downlink contact windows with bisection horizon refinement
        for gs in stations:
            el_deg, _, _ = compute_site_visibility_batch(
                sat_ecef_traj, gs["lat_deg"], gs["lon_deg"], gs["alt_km"]
            )
            min_el = float(gs["min_elevation_deg"])
            vis = el_deg >= min_el
            if not np.any(vis):
                continue

            padded = np.concatenate([[False], vis, [False]])
            starts = np.where(padded[1:] & ~padded[:-1])[0]
            ends = np.where(~padded[1:] & padded[:-1])[0] - 1

            def gs_pred(
                t_val: float,
                li: int = local_i,
                lat: float = gs["lat_deg"],
                lon: float = gs["lon_deg"],
                alt: float = gs["alt_km"],
                mel: float = min_el,
            ) -> bool:
                p = eval_single_sat_ecef(li, t_val)
                el_v, _, _ = compute_site_visibility_batch(p, lat, lon, alt)
                return bool(el_v >= mel)

            for s_i, e_i in zip(starts.tolist(), ends.tolist()):
                t_start = (
                    _bisect_crossing(gs_pred, float(t_grid[s_i - 1]), float(t_grid[s_i]))
                    if s_i > 0
                    else float(t_grid[0])
                )
                t_end = (
                    _bisect_crossing(gs_pred, float(t_grid[e_i + 1]), float(t_grid[e_i]))
                    if e_i + 1 < len(t_grid)
                    else float(t_grid[-1])
                )
                dur = t_end - t_start
                if dur >= 30.0:
                    dl_id += 1
                    rate = float(gs["downlink_rate_gbps"])
                    dl_windows.append({
                        "contact_id": f"DL-{dl_id:05d}",
                        "sat_id": sat_id,
                        "station_id": gs["id"],
                        "start_sec": round(t_start, 2),
                        "end_sec": round(t_end, 2),
                        "duration_sec": round(dur, 2),
                        "max_elevation_deg": round(float(np.max(el_deg[s_i:e_i + 1])), 2),
                        "downlink_rate_gbps": rate,
                        "max_volume_gb": round(dur * rate, 2),
                        "refinement_tol_sec": 0.25,
                    })

    return {
        "sat_count_analyzed": n_sats,
        "target_count": len(targets),
        "station_count": len(stations),
        "horizon_sec": horizon_sec,
        "coarse_step_sec": coarse_step_sec,
        "horizon_refinement": "Bisection (< 0.25 s tolerance)",
        "max_off_nadir_deg": max_off_nadir_deg,
        "observation_windows": obs_windows,
        "downlink_windows": dl_windows,
    }
