import type { ProvenanceTag } from '../types';

/**
 * Physical & Geodetic Constants (SI-consistent km / s / rad units)
 * Every constant carries explicit provenance per Constellation Lab scientific integrity policy.
 */
export const CONSTANTS = {
  /** WGS84 / EGM96 Earth gravitational parameter (km^3 / s^2) */
  MU_EARTH_KM3_S2: 398600.4418,
  /** WGS84 Earth equatorial radius (km) */
  R_EARTH_KM: 6378.137,
  /** WGS84 Earth flattening (dimensionless) */
  F_EARTH: 1 / 298.257223563,
  /** WGS84 polar radius (km) */
  R_POLAR_KM: 6378.137 * (1 - 1 / 298.257223563),
  /** WGS84 first eccentricity squared */
  E2_WGS84: (1 / 298.257223563) * (2 - 1 / 298.257223563),
  /** Dominant zonal harmonic J2 (EGM96/WGS84) */
  J2_EARTH: 1.08262668e-3,
  /** WGS84 Earth sidereal rotation rate (rad/s) */
  OMEGA_EARTH_RAD_S: 7.292115e-5,
  /** Tropical year in seconds (365.2421897 days) for SSO precession target */
  TROPICAL_YEAR_SEC: 365.2421897 * 86400,
  /** Required SSO nodal precession rate (rad/s) */
  SSO_RAAN_RATE_RAD_S: (2 * Math.PI) / (365.2421897 * 86400),
  /** Required SSO nodal precession rate (deg/day) */
  SSO_RAAN_RATE_DEG_DAY: 360 / 365.2421897,
  DEG_TO_RAD: Math.PI / 180,
  RAD_TO_DEG: 180 / Math.PI,
  TWO_PI: 2 * Math.PI,
} as const;

export interface ProvenanceLedgerEntry {
  id: string;
  parameter: string;
  value: string;
  units: string;
  provenance: ProvenanceTag;
  sourceOrJustification: string;
}

export const PROVENANCE_LEDGER: ProvenanceLedgerEntry[] = [
  {
    id: 'P-01',
    parameter: 'Earth Gravitational Parameter (μ)',
    value: '398600.4418',
    units: 'km³/s²',
    provenance: 'VERIFIED_SOURCE',
    sourceOrJustification: 'WGS84 / NIMA TR8350.2 standard Earth gravitational constant',
  },
  {
    id: 'P-02',
    parameter: 'WGS84 Reference Ellipsoid (R_e, f)',
    value: '6378.137 km, 1/298.257223563',
    units: 'km, dimensionless',
    provenance: 'VERIFIED_SOURCE',
    sourceOrJustification: 'WGS84 geodetic ellipsoid specification',
  },
  {
    id: 'P-03',
    parameter: 'Zonal Harmonic J2',
    value: '1.08262668 × 10⁻³',
    units: 'dimensionless',
    provenance: 'VERIFIED_SOURCE',
    sourceOrJustification: 'EGM96 / Vallado Fundamentals of Astrodynamics standard value',
  },
  {
    id: 'P-04',
    parameter: 'Earth Sidereal Rotation Rate (ω_E)',
    value: '7.2921150 × 10⁻⁵',
    units: 'rad/s',
    provenance: 'VERIFIED_SOURCE',
    sourceOrJustification: 'WGS84 mean angular velocity of the Earth',
  },
  {
    id: 'P-05',
    parameter: 'ECI ↔ ECEF Frame Rotation',
    value: 'Single-axis GMST (IAU-82)',
    units: 'rad',
    provenance: 'MODEL_ESTIMATE',
    sourceOrJustification: 'Omits precession, nutation, and IERS EOP polar motion; documented ~0.01° simplification over short LEO horizons',
  },
  {
    id: 'P-06',
    parameter: 'Orbital Perturbation Model',
    value: 'Two-Body Keplerian / Two-Body + J2 RK4',
    units: 'km/s²',
    provenance: 'MODEL_ESTIMATE',
    sourceOrJustification: 'Omits atmospheric drag, SRP, higher-order tesseral harmonics, and third-body Sun/Moon gravity',
  },
  {
    id: 'P-07',
    parameter: 'Cylindrical Solar Eclipse Model',
    value: 'Analytical low-precision Sun ephemeris + Earth cylinder',
    units: 'boolean',
    provenance: 'MODEL_ESTIMATE',
    sourceOrJustification: 'Omits penumbra and atmospheric refraction; provides physically consistent sunlit/eclipse duty cycles',
  },
  {
    id: 'P-08',
    parameter: 'Provisional Reference Constellation (Walker 24/6/1, 550 km, 97.59°)',
    value: 'T=24, P=6, F=1, h=550 km, e=0.001',
    units: 'Walker Delta',
    provenance: 'SYNTHETIC_ASSUMPTION',
    sourceOrJustification: 'Provisional starting benchmark (NOT historically confirmed, NOT presumed optimal)',
  },
  {
    id: 'P-09',
    parameter: 'Onboard Bus & Payload Bounds',
    value: '120 Wh battery, 64 Gb SSR, 0.40 Gbps downlink, 2.0 °/s slew',
    units: 'Wh, Gb, Gbps, deg/s',
    provenance: 'SYNTHETIC_ASSUMPTION',
    sourceOrJustification: 'Representative agile smallsat EO resource envelope for constrained scheduling evaluation',
  },
  {
    id: 'P-10',
    parameter: 'Cloud Cover & Ground Outage Process',
    value: 'Deterministic seeded correlated Bernoulli generator',
    units: 'probability [0,1]',
    provenance: 'SYNTHETIC_ASSUMPTION',
    sourceOrJustification: 'Controlled stochastic testbed; NOT real meteorological observations or forecasts',
  },
  {
    id: 'P-11',
    parameter: 'External Orekit / GMAT / Basilisk Trajectory Parity',
    value: 'Not installed in Node.js container',
    units: 'external check',
    provenance: 'UNVERIFIED',
    sourceOrJustification: 'Internal conservation, RK4 convergence, and analytical J2 checks pass; external cross-validation requires offline Python/Java execution',
  },
];
