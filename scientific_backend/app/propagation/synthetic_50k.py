"""SYNTHETIC_50K scalable constellation generator and chunked SI-unit orbital propagator.

SCIENTIFIC INTEGRITY DECLARATION:
The 50,000 objects generated here are HYPOTHETICAL, SIMULATED SPACECRAFT designed for
computational scalability stress testing. They are NOT present-day active satellites and
do NOT imply a deployable or collision-safe mission.

Physics (SI units internally: meters, m/s, radians, seconds):
- Deterministic multi-shell Walker Delta family summing to exactly N (default 50,000) unique IDs.
- Selectable propagation fidelity:
  1) `j2_secular_kepler`: Vectorized J2 secular nodal precession (dOmega/dt), apsidal precession
     (domega/dt), and mean-motion J2 correction (dM/dt) + vectorized Newton-Raphson Kepler solver
     (residual < 1e-12 rad) -> Cartesian ECI (m, m/s). Used for high-throughput 50,000-object
     24-hour screening & interactive epochs.
  2) `j2_rk4_numerical`: Vectorized chunked Cartesian Two-Body + J2 4th-order Runge-Kutta
     numerical integration in SI units for high-fidelity propagation and cross-verification.
- Explicit RAM budgeting, chunked execution, PyArrow Parquet streaming artifacts, and psutil
  CPU/RSS instrumentation.
"""
from __future__ import annotations

import hashlib
import json
import os
import platform
import time
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import numpy as np
import psutil
import pyarrow as pa
import pyarrow.parquet as pq

from app.config import (
    ARTIFACTS_DIR,
    FRAME_FIDELITY_NOTE,
    J2_EARTH,
    MU_EARTH_M3_S2,
    R_EARTH_EQ_KM,
    R_EARTH_EQ_M,
)
from app.frames.transforms import (
    datetime_to_jd_fr,
    ecef_to_geodetic_batch,
    eci_to_ecef_batch,
    jd_array_to_gmst_rad,
)


@dataclass(frozen=True)
class WalkerShellSpec:
    shell_id: str
    name: str
    total_sats: int
    planes: int
    phasing: int
    altitude_km: float
    inclination_deg: float
    eccentricity: float
    raan0_deg: float
    arg_perigee_deg: float
    controllable_fraction: float  # Fraction of spacecraft eligible for controlled ops/maneuvers


# Documented 10-shell hypothetical stress-test family summing to EXACTLY 50,000 unique spacecraft
DEFAULT_50K_SHELLS: List[WalkerShellSpec] = [
    WalkerShellSpec("S01", "VLEO Optical Shell A", 4000, 80, 1, 420.0, 53.0, 0.0005, 0.0, 0.0, 0.05),
    WalkerShellSpec("S02", "LEO SSO EO Primary", 6000, 100, 1, 520.0, 97.48, 0.0010, 12.0, 90.0, 0.08),
    WalkerShellSpec("S03", "LEO Mid-Inc Shell A", 8000, 100, 3, 550.0, 53.2, 0.0008, 24.0, 45.0, 0.02),
    WalkerShellSpec("S04", "LEO High-Inc Polar", 5000, 100, 2, 580.0, 87.9, 0.0012, 36.0, 0.0, 0.04),
    WalkerShellSpec("S05", "LEO Mid-Inc Shell B", 7000, 100, 5, 610.0, 43.0, 0.0007, 48.0, 180.0, 0.02),
    WalkerShellSpec("S06", "LEO SSO Radar Shell", 5000, 100, 1, 650.0, 98.00, 0.0011, 60.0, 90.0, 0.05),
    WalkerShellSpec("S07", "LEO Equatorial Belt", 4000, 80, 2, 720.0, 33.0, 0.0009, 72.0, 30.0, 0.02),
    WalkerShellSpec("S08", "Upper LEO Broadband A", 5000, 100, 4, 880.0, 70.0, 0.0015, 84.0, 120.0, 0.01),
    WalkerShellSpec("S09", "Upper LEO Polar Relay", 3000, 60, 1, 1050.0, 86.5, 0.0010, 96.0, 60.0, 0.02),
    WalkerShellSpec("S10", "High LEO MEO-Edge", 3000, 60, 3, 1200.0, 55.0, 0.0020, 108.0, 270.0, 0.01),
]
assert sum(s.total_sats for s in DEFAULT_50K_SHELLS) == 50_000


