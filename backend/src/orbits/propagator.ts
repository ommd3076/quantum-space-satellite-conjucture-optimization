import { CONSTANTS } from '../physics/constants';
import {
  ecefToGeodetic,
  eciToEcef,
  isInCylindricalEclipse,
  isoToJulianDate,
  julianDateToGmstRad,
  sunDirectionEci,
} from '../frames/transforms';
import {
  coeToEci,
  specificAngularMomentumMag,
  specificMechanicalEnergy,
} from './kepler';
import type {
  OrbitalElements,
  PropagatorModel,
  SatelliteState,
  Vec3,
  WalkerConstellationConfig,
} from '../types';

/**
 * Compute gravitational acceleration (km/s^2) in ECI for Two-Body or Two-Body + J2.
 */
export function gravitationalAccelerationEci(r: Vec3, includeJ2: boolean): Vec3 {
  const mu = CONSTANTS.MU_EARTH_KM3_S2;
  const r2 = r.x * r.x + r.y * r.y + r.z * r.z;
  const rMag = Math.sqrt(r2);
  const r3 = r2 * rMag;
  const invR3 = -mu / r3;

  let ax = invR3 * r.x;
  let ay = invR3 * r.y;
  let az = invR3 * r.z;

  if (includeJ2) {
    const r5 = r3 * r2;
    const z2OverR2 = (r.z * r.z) / r2;
    const factor = (-1.5 * CONSTANTS.J2_EARTH * mu * CONSTANTS.R_EARTH_KM * CONSTANTS.R_EARTH_KM) / r5;
    const xyFactor = 1 - 5 * z2OverR2;
    const zFactor = 3 - 5 * z2OverR2;
    ax += factor * r.x * xyFactor;
    ay += factor * r.y * xyFactor;
    az += factor * r.z * zFactor;
  }

  return { x: ax, y: ay, z: az };
}

/**
 * Single classical 4th-order Runge-Kutta (RK4) step for Cartesian ECI state (r, v).
 */
export function rk4Step(r: Vec3, v: Vec3, dt: number, includeJ2: boolean): { r: Vec3; v: Vec3 } {
  const a1 = gravitationalAccelerationEci(r, includeJ2);
  const k1r = v;
  const k1v = a1;

  const r2: Vec3 = {
    x: r.x + 0.5 * dt * k1r.x,
    y: r.y + 0.5 * dt * k1r.y,
    z: r.z + 0.5 * dt * k1r.z,
  };
  const v2: Vec3 = {
    x: v.x + 0.5 * dt * k1v.x,
    y: v.y + 0.5 * dt * k1v.y,
    z: v.z + 0.5 * dt * k1v.z,
  };
  const a2 = gravitationalAccelerationEci(r2, includeJ2);

  const r3: Vec3 = {
    x: r.x + 0.5 * dt * v2.x,
    y: r.y + 0.5 * dt * v2.y,
    z: r.z + 0.5 * dt * v2.z,
  };
  const v3: Vec3 = {
    x: v.x + 0.5 * dt * a2.x,
    y: v.y + 0.5 * dt * a2.y,
    z: v.z + 0.5 * dt * a2.z,
  };
  const a3 = gravitationalAccelerationEci(r3, includeJ2);

  const r4: Vec3 = {
    x: r.x + dt * v3.x,
    y: r.y + dt * v3.y,
    z: r.z + dt * v3.z,
  };
  const v4: Vec3 = {
    x: v.x + dt * a3.x,
    y: v.y + dt * a3.y,
    z: v.z + dt * a3.z,
  };
  const a4 = gravitationalAccelerationEci(r4, includeJ2);

  const dt6 = dt / 6;
  return {
    r: {
      x: r.x + dt6 * (k1r.x + 2 * v2.x + 2 * v3.x + v4.x),
      y: r.y + dt6 * (k1r.y + 2 * v2.y + 2 * v3.y + v4.y),
      z: r.z + dt6 * (k1r.z + 2 * v2.z + 2 * v3.z + v4.z),
    },
    v: {
      x: v.x + dt6 * (k1v.x + 2 * a2.x + 2 * a3.x + a4.x),
      y: v.y + dt6 * (k1v.y + 2 * a2.y + 2 * a3.y + a4.y),
      z: v.z + dt6 * (k1v.z + 2 * a2.z + 2 * a3.z + a4.z),
    },
  };
}

/**
 * Advance Cartesian state from t=0 to dtTotal using sub-stepped RK4.
 */
export function propagateRk4Interval(
  r0: Vec3,
  v0: Vec3,
  dtTotal: number,
  maxStepSec: number,
  includeJ2: boolean,
): { r: Vec3; v: Vec3 } {
  if (dtTotal === 0) return { r: { ...r0 }, v: { ...v0 } };
  const steps = Math.max(1, Math.ceil(Math.abs(dtTotal) / Math.max(0.1, maxStepSec)));
  const h = dtTotal / steps;
  let r = r0;
  let v = v0;
  for (let i = 0; i < steps; i++) {
    const next = rk4Step(r, v, h, includeJ2);
    r = next.r;
    v = next.v;
  }
  return { r, v };
}

/**
 * Validate and generate Walker Delta T/P/F orbital elements.
 * Enforces T divisible by P, F in [0, P-1], physically valid LEO altitude and eccentricity.
 */
