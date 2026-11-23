import { CONSTANTS } from '../physics/constants';
import { cross, dot, norm, wrapAngleRad } from '../frames/transforms';
import type { OrbitalElements, Vec3 } from '../types';

/**
 * Solve Kepler's Equation M = E - e sin(E) for eccentric anomaly E (rad)
 * via Newton-Raphson iteration to |f(E)| < 1e-13.
 */
export function solveKeplerEquation(meanAnomalyRad: number, e: number): number {
  if (e < 0 || e >= 1) {
    throw new Error(`Kepler solver requires elliptical eccentricity 0 <= e < 1, got ${e}`);
  }
  const M = wrapAngleRad(meanAnomalyRad);
  if (e < 1e-12) return M;

  let E = e < 0.8 ? M : Math.PI;
  for (let i = 0; i < 30; i++) {
    const f = E - e * Math.sin(E) - M;
    const fp = 1 - e * Math.cos(E);
    const dE = -f / fp;
    E += dE;
    if (Math.abs(dE) < 1e-13) break;
  }
  return E;
}

/**
 * Classical Orbital Elements (COE) -> Cartesian ECI state (r in km, v in km/s).
 */
export function coeToEci(coe: OrbitalElements): { r: Vec3; v: Vec3 } {
  const mu = CONSTANTS.MU_EARTH_KM3_S2;
  const a = coe.aKm;
  const e = coe.e;
  const inc = coe.incDeg * CONSTANTS.DEG_TO_RAD;
  const raan = coe.raanDeg * CONSTANTS.DEG_TO_RAD;
  const argp = coe.argPerigeeDeg * CONSTANTS.DEG_TO_RAD;
  const M = coe.meanAnomalyDeg * CONSTANTS.DEG_TO_RAD;

  const E = solveKeplerEquation(M, e);
  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const sqrtOneMinusE2 = Math.sqrt(1 - e * e);

  // Perifocal coordinates
  const rMag = a * (1 - e * cosE);
  const xP = a * (cosE - e);
  const yP = a * sqrtOneMinusE2 * sinE;

  const vFactor = Math.sqrt(mu * a) / rMag;
  const vxP = -vFactor * sinE;
  const vyP = vFactor * sqrtOneMinusE2 * cosE;

  // Rotation matrix from Perifocal (PQW) to ECI (IJK): Rz(-raan) * Rx(-inc) * Rz(-argp)
  const cO = Math.cos(raan);
  const sO = Math.sin(raan);
  const ci = Math.cos(inc);
  const si = Math.sin(inc);
  const cw = Math.cos(argp);
  const sw = Math.sin(argp);

  const p11 = cO * cw - sO * sw * ci;
  const p12 = -cO * sw - sO * cw * ci;
  const p21 = sO * cw + cO * sw * ci;
  const p22 = -sO * sw + cO * cw * ci;
  const p31 = sw * si;
  const p32 = cw * si;

  return {
    r: {
      x: p11 * xP + p12 * yP,
      y: p21 * xP + p22 * yP,
      z: p31 * xP + p32 * yP,
    },
    v: {
      x: p11 * vxP + p12 * vyP,
      y: p21 * vxP + p22 * vyP,
      z: p31 * vxP + p32 * vyP,
    },
  };
}

/**
 * Cartesian ECI state (r in km, v in km/s) -> Classical Orbital Elements (COE).
 */
