import { CONSTANTS } from '../physics/constants';
import type { Vec3 } from '../types';

export function wrapLonDeg(lonDeg: number): number {
  let w = ((lonDeg + 180) % 360 + 360) % 360 - 180;
  if (w === 180) w = -180;
  return w;
}

export function wrapAngleRad(rad: number): number {
  const twopi = CONSTANTS.TWO_PI;
  return ((rad % twopi) + twopi) % twopi;
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function norm(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function normalize(a: Vec3): Vec3 {
  const n = norm(a);
  if (n < 1e-15) return { x: 0, y: 0, z: 0 };
  return { x: a.x / n, y: a.y / n, z: a.z / n };
}

/**
 * Convert UTC Date (or ISO string + offset seconds) to Julian Date (JD_UTC).
 */
export function isoToJulianDate(epochIso: string, offsetSec = 0): number {
  const ms = Date.parse(epochIso);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid UTC epoch ISO string: ${epochIso}`);
  }
  const unixSec = ms / 1000 + offsetSec;
  return unixSec / 86400 + 2440587.5;
}

/**
 * Greenwich Mean Sidereal Time (GMST) in radians [0, 2π) using IAU-1982 / Vallado expression.
 * Provenance: MODEL_ESTIMATE (omits equation of equinoxes / polar motion).
 */
export function julianDateToGmstRad(jd: number): number {
  const tUt1 = (jd - 2451545.0) / 36525.0;
  // GMST in seconds of time (IAU 1982)
  const gmstSec =
    67310.54841 +
    (876600 * 3600 + 8640184.812866) * tUt1 +
    0.093104 * tUt1 * tUt1 -
    6.2e-6 * tUt1 * tUt1 * tUt1;
  const gmstDeg = ((gmstSec / 240.0) % 360 + 360) % 360;
  return gmstDeg * CONSTANTS.DEG_TO_RAD;
}

/**
 * Rotate ECI position vector to ECEF using Z-axis GMST rotation.
 */
export function eciToEcef(rEci: Vec3, gmstRad: number): Vec3 {
  const c = Math.cos(gmstRad);
  const s = Math.sin(gmstRad);
  return {
    x: c * rEci.x + s * rEci.y,
    y: -s * rEci.x + c * rEci.y,
    z: rEci.z,
  };
}

/**
 * Inverse rotation: ECEF position vector to ECI.
 */
export function ecefToEci(rEcef: Vec3, gmstRad: number): Vec3 {
  const c = Math.cos(gmstRad);
  const s = Math.sin(gmstRad);
  return {
    x: c * rEcef.x - s * rEcef.y,
    y: s * rEcef.x + c * rEcef.y,
    z: rEcef.z,
  };
}

/**
 * Convert WGS84 Geodetic (latDeg, lonDeg, altKm) to ECEF Cartesian (km).
 */
export function geodeticToEcef(latDeg: number, lonDeg: number, altKm = 0): Vec3 {
  const lat = latDeg * CONSTANTS.DEG_TO_RAD;
  const lon = lonDeg * CONSTANTS.DEG_TO_RAD;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);

  const N = CONSTANTS.R_EARTH_KM / Math.sqrt(1 - CONSTANTS.E2_WGS84 * sinLat * sinLat);
  return {
    x: (N + altKm) * cosLat * cosLon,
    y: (N + altKm) * cosLat * sinLon,
    z: (N * (1 - CONSTANTS.E2_WGS84) + altKm) * sinLat,
  };
}

/**
 * Convert ECEF Cartesian (km) to WGS84 Geodetic (latDeg, lonDeg, altKm).
 * Uses iterative Bowring/exact fixed-point convergence to < 1e-12 rad.
 */
export function ecefToGeodetic(rEcef: Vec3): { latDeg: number; lonDeg: number; altKm: number } {
  const { x, y, z } = rEcef;
  const a = CONSTANTS.R_EARTH_KM;
  const e2 = CONSTANTS.E2_WGS84;
  const p = Math.sqrt(x * x + y * y);
  const lonRad = Math.atan2(y, x);

  if (p < 1e-10) {
    const latDeg = z >= 0 ? 90 : -90;
    const altKm = Math.abs(z) - CONSTANTS.R_POLAR_KM;
    return { latDeg, lonDeg: 0, altKm };
  }

  let lat = Math.atan2(z, p * (1 - e2));
  let N = a;
  for (let iter = 0; iter < 10; iter++) {
    const sinLat = Math.sin(lat);
    N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
    const nextLat = Math.atan2(z + e2 * N * sinLat, p);
    if (Math.abs(nextLat - lat) < 1e-13) {
      lat = nextLat;
      break;
    }
    lat = nextLat;
  }

  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  const altKm =
    Math.abs(cosLat) > 1e-8 ? p / cosLat - N : Math.abs(z) / Math.abs(sinLat) - N * (1 - e2);

  return {
    latDeg: lat * CONSTANTS.RAD_TO_DEG,
    lonDeg: wrapLonDeg(lonRad * CONSTANTS.RAD_TO_DEG),
    altKm,
  };
}

/**
 * Compute topocentric elevation angle (deg), azimuth (deg), slant range (km),
 * and satellite off-nadir look angle (deg) between a satellite ECEF state and a ground point.
 */
export function computeAccessGeometry(
  satEcef: Vec3,
  siteLatDeg: number,
  siteLonDeg: number,
  siteAltKm = 0,
): {
  elevationDeg: number;
  azimuthDeg: number;
  slantRangeKm: number;
  offNadirDeg: number;
  earthOccluded: boolean;
  lookVecEcef: Vec3;
} {
  const siteEcef = geodeticToEcef(siteLatDeg, siteLonDeg, siteAltKm);
  const rho = sub(satEcef, siteEcef); // site -> satellite
  const slantRangeKm = norm(rho);

  const lat = siteLatDeg * CONSTANTS.DEG_TO_RAD;
  const lon = siteLonDeg * CONSTANTS.DEG_TO_RAD;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);

  // Topocentric SEZ basis vectors in ECEF
  const south: Vec3 = { x: sinLat * cosLon, y: sinLat * sinLon, z: -cosLat };
  const east: Vec3 = { x: -sinLon, y: cosLon, z: 0 };
  const zenith: Vec3 = { x: cosLat * cosLon, y: cosLat * sinLon, z: sinLat };

  const rhoS = dot(rho, south);
  const rhoE = dot(rho, east);
  const rhoZ = dot(rho, zenith);

  const elevRad = Math.asin(Math.max(-1, Math.min(1, rhoZ / Math.max(slantRangeKm, 1e-9))));
  const azRad = Math.atan2(rhoE, -rhoS);
  const azimuthDeg = ((azRad * CONSTANTS.RAD_TO_DEG) % 360 + 360) % 360;
  const elevationDeg = elevRad * CONSTANTS.RAD_TO_DEG;

  // Satellite nadir vector (sat -> Earth center) and target look vector (sat -> site)
  const nadirDir = normalize(scale(satEcef, -1));
  const lookVecEcef = normalize(scale(rho, -1));
  const cosOffNadir = Math.max(-1, Math.min(1, dot(nadirDir, lookVecEcef)));
  const offNadirDeg = Math.acos(cosOffNadir) * CONSTANTS.RAD_TO_DEG;

  // Earth occultation check: elevation < 0 means target is below local horizon (Earth blocks LOS)
  const earthOccluded = elevationDeg < 0;

  return {
    elevationDeg,
    azimuthDeg,
    slantRangeKm,
    offNadirDeg,
    earthOccluded,
    lookVecEcef,
  };
}

/**
 * Low-precision analytical Sun unit direction vector in ECI (Vallado / USNO Astronomical Almanac).
 * Accuracy ~0.01 deg over 1950-2050. Provenance: MODEL_ESTIMATE.
 */
export function sunDirectionEci(jd: number): Vec3 {
  const n = jd - 2451545.0;
  const L = wrapAngleRad((280.46 + 0.9856474 * n) * CONSTANTS.DEG_TO_RAD);
  const g = wrapAngleRad((357.528 + 0.9856003 * n) * CONSTANTS.DEG_TO_RAD);
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * CONSTANTS.DEG_TO_RAD;
  const eps = (23.439 - 0.0000004 * n) * CONSTANTS.DEG_TO_RAD;
  return {
    x: Math.cos(lambda),
    y: Math.cos(eps) * Math.sin(lambda),
    z: Math.sin(eps) * Math.sin(lambda),
  };
}

/**
 * Cylindrical Earth shadow eclipse check in ECI.
 * Returns true if satellite lies in Earth's cylindrical umbra.
 * Provenance: MODEL_ESTIMATE.
 */
export function isInCylindricalEclipse(rEciKm: Vec3, sunUnitEci: Vec3): boolean {
  const proj = dot(rEciKm, sunUnitEci);
  if (proj >= 0) return false; // Sunlit side of Earth
  const rSq = dot(rEciKm, rEciKm);
  const perpSq = rSq - proj * proj;
  return perpSq < CONSTANTS.R_EARTH_KM * CONSTANTS.R_EARTH_KM;
}