export function generateWalkerDeltaConstellation(config: WalkerConstellationConfig): Array<{
  satId: string;
  planeIndex: number;
  slotIndex: number;
  elements: OrbitalElements;
}> {
  const { totalSatellites: T, planes: P, phasing: F } = config;
  if (!Number.isInteger(T) || T < 1 || T > 96) {
    throw new Error(`Total satellites T must be an integer in [1, 96], got ${T}`);
  }
  if (!Number.isInteger(P) || P < 1 || P > T) {
    throw new Error(`Planes P must be an integer in [1, T], got ${P}`);
  }
  if (T % P !== 0) {
    throw new Error(`Standard Walker Delta requires T divisible by P (${T} mod ${P} != 0)`);
  }
  if (!Number.isInteger(F) || F < 0 || F >= P) {
    throw new Error(`Phasing F must be an integer in [0, P-1], got ${F} for P=${P}`);
  }
  if (config.altitudeKm < 250 || config.altitudeKm > 2000) {
    throw new Error(`LEO altitude must be within [250, 2000] km, got ${config.altitudeKm}`);
  }
  if (config.eccentricity < 0 || config.eccentricity >= 0.25) {
    throw new Error(`LEO eccentricity must be in [0, 0.25), got ${config.eccentricity}`);
  }

  const aKm = CONSTANTS.R_EARTH_KM + config.altitudeKm;
  const perigeeAltKm = aKm * (1 - config.eccentricity) - CONSTANTS.R_EARTH_KM;
  if (perigeeAltKm < 160) {
    throw new Error(`Perigee altitude ${perigeeAltKm.toFixed(1)} km decays below 160 km`);
  }

  const satsPerPlane = T / P;
  const result: Array<{
    satId: string;
    planeIndex: number;
    slotIndex: number;
    elements: OrbitalElements;
  }> = [];

  for (let p = 0; p < P; p++) {
    const raanDeg = ((config.raan0Deg + (360 * p) / P) % 360 + 360) % 360;
    for (let s = 0; s < satsPerPlane; s++) {
      const meanAnomalyDeg =
        ((config.meanAnomaly0Deg + (360 * s) / satsPerPlane + (360 * F * p) / T) % 360 + 360) % 360;
      const satId = `SAT-P${p + 1}S${s + 1}`;
      result.push({
        satId,
        planeIndex: p,
        slotIndex: s,
        elements: {
          aKm,
          e: config.eccentricity,
          incDeg: config.inclinationDeg,
          raanDeg,
          argPerigeeDeg: config.argPerigeeDeg,
          meanAnomalyDeg,
        },
      });
    }
  }
  return result;
}

/**
 * Propagate one satellite across an array of monotonic timestamps tSec (seconds since epoch).
 */
export function propagateSatelliteStates(
  satId: string,
  planeIndex: number,
  slotIndex: number,
  elements: OrbitalElements,
  epochIso: string,
  timeStepsSec: number[],
  model: PropagatorModel,
  rk4StepSec: number,
): SatelliteState[] {
  const states: SatelliteState[] = [];
  const nRadPerSec = Math.sqrt(
    CONSTANTS.MU_EARTH_KM3_S2 / (elements.aKm * elements.aKm * elements.aKm),
  );
  const { r: r0, v: v0 } = coeToEci(elements);

  let currR = r0;
  let currV = v0;
  let prevT = 0;

  for (let i = 0; i < timeStepsSec.length; i++) {
    const tSec = timeStepsSec[i];
    let rEci: Vec3;
    let vEci: Vec3;

    if (model === 'kepler_2body') {
      const meanAnomalyDeg =
        ((elements.meanAnomalyDeg + nRadPerSec * tSec * CONSTANTS.RAD_TO_DEG) % 360 + 360) % 360;
      const cart = coeToEci({ ...elements, meanAnomalyDeg });
      rEci = cart.r;
      vEci = cart.v;
    } else {
      const dt = tSec - prevT;
      if (i > 0 && dt !== 0) {
        const next = propagateRk4Interval(currR, currV, dt, rk4StepSec, true);
        currR = next.r;
        currV = next.v;
      } else if (i === 0 && tSec !== 0) {
        const next = propagateRk4Interval(r0, v0, tSec, rk4StepSec, true);
        currR = next.r;
        currV = next.v;
      }
      rEci = currR;
      vEci = currV;
      prevT = tSec;
    }

    const jd = isoToJulianDate(epochIso, tSec);
    const gmstRad = julianDateToGmstRad(jd);
    const ecefPosKm = eciToEcef(rEci, gmstRad);
    const geo = ecefToGeodetic(ecefPosKm);
    const sunDir = sunDirectionEci(jd);
    const inEclipse = isInCylindricalEclipse(rEci, sunDir);

    states.push({
      satId,
      planeIndex,
      slotIndex,
      tSec,
      eciPosKm: rEci,
      eciVelKmS: vEci,
      ecefPosKm,
      latDeg: geo.latDeg,
      lonDeg: geo.lonDeg,
      altKm: geo.altKm,
      inEclipse,
      specificEnergyKm2S2: specificMechanicalEnergy(rEci, vEci),
      angularMomentumKm2S: specificAngularMomentumMag(rEci, vEci),
    });
  }

  return states;
}