export function eciToCoe(r: Vec3, v: Vec3): OrbitalElements {
  const mu = CONSTANTS.MU_EARTH_KM3_S2;
  const rMag = norm(r);
  const vMag = norm(v);
  const hVec = cross(r, v);
  const hMag = norm(hVec);
  const nVec: Vec3 = { x: -hVec.y, y: hVec.x, z: 0 };
  const nMag = norm(nVec);

  const rDotV = dot(r, v);
  const eVec: Vec3 = {
    x: ((vMag * vMag - mu / rMag) * r.x - rDotV * v.x) / mu,
    y: ((vMag * vMag - mu / rMag) * r.y - rDotV * v.y) / mu,
    z: ((vMag * vMag - mu / rMag) * r.z - rDotV * v.z) / mu,
  };
  const e = norm(eVec);

  const energy = (vMag * vMag) / 2 - mu / rMag;
  const aKm = -mu / (2 * energy);
  const incRad = Math.acos(Math.max(-1, Math.min(1, hVec.z / hMag)));

  let raanRad = 0;
  if (nMag > 1e-10) {
    raanRad = Math.acos(Math.max(-1, Math.min(1, nVec.x / nMag)));
    if (nVec.y < 0) raanRad = CONSTANTS.TWO_PI - raanRad;
  }

  let argpRad = 0;
  if (nMag > 1e-10 && e > 1e-10) {
    argpRad = Math.acos(Math.max(-1, Math.min(1, dot(nVec, eVec) / (nMag * e))));
    if (eVec.z < 0) argpRad = CONSTANTS.TWO_PI - argpRad;
  }

  let nuRad = 0;
  if (e > 1e-10) {
    nuRad = Math.acos(Math.max(-1, Math.min(1, dot(eVec, r) / (e * rMag))));
    if (rDotV < 0) nuRad = CONSTANTS.TWO_PI - nuRad;
  } else if (nMag > 1e-10) {
    nuRad = Math.acos(Math.max(-1, Math.min(1, dot(nVec, r) / (nMag * rMag))));
    if (r.z < 0) nuRad = CONSTANTS.TWO_PI - nuRad;
  } else {
    nuRad = Math.atan2(r.y, r.x);
  }

  const E =
    e > 1e-10
      ? 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nuRad / 2), Math.sqrt(1 + e) * Math.cos(nuRad / 2))
      : nuRad;
  const M = wrapAngleRad(E - e * Math.sin(E));

  return {
    aKm,
    e,
    incDeg: incRad * CONSTANTS.RAD_TO_DEG,
    raanDeg: wrapAngleRad(raanRad) * CONSTANTS.RAD_TO_DEG,
    argPerigeeDeg: wrapAngleRad(argpRad) * CONSTANTS.RAD_TO_DEG,
    meanAnomalyDeg: M * CONSTANTS.RAD_TO_DEG,
  };
}

export function specificMechanicalEnergy(r: Vec3, v: Vec3): number {
  const rMag = norm(r);
  const vMag = norm(v);
  return 0.5 * vMag * vMag - CONSTANTS.MU_EARTH_KM3_S2 / rMag;
}

export function specificAngularMomentumMag(r: Vec3, v: Vec3): number {
  return norm(cross(r, v));
}

export function orbitalPeriodSec(aKm: number): number {
  return CONSTANTS.TWO_PI * Math.sqrt((aKm * aKm * aKm) / CONSTANTS.MU_EARTH_KM3_S2);
}

/**
 * Analytical secular J2 RAAN precession rate (deg/day).
 * dOmega/dt = -(3/2) * J2 * (Re / p)^2 * n * cos(i)
 */
export function analyticalJ2RaanRateDegPerDay(aKm: number, e: number, incDeg: number): number {
  const n = Math.sqrt(CONSTANTS.MU_EARTH_KM3_S2 / (aKm * aKm * aKm));
  const p = aKm * (1 - e * e);
  const ratio = CONSTANTS.R_EARTH_KM / p;
  const incRad = incDeg * CONSTANTS.DEG_TO_RAD;
  const rateRadPerSec = -1.5 * CONSTANTS.J2_EARTH * ratio * ratio * n * Math.cos(incRad);
  return rateRadPerSec * CONSTANTS.RAD_TO_DEG * 86400;
}

/**
 * Compute Sun-synchronous inclination (deg) for given altitude (km) and eccentricity under J2 model.
 */
export function computeSsoInclinationDeg(altitudeKm: number, e = 0.001): number {
  const aKm = CONSTANTS.R_EARTH_KM + altitudeKm;
  const n = Math.sqrt(CONSTANTS.MU_EARTH_KM3_S2 / (aKm * aKm * aKm));
  const p = aKm * (1 - e * e);
  const ratio = CONSTANTS.R_EARTH_KM / p;
  const cosI = -CONSTANTS.SSO_RAAN_RATE_RAD_S / (1.5 * CONSTANTS.J2_EARTH * ratio * ratio * n);
  if (Math.abs(cosI) > 1) {
    throw new Error(`No Sun-synchronous inclination exists at altitude ${altitudeKm} km (|cos i| = ${Math.abs(cosI).toFixed(4)})`);
  }
  return Math.acos(cosI) * CONSTANTS.RAD_TO_DEG;
}