class SyntheticConstellationCatalog:
    """In-memory vectorized container of N uniquely initialized hypothetical spacecraft (SI units)."""

    def __init__(
        self,
        shells: Optional[List[WalkerShellSpec]] = None,
        epoch_utc: Optional[datetime] = None,
        seed: int = 20261123,
    ):
        self.shells = shells or DEFAULT_50K_SHELLS
        self.epoch_utc = (epoch_utc or datetime(2026, 11, 23, 0, 0, 0, tzinfo=timezone.utc)).astimezone(timezone.utc)
        self.seed = int(seed)

        for sh in self.shells:
            if sh.total_sats % sh.planes != 0:
                raise ValueError(f"Shell {sh.shell_id}: T={sh.total_sats} not divisible by P={sh.planes}")
            if not (0 <= sh.phasing < sh.planes):
                raise ValueError(f"Shell {sh.shell_id}: F={sh.phasing} out of [0, P-1]")

        self.count = sum(sh.total_sats for sh in self.shells)
        self.sat_ids: List[str] = []
        self.shell_indices = np.empty(self.count, dtype=np.int16)
        self.plane_indices = np.empty(self.count, dtype=np.int32)
        self.slot_indices = np.empty(self.count, dtype=np.int32)
        self.controllable_mask = np.zeros(self.count, dtype=bool)

        # Classical elements in SI units (m, dimensionless, radians)
        self.a_m = np.empty(self.count, dtype=np.float64)
        self.e = np.empty(self.count, dtype=np.float64)
        self.inc_rad = np.empty(self.count, dtype=np.float64)
        self.raan0_rad = np.empty(self.count, dtype=np.float64)
        self.argp0_rad = np.empty(self.count, dtype=np.float64)
        self.m0_rad = np.empty(self.count, dtype=np.float64)

        rng = np.random.default_rng(self.seed)
        cursor = 0
        for s_idx, sh in enumerate(self.shells):
            n_sh = sh.total_sats
            sats_per_plane = n_sh // sh.planes
            # Small deterministic per-satellite altitude/eccentricity micro-dispersion (<= 0.4 km)
            # ensuring genuinely distinct orbital parameters while preserving shell structure
            alt_jitter_m = rng.uniform(-400.0, 400.0, size=n_sh)
            ecc_jitter = rng.uniform(0.0, 2e-4, size=n_sh)

            p_arr = np.repeat(np.arange(sh.planes, dtype=np.int32), sats_per_plane)
            sl_arr = np.tile(np.arange(sats_per_plane, dtype=np.int32), sh.planes)

            raan_deg = np.mod(sh.raan0_deg + (360.0 * p_arr) / sh.planes, 360.0)
            m0_deg = np.mod(
                (360.0 * sl_arr) / sats_per_plane + (360.0 * sh.phasing * p_arr) / n_sh,
                360.0,
            )

            end = cursor + n_sh
            self.shell_indices[cursor:end] = s_idx
            self.plane_indices[cursor:end] = p_arr
            self.slot_indices[cursor:end] = sl_arr

            # Deterministic controllable subset: first k slots in plane 0..
            n_ctrl = max(1, int(round(n_sh * sh.controllable_fraction)))
            ctrl_stride = max(1, n_sh // n_ctrl)
            ctrl_local = np.zeros(n_sh, dtype=bool)
            ctrl_local[::ctrl_stride] = True
            self.controllable_mask[cursor:end] = ctrl_local

            self.a_m[cursor:end] = R_EARTH_EQ_M + sh.altitude_km * 1000.0 + alt_jitter_m
            self.e[cursor:end] = sh.eccentricity + ecc_jitter
            self.inc_rad[cursor:end] = np.deg2rad(sh.inclination_deg)
            self.raan0_rad[cursor:end] = np.deg2rad(raan_deg)
            self.argp0_rad[cursor:end] = np.deg2rad(sh.arg_perigee_deg)
            self.m0_rad[cursor:end] = np.deg2rad(m0_deg)

            for p_i, sl_i in zip(p_arr.tolist(), sl_arr.tolist()):
                self.sat_ids.append(f"SYN-{sh.shell_id}-P{p_i + 1:03d}-S{sl_i + 1:03d}")

            cursor = end

        self.id_to_index: Dict[str, int] = {sid: idx for idx, sid in enumerate(self.sat_ids)}
        self.config_hash = hashlib.sha256(
            json.dumps(
                {
                    "seed": self.seed,
                    "epoch_utc": self.epoch_utc.isoformat(),
                    "shells": [asdict(s) for s in self.shells],
                },
                sort_keys=True,
            ).encode("utf-8")
        ).hexdigest()

    def summary(self) -> Dict[str, Any]:
        return {
            "mode": "SYNTHETIC_50K",
            "provenance": "HYPOTHETICAL_SIMULATED_CONSTELLATION",
            "warning": (
                "These 50,000 spacecraft are hypothetical simulated stress-test objects, "
                "NOT real present-day active satellites and NOT a collision-safe deployment."
            ),
            "config_hash": self.config_hash,
            "seed": self.seed,
            "epoch_utc": self.epoch_utc.isoformat(),
            "total_objects": self.count,
            "controllable_objects": int(np.sum(self.controllable_mask)),
            "background_traffic_objects": int(self.count - np.sum(self.controllable_mask)),
            "shells": [asdict(s) for s in self.shells],
        }


def solve_kepler_vectorized(M: np.ndarray, e: np.ndarray, max_iter: int = 8) -> np.ndarray:
    """Vectorized Newton-Raphson solver for E - e*sin(E) = M (residual < 1e-12 rad)."""
    M_wrap = np.mod(M, 2.0 * np.pi)
    E = M_wrap + e * np.sin(M_wrap) + 0.5 * (e ** 2) * np.sin(2.0 * M_wrap)
    for _ in range(max_iter):
        f = E - e * np.sin(E) - M_wrap
        fp = 1.0 - e * np.cos(E)
        dE = f / fp
        E -= dE
        if float(np.max(np.abs(dE))) < 1e-13:
            break
    return E


def coe_to_eci_si_vectorized(
    a_m: np.ndarray,
    e: np.ndarray,
    inc: np.ndarray,
    raan: np.ndarray,
    argp: np.ndarray,
    mean_anom: np.ndarray,
) -> Tuple[np.ndarray, np.ndarray]:
    """Convert classical orbital elements (SI: m, rad) -> ECI Cartesian (r_m, v_m_s) shape (..., 3)."""
    E = solve_kepler_vectorized(mean_anom, e)
    cos_E = np.cos(E)
    sin_E = np.sin(E)
    sqrt_1me2 = np.sqrt(1.0 - e * e)

    # Perifocal position & velocity (m, m/s)
    r_mag = a_m * (1.0 - e * cos_E)
    x_p = a_m * (cos_E - e)
    y_p = a_m * sqrt_1me2 * sin_E

    n_rad_s = np.sqrt(MU_EARTH_M3_S2 / (a_m ** 3))
    v_fac = (n_rad_s * a_m * a_m) / r_mag
    vx_p = -v_fac * sin_E
    vy_p = v_fac * sqrt_1me2 * cos_E

    cos_O = np.cos(raan)
    sin_O = np.sin(raan)
    cos_i = np.cos(inc)
    sin_i = np.sin(inc)
    cos_w = np.cos(argp)
    sin_w = np.sin(argp)

    # Rotation matrix perifocal -> ECI (P and Q column vectors)
    p1 = cos_O * cos_w - sin_O * sin_w * cos_i
    p2 = sin_O * cos_w + cos_O * sin_w * cos_i
    p3 = sin_w * sin_i

    q1 = -cos_O * sin_w - sin_O * cos_w * cos_i
    q2 = -sin_O * sin_w + cos_O * cos_w * cos_i
    q3 = cos_w * sin_i

    r_eci = np.stack([p1 * x_p + q1 * y_p, p2 * x_p + q2 * y_p, p3 * x_p + q3 * y_p], axis=-1)
    v_eci = np.stack([p1 * vx_p + q1 * vy_p, p2 * vx_p + q2 * vy_p, p3 * vx_p + q3 * vy_p], axis=-1)
    return r_eci, v_eci


def propagate_j2_secular_chunk(
    a_m: np.ndarray,
    e: np.ndarray,
    inc: np.ndarray,
    raan0: np.ndarray,
    argp0: np.ndarray,
    m0: np.ndarray,
    t_offsets_sec: np.ndarray,
) -> Tuple[np.ndarray, np.ndarray]:
    """Propagate chunk of N objects across T time offsets using J2 secular rates + Keplerian motion.

    Returns (r_eci_m, v_eci_m_s) each of shape (N, T, 3) in SI units.
    """
    n0 = np.sqrt(MU_EARTH_M3_S2 / (a_m ** 3))
    p_m = a_m * (1.0 - e * e)
    j2_fac = 1.5 * J2_EARTH * ((R_EARTH_EQ_M / p_m) ** 2) * n0
    cos_i = np.cos(inc)
    sin_i2 = np.sin(inc) ** 2
    sqrt_1me2 = np.sqrt(1.0 - e * e)

    # First-order Brouwer/Vallado J2 secular rates (rad/s)
    raan_dot = -j2_fac * cos_i
    argp_dot = j2_fac * (2.0 - 2.5 * sin_i2)
    m_dot = n0 + j2_fac * sqrt_1me2 * (1.0 - 1.5 * sin_i2)

    t = t_offsets_sec[np.newaxis, :]  # (1, T)
    a_2d = a_m[:, np.newaxis]
    e_2d = e[:, np.newaxis]
    inc_2d = inc[:, np.newaxis]
    raan_t = raan0[:, np.newaxis] + raan_dot[:, np.newaxis] * t
    argp_t = argp0[:, np.newaxis] + argp_dot[:, np.newaxis] * t
    m_t = m0[:, np.newaxis] + m_dot[:, np.newaxis] * t

    return coe_to_eci_si_vectorized(a_2d, e_2d, inc_2d, raan_t, argp_t, m_t)


def _accel_two_body_j2_si(r_m: np.ndarray) -> np.ndarray:
    """Vectorized Two-Body + J2 gravitational acceleration in SI (m/s^2), r_m shape (N, 3)."""
    x = r_m[:, 0]
    y = r_m[:, 1]
    z = r_m[:, 2]
    r2 = x * x + y * y + z * z
    r_mag = np.sqrt(r2)
    r3 = r2 * r_mag
    inv_r3 = -MU_EARTH_M3_S2 / r3

    r5 = r3 * r2
    z2_r2 = (z * z) / r2
    j2_c = (-1.5 * J2_EARTH * MU_EARTH_M3_S2 * (R_EARTH_EQ_M ** 2)) / r5
    xy_fac = 1.0 - 5.0 * z2_r2
    z_fac = 3.0 - 5.0 * z2_r2

    ax = inv_r3 * x + j2_c * x * xy_fac
    ay = inv_r3 * y + j2_c * y * xy_fac
    az = inv_r3 * z + j2_c * z * z_fac
    return np.stack([ax, ay, az], axis=-1)


def propagate_j2_rk4_chunk(
    r0_m: np.ndarray,
    v0_m_s: np.ndarray,
    t_offsets_sec: np.ndarray,
    max_step_sec: float = 20.0,
) -> Tuple[np.ndarray, np.ndarray]:
    """Vectorized Cartesian Two-Body + J2 RK4 propagator in SI units for N objects over T monotonic epochs."""
    n_obj = r0_m.shape[0]
    n_t = len(t_offsets_sec)
    r_out = np.empty((n_obj, n_t, 3), dtype=np.float64)
    v_out = np.empty((n_obj, n_t, 3), dtype=np.float64)

    r = r0_m.copy()
    v = v0_m_s.copy()
    prev_t = 0.0

    for idx, t_target in enumerate(t_offsets_sec):
        dt_total = float(t_target - prev_t)
        if dt_total != 0.0:
            n_sub = max(1, int(np.ceil(abs(dt_total) / max_step_sec)))
            h = dt_total / n_sub
            for _ in range(n_sub):
                k1r = v
                k1v = _accel_two_body_j2_si(r)

                r2 = r + 0.5 * h * k1r
                v2 = v + 0.5 * h * k1v
                k2r = v2
                k2v = _accel_two_body_j2_si(r2)

                r3 = r + 0.5 * h * k2r
                v3 = v + 0.5 * h * k2v
                k3r = v3
                k3v = _accel_two_body_j2_si(r3)

                r4 = r + h * k3r
                v4 = v + h * k3v
                k4r = v4
                k4v = _accel_two_body_j2_si(r4)

                r = r + (h / 6.0) * (k1r + 2.0 * k2r + 2.0 * k3r + k4r)
                v = v + (h / 6.0) * (k1v + 2.0 * k2v + 2.0 * k3v + k4v)
            prev_t = float(t_target)
        r_out[:, idx, :] = r
        v_out[:, idx, :] = v

    return r_out, v_out


def propagate_synthetic_single_epoch(
    catalog: SyntheticConstellationCatalog,
    t_offset_sec: float,
    fidelity: str = "j2_secular_kepler",
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Propagate all N synthetic objects to a single epoch offset -> (r_eci_km, v_eci_km_s, r_ecef_km)."""
    t_arr = np.array([float(t_offset_sec)], dtype=np.float64)
    if fidelity == "j2_rk4_numerical" and abs(t_offset_sec) > 0.0:
        r0, v0 = coe_to_eci_si_vectorized(
            catalog.a_m, catalog.e, catalog.inc_rad, catalog.raan0_rad, catalog.argp0_rad, catalog.m0_rad
        )
        r_eci_m, v_eci_m_s = propagate_j2_rk4_chunk(r0, v0, t_arr, max_step_sec=30.0)
    else:
        r_eci_m, v_eci_m_s = propagate_j2_secular_chunk(
            catalog.a_m,
            catalog.e,
            catalog.inc_rad,
            catalog.raan0_rad,
            catalog.argp0_rad,
            catalog.m0_rad,
            t_arr,
        )
    r_eci_km = r_eci_m[:, 0, :] * 1e-3
    v_eci_km_s = v_eci_m_s[:, 0, :] * 1e-3

    eval_dt = catalog.epoch_utc + timedelta(seconds=float(t_offset_sec))
    jd, fr = datetime_to_jd_fr(eval_dt)
    gmst = float(jd_array_to_gmst_rad(np.array([jd + fr]))[0])
    r_ecef_km = eci_to_ecef_batch(r_eci_km, np.array(gmst))
    return r_eci_km, v_eci_km_s, r_ecef_km


def estimate_memory_plan(n_objects: int, n_epochs: int, chunk_size: int) -> Dict[str, Any]:
    """Explicit RAM & storage budget calculation (Milestone 3 requirement)."""
    full_pos_float64_bytes = n_objects * n_epochs * 3 * 8
    full_pos_vel_float64_bytes = n_objects * n_epochs * 6 * 8
    chunk_pos_vel_float64_bytes = min(n_objects, chunk_size) * n_epochs * 6 * 8
    # Intermediate trig/Kepler arrays ~4x chunk pos/vel buffer
    chunk_working_set_bytes = chunk_pos_vel_float64_bytes * 4
    return {
        "n_objects": n_objects,
        "n_epochs": n_epochs,
        "total_object_time_samples": n_objects * n_epochs,
        "chunk_size": chunk_size,
        "naive_full_xyz_float64_gb": round(full_pos_float64_bytes / 1e9, 3),
        "naive_full_pv_float64_gb": round(full_pos_vel_float64_bytes / 1e9, 3),
        "chunked_working_set_mb": round(chunk_working_set_bytes / 1e6, 2),
        "strategy": "Object-chunked propagation with streaming compressed Float32/Float64 Parquet output",
    }


def run_50k_chunked_benchmark(
    catalog: SyntheticConstellationCatalog,
    horizon_sec: float = 86400.0,
    step_sec: float = 300.0,
    chunk_size: int = 5000,
    fidelity: str = "j2_secular_kepler",
    write_parquet: bool = True,
    artifact_tag: str = "bench_50k",
    progress_cb: Optional[Callable[[float, str], None]] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> Dict[str, Any]:
    """Execute the real 50,000-object chunked propagation stress benchmark with full instrumentation.

    - Computes every single object-time state vector without shortcuts or duplication.
    - Checks finite values, orbital radius > R_EARTH, and mechanical invariants on every chunk.
    - Streams chunked compressed Parquet artifact (if enabled) so RAM stays strictly bounded.
    - Records actual CPU, RAM, peak RSS, throughput (states/s), wall time, and artifact bytes.
    """
    t_wall_start = time.perf_counter()
    proc = psutil.Process(os.getpid())
    rss_start_mb = proc.memory_info().rss / (1024 * 1024)
    peak_rss_mb = rss_start_mb

    n_epochs = int(horizon_sec // step_sec) + 1
    t_offsets = np.arange(n_epochs, dtype=np.float64) * step_sec
    n_obj = catalog.count
    mem_plan = estimate_memory_plan(n_obj, n_epochs, chunk_size)

    jd0, fr0 = datetime_to_jd_fr(catalog.epoch_utc)
    gmst_arr = jd_array_to_gmst_rad(jd0 + fr0 + t_offsets / 86400.0)  # (T,)

    run_id = f"{artifact_tag}_{int(time.time())}"
    parquet_path: Optional[Path] = ARTIFACTS_DIR / f"{run_id}.parquet" if write_parquet else None
    pq_writer: Optional[pq.ParquetWriter] = None

    valid_objects = 0
    invalid_objects = 0
    valid_samples = 0
    invalid_samples = 0
    max_rel_energy_drift = 0.0
    max_rel_h_drift = 0.0
    min_alt_km_observed = float("inf")
    max_alt_km_observed = float("-inf")
    cancelled = False

    # Random audit sample indices (deterministic seed) for independent scipy DOP853 cross-check
    sample_audit_indices = sorted(
        int(x) for x in np.random.default_rng(catalog.seed + 7).choice(n_obj, size=min(10, n_obj), replace=False)
    )
    audit_snapshots: List[Dict[str, Any]] = []

    try:
        for start in range(0, n_obj, chunk_size):
            if cancel_check and cancel_check():
                cancelled = True
                break

            end = min(n_obj, start + chunk_size)
            a_c = catalog.a_m[start:end]
            e_c = catalog.e[start:end]
            inc_c = catalog.inc_rad[start:end]
            raan_c = catalog.raan0_rad[start:end]
            argp_c = catalog.argp0_rad[start:end]
            m0_c = catalog.m0_rad[start:end]

            if fidelity == "j2_rk4_numerical":
                r0_c, v0_c = coe_to_eci_si_vectorized(a_c, e_c, inc_c, raan_c, argp_c, m0_c)
                r_eci_m, v_eci_m_s = propagate_j2_rk4_chunk(r0_c, v0_c, t_offsets, max_step_sec=30.0)
            else:
                r_eci_m, v_eci_m_s = propagate_j2_secular_chunk(
                    a_c, e_c, inc_c, raan_c, argp_c, m0_c, t_offsets
                )

            # Physical sanity & invariant checks on EVERY object-time state
            r_norm_m = np.linalg.norm(r_eci_m, axis=-1)  # (C, T)
            v2_m2_s2 = np.sum(v_eci_m_s * v_eci_m_s, axis=-1)
            finite_ok = np.all(np.isfinite(r_eci_m), axis=-1) & np.all(np.isfinite(v_eci_m_s), axis=-1)
            above_earth = r_norm_m > (R_EARTH_EQ_M + 100_000.0)
            sample_ok = finite_ok & above_earth

            chunk_valid_samples = int(np.sum(sample_ok))
            chunk_invalid_samples = int(sample_ok.size - chunk_valid_samples)
            valid_samples += chunk_valid_samples
            invalid_samples += chunk_invalid_samples

            obj_ok = np.all(sample_ok, axis=1)
            valid_objects += int(np.sum(obj_ok))
            invalid_objects += int(obj_ok.size - np.sum(obj_ok))

            # Specific two-body energy & angular momentum spread (note: under J2, two-body osculating energy oscillates ~O(J2) ~1e-3, while secular Kepler holds a constant)
            eps = 0.5 * v2_m2_s2 - MU_EARTH_M3_S2 / r_norm_m
            rel_dE = np.abs(eps - eps[:, :1]) / np.maximum(np.abs(eps[:, :1]), 1e-9)
            max_rel_energy_drift = max(max_rel_energy_drift, float(np.max(rel_dE)))

            h_vec = np.cross(r_eci_m, v_eci_m_s)
            h_mag = np.linalg.norm(h_vec, axis=-1)
            rel_dH = np.abs(h_mag - h_mag[:, :1]) / np.maximum(h_mag[:, :1], 1e-9)
            max_rel_h_drift = max(max_rel_h_drift, float(np.max(rel_dH)))

            min_alt_km_observed = min(min_alt_km_observed, float((np.min(r_norm_m) - R_EARTH_EQ_M) * 1e-3))
            max_alt_km_observed = max(max_alt_km_observed, float((np.max(r_norm_m) - R_EARTH_EQ_M) * 1e-3))

            # Capture audit snapshots for random sample indices in this chunk
            for g_idx in sample_audit_indices:
                if start <= g_idx < end:
                    loc = g_idx - start
                    audit_snapshots.append({
                        "sat_id": catalog.sat_ids[g_idx],
                        "index": g_idx,
                        "r0_eci_m": r_eci_m[loc, 0].tolist(),
                        "v0_eci_m_s": v_eci_m_s[loc, 0].tolist(),
                        "r_end_eci_m": r_eci_m[loc, -1].tolist(),
                        "v_end_eci_m_s": v_eci_m_s[loc, -1].tolist(),
                        "t_end_sec": float(t_offsets[-1]),
                    })

            # Stream ECEF positions in km (Float32) to compressed Parquet for bounded RAM & compact disk artifact
            if write_parquet and parquet_path is not None:
                r_ecef_km = eci_to_ecef_batch(r_eci_m * 1e-3, gmst_arr[np.newaxis, :])
                c_len = end - start
                obj_idx_col = np.repeat(np.arange(start, end, dtype=np.int32), n_epochs)
                t_sec_col = np.tile(t_offsets.astype(np.float32), c_len)
                flat_ecef = r_ecef_km.reshape(-1, 3).astype(np.float32)

                table = pa.table({
                    "obj_idx": pa.array(obj_idx_col),
                    "t_sec": pa.array(t_sec_col),
                    "x_ecef_km": pa.array(flat_ecef[:, 0]),
                    "y_ecef_km": pa.array(flat_ecef[:, 1]),
                    "z_ecef_km": pa.array(flat_ecef[:, 2]),
                })
                if pq_writer is None:
                    pq_writer = pq.ParquetWriter(parquet_path, table.schema, compression="zstd")
                pq_writer.write_table(table)

            cur_rss = proc.memory_info().rss / (1024 * 1024)
            if cur_rss > peak_rss_mb:
                peak_rss_mb = cur_rss

            if progress_cb:
                progress_cb(end / n_obj, f"Propagated {end:,}/{n_obj:,} objects (RSS {cur_rss:.1f} MB)")
    finally:
        if pq_writer is not None:
            pq_writer.close()

    wall_sec = time.perf_counter() - t_wall_start
    total_computed = valid_samples + invalid_samples
    throughput = total_computed / max(wall_sec, 1e-9)
    artifact_bytes = parquet_path.stat().st_size if (parquet_path and parquet_path.exists()) else 0

    report = {
        "run_id": run_id,
        "status": "CANCELLED" if cancelled else ("COMPLETED_WITH_ERRORS" if invalid_samples > 0 else "COMPLETED"),
        "mode": "SYNTHETIC_50K",
        "provenance": "HYPOTHETICAL_SIMULATED_STRESS_TEST",
        "executed_at_utc": datetime.now(timezone.utc).isoformat(),
        "config_hash": catalog.config_hash,
        "seed": catalog.seed,
        "epoch_utc": catalog.epoch_utc.isoformat(),
        "fidelity": fidelity,
        "frame": "ECI(J2000-aligned) -> ECEF(IAU-82 GMST simplified EOP)",
        "frame_note": FRAME_FIDELITY_NOTE,
        "horizon_sec": horizon_sec,
        "step_sec": step_sec,
        "n_epochs": n_epochs,
        "counts": {
            "total_objects_configured": n_obj,
            "synthetic_propagated_valid": valid_objects,
            "synthetic_failed": invalid_objects,
            "valid_object_time_samples": valid_samples,
            "invalid_object_time_samples": invalid_samples,
        },
        "physics_diagnostics": {
            "max_relative_energy_variation": max_rel_energy_drift,
            "max_relative_angular_momentum_variation": max_rel_h_drift,
            "min_geocentric_alt_km": round(min_alt_km_observed, 3) if np.isfinite(min_alt_km_observed) else None,
            "max_geocentric_alt_km": round(max_alt_km_observed, 3) if np.isfinite(max_alt_km_observed) else None,
        },
        "memory_plan": mem_plan,
        "hardware_benchmark": {
            "cpu_model": platform.processor() or platform.machine(),
            "cpu_logical_cores": os.cpu_count(),
            "total_system_ram_gb": round(psutil.virtual_memory().total / (1024 ** 3), 2),
            "process_rss_start_mb": round(rss_start_mb, 2),
            "process_rss_peak_mb": round(peak_rss_mb, 2),
            "wall_time_sec": round(wall_sec, 4),
            "throughput_states_per_sec": round(throughput, 1),
            "parquet_artifact_file": parquet_path.name if (parquet_path and parquet_path.exists()) else None,
            "parquet_artifact_mb": round(artifact_bytes / (1024 * 1024), 2),
        },
        "random_audit_snapshots": audit_snapshots,
    }

    report_path = ARTIFACTS_DIR / f"{run_id}_report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    report["report_file"] = report_path.name
    return report


def inspect_synthetic_object(
    catalog: SyntheticConstellationCatalog,
    sat_id: str,
    t_offset_sec: float = 0.0,
    num_track_points: int = 96,
) -> Dict[str, Any]:
    """Return initial orbital elements, current propagated SI/km state, and 1-orbit track for one synthetic spacecraft."""
    if sat_id not in catalog.id_to_index:
        raise KeyError(f"Synthetic object '{sat_id}' not found in current catalog.")
    idx = catalog.id_to_index[sat_id]
    sh = catalog.shells[int(catalog.shell_indices[idx])]

    a_m = float(catalog.a_m[idx])
    e = float(catalog.e[idx])
    inc = float(catalog.inc_rad[idx])
    raan0 = float(catalog.raan0_rad[idx])
    argp0 = float(catalog.argp0_rad[idx])
    m0 = float(catalog.m0_rad[idx])
    period_sec = float(2.0 * np.pi * np.sqrt((a_m ** 3) / MU_EARTH_M3_S2))

    track_offsets = float(t_offset_sec) + np.linspace(0.0, period_sec, num_track_points, dtype=np.float64)
    r_eci_m, v_eci_m_s = propagate_j2_secular_chunk(
        np.array([a_m]),
        np.array([e]),
        np.array([inc]),
        np.array([raan0]),
        np.array([argp0]),
        np.array([m0]),
        track_offsets,
    )
    r_eci_km = r_eci_m[0] * 1e-3
    v_eci_km_s = v_eci_m_s[0] * 1e-3

    jd0, fr0 = datetime_to_jd_fr(catalog.epoch_utc)
    gmst_arr = jd_array_to_gmst_rad(jd0 + fr0 + track_offsets / 86400.0)
    r_ecef_km = eci_to_ecef_batch(r_eci_km, gmst_arr)
    lat_deg, lon_deg, alt_km = ecef_to_geodetic_batch(r_ecef_km)

    inv_r = 1.0 / R_EARTH_EQ_KM
    track_three = np.stack(
        [r_ecef_km[:, 0] * inv_r, r_ecef_km[:, 2] * inv_r, -r_ecef_km[:, 1] * inv_r],
        axis=-1,
    ).astype(np.float32).tolist()

    eval_dt = catalog.epoch_utc + timedelta(seconds=float(t_offset_sec))
    return {
        "mode": "SYNTHETIC_50K",
        "provenance": "HYPOTHETICAL_SIMULATED_SPACECRAFT",
        "sat_id": sat_id,
        "index": idx,
        "shell_id": sh.shell_id,
        "shell_name": sh.name,
        "plane_index": int(catalog.plane_indices[idx]),
        "slot_index": int(catalog.slot_indices[idx]),
        "controllable": bool(catalog.controllable_mask[idx]),
        "propagator": "Vectorized J2 Secular + Newton-Raphson Kepler (SI internal)",
        "frame": "ECI(J2000-aligned) -> ECEF(IAU-82 GMST simplified EOP)",
        "epoch_utc": catalog.epoch_utc.isoformat(),
        "eval_epoch_utc": eval_dt.isoformat(),
        "t_offset_sec": float(t_offset_sec),
        "orbital_period_sec": round(period_sec, 2),
        "initial_elements": {
            "a_km": round(a_m * 1e-3, 4),
            "eccentricity": round(e, 6),
            "inclination_deg": round(float(np.rad2deg(inc)), 4),
            "raan_deg": round(float(np.rad2deg(raan0)), 4),
            "arg_perigee_deg": round(float(np.rad2deg(argp0)), 4),
            "mean_anomaly_deg": round(float(np.rad2deg(m0)), 4),
        },
        "state": {
            "r_eci_km": [round(float(x), 4) for x in r_eci_km[0]],
            "v_eci_km_s": [round(float(x), 6) for x in v_eci_km_s[0]],
            "r_ecef_km": [round(float(x), 4) for x in r_ecef_km[0]],
            "lat_deg": round(float(lat_deg[0]), 4),
            "lon_deg": round(float(lon_deg[0]), 4),
            "alt_km": round(float(alt_km[0]), 3),
            "speed_km_s": round(float(np.linalg.norm(v_eci_km_s[0])), 5),
        },
        "track_threejs": track_three,
    }
