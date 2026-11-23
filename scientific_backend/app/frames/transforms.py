"""Vectorized coordinate frame & time-scale transforms (NumPy).

Supports:
- UTC datetime -> Julian Date (jd, fr) for SGP4 & GMST
- IAU-1982 GMST (Vallado Eq. 3-47) for TEME/ECI <-> ECEF/ITRF (simplified EOP mode, explicitly disclosed)
- WGS84 Geodetic (lat, lon, alt) <-> ECEF
- Topocentric SEZ elevation, azimuth, range, off-nadir angle, and spherical/ellipsoidal horizon check
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Tuple

import numpy as np

from app.config import E2_WGS84, R_EARTH_EQ_KM


def datetime_to_jd_fr(dt: datetime) -> Tuple[float, float]:
    """Convert timezone-aware UTC datetime to two-part Julian Date (jd, fr) matching sgp4.api.jday."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    y = dt.year
    m = dt.month
    d = dt.day
    if m <= 2:
        y -= 1
        m += 12
    a = y // 100
    b = 2 - a + a // 4
    jd_day = float(int(365.25 * (y + 4716)) + int(30.6001 * (m + 1)) + d + b - 1524.5)
    sec_of_day = (
        dt.hour * 3600.0
        + dt.minute * 60.0
        + dt.second
        + dt.microsecond * 1e-6
    )
    fr = sec_of_day / 86400.0
    return jd_day, fr


def jd_array_to_gmst_rad(jd_total: np.ndarray) -> np.ndarray:
    """Compute Greenwich Mean Sidereal Time (radians) via IAU-1982 formula (Vallado)."""
    t_ut1 = (jd_total - 2451545.0) / 36525.0
    gmst_sec = (
        67310.54841
        + (876600.0 * 3600.0 + 8640184.812866) * t_ut1
        + 0.093104 * (t_ut1 ** 2)
        - 6.2e-6 * (t_ut1 ** 3)
    )
    gmst_rad = np.mod(gmst_sec, 86400.0) * (2.0 * np.pi / 86400.0)
    return gmst_rad


def eci_to_ecef_batch(r_eci: np.ndarray, gmst_rad: np.ndarray) -> np.ndarray:
    """Rotate inertial positions (TEME or GCRF-aligned) to ECEF around Z by GMST.

    Parameters
    ----------
    r_eci : ndarray shape (..., 3)
    gmst_rad : ndarray broadcastable to r_eci.shape[:-1]
    """
    cos_g = np.cos(gmst_rad)
    sin_g = np.sin(gmst_rad)
    x = r_eci[..., 0]
    y = r_eci[..., 1]
    z = r_eci[..., 2]
    out = np.empty_like(r_eci)
    out[..., 0] = cos_g * x + sin_g * y
    out[..., 1] = -sin_g * x + cos_g * y
    out[..., 2] = z
    return out


def ecef_to_eci_batch(r_ecef: np.ndarray, gmst_rad: np.ndarray) -> np.ndarray:
    """Rotate ECEF positions to inertial frame around Z by -GMST."""
    return eci_to_ecef_batch(r_ecef, -gmst_rad)


def geodetic_to_ecef_km(lat_deg: float, lon_deg: float, alt_km: float = 0.0) -> np.ndarray:
    """WGS84 geodetic (deg, deg, km) -> ECEF position vector (km)."""
    lat = np.deg2rad(lat_deg)
    lon = np.deg2rad(lon_deg)
    sin_lat = np.sin(lat)
    cos_lat = np.cos(lat)
    n_val = R_EARTH_EQ_KM / np.sqrt(1.0 - E2_WGS84 * sin_lat * sin_lat)
    x = (n_val + alt_km) * cos_lat * np.cos(lon)
    y = (n_val + alt_km) * cos_lat * np.sin(lon)
    z = (n_val * (1.0 - E2_WGS84) + alt_km) * sin_lat
    return np.array([x, y, z], dtype=np.float64)


def ecef_to_geodetic_batch(r_ecef_km: np.ndarray) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Iterative Bowring/Heikkinen WGS84 ECEF (km) -> (lat_deg, lon_deg, alt_km)."""
    x = r_ecef_km[..., 0]
    y = r_ecef_km[..., 1]
    z = r_ecef_km[..., 2]
    p = np.hypot(x, y)
    lon = np.arctan2(y, x)
    lat = np.arctan2(z, np.maximum(p, 1e-12) * (1.0 - E2_WGS84))
    for _ in range(6):
        sin_lat = np.sin(lat)
        n_val = R_EARTH_EQ_KM / np.sqrt(1.0 - E2_WGS84 * sin_lat * sin_lat)
        lat = np.arctan2(z + E2_WGS84 * n_val * sin_lat, np.maximum(p, 1e-12))
    sin_lat = np.sin(lat)
    cos_lat = np.cos(lat)
    n_val = R_EARTH_EQ_KM / np.sqrt(1.0 - E2_WGS84 * sin_lat * sin_lat)
    alt = np.where(
        np.abs(cos_lat) > 1e-6,
        p / np.where(np.abs(cos_lat) > 1e-6, cos_lat, 1.0) - n_val,
        np.abs(z) / np.maximum(np.abs(sin_lat), 1e-12) - n_val * (1.0 - E2_WGS84),
    )
    return np.rad2deg(lat), np.rad2deg(lon), alt


def compute_site_visibility_batch(
    sat_ecef_km: np.ndarray,
    site_lat_deg: float,
    site_lon_deg: float,
    site_alt_km: float = 0.0,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Compute (elevation_deg, off_nadir_deg, slant_range_km) from ground site to sat_ecef_km (..., 3)."""
    site_ecef = geodetic_to_ecef_km(site_lat_deg, site_lon_deg, site_alt_km)
    rho = sat_ecef_km - site_ecef  # site -> sat
    rho_norm = np.linalg.norm(rho, axis=-1)
    rho_safe = np.maximum(rho_norm, 1e-9)

    # Local geodetic Up unit vector at site
    lat = np.deg2rad(site_lat_deg)
    lon = np.deg2rad(site_lon_deg)
    up = np.array([
        np.cos(lat) * np.cos(lon),
        np.cos(lat) * np.sin(lon),
        np.sin(lat),
    ], dtype=np.float64)

    sin_el = np.clip(np.einsum("...i,i->...", rho, up) / rho_safe, -1.0, 1.0)
    el_deg = np.rad2deg(np.arcsin(sin_el))

    # Off-nadir angle at spacecraft between nadir (-r_sat) and target line-of-sight (-rho)
    sat_norm = np.maximum(np.linalg.norm(sat_ecef_km, axis=-1), 1e-9)
    # cos(off_nadir) = dot(-r_sat, -rho) / (|r_sat| |rho|) = dot(r_sat, rho) / (|r_sat| |rho|)
    cos_off = np.clip(
        np.einsum("...i,...i->...", sat_ecef_km, rho) / (sat_norm * rho_safe),
        -1.0,
        1.0,
    )
    off_nadir_deg = np.rad2deg(np.arccos(cos_off))
    return el_deg, off_nadir_deg, rho_norm
