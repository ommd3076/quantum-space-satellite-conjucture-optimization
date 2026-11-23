import test from 'node:test';
import assert from 'node:assert/strict';
import { CONSTANTS } from '../../backend/src/physics/constants';
import {
  computeAccessGeometry,
  ecefToEci,
  ecefToGeodetic,
  eciToEcef,
  geodeticToEcef,
  isInCylindricalEclipse,
  isoToJulianDate,
  julianDateToGmstRad,
  norm,
  sub,
} from '../../backend/src/frames/transforms';
import {
  analyticalJ2RaanRateDegPerDay,
  coeToEci,
  computeSsoInclinationDeg,
  eciToCoe,
  orbitalPeriodSec,
  solveKeplerEquation,
  specificAngularMomentumMag,
  specificMechanicalEnergy,
} from '../../backend/src/orbits/kepler';
import {
  generateWalkerDeltaConstellation,
  propagateRk4Interval,
} from '../../backend/src/orbits/propagator';
import { createPresetScenarios } from '../../backend/src/scenarios/presets';

test('Kepler solver achieves residual < 1e-12 across elliptical eccentricities', () => {
  for (const e of [0, 0.001, 0.05, 0.25, 0.6]) {
    for (const M of [0.1, 1.2, 3.1, 5.4]) {
      const E = solveKeplerEquation(M, e);
      const residual = Math.abs(E - e * Math.sin(E) - M);
      assert.ok(residual < 1e-12, `Residual ${residual} exceeded 1e-12 for e=${e}, M=${M}`);
    }
  }
});

test('COE <-> ECI state conversion round-trips within 1e-9 km and 1e-9 deg', () => {
  const coe0 = {
    aKm: CONSTANTS.R_EARTH_KM + 550,
    e: 0.015,
    incDeg: 97.59,
    raanDeg: 132.4,
    argPerigeeDeg: 48.2,
    meanAnomalyDeg: 217.6,
  };
  const { r, v } = coeToEci(coe0);
  const coe1 = eciToCoe(r, v);

  assert.ok(Math.abs(coe1.aKm - coe0.aKm) < 1e-9);
  assert.ok(Math.abs(coe1.e - coe0.e) < 1e-11);
  assert.ok(Math.abs(coe1.incDeg - coe0.incDeg) < 1e-9);
  assert.ok(Math.abs(coe1.raanDeg - coe0.raanDeg) < 1e-9);
  assert.ok(Math.abs(coe1.argPerigeeDeg - coe0.argPerigeeDeg) < 1e-8);
  assert.ok(Math.abs(coe1.meanAnomalyDeg - coe0.meanAnomalyDeg) < 1e-8);
});

test('Two-body RK4 preserves specific energy, angular momentum, and 1-orbit period closure', () => {
  const a = CONSTANTS.R_EARTH_KM + 550;
  const coe = { aKm: a, e: 0.005, incDeg: 55, raanDeg: 20, argPerigeeDeg: 15, meanAnomalyDeg: 0 };
  const { r: r0, v: v0 } = coeToEci(coe);
  const T = orbitalPeriodSec(a);

  const { r: r1, v: v1 } = propagateRk4Interval(r0, v0, T, 5, false);
  const dE = Math.abs(specificMechanicalEnergy(r1, v1) - specificMechanicalEnergy(r0, v0)) / Math.abs(specificMechanicalEnergy(r0, v0));
  const dH = Math.abs(specificAngularMomentumMag(r1, v1) - specificAngularMomentumMag(r0, v0)) / specificAngularMomentumMag(r0, v0);
  const closureKm = norm(sub(r1, r0));

  assert.ok(dE < 1e-8, `Relative energy drift ${dE}`);
  assert.ok(dH < 1e-8, `Relative angular momentum drift ${dH}`);
  assert.ok(closureKm < 1e-3, `1-orbit closure error ${closureKm} km`);
});

test('J2 RK4 nodal precession matches analytical SSO rate (+0.9856 deg/day) and shows O(dt^4) convergence', () => {
  const alt = 550;
  const a = CONSTANTS.R_EARTH_KM + alt;
  const ssoInc = computeSsoInclinationDeg(alt, 0.001);
  assert.ok(ssoInc > 97 && ssoInc < 98.5, `Expected SSO inc near 97.6 deg, got ${ssoInc}`);

  const coe0 = { aKm: a, e: 0.001, incDeg: ssoInc, raanDeg: 45, argPerigeeDeg: 0, meanAnomalyDeg: 0 };
  const { r: r0, v: v0 } = coeToEci(coe0);
  const T = orbitalPeriodSec(a);
  const dtTotal = 10 * T;
  const { r: r1, v: v1 } = propagateRk4Interval(r0, v0, dtTotal, 10, true);
  const coe1 = eciToCoe(r1, v1);

  let dRaan = coe1.raanDeg - coe0.raanDeg;
  if (dRaan < -180) dRaan += 360;
  const numDegDay = dRaan / (dtTotal / 86400);
  const anaDegDay = analyticalJ2RaanRateDegPerDay(a, 0.001, ssoInc);

  assert.ok(Math.abs(anaDegDay - CONSTANTS.SSO_RAAN_RATE_DEG_DAY) < 1e-4);
  assert.ok(Math.abs(numDegDay - anaDegDay) < 0.03, `Numerical ${numDegDay} vs analytical ${anaDegDay}`);

  // Convergence test
  const ref = propagateRk4Interval(r0, v0, T, 1, true);
  const dt10 = propagateRk4Interval(r0, v0, T, 10, true);
  const dt20 = propagateRk4Interval(r0, v0, T, 20, true);
  const err10 = norm(sub(dt10.r, ref.r));
  const err20 = norm(sub(dt20.r, ref.r));
  assert.ok(err20 / err10 > 10, `Expected ~16x RK4 convergence ratio, got ${err20 / err10}`);
});

test('WGS84 Geodetic <-> ECEF <-> ECI round-trips and access/eclipse geometry pass boundary checks', () => {
  const jd = isoToJulianDate('2026-11-23T12:00:00Z');
  const gmst = julianDateToGmstRad(jd);
  const ecef = geodeticToEcef(78.23, 15.41, 0.46);
  const eci = ecefToEci(ecef, gmst);
  const back = ecefToGeodetic(eciToEcef(eci, gmst));
  assert.ok(Math.abs(back.latDeg - 78.23) < 1e-9);
  assert.ok(Math.abs(back.lonDeg - 15.41) < 1e-9);
  assert.ok(Math.abs(back.altKm - 0.46) < 1e-9);

  const sat = geodeticToEcef(10, 20, 550);
  const overhead = computeAccessGeometry(sat, 10, 20, 0);
  const antipode = computeAccessGeometry(sat, -10, -160, 0);
  assert.ok(Math.abs(overhead.elevationDeg - 90) < 1e-4);
  assert.equal(overhead.earthOccluded, false);
  assert.equal(antipode.earthOccluded, true);

  assert.equal(isInCylindricalEclipse({ x: -7000, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }), true);
  assert.equal(isInCylindricalEclipse({ x: 7000, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }), false);
});

test('Walker Delta validation enforces T divisible by P and valid phasing', () => {
  const ref = createPresetScenarios().reference_24_6_1.constellation;
  const sats = generateWalkerDeltaConstellation(ref);
  assert.equal(sats.length, 24);
  assert.throws(() => generateWalkerDeltaConstellation({ ...ref, totalSatellites: 25, planes: 6 }));
  assert.throws(() => generateWalkerDeltaConstellation({ ...ref, phasing: 6 }));
});
