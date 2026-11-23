# Constellation Lab — Orbital Simulation & Optimization Research Platform

Research-grade LEO Earth-observation satellite constellation simulation, visibility/resource modeling, classical optimization baselines, candidate adaptive scheduling algorithm (`SRA-RHR`), independent feasibility verification, and reproducible multi-seed experimentation.

## Scientific Integrity & Scope
- **Provisional Starting Problem (Not Historically Confirmed):** Physics-constrained design and adaptive scheduling of a LEO Earth-observation satellite constellation under limited observation windows, onboard energy/storage, downlink opportunities, and synthetic stochastic cloud/outage events.
- **No Fabricated Data:** All trajectories, access windows, schedules, objective scores, runtime measurements, and confidence intervals are computed dynamically by the scientific backend (`backend/src/`) and verified independently (`backend/src/validation/verifier.ts`).
- **Provenance Tracking:** Every parameter is explicitly tagged `VERIFIED_SOURCE`, `MODEL_ESTIMATE`, `SYNTHETIC_ASSUMPTION`, `MEASURED_EXPERIMENT`, or `UNVERIFIED` in the **Scientific Audit Center** and `research/assumptions_register.md`.

## Quick Start
```bash
npm install
npm test          # Runs physics, numerical convergence, verifier, and optimization unit tests
npm run dev       # Launches Express Scientific API + Vite React/Three.js UI on http://localhost:3000
npm run build     # Production frontend bundle
```

## Architecture
- `backend/src/physics/` — WGS84/IAU physical constants and provenance ledger.
- `backend/src/frames/` — UTC→JD→GMST, ECI↔ECEF, WGS84 geodetic transforms, topocentric access geometry, and cylindrical Earth shadow eclipse.
- `backend/src/orbits/` — Newton-Raphson Keplerian solver, COE↔ECI conversions, analytical $J_2$ SSO precession, RK4 Two-Body+$J_2$ numerical propagator, and Walker Delta $T/P/F$ generator.
- `backend/src/geometry/` — Target FOV access windows, ground-station contacts, seeded correlated cloud/outage generator, and revisit/fairness analytics.
- `backend/src/validation/` — Independent constraint verifier (`verifier.ts`) and live scientific audit suite (`auditSuite.ts`).
- `backend/src/algorithms/` — Deterministic Greedy, Deadline-Urgency Heuristic, Exact/Bounded Branch-and-Bound (MILP-style with certified dual upper bound), Standard Rolling-Horizon, and Candidate `SRA-RHR` with 3 ablation toggles.
- `experiments/` — Paired multi-seed benchmark & component ablation runner persisting raw JSON artifacts to `experiments/outputs/`.
- `research/` — Phase 0 scientific documentation (`problem_definition.md`, `literature_review.md`, `novelty_audit.md`, `mathematical_formulation.md`, `assumptions_register.md`, `constellation_decision.md`, `limitations.md`).
- `tests/` — Deterministic `node:test` physics & optimization verification suites.

## Execution Environment Limitations
The interactive container runs Node.js v22 without Python scientific packages (`numpy`, `scipy`, `ortools`, `orekit`, `basilisk`). Accordingly, the live numerical engine executes in deterministic IEEE-754 double-precision TypeScript inside Express. External trajectory cross-checks against Orekit/GMAT/Basilisk are marked `UNVERIFIED` until run offline.
