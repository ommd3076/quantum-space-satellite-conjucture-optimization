# Problem Definition — Constellation Lab

**Status:** PROVISIONAL STARTING PROBLEM (NOT HISTORICALLY CONFIRMED)  
**Date Locked:** 2026-11-23  
**Provenance Classification:** `SYNTHETIC_ASSUMPTION` (mission scenario parameters) paired with `VERIFIED_SOURCE` (WGS84/IAU astrodynamics constants)

## 1. Context Separation
No prior historical constellation proposal file, repository history, or previous study title was present in the provided workspace. In strict adherence to the Critical Context Rule, this platform adopts and locks the following **provisional, not historically confirmed** research problem:

> **Physics-constrained design and adaptive scheduling of a low-Earth-orbit (LEO) Earth-observation satellite constellation under limited observation windows, onboard energy and storage bounds, ground-station downlink opportunities, and stochastic cloud/outage events.**

## 2. Mission Specification
- **Mission Type:** Agile optical/multispectral Earth-observation (EO) LEO constellation imaging discrete global points of interest (POIs) and downlinking collected imagery to a distributed ground-station network.
- **Target Geography:** Global multi-latitude target distribution spanning equatorial ($0^\circ$–$20^\circ$), mid-latitude ($20^\circ$–$55^\circ$), and high-latitude ($55^\circ$–$72^\circ$) sites, plus regional disaster/monitoring clusters (all synthetic coordinates explicitly labeled `SYNTHETIC_ASSUMPTION`).
- **Planning Horizon:** Configurable, default $H = 6\text{ hours}$ ($21,600\text{ s}$, $\approx 3.75$ LEO revolutions at $550\text{ km}$) with discrete propagation grid $\Delta t = 30\text{ s}$ (and $5\text{ s}$ RK4 integration sub-steps). Extended $24\text{ h}$ horizon supported for coverage/revisit analysis.

## 3. Decision Variables, Constraints & Objective
- **Decision Variables:**
  - $x_{s,k} \in \{0, 1\}$: Assign satellite $s \in \mathcal{S}$ to execute observation opportunity $k \in \mathcal{W}^{\text{obs}}_s$ for target $i(k)$ within its geometrically valid line-of-sight & FOV visibility window $[t^{\text{start}}_k, t^{\text{end}}_k]$.
  - $y_{s,d} \in \{0, 1\}$ and transferred data volume $q_{s,d} \in [0, Q^{\max}_{s,d}]$: Execute downlink session during valid ground-station contact window $d \in \mathcal{W}^{\text{dl}}_s$.
- **Physical & Operational Constraints:**
  1. **Geometric Visibility & Off-Nadir FOV:** Observations occur strictly inside numerically propagated access windows with off-nadir angle $\theta \le \theta_{\max}$ and Earth non-occultation.
  2. **Target Non-Duplication & Deadlines:** Each target $i$ is rewarded at most once (or with diminishing submodular backup credit only when cloud-uncertain realizations are evaluated) prior to deadline $D_i$.
  3. **Exclusivity & Attitude Slew Transition:** A satellite executes at most one task at a time; consecutive tasks $k_1 \to k_2$ require $\Delta t \ge \tau_{\text{setup}} + \Delta\psi(k_1, k_2) / \omega_{\text{slew}}$.
  4. **Onboard Energy Conservation:** Battery state-of-charge $E_s(t) \in [E_{\min}, E_{\max}]$ tracks continuous solar charging in sunlit arcs (using cylindrical Earth shadow geometry), baseline bus draw, imaging draw, and downlink draw.
  5. **Onboard Storage & Downlink Coupling:** Solid-state recorder $D_s(t) \in [0, D_{\max}]$ increases by $\Delta D_k$ on observation and decreases during verified ground-station contacts at data rate $R_{\text{dl}}$.
- **Primary Objective (Optimized):** Maximize total priority-weighted delivered observation utility subject to exact hard feasibility verified by an independent verifier. Under stochastic evaluation, measure realized (post-cloud, post-outage) delivered priority value.
- **Monitored Metrics (Not Directly Optimized Unless Specified):** Coverage fraction, mean/max revisit gap (s), Jain's regional fairness index, mean data delivery latency (s), peak storage utilization (%), minimum battery margin (%), solver runtime (ms), dual optimality gap (%), and independent verifier violation count (must be 0).

## 4. Falsifiable Research Hypothesis
- **Hypothesis ($H_1$):** On paired frozen LEO Earth-observation scenarios with correlated cloud-cover probabilities and ground-station downlink bottlenecks, the candidate algorithm **SRA-RHR** (*Submodular Risk-Aware Rolling-Horizon with Constraint-Preserving Incremental Repair*) achieves statistically higher realized priority-weighted delivered value (positive paired mean difference with 95% confidence interval strictly $> 0$) than deterministic greedy, deadline-priority heuristic, and standard rolling-horizon baselines under equal compute budgets, with zero independently verified constraint violations.
- **Falsification Conditions:** $H_1$ is falsified if:
  1. Any independently verified resource or timing violation occurs in SRA-RHR; or
  2. The 95% confidence interval of the paired realized-utility difference against standard rolling-horizon or greedy baselines includes $0$ or is negative across the held-out suite; or
  3. Component ablation shows that disabling any proposed mechanism (`risk_aware`, `downlink_shadow_pricing`, `incremental_repair`) does not degrade or actually improves realized performance across the suite.
