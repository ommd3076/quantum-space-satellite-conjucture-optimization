# Mathematical Formulation

## 1. Orbital Dynamics & Reference Frames
### Two-Body + $J_2$ Equations of Motion (ECI Frame)
In Earth-Centered Inertial (ECI, J2000-aligned) Cartesian coordinates $\mathbf{r} = [x, y, z]^T\text{ (km)}$ and $\mathbf{v} = \dot{\mathbf{r}}\text{ (km/s)}$:
$$\ddot{\mathbf{r}} = -\frac{\mu}{r^3}\mathbf{r} + \mathbf{a}_{J2}(\mathbf{r})$$
where $r = \|\mathbf{r}\|_2$, $\mu = 398600.4418\text{ km}^3/\text{s}^2$, $R_e = 6378.137\text{ km}$, $J_2 = 1.08262668 \times 10^{-3}$, and:
$$\mathbf{a}_{J2}(\mathbf{r}) = -\frac{3}{2} J_2 \frac{\mu R_e^2}{r^5} \begin{bmatrix} x \left(1 - 5\frac{z^2}{r^2}\right) \\ y \left(1 - 5\frac{z^2}{r^2}\right) \\ z \left(3 - 5\frac{z^2}{r^2}\right) \end{bmatrix}$$

### Conserved Two-Body Invariants (Verification Targets)
When $J_2 = 0$:
- Specific mechanical energy: $\varepsilon = \frac{1}{2}\|\mathbf{v}\|^2 - \frac{\mu}{r} = -\frac{\mu}{2a}$
- Specific angular momentum: $\mathbf{h} = \mathbf{r} \times \mathbf{v}$
- Orbital period: $T = 2\pi \sqrt{a^3 / \mu}$

### Secular $J_2$ Nodal Precession (Sun-Synchronous Verification)
$$\dot{\Omega}_{J2} = -\frac{3}{2} J_2 \left(\frac{R_e}{a(1-e^2)}\right)^2 n \cos i, \quad n = \sqrt{\frac{\mu}{a^3}}$$
A Sun-synchronous orbit requires $\dot{\Omega}_{J2} \approx +0.985647^\circ/\text{day}$ ($1.99106 \times 10^{-7}\text{ rad/s}$).

### Walker Delta $T / P / F$ Convention
For total satellites $T$, orbital planes $P$ ($T \bmod P = 0$, satellites per plane $S = T/P$), phasing parameter $F \in \{0, \dots, P-1\}$:
- Plane $p \in \{0, \dots, P-1\}$ RAAN: $\Omega_p = \Omega_0 + \frac{2\pi p}{P}$
- Satellite $s \in \{0, \dots, S-1\}$ in plane $p$ initial Mean Anomaly:
$$M_{p,s}(t_0) = \left(M_0 + \frac{2\pi s}{S} + \frac{2\pi F p}{T}\right) \bmod 2\pi$$

## 2. Scheduling Optimization Formulation
### Sets & Indices
- $\mathcal{S}$: Satellites, $|\mathcal{S}| = T$
- $\mathcal{I}$: Ground targets, each with priority $w_i > 0$, deadline $D_i$, required imaging duration $\delta^{\text{obs}}_i$ (s), data volume $v_i$ (Gb), cloud failure probability $c_{k} \in [0, 1)$
- $\mathcal{K}_s$: Feasible observation access opportunities for satellite $s$ (start $a_k$, end $b_k$, execution start $\tau_k \in [a_k, b_k - \delta^{\text{obs}}_i]$, target $i(k)$, off-nadir angle $\theta_k$)
- $\mathcal{G}_s$: Ground-station downlink contact windows for satellite $s$ (start $a_g$, end $b_g$, max downlink volume $Q_g = R_{\text{dl}}(b_g - a_g)$)

### Decision Variables
- $x_k \in \{0,1\}$: whether observation opportunity $k$ is executed
- $y_g \in \{0,1\}$ and $q_g \in [0, Q_g]$: downlink session activation and data volume (Gb) transferred during contact $g$

### Constraints
1. **Exclusivity & Slew Transition:** For consecutive scheduled tasks $u, v$ on satellite $s$, $\tau_v \ge \tau_u + \delta_u + \tau_{\text{setup}} + \frac{\Delta\psi(u,v)}{\omega_{\text{slew}}}$.
2. **Deadline:** $\tau_k + \delta^{\text{obs}}_{i(k)} \le D_{i(k)}$ whenever $x_k = 1$.
3. **Storage Dynamics (Gb):** $D_s(t^+) = D_s(t^-) + v_{i(k)} x_k$ after observation, $D_s(t^+) = D_s(t^-) - q_g$ after downlink, with $0 \le D_s(t) \le D_{\max}$ for all $t$.
4. **Energy Dynamics (Wh):** Over each interval $[t_a, t_b]$, $E_s(t_b) = \min(E_{\max}, E_s(t_a) + P_{\text{sun}} \cdot \Delta t_{\text{sunlit}} - P_{\text{idle}} \Delta t - P_{\text{task}} \delta_{\text{task}})$ with $E_s(t) \ge E_{\min}$ at all event boundaries.
5. **Single-Credit Objective & Downlink Delivery:** Deterministic objective rewards unique captured-and-downlink-feasible observations weighted by priority $w_i$ (with partial capture credit $\alpha_{\text{cap}} = 0.25$ and full delivery credit $1.0$ when downlinked before horizon end, identical across all solvers). Stochastic evaluation draws deterministic seeded Bernoulli cloud/outage realizations per scenario seed.

## 3. Candidate Research Algorithm (`SRA-RHR`) Mechanics
1. **Shadow Pricing ($\pi^{\text{dl}}_s(t)$):** Estimates remaining downlink capacity $C^{\text{rem}}_s(t) = \sum_{g: a_g \ge t} Q_g$ vs. current buffered data $D_s(t)$, setting scarcity multiplier $\pi^{\text{dl}}_s(t) = \beta_{\text{dl}} \cdot \max(0, \frac{D_s(t) + v_k}{C^{\text{rem}}_s(t) + \epsilon} - 0.5)$.
2. **Submodular Risk-Aware Utility:** For target $i$ already covered by scheduled set $A_i$ with failure probabilities $\{c_j\}_{j \in A_i}$, marginal expected success probability of adding opportunity $k$ is:
$$\Delta P_i(k \mid A_i) = \left(\prod_{j \in A_i} c_j\right) (1 - c_k)$$
(Under deterministic single-assignment mode where $|A_i| \le 1$, this reduces to risk-adjusted expected priority $w_i(1 - \lambda_{\text{risk}} c_k)$.)
3. **Constraint-Preserving Incremental Repair:** When an observation fails due to realized cloud cover or a ground station experiences an outage at decision epoch $t_r$, only affected satellites enter a bounded local repair pass (1-for-1 swap + unscheduled opportunity insertion) preserving all already-committed past actions and exact battery/storage invariants.
- **Complexity:** $O(N_{\text{slices}} \cdot (|\mathcal{K}_{\text{win}}| \log |\mathcal{K}_{\text{win}}| + |\mathcal{S}| \cdot K_{\text{repair}}))$ per run — polynomial in window count.
- **Guarantees:** Hard-constraint feasibility guaranteed by incremental forward-simulation acceptance gate and verified independently by `verifier.ts`. **No global optimality guarantee is claimed (unproven heuristic).**
