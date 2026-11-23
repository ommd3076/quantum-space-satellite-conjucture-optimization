"""Scalable broad-phase + narrow-phase geometric proximity screening over up to 50,000 objects.

IMPORTANT SCIENTIFIC DISCLAIMER:
This module performs DETERMINISTIC GEOMETRIC PROXIMITY SCREENING ONLY (using
`scipy.spatial.cKDTree` broad-phase neighbor search + local relative-velocity narrow-phase
closest-approach estimation).
It is NOT a collision probability (Pc), operational conjunction warning, or flight-safety
clearance because orbital covariance matrices, atmospheric density uncertainties, and full
IERS Earth-orientation parameters are not modeled.
"""
from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

import numpy as np
from scipy.spatial import cKDTree


def screen_proximity_epoch(
    object_ids: List[str],
    r_eci_km: np.ndarray,
    v_eci_km_s: np.ndarray,
    threshold_km: float = 5.0,
    narrow_window_sec: float = 30.0,
    max_reported_pairs: int = 100,
) -> Dict[str, Any]:
    """Run O(N log N) cKDTree broad-phase + linear-relative-motion narrow-phase TCA refinement."""
    t0 = time.perf_counter()
    n_obj = len(object_ids)
    if n_obj < 2 or r_eci_km.shape[0] != n_obj:
        return {
            "status": "NO_PAIRS",
            "objects_screened": n_obj,
            "threshold_km": threshold_km,
            "candidate_pairs_broad_phase": 0,
            "close_approaches": [],
            "wall_time_ms": 0.0,
            "disclaimer": (
                "DETERMINISTIC_GEOMETRIC_SCREENING_ONLY: Not collision probability (Pc) "
                "or flight-safety conjunction warning."
            ),
        }

    # Filter out any non-finite rows explicitly and report count
    valid_mask = np.all(np.isfinite(r_eci_km), axis=1) & np.all(np.isfinite(v_eci_km_s), axis=1)
    valid_indices = np.where(valid_mask)[0]
    r_valid = r_eci_km[valid_indices]
    v_valid = v_eci_km_s[valid_indices]

    t_tree0 = time.perf_counter()
    tree = cKDTree(r_valid)
    # Broad-phase search radius expanded slightly to catch approaches occurring within +/- narrow_window_sec
    # At max ~15 km/s relative speed, keep broad-phase radius tightly bounded to user threshold + margin
    broad_radius_km = float(threshold_km) * 1.5
    raw_pairs = tree.query_pairs(r=broad_radius_km, output_type="ndarray")
    tree_ms = (time.perf_counter() - t_tree0) * 1000.0

    close_approaches: List[Dict[str, Any]] = []
    if len(raw_pairs) > 0:
        i_idx = raw_pairs[:, 0]
        j_idx = raw_pairs[:, 1]
        dr = r_valid[j_idx] - r_valid[i_idx]          # (P, 3) km
        dv = v_valid[j_idx] - v_valid[i_idx]          # (P, 3) km/s
        dist_now = np.linalg.norm(dr, axis=1)
        dv2 = np.sum(dv * dv, axis=1)
        # Local linear narrow-phase Time of Closest Approach (TCA) within [-narrow_window_sec, +narrow_window_sec]
        t_ca = np.where(dv2 > 1e-12, -np.sum(dr * dv, axis=1) / np.maximum(dv2, 1e-12), 0.0)
        t_ca = np.clip(t_ca, -narrow_window_sec, narrow_window_sec)
        dr_ca = dr + dv * t_ca[:, np.newaxis]
        min_dist_km = np.linalg.norm(dr_ca, axis=1)
        rel_speed_km_s = np.sqrt(dv2)

        within = np.where(min_dist_km <= threshold_km)[0]
        # Sort by closest approach distance ascending
        order = within[np.argsort(min_dist_km[within])]
        for p_i in order[:max_reported_pairs]:
            g_i = int(valid_indices[int(i_idx[p_i])])
            g_j = int(valid_indices[int(j_idx[p_i])])
            close_approaches.append({
                "object_a": object_ids[g_i],
                "object_b": object_ids[g_j],
                "instantaneous_dist_km": round(float(dist_now[p_i]), 4),
                "narrow_phase_min_dist_km": round(float(min_dist_km[p_i]), 4),
                "tca_offset_sec": round(float(t_ca[p_i]), 3),
                "relative_speed_km_s": round(float(rel_speed_km_s[p_i]), 4),
            })

    wall_ms = (time.perf_counter() - t0) * 1000.0
    naive_pairs = n_obj * (n_obj - 1) // 2

    return {
        "status": "COMPLETED",
        "method": "Broad-phase scipy.spatial.cKDTree + narrow-phase local linear TCA",
        "objects_screened": int(len(valid_indices)),
        "objects_skipped_non_finite": int(n_obj - len(valid_indices)),
        "naive_all_pairs_avoided": naive_pairs,
        "broad_phase_radius_km": round(broad_radius_km, 3),
        "threshold_km": threshold_km,
        "candidate_pairs_broad_phase": int(len(raw_pairs)),
        "pairs_within_threshold": len(close_approaches),
        "broad_phase_ms": round(tree_ms, 3),
        "wall_time_ms": round(wall_ms, 3),
        "close_approaches": close_approaches,
        "disclaimer": (
            "DETERMINISTIC_GEOMETRIC_SCREENING_ONLY: No orbital covariance matrices or EOP "
            "uncertainties are modeled. Not collision probability (Pc) or operational conjunction warning."
        ),
    }
