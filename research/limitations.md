# Experimental Protocol & Limitations

## 1. Preregistered Experimental Protocol
- **Paired Frozen Scenarios:** Every solver (`greedy`, `deadline_heuristic`, `exact_bnb`, `rolling_horizon`, `proposed`) receives the identical scenario manifest (verified by identical SHA-256 hash), identical access windows, identical resource bounds, identical objective definition, and identical compute time budget.
- **Independent Verification Gate:** Every returned schedule is checked by `backend/src/validation/verifier.ts` without trusting the solver's own reported score or feasibility flag. Any schedule with $>0$ constraint violations is flagged `INVALID_VIOLATION` and excluded from valid utility rankings while counted explicitly in the failure ledger.
- **Statistical Reporting:** Multi-seed batches compute sample mean, standard deviation, 95% confidence intervals ($t_{n-1, 0.975} \cdot s / \sqrt{n}$), paired differences vs. standard Rolling Horizon, paired Cohen's $d$ effect size, min/max worst-case tail outcomes, and timeout/infeasibility counts.
- **Mandatory Component Ablation:** `SRA-RHR` is evaluated in four modes under identical seeds:
  1. `SRA-RHR (Full)` — all 3 mechanisms active
  2. `Ablation -NoRisk` — `useRiskAware = false`
  3. `Ablation -NoShadow` — `useShadowPricing = false`
  4. `Ablation -NoRepair` — `useIncrementalRepair = false`
- **No Cherry-Picking:** All run artifacts, including negative deltas, solver timeouts, and high-cloud degradation cases, are persisted and displayed in the Experiment Lab.

## 2. Explicit Execution Environment & Model Limitations
1. **Runtime Environment:** The interactive Google AI Studio container runs Node.js v22 + TypeScript (`tsx` + Express + Vite) without `numpy`, `scipy`, `ortools`, `orekit`, or `basilisk` pre-installed in Python. Consequently, the live scientific backend executes in deterministic IEEE-754 double-precision TypeScript (`backend/src/`), with unit tests executed directly via `tsx --test`. A standalone Docker / Python parity guide is documented in `README.md` and `Dockerfile`.
2. **External Astrodynamics Cross-Check Blocker:** Trajectories have been verified internally against analytical two-body invariants (energy, angular momentum, period), RK4 timestep convergence ($O(\Delta t^4)$), WGS84 coordinate round-trips, and analytical $J_2$ nodal precession rates, but have **NOT** been externally cross-checked against Orekit, GMAT, or Basilisk inside this container.
3. **Exact Solver Scaling:** The built-in Branch-and-Bound exact solver (`exact_bnb`) certifies proven global optimality (`OPTIMAL`, gap $0.00\%$) on small-to-medium instances and returns best feasible incumbents with real dual upper bounds and optimality gaps when hitting the configured time budget on large 24–48 satellite constellations.
4. **Simplified Physics & Synthetic Weather:** Atmospheric drag, third-body perturbations, full IERS EOP frame transformations, high-fidelity reaction-wheel torque curves, and real satellite weather forecasts are intentionally omitted rather than faked.
