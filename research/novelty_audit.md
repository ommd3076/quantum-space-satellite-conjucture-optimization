# Novelty Audit & Candidate Algorithm Selection

**Novelty Status Declaration:** `UNESTABLISHED / CANDIDATE_SYNTHESIS`  
This audit explicitly prohibits claiming proven novelty or publication readiness prior to empirical benchmarking and external peer review.

## 1. Three Candidate Research Mechanisms Evaluated

| Criterion | Candidate A: Multi-Stage Stochastic MILP (Benders) | Candidate B: Decentralized Consensus Auction (CBBA-EO) | Candidate C (Selected): Submodular Risk-Aware Rolling-Horizon with Downlink Shadow Pricing & Incremental Repair (`SRA-RHR`) |
| :--- | :--- | :--- | :--- |
| **Physical Relevance** | High for offline planning, poor for real-time outages | High for ISL-equipped fleets (requires ISL model not in baseline) | High: directly couples cloud risk, storage/downlink bottleneck, and event-triggered repair without requiring unmodeled ISLs |
| **Novelty Plausibility** | Low (closely mirrors Valicka et al. 2019 two-stage MIP) | Low-Moderate (well-studied in multi-agent robotics) | Moderate-Low as individual parts, plausible as a unified coupled mechanism; **must be ablated** |
| **Math Tractability** | Exponential scaling in scenarios $\times$ tasks | Heuristic convergence only under coupled battery/storage | Polynomial-time per horizon slice $O(W \log W + R \cdot K)$ with explicit dual scarcity signal |
| **Testability & Ablation** | Hard to ablate within tight browser/API time budgets | Requires synthetic ISL topology assumptions | Cleanly decomposes into 3 independently toggleable mechanisms (`risk_aware`, `shadow_pricing`, `incremental_repair`) |
| **Implementation Budget** | Exceeds pure-TS solver latency budget | Medium | Fits cleanly inside deterministic reproducible engine alongside exact Branch-and-Bound baseline |

## 2. Honest Assessment of Prior Art Overlap
- **Cloud risk discounting & backup scheduling** is established prior art (Wang et al. 2016; Valicka et al. 2019).
- **Rolling-horizon replanning** is established prior art (Qiu et al. 2013).
- **Lagrangian / shadow pricing of storage & downlink bottlenecks** is standard in network optimization and operations research.
- **Local swap/repair heuristics** are standard in combinatorial scheduling.

**What is specifically tested here:** Whether coupling (1) submodular marginal cloud-risk utility (penalizing correlated cloud failure and rewarding backup observations only by marginal probability gain $1 - \prod c_k$), (2) forward-looking downlink/energy shadow pricing derived from each satellite's remaining contact capacity, and (3) event-triggered constraint-preserving incremental repair (1-for-1 swap and eject-insert) yields measurable, statistically significant gains over standard rolling-horizon and exact/heuristic baselines under downlink scarcity and stochastic cloud/outage regimes.

## 3. Integrity Commitment
- If empirical benchmarks or ablations show SRA-RHR fails to outperform standard Rolling Horizon or Greedy, **that negative result will be logged, displayed in the UI, and retained without cherry-picking**.
- No theoretical optimality guarantee is claimed for SRA-RHR; it is a polynomial-time constructive + repair heuristic with guaranteed hard-constraint feasibility (verified independently by `verifier.ts`).
