# Data Provenance & Source Integrity Policy

## 1. Strict Mode Separation
Constellation Lab enforces an unbreakable boundary between two operational regimes:

1. **`REAL_CATALOG`:** Contains exclusively publicly catalogued space objects ingested from real, date-stamped GP/OMM CSV snapshots (CelesTrak `gp.php?GROUP=<group>&FORMAT=csv`, or optional user-authorized Space-Track GP).
   - Supports $\ge 6$-digit `NORAD_CAT_ID` values (no legacy 5-digit TLE truncation).
   - Every snapshot stores raw immutable CSV bytes, SHA-256 digest, exact source URL, UTC retrieval timestamp, deduplicated object counts, classification histogram (`PAYLOAD`, `ROCKET_BODY`, `DEBRIS`, `UNKNOWN`), element epoch range, median element age, and stale count ($>7$ days).
   - CelesTrak update-policy compliance: cached locally for at least `CELESTRAK_MIN_CACHE_AGE_SEC` (default 7200 s) with a 600 s cooldown even on manual refresh; UI never polls CelesTrak directly.
   - If network access is unavailable and no verified local snapshot exists, the backend returns `status = DATA_NOT_RETRIEVED` with `0` objects — never fabricated real-looking satellites.

2. **`SYNTHETIC_50K`:** Contains **50,000 separately initialized, hypothetical spacecraft** across a documented 10-shell Walker Delta family (`SYN-S01-P001-S001` through `SYN-S10-...`) for computational scalability, proximity screening, and subset scheduling stress tests.
   - Explicitly labeled `HYPOTHETICAL_SIMULATED_CONSTELLATION`.
   - Does NOT represent a present-day active fleet or a collision-safe operational deployment.
   - Distinguishes controllable spacecraft (eligible for impulsive $\Delta v$ maneuvers and tasking) from background simulated traffic.

## 2. Ground Stations & Resource Assumptions
- Ground-station geodetic coordinates (`GS-SVALBARD`, `GS-TROLL`, `GS-KIRUNA`, `GS-FAIRBANKS`, `GS-WALLOPS`, `GS-CANBERRA`) are `VERIFIED_SOURCE` public facility coordinates.
- Downlink bitrates, cloud cover probabilities, onboard battery/storage budgets, and spacecraft propulsion mass/$I_{sp}$ parameters are explicitly tagged `SYNTHETIC_ASSUMPTION`.
