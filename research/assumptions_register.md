# Assumptions Register & Provenance Ledger

Every model parameter in Constellation Lab carries an explicit provenance tag:
- `VERIFIED_SOURCE`: Standard physical/geodetic constants (WGS84, IAU) or verified literature citations.
- `SYNTHETIC_ASSUMPTION`: Reproducible engineering or mission parameters constructed for controlled benchmarking; **not real satellite telemetry or measured operations**.
- `MODEL_ESTIMATE`: Analytical or numerical approximation with known fidelity bounds.
- `MEASURED_EXPERIMENT`: Directly timed or computed from executed solver/simulation runs.
- `UNVERIFIED`: External validation or citation items that could not be checked in this environment.

| ID | Parameter / Model Component | Value / Formulation | Provenance | Justification & Simplification Limits |
| :--- | :--- | :--- | :--- | :--- |
| A-01 | Earth Gravitational Parameter $\mu$ | $398600.4418\text{ km}^3/\text{s}^2$ | `VERIFIED_SOURCE` | WGS84 / EGM96 standard |
| A-02 | Earth Equatorial Radius $R_e$ | $6378.137\text{ km}$, $f=1/298.257223563$ | `VERIFIED_SOURCE` | WGS84 reference ellipsoid |
| A-03 | Zonal Harmonic $J_2$ | $1.08262668 \times 10^{-3}$ | `VERIFIED_SOURCE` | EGM96/WGS84 dominant oblateness term |
| A-04 | Earth Rotation Rate $\omega_E$ | $7.2921150 \times 10^{-5}\text{ rad/s}$ | `VERIFIED_SOURCE` | WGS84 mean sidereal rotation rate |
| A-05 | ECI-to-ECEF Frame Transform | Single Z-axis GMST rotation (IAU-82 formula) | `MODEL_ESTIMATE` | Omits precession, nutation, and polar motion (EOP). Accurate to ~0.01° over multi-day LEO arcs; not ITRF2020 precision. |
| A-06 | Perturbation Model | Two-Body or Two-Body + $J_2$ (RK4, default $\Delta t = 5\text{ s}$) | `MODEL_ESTIMATE` | Omits higher-order gravity ($J_3$, tesserals), atmospheric drag, solar radiation pressure, and third-body Sun/Moon. |
| A-07 | Solar Eclipse Geometry | Cylindrical Earth shadow with low-precision analytical Sun vector | `MODEL_ESTIMATE` | Omits penumbra and atmospheric refraction. |
| A-08 | Reference Constellation (`24/6/1` at 550 km, 97.59° SSO) | Walker Delta $T=24, P=6, F=1$, $h=550\text{ km}$, $e=0.001$ | `SYNTHETIC_ASSUMPTION` | Provisional benchmark baseline; **not presumed optimal** and not historically confirmed. |
| A-09 | Payload Sensor FOV | $\pm 30^\circ$ off-nadir max agile look angle | `SYNTHETIC_ASSUMPTION` | Representative agile smallsat optical imaging envelope. |
| A-10 | Resource Bounds (Battery / Storage / Downlink) | $E_{\max}=120\text{ Wh}$, $E_{\min}=24\text{ Wh}$, $D_{\max}=64\text{ Gb}$, $R_{\text{dl}}=0.40\text{ Gbps}$ | `SYNTHETIC_ASSUMPTION` | Representative 50–100 kg smallsat EO bus parameters. |
| A-11 | Cloud Cover & Ground Outage Model | Seeded latitude-band correlated Bernoulli model | `SYNTHETIC_ASSUMPTION` | Deterministic seeded synthetic process; **does not represent real meteorological forecasts**. |
| A-12 | External Astrodynamics Cross-Check (Orekit/GMAT/Basilisk) | Not installed in Node.js container runtime | `UNVERIFIED` | Internal analytical/numerical cross-checks (Kepler invariants, RK4 timestep convergence, analytical J2 nodal rate) pass; external Orekit/GMAT parity requires standalone Python/Java run. |
