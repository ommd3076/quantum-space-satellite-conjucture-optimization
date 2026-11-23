"""Central configuration, physical constants (SI & km), and provenance declarations."""
from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BASE_DIR.parent

DATA_DIR = Path(os.environ.get("SCIENCE_DATA_DIR", str(BASE_DIR / "data")))
CATALOG_CACHE_DIR = DATA_DIR / "catalogs"
ARTIFACTS_DIR = DATA_DIR / "artifacts"
EXPERIMENTS_RESULTS_DIR = REPO_ROOT / "experiments" / "results"

for _d in (DATA_DIR, CATALOG_CACHE_DIR, ARTIFACTS_DIR, EXPERIMENTS_RESULTS_DIR):
    _d.mkdir(parents=True, exist_ok=True)

# CelesTrak GP/OMM policy compliance:
# Per https://celestrak.org/usage-policy.php, GP data updates every ~2 hours;
# cache snapshots locally and never hammer endpoints from UI loops.
CELESTRAK_GP_BASE_URL = "https://celestrak.org/NORAD/elements/gp.php"
CELESTRAK_MIN_CACHE_AGE_SEC = int(os.environ.get("CELESTRAK_MIN_CACHE_AGE_SEC", "7200"))

# Optional user-authorized Space-Track credentials (read exclusively from env, NEVER hardcoded)
SPACETRACK_IDENTITY = os.environ.get("SPACETRACK_IDENTITY", "")
SPACETRACK_PASSWORD = os.environ.get("SPACETRACK_PASSWORD", "")

# WGS84 & EGM96/IAU physical constants (VERIFIED_SOURCE: NGA TR8350.2 / IAU)
MU_EARTH_M3_S2 = 3.986004418e14          # m^3 / s^2
MU_EARTH_KM3_S2 = 398600.4418            # km^3 / s^2
R_EARTH_EQ_M = 6_378_137.0               # m (WGS84 semi-major axis)
R_EARTH_EQ_KM = 6378.137                 # km
FLATTENING_WGS84 = 1.0 / 298.257223563
E2_WGS84 = FLATTENING_WGS84 * (2.0 - FLATTENING_WGS84)
J2_EARTH = 1.08262668e-3                 # EGM96 unnormalized J2
OMEGA_EARTH_RAD_S = 7.2921150e-5         # rad/s nominal Earth rotation rate
G0_M_S2 = 9.80665                        # Standard gravity for rocket equation

# WGS-72 constants used by SGP4/SDP4 (Vallado 2006 / sgp4 library default)
MU_WGS72_KM3_S2 = 398600.8
R_WGS72_KM = 6378.135

# Coordinate-frame fidelity disclosure
FRAME_FIDELITY_NOTE = (
    "TEME-to-ITRF/ECEF uses IAU-1982 GMST rotation (simplified Earth orientation: "
    "UT1-UTC=0 and polar motion xp=yp=0 neglected; ~15-30 m surface uncertainty vs full IERS EOP)."
)
