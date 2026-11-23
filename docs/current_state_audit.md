# Constellation Lab — Milestone 0 Forensic Current-State Audit

**Audit Timestamp (UTC):** 2026-11-23  
**Auditor:** Automated Engineering Audit (direct file & runtime inspection)  
**Repository State:** Local workspace without `.git` history (`git status` reports not a git repository).

---

## 1. Runtime Environment Findings (Directly Observed)

| Component | Observed Value | Status |
| --- | --- | --- |
| OS / Kernel | `Linux localhost 4.19.0-gvisor x86_64` | Verified |
| CPU / Memory | 4 vCPU, 12 GiB RAM (~11 GiB available), 0 swap | Verified |
| Compilers | `/usr/bin/gcc`, `/usr/bin/g++` | Verified |
| Node.js | `v22.23.2` + `tsx 4.21.0` + `vite 8.3.0` + `express 4.21.2` | Verified |
| Python | `/usr/bin/python3` (`Python 3.11.2`), stdlib `venv` available (`ensurepip` absent; `get-pip.py` + PyPI reachable over HTTPS) | Verified |
| Network (CelesTrak) | `HEAD https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=csv` → `HTTP/2 200` | Verified |
| Dev Server (`server.ts`) | Running on `http://0.0.0.0:3000`; `GET /api/health` returns `200 OK` | Verified |

---

## 2. File-by-File Inventory & Metric Provenance Audit

### 2.1 Server & API Gateway
- **`/server.ts`** (241 lines): Express server on port `3000` hosting Vite middleware (`dev`) or `dist/` (`prod`). Currently executes **all** propagation, access geometry, optimization, paired experiments, and audit checks directly in Node.js/TypeScript in-process (`/api/presets`, `/api/propagate`, `/api/solve`, `/api/experiments/run`, `/api/audit`, `/api/research/:filename`).
- **`/src/api/client.ts`** (115 lines): Thin `fetch()` client targeting `/api/*` endpoints. No Python service health/offline ribbon or binary `Float32` frame streaming yet.

### 2.2 Orbital Dynamics & Geometry (TypeScript — Prior Implementation)
- **`/backend/src/physics/constants.ts`**: Hardcoded WGS84/IAU constants (`MU_EARTH_KM3_S2 = 398600.4418`, `R_EARTH_KM = 6378.137`, `J2_EARTH = 1.08262668e-3`).
- **`/backend/src/orbits/kepler.ts`**: Newton-Raphson Kepler solver, COE $\leftrightarrow$ ECI conversions, analytical $J_2$ RAAN drift formula.
- **`/backend/src/orbits/propagator.ts`** (277 lines):
  - **Hard cap:** Line 144 restricts `totalSatellites` to `[1, 96]`. Cannot scale to 50,000 objects.
  - **Physics:** Two-Body Keplerian and fixed-step RK4 Two-Body + $J_2$ in TypeScript objects (`{x, y, z}`). No SGP4/SDP4, no GP/OMM ingestion, no TEME frame, no impulsive/finite-burn orbital maneuvers, no propellant accounting.
- **`/backend/src/frames/transforms.ts`**: Simplified IAU-82 GMST rotation only (no polar motion / UT1-UTC EOP table; no TEME $\leftrightarrow$ ITRF distinction).
- **`/backend/src/geometry/access.ts`** (398 lines):
  - Samples at discrete `sampleStepSec` (5–300 s) with **no horizon-crossing refinement** (window end padded by `+ sampleStepSec`, introducing up to 1-step timing bias).
  - Cloud cover and ground-station outages are **purely synthetic seeded PRNG realizations** (`SYNTHETIC_ASSUMPTION`).
  - Ground station coordinates are static preset constants (6 stations).

### 2.3 Optimization & Experiments (TypeScript — Prior Implementation)
- **`/backend/src/algorithms/{greedy,heuristic,cpsat,rolling_horizon,proposed}/index.ts`**:
  - Note: `algorithms/cpsat/index.ts` is actually a **custom JavaScript depth-first branch-and-bound**, NOT Google OR-Tools CP-SAT!
  - All 5 solvers operate on the small 12–48 satellite synthetic EO scheduling problem.
  - **Prior novelty claim status:** Unproven. Prior 5-seed run on `reference_24_6_1` yielded inconclusive/negative delta for `SRA-RHR` vs. `rolling_horizon` (`-5.2 ± 90.9`) and was rightly labeled `FALSIFIED_OR_INCONCLUSIVE`. It must remain labeled **unproven**.
- **`/backend/src/validation/verifier.ts`**: Internal TypeScript feasibility checker (checks schedule constraints, not independent cross-engine orbital verification).

### 2.4 Existing Tests & Verification Gaps
- **`/tests/unit/physics.test.ts`** and **`/tests/optimization/algorithms.test.ts`**:
  - Observed passing via `tsx --test` (10 tests), **however** these are self-consistency tests of the TypeScript equations against themselves (energy/momentum conservation, round-trip inversions, analytical $J_2$ formula).
  - **Critical Gap:** ZERO independent cross-validation against canonical reference implementations (e.g., Vallado 2006 SGP4 test vectors, C++ `sgp4`, `scipy.integrate.solve_ivp(DOP853)`, or Orekit/GMAT).
  - **Critical Gap:** ZERO real catalog GP/OMM ingestion or provenance tracking.
  - **Critical Gap:** ZERO 50,000-object propagation capability, memory budget, chunked columnar persistence, or hardware performance profiling.
  - **Critical Gap:** ZERO translational $\Delta v$ orbital maneuvers or rocket-equation fuel accounting.
  - **Critical Gap:** ZERO conjunction broad-phase/narrow-phase screening.

