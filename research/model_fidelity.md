# Orbital Physics, Reference Frames, & Model Fidelity Register

## 1. Real Catalog Propagation (`REAL_CATALOG`)
- **Model:** C++-accelerated SGP4 / SDP4 (`sgp4 2.23`, `Satrec.omm` + `SatrecArray.sgp4`, WGS-72 gravity convention).
- **Mean-Element Semantics:** GP/OMM elements are preserved without modification. Every SGP4 return/error code (`0..6`) is captured in `error_code_histogram`; failed objects are reported explicitly and never silently dropped.
- **No TLE Editing:** Translational orbital maneuvers are never injected into published SGP4 records.

## 2. Synthetic 50,000-Object Propagation (`SYNTHETIC_50K`)
- **Internal Units:** SI (`meters`, `m/s`, `kg`, `seconds`, `radians`).
- **Selectable Fidelities:**
  1. `j2_secular_kepler` (High-Throughput Screening): Vectorized first-order Brouwer/Vallado $J_2$ secular rates ($\dot{\Omega}, \dot{\omega}, \dot{M}$) + vectorized Newton-Raphson Kepler solver ($< 10^{-12}\text{ rad}$ residual). Omits short-period $\mathcal{O}(J_2)$ osculating ripples ($\sim 1\text{–}12\text{ km}$ over 6h LEO arcs, measured directly against `DOP853`).
  2. `j2_rk4_numerical` (High-Fidelity Cartesian): Vectorized chunked 4th-order Runge-Kutta Two-Body + $J_2$ integrator agreeing to $< 1\text{ m}$ over 6-hour LEO arcs against `scipy.integrate.solve_ivp(DOP853, rtol=1e-12)`.
- **Unmodeled Perturbations:** Atmospheric drag (NRLMSISE-00), solar radiation pressure, tesseral/higher-order geopotential ($J_3$, EGM2008), and lunisolar third-body gravity are not yet included in the synthetic numerical branch.

## 3. Coordinate Frames & Time Scales
- **TEME/ECI $\to$ ECEF:** Uses IAU-1982 GMST rotation (simplified Earth orientation mode: $\text{UT1}-\text{UTC} = 0$, polar motion $x_p = y_p = 0$, nutation/precession neglected; $\sim 15\text{–}30\text{ m}$ surface offset relative to full IERS EOP Bulletin A/B).
- **Display vs. Science Precision:** Full `float64` states are maintained on the Python backend. Binary `Float32` Three.js positions are used strictly for GPU rendering and are never fed back into scientific calculations.

## 4. Impulsive Maneuvers & Conjunction Screening
- **Impulsive $\Delta v$ Maneuvers:** Executed exclusively on controllable synthetic spacecraft via `scipy.integrate.solve_ivp(DOP853, rtol=1e-10, atol=1e-12)` in ECI or RTN frame with exact velocity discontinuity and Tsiolkovsky propellant accounting.
- **Proximity Screening:** Uses `scipy.spatial.cKDTree` broad-phase + local linear relative-motion narrow-phase TCA refinement. Explicitly labeled `DETERMINISTIC_GEOMETRIC_SCREENING_ONLY` — NOT collision probability ($P_c$) or flight-safety warning.
