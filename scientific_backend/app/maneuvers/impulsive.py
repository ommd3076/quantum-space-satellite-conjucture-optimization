"""Impulsive delta-v orbital maneuver engine for CONTROLLABLE SYNTHETIC spacecraft.

Physical & Scientific Rules:
- Uses SI units internally (m, m/s, kg, s) with Two-Body + J2 numerical integration via
  `scipy.integrate.solve_ivp(..., method="DOP853", rtol=1e-10, atol=1e-12)`.
- Applies true translational velocity discontinuities in an explicitly specified inertial (ECI)
  or local orbital (RTN / Radial-Transverse-Normal) frame at scheduled burn epochs.
- Computes propellant mass expenditure via the Tsiolkovsky rocket equation:
      dm = m_current * (1 - exp(-|dv| / (Isp * g0)))
  using explicitly labeled hypothetical spacecraft mass & Isp parameters.
- Strictly refuses to "edit a TLE" or pretend a post-maneuver state remains SGP4-validated.
  Distinguishes translational orbit maneuvers from attitude slews / schedule replanning.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Literal, Tuple

import numpy as np
from scipy.integrate import solve_ivp

from app.config import G0_M_S2, J2_EARTH, MU_EARTH_M3_S2, R_EARTH_EQ_KM, R_EARTH_EQ_M
from app.frames.transforms import datetime_to_jd_fr, eci_to_ecef_batch, jd_array_to_gmst_rad


@dataclass
class ImpulsiveBurnSpec:
    t_burn_sec: float
    frame: Literal["RTN", "ECI"]
    dv_m_s: Tuple[float, float, float]  # (dR, dT, dN) or (dVx, dVy, dVz) in m/s
    label: str = "Impulsive Burn"


def _two_body_j2_ode(_t: float, y: np.ndarray) -> np.ndarray:
    """Cartesian Two-Body + J2 equations of motion in SI (m, m/s)."""
    rx, ry, rz, vx, vy, vz = y
    r2 = rx * rx + ry * ry + rz * rz
    r = np.sqrt(r2)
    r3 = r2 * r
    inv_r3 = -MU_EARTH_M3_S2 / r3

    r5 = r3 * r2
    z2_r2 = (rz * rz) / r2
    j2_c = (-1.5 * J2_EARTH * MU_EARTH_M3_S2 * (R_EARTH_EQ_M ** 2)) / r5
    xy_fac = 1.0 - 5.0 * z2_r2
    z_fac = 3.0 - 5.0 * z2_r2

    ax = inv_r3 * rx + j2_c * rx * xy_fac
    ay = inv_r3 * ry + j2_c * ry * xy_fac
    az = inv_r3 * rz + j2_c * rz * z_fac
    return np.array([vx, vy, vz, ax, ay, az], dtype=np.float64)


def rtn_to_eci_delta_v(r_eci_m: np.ndarray, v_eci_m_s: np.ndarray, dv_rtn: np.ndarray) -> np.ndarray:
    """Transform delta-v from local orbital RTN (Radial, Transverse/In-track, Cross-track Normal) to ECI."""
    r_hat = r_eci_m / np.linalg.norm(r_eci_m)
    h_vec = np.cross(r_eci_m, v_eci_m_s)
    n_hat = h_vec / np.linalg.norm(h_vec)
    t_hat = np.cross(n_hat, r_hat)
    t_hat = t_hat / np.linalg.norm(t_hat)
    return dv_rtn[0] * r_hat + dv_rtn[1] * t_hat + dv_rtn[2] * n_hat


def eci_state_to_osculating_elements_km(r_m: np.ndarray, v_m_s: np.ndarray) -> Dict[str, float]:
    """Compute osculating semi-major axis (km), eccentricity, inclination (deg), perigee/apogee alt (km)."""
    r = float(np.linalg.norm(r_m))
    v2 = float(np.dot(v_m_s, v_m_s))
    eps = 0.5 * v2 - MU_EARTH_M3_S2 / r
    a_m = -MU_EARTH_M3_S2 / (2.0 * eps) if abs(eps) > 1e-12 else float("inf")
    h_vec = np.cross(r_m, v_m_s)
    h_mag = float(np.linalg.norm(h_vec))
    e_vec = np.cross(v_m_s, h_vec) / MU_EARTH_M3_S2 - r_m / r
    e_mag = float(np.linalg.norm(e_vec))
    inc_deg = float(np.rad2deg(np.arccos(np.clip(h_vec[2] / max(h_mag, 1e-12), -1.0, 1.0))))
    perigee_alt_km = (a_m * (1.0 - e_mag) - R_EARTH_EQ_M) * 1e-3
    apogee_alt_km = (a_m * (1.0 + e_mag) - R_EARTH_EQ_M) * 1e-3
    return {
        "a_km": round(a_m * 1e-3, 4),
        "eccentricity": round(e_mag, 6),
        "inclination_deg": round(inc_deg, 4),
        "perigee_alt_km": round(perigee_alt_km, 3),
        "apogee_alt_km": round(apogee_alt_km, 3),
        "specific_energy_km2_s2": round(eps * 1e-6, 6),
    }


def simulate_impulsive_maneuvers(
    sat_id: str,
    r0_eci_m: np.ndarray,
    v0_eci_m_s: np.ndarray,
    epoch_utc: datetime,
    burns: List[ImpulsiveBurnSpec],
    horizon_sec: float = 10800.0,
    sample_step_sec: float = 60.0,
    wet_mass_kg: float = 250.0,
    dry_mass_kg: float = 220.0,
    isp_s: float = 220.0,
    provenance_note: str = "SYNTHETIC_ASSUMPTION: Hypothetical controllable spacecraft mass/Isp parameters.",
) -> Dict[str, Any]:
    """Propagate both unmaneuvered baseline and post-burn maneuvered trajectory via DOP853 (Two-Body + J2)."""
    if wet_mass_kg <= dry_mass_kg or dry_mass_kg <= 0 or isp_s <= 0:
        raise ValueError("Invalid propulsion parameters: require wet_mass_kg > dry_mass_kg > 0 and isp_s > 0.")

    sorted_burns = sorted(burns, key=lambda b: b.t_burn_sec)
    for b in sorted_burns:
        if b.t_burn_sec < 0.0 or b.t_burn_sec > horizon_sec:
            raise ValueError(f"Burn time {b.t_burn_sec}s must lie within [0, {horizon_sec}]s.")

    t_grid = np.arange(0.0, horizon_sec + 1e-6, sample_step_sec, dtype=np.float64)
    if t_grid[-1] < horizon_sec:
        t_grid = np.append(t_grid, horizon_sec)

    y0 = np.concatenate([r0_eci_m, v0_eci_m_s]).astype(np.float64)

    # 1. Propagate unmaneuvered reference trajectory with DOP853
    sol_base = solve_ivp(
        _two_body_j2_ode,
        (0.0, float(horizon_sec)),
        y0,
        method="DOP853",
        t_eval=t_grid,
        rtol=1e-10,
        atol=1e-12,
    )
    if not sol_base.success:
        raise RuntimeError(f"Baseline DOP853 propagation failed: {sol_base.message}")
    base_states = sol_base.y.T  # (T, 6)

    # 2. Propagate piecewise maneuvered trajectory with exact velocity discontinuities at each burn
    curr_t = 0.0
    curr_y = y0.copy()
    curr_mass = float(wet_mass_kg)
    total_dv_m_s = 0.0
    total_propellant_kg = 0.0
    burn_events: List[Dict[str, Any]] = []

    maneuver_states = np.empty_like(base_states)
    filled_mask = np.zeros(len(t_grid), dtype=bool)

    segments_end_times = [b.t_burn_sec for b in sorted_burns] + [float(horizon_sec)]

    for seg_idx, seg_end in enumerate(segments_end_times):
        # Evaluate samples in [curr_t, seg_end] (exclude already filled points)
        in_seg = (t_grid >= curr_t - 1e-9) & (t_grid <= seg_end + 1e-9) & (~filled_mask)
        t_eval_seg = t_grid[in_seg]

        if seg_end > curr_t + 1e-12:
            # Always include seg_end in solver output so we have exact pre-burn state
            eval_with_end = np.unique(np.append(t_eval_seg, seg_end))
            sol_seg = solve_ivp(
                _two_body_j2_ode,
                (curr_t, seg_end),
                curr_y,
                method="DOP853",
                t_eval=eval_with_end,
                rtol=1e-10,
                atol=1e-12,
            )
            if not sol_seg.success:
                raise RuntimeError(f"Maneuver segment {seg_idx} DOP853 failed: {sol_seg.message}")
            # Map back to t_grid indices
            idx_list = np.where(in_seg)[0]
            for g_i in idx_list:
                pos_in_eval = int(np.argmin(np.abs(eval_with_end - t_grid[g_i])))
                maneuver_states[g_i] = sol_seg.y[:, pos_in_eval]
                filled_mask[g_i] = True
            curr_y = sol_seg.y[:, -1].copy()
            curr_t = seg_end
        elif len(t_eval_seg) > 0:
            idx_list = np.where(in_seg)[0]
            for g_i in idx_list:
                maneuver_states[g_i] = curr_y
                filled_mask[g_i] = True

        # Apply impulsive burn if this segment ends at a burn
        if seg_idx < len(sorted_burns):
            burn = sorted_burns[seg_idx]
            r_pre = curr_y[:3].copy()
            v_pre = curr_y[3:].copy()
            dv_vec_in = np.array(burn.dv_m_s, dtype=np.float64)
            dv_eci = (
                rtn_to_eci_delta_v(r_pre, v_pre, dv_vec_in)
                if burn.frame == "RTN"
                else dv_vec_in
            )
            dv_mag = float(np.linalg.norm(dv_eci))

            # Tsiolkovsky rocket equation check
            m_after = curr_mass * float(np.exp(-dv_mag / (isp_s * G0_M_S2)))
            prop_used = curr_mass - m_after
            if m_after < dry_mass_kg - 1e-9:
                raise ValueError(
                    f"Burn '{burn.label}' at t={burn.t_burn_sec}s requires {prop_used:.3f} kg propellant, "
                    f"exceeding remaining propellant {curr_mass - dry_mass_kg:.3f} kg."
                )

            pre_oe = eci_state_to_osculating_elements_km(r_pre, v_pre)
            v_post = v_pre + dv_eci
            post_oe = eci_state_to_osculating_elements_km(r_pre, v_post)

            curr_y[3:] = v_post
            curr_mass = m_after
            total_dv_m_s += dv_mag
            total_propellant_kg += prop_used

            burn_events.append({
                "label": burn.label,
                "t_burn_sec": burn.t_burn_sec,
                "burn_epoch_utc": (epoch_utc + timedelta(seconds=burn.t_burn_sec)).isoformat(),
                "commanded_frame": burn.frame,
                "dv_commanded_m_s": [round(float(x), 4) for x in dv_vec_in],
                "dv_applied_eci_m_s": [round(float(x), 4) for x in dv_eci],
                "dv_magnitude_m_s": round(dv_mag, 4),
                "velocity_discontinuity_verified_m_s": round(float(np.linalg.norm(v_post - v_pre)), 6),
                "propellant_used_kg": round(prop_used, 4),
                "mass_after_burn_kg": round(curr_mass, 4),
                "osculating_pre_burn": pre_oe,
                "osculating_post_burn": post_oe,
                "delta_a_km": round(post_oe["a_km"] - pre_oe["a_km"], 4),
                "delta_inc_deg": round(post_oe["inclination_deg"] - pre_oe["inclination_deg"], 5),
                "delta_perigee_alt_km": round(post_oe["perigee_alt_km"] - pre_oe["perigee_alt_km"], 4),
                "delta_apogee_alt_km": round(post_oe["apogee_alt_km"] - pre_oe["apogee_alt_km"], 4),
            })

            # If a sample point sits exactly on t_burn_sec, record post-burn state for clarity
            exact_idx = np.where(np.abs(t_grid - burn.t_burn_sec) < 1e-9)[0]
            for gi in exact_idx:
                maneuver_states[gi] = curr_y

    # Convert both trajectories to ECEF & Three.js coordinates for 3D visual comparison
    jd0, fr0 = datetime_to_jd_fr(epoch_utc)
    gmst_arr = jd_array_to_gmst_rad(jd0 + fr0 + t_grid / 86400.0)
    base_ecef_km = eci_to_ecef_batch(base_states[:, :3] * 1e-3, gmst_arr)
    man_ecef_km = eci_to_ecef_batch(maneuver_states[:, :3] * 1e-3, gmst_arr)
    sep_km = np.linalg.norm((maneuver_states[:, :3] - base_states[:, :3]) * 1e-3, axis=-1)

    inv_r = 1.0 / R_EARTH_EQ_KM
    base_three = np.stack(
        [base_ecef_km[:, 0] * inv_r, base_ecef_km[:, 2] * inv_r, -base_ecef_km[:, 1] * inv_r],
        axis=-1,
    ).astype(np.float32).tolist()
    man_three = np.stack(
        [man_ecef_km[:, 0] * inv_r, man_ecef_km[:, 2] * inv_r, -man_ecef_km[:, 1] * inv_r],
        axis=-1,
    ).astype(np.float32).tolist()

    final_oe_base = eci_state_to_osculating_elements_km(base_states[-1, :3], base_states[-1, 3:])
    final_oe_man = eci_state_to_osculating_elements_km(maneuver_states[-1, :3], maneuver_states[-1, 3:])

    return {
        "sat_id": sat_id,
        "maneuver_type": "TRANSLATIONAL_IMPULSIVE_ORBIT_MANEUVER",
        "propagator": "scipy.integrate.solve_ivp(DOP853, rtol=1e-10, atol=1e-12) Two-Body + J2 (SI)",
        "frame": "ECI(J2000-aligned) with RTN/ECI burn execution",
        "provenance": provenance_note,
        "epoch_utc": epoch_utc.isoformat(),
        "horizon_sec": horizon_sec,
        "propulsion_budget": {
            "wet_mass_kg": wet_mass_kg,
            "dry_mass_kg": dry_mass_kg,
            "available_propellant_kg": round(wet_mass_kg - dry_mass_kg, 4),
            "isp_s": isp_s,
            "total_dv_m_s": round(total_dv_m_s, 4),
            "total_propellant_used_kg": round(total_propellant_kg, 4),
            "remaining_propellant_kg": round(curr_mass - dry_mass_kg, 4),
            "final_mass_kg": round(curr_mass, 4),
        },
        "burn_events": burn_events,
        "trajectory_divergence": {
            "max_position_separation_km": round(float(np.max(sep_km)), 4),
            "final_position_separation_km": round(float(sep_km[-1]), 4),
            "final_elements_baseline": final_oe_base,
            "final_elements_maneuvered": final_oe_man,
        },
        "baseline_track_threejs": base_three,
        "maneuvered_track_threejs": man_three,
    }
