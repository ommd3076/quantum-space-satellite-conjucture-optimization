# Constellation Design Decision — Provisional Reference Baseline

**Status:** PROVISIONAL REFERENCE SCENARIO (LOCKED FOR FAIR SOLVER COMPARISON, NOT PRESUMED OPTIMAL)

## 1. Candidate Scale Trade-Space
Per Phase 1, three candidate fleet scales are supported in the Constellation Designer and Benchmark Suite:
- **Small Fleet (6–12 satellites):** e.g., Walker `12/3/1` ($h=550\text{ km}$, $i=97.59^\circ$) — fast exact solver verification, high revisit gaps.
- **Provisional Reference Fleet (24 satellites):** Walker `24/6/1` ($h=550\text{ km}$, $e=0.001$, $i=97.59^\circ$ SSO, $\pm 30^\circ$ off-nadir FOV) — balanced global coverage and realistic scheduling contention.
- **Large Fleet (48–96 satellites):** e.g., Walker `48/8/1` — tests scalability of heuristics and rolling-horizon solvers.

## 2. Sun-Synchronous Inclination Verification ($J_2$ Model)
For $h = 550\text{ km}$ ($a = R_e + h = 6928.137\text{ km}$), $e = 0.001$, $p = a(1-e^2) \approx 6928.130\text{ km}$:
- Mean motion $n = \sqrt{\mu / a^3} \approx 1.09475 \times 10^{-3}\text{ rad/s}$ (orbital period $T \approx 5739.3\text{ s} \approx 95.66\text{ min}$).
- Required Sun-synchronous nodal precession: $\dot{\Omega}_{\text{SSO}} = \frac{2\pi}{365.2421897 \times 86400} \approx 1.99106 \times 10^{-7}\text{ rad/s}$ ($+0.98565^\circ/\text{day}$).
- Solving $\cos i = -\frac{\dot{\Omega}_{\text{SSO}}}{\frac{3}{2} J_2 (R_e/p)^2 n}$ yields $i \approx 97.591^\circ$.
- This analytical value is verified numerically against our RK4 $J_2$ propagator in `tests/unit/physics.test.ts` and displayed live in **Orbit & Coverage Analytics**.

## 3. Ground Station Network (`SYNTHETIC_ASSUMPTION` Coordinates of Standard High-Latitude / Mid-Latitude Sites)
Default 6-station downlink network:
1. Svalbard (`78.23°N, 15.41°E`, min elev $5^\circ$)
2. Fairbanks (`64.86°N, -147.85°W`, min elev $5^\circ$)
3. Punta Arenas (`-53.16°S, -70.91°W`, min elev $5^\circ$)
4. Hartebeesthoek (`-25.89°S, 27.69°E`, min elev $7^\circ$)
5. Dongara (`-29.25°S, 114.93°E`, min elev $7^\circ$)
6. Madrid (`40.43°N, -4.25°W`, min elev $7^\circ$)

All scenario manifests are deterministically serialized and hashed with SHA-256 before any solver executes so every baseline and candidate algorithm sees byte-identical inputs.