### 2.5 Frontend UI (Preserve!)
- **`/src/App.tsx`**, **`/src/components/EarthGlobe3D.tsx`**, **`/src/views/*.tsx`**:
  - Functional 6-tab workspace (`Mission`, `Designer`, `Coverage`, `Algorithms`, `Experiments`, `Audit`) with working Three.js WGS84 Earth globe, procedural cartography, composite spacecraft, and diagnostics drawer.
  - **UI Migration Constraint:** Preserve navigation, layout, and 3D Earth aesthetic. Upgrade `EarthGlobe3D.tsx` to render up to 50,000 objects via GPU `THREE.Points` fed by binary `Float32` frames from the Python backend, keeping the detailed 5-part satellite mesh + orbit trail for the selected object, and add the required Scientific Status / Provenance Ribbon without silent TypeScript fallback when Python is offline.

---

## 3. Exact Architecture & Migration Plan

1. **Bootstrap Isolated Python Scientific Environment (`scientific_backend/.venv`)**:
   - Pin `fastapi`, `uvicorn`, `numpy`, `scipy`, `sgp4` (C++ `SatrecArray`), `pyarrow`, `ortools`, `httpx`, `pytest`, `psutil`.
   - Ship `Dockerfile.science`, `docker-compose.yml`, and `README_RUN_SCIENCE.md` for fully portable local/container execution.
2. **Milestone 1 — Real Source Data & Provenance (`scientific_backend/app/catalogs/celestrak.py`)**:
   - Live CelesTrak GP/OMM CSV adapter (supporting $\ge 6$-digit NORAD IDs) respecting CelesTrak caching/rate-limit policy + optional user-authorized Space-Track GP adapter via `SPACETRACK_IDENTITY` / `SPACETRACK_PASSWORD` environment variables.
   - Immutable raw snapshot caching with SHA-256 hash, retrieval UTC timestamp, source URL, deduplication by `NORAD_CAT_ID`, explicit object-type separation (`PAYLOAD`, `ROCKET_BODY`, `DEBRIS`, `UNKNOWN`), data-age computation, and explicit `DATA_NOT_RETRIEVED` state if offline without cache.
3. **Milestone 2 — Validated Orbital Physics & Maneuvers (`propagation/`, `frames/`, `maneuvers/`)**:
   - `REAL_CATALOG`: C++-accelerated `sgp4` (`Satrec.omm` + `SatrecArray.sgp4`) preserving TEME/WGS-72 mean-element semantics and reporting every SGP4 error code (`0..6`).
   - `SYNTHETIC_50K`: Exactly 50,000 uniquely initialized spacecraft across documented multi-shell Walker Delta families; vectorized $J_2$ analytical/secular + numerical Two-Body + $J_2$ RK4/DOP853 in SI units.
   - Impulsive $\Delta v$ orbital maneuvers in ECI or RTN frame on controllable synthetic spacecraft with `scipy.integrate.solve_ivp(DOP853)` post-maneuver propagation and Tsiolkovsky propellant accounting (explicitly forbidding "TLE editing").
   - Independent validation against Vallado 2006 SGP4 reference vectors and `scipy.integrate.solve_ivp(DOP853)` high-order reference integrator.
4. **Milestone 3 — 50,000-Object Scalable Engine & Job Queue (`jobs/`, `scripts/bench_50k.py`)**:
   - Chunked propagation over 50,000 objects × 288 steps (24h @ 5-min = 14,400,000 state samples) and 1-minute high-rate stress test, streaming to compressed Parquet artifacts with explicit memory accounting, RSS/peak RAM, throughput (states/sec), progress, cancellation, and compact binary `Float32` frames for WebGL.
5. **Milestone 4 — Dense Access Windows & Broad/Narrow Conjunction Screening (`access/`, `screening/`)**:
   - WGS84 ellipsoid visibility + off-nadir FOV with bisection horizon-crossing refinement (sub-second entry/exit precision) and event lifecycle logs.
   - Scalable `scipy.spatial.cKDTree` broad-phase neighbor search + narrow-phase closest-approach refinement (explicitly labeled geometric screening, NOT $P_c$).
6. **Milestone 5 — Real OR-Tools CP-SAT & Baselines (`optimization/`)**:
   - Google OR-Tools CP-SAT exact solver + Greedy + Earliest-Deadline Weighted + Rolling Horizon + Locality-Aware Hierarchical Repair (`H-RHR`, honestly labeled unproven) with decoupled independent verifier and artifact logging.
7. **Milestone 6 & 7 — Express Proxy Gateway + Existing 3D Frontend Integration + Reproducible Package**:
   - Express (`server.ts`) proxies `/api/science/*` strictly to Python FastAPI (`PYTHON_SCIENCE_URL`, default `http://127.0.0.1:8000`) and returns explicit `503 BACKEND_OFFLINE` when unreachable — zero silent TypeScript fallback.
   - Upgrade `EarthGlobe3D.tsx` + `MissionControlView.tsx` + Audit/Algorithms/Experiments views to consume real Python frames, binary Float32 50k clouds, object inspection, maneuver execution, and provenance ribbon while preserving existing navigation and visual design.
