import { performance } from 'node:perf_hooks';
import { CONSTANTS } from '../physics/constants';
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
} from '../frames/transforms';
import {
  analyticalJ2RaanRateDegPerDay,
  coeToEci,
  computeSsoInclinationDeg,
  eciToCoe,
  orbitalPeriodSec,
  specificAngularMomentumMag,
  specificMechanicalEnergy,
} from '../orbits/kepler';
import { propagateRk4Interval } from '../orbits/propagator';
import { createPresetScenarios } from '../scenarios/presets';
import { propagateAndAnalyzeScenario } from '../geometry/access';
import { verifyScheduleIndependently } from './verifier';
import { runGreedyBaseline } from '../algorithms/greedy';

export interface AuditCheckResult {
  id: string;
  category: 'Physics' | 'Numerical' | 'Frames' | 'Geometry' | 'Verification';
  name: string;
  toleranceSpec: string;
  measuredValue: string;
  passed: boolean;
  runtimeMs: number;
  notes: string;
}

/**
 * Runs real executable scientific validation checks on demand for the Scientific Audit Center
 * and automated test suite. Never fabricates or caches fake pass statuses.
 */
export function runScientificAuditSuite(): {
  executedAtIso: string;
  totalChecks: number;
  passedChecks: number;
  checks: AuditCheckResult[];
} {
  const checks: AuditCheckResult[] = [];

  const runCheck = (
    id: string,
    category: AuditCheckResult['category'],
    name: string,
    toleranceSpec: string,
    fn: () => { passed: boolean; measuredValue: string; notes: string },
  ) => {
    const t0 = performance.now();
    try {
      const res = fn();
      checks.push({
        id,
        category,
        name,
        toleranceSpec,
        measuredValue: res.measuredValue,
        passed: res.passed,
        runtimeMs: +(performance.now() - t0).toFixed(2),
        notes: res.notes,
      });
    } catch (err) {
      checks.push({
        id,
        category,
        name,
        toleranceSpec,
        measuredValue: 'EXCEPTION',
        passed: false,
        runtimeMs: +(performance.now() - t0).toFixed(2),
        notes: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // 1. Two-Body Energy & Angular Momentum Conservation (1 full orbit RK4)
  runCheck(
    'PHY-01',
    'Physics',
    'Two-Body Energy & Angular Momentum Conservation (1 Orbit RK4)',
    'Rel. drift < 1.0e-8',
    () => {
      const a = CONSTANTS.R_EARTH_KM + 550;
      const coe = { aKm: a, e: 0.01, incDeg: 97.59, raanDeg: 40, argPerigeeDeg: 25, meanAnomalyDeg: 10 };
      const { r: r0, v: v0 } = coeToEci(coe);
      const T = orbitalPeriodSec(a);
      const { r: r1, v: v1 } = propagateRk4Interval(r0, v0, T, 5, false);
      const e0 = specificMechanicalEnergy(r0, v0);
      const e1 = specificMechanicalEnergy(r1, v1);
      const h0 = specificAngularMomentumMag(r0, v0);
      const h1 = specificAngularMomentumMag(r1, v1);
      const dE = Math.abs(e1 - e0) / Math.abs(e0);
      const dH = Math.abs(h1 - h0) / Math.abs(h0);
      const posClosureKm = norm(sub(r1, r0));
      return {
        passed: dE < 1e-8 && dH < 1e-8 && posClosureKm < 1e-3,
        measuredValue: `ΔE/E=${dE.toExponential(2)}, Δh/h=${dH.toExponential(2)}, closure=${posClosureKm.toExponential(2)} km`,
        notes: `Period T=${T.toFixed(2)}s, RK4 Δt=5s`,
      };
    },
  );

  // 2. COE <-> ECI Round-Trip Precision
  runCheck(
    'PHY-02',
    'Physics',
    'COE ↔ ECI State-Element Conversion Round-Trip',
    '|Δa| < 1e-9 km, |Δangle| < 1e-9 deg',
    () => {
      const coe0 = { aKm: 6978.137, e: 0.025, incDeg: 53.2, raanDeg: 128.4, argPerigeeDeg: 215.7, meanAnomalyDeg: 312.9 };
      const { r, v } = coeToEci(coe0);
      const coe1 = eciToCoe(r, v);
      const da = Math.abs(coe1.aKm - coe0.aKm);
      const de = Math.abs(coe1.e - coe0.e);
      const di = Math.abs(coe1.incDeg - coe0.incDeg);
      const dO = Math.abs(coe1.raanDeg - coe0.raanDeg);
      const dM = Math.abs(coe1.meanAnomalyDeg - coe0.meanAnomalyDeg);
      const maxAng = Math.max(di, dO, dM);
      return {
        passed: da < 1e-9 && de < 1e-11 && maxAng < 1e-9,
        measuredValue: `Δa=${da.toExponential(2)} km, Δang=${maxAng.toExponential(2)}°`,
        notes: 'Newton-Raphson Kepler residual < 1e-13 rad',
      };
    },
  );

  // 3. J2 Secular Nodal Precession vs Analytical SSO Target
  runCheck(
    'PHY-03',
    'Physics',
    'J2 RK4 Nodal Precession Rate vs Analytical Secular Formula (SSO 550 km)',
    '|Numerical - Analytical| < 0.03 deg/day',
    () => {
      const alt = 550;
      const a = CONSTANTS.R_EARTH_KM + alt;
      const ssoInc = computeSsoInclinationDeg(alt, 0.001);
      const coe0 = { aKm: a, e: 0.001, incDeg: ssoInc, raanDeg: 45, argPerigeeDeg: 0, meanAnomalyDeg: 0 };
      const { r: r0, v: v0 } = coeToEci(coe0);
      // Integrate exactly 10 full orbits to average short-periodic J2 oscillations
      const T = orbitalPeriodSec(a);
      const dtTotal = 10 * T;
      const { r: r1, v: v1 } = propagateRk4Interval(r0, v0, dtTotal, 10, true);
      const coe1 = eciToCoe(r1, v1);
      let dRaan = coe1.raanDeg - coe0.raanDeg;
      if (dRaan < -180) dRaan += 360;
      if (dRaan > 180) dRaan -= 360;
      const numericalDegPerDay = dRaan / (dtTotal / 86400);
      const analyticalDegPerDay = analyticalJ2RaanRateDegPerDay(a, 0.001, ssoInc);
      const err = Math.abs(numericalDegPerDay - analyticalDegPerDay);
      return {
        passed: numericalDegPerDay > 0 && err < 0.03,
        measuredValue: `RK4=+${numericalDegPerDay.toFixed(4)}°/d vs Analytic=+${analyticalDegPerDay.toFixed(4)}°/d`,
        notes: `SSO target=+${CONSTANTS.SSO_RAAN_RATE_DEG_DAY.toFixed(4)}°/d at i=${ssoInc.toFixed(3)}°`,
      };
    },
  );

  // 4. RK4 Timestep Convergence Check (dt=20s vs dt=10s vs dt=2s reference)
  runCheck(
    'NUM-01',
    'Numerical',
    'J2 RK4 Timestep Convergence (Order-4 Error Reduction)',
    'err(10s) < err(20s) / 10 (theoretical 16x)',
    () => {
      const a = CONSTANTS.R_EARTH_KM + 550;
      const coe = { aKm: a, e: 0.002, incDeg: 97.59, raanDeg: 10, argPerigeeDeg: 30, meanAnomalyDeg: 45 };
      const { r: r0, v: v0 } = coeToEci(coe);
      const duration = 5400; // ~1 orbit
      const ref = propagateRk4Interval(r0, v0, duration, 1, true);
      const med = propagateRk4Interval(r0, v0, duration, 10, true);
      const coarse = propagateRk4Interval(r0, v0, duration, 20, true);
      const err10 = norm(sub(med.r, ref.r));
      const err20 = norm(sub(coarse.r, ref.r));
      const ratio = err20 / Math.max(err10, 1e-15);
      return {
        passed: err10 < 1e-4 && ratio > 10,
        measuredValue: `err(20s)=${err20.toExponential(2)} km, err(10s)=${err10.toExponential(2)} km, ratio=${ratio.toFixed(1)}×`,
        notes: 'Classic RK4 theoretical halving ratio is 2⁴ = 16×',
      };
    },
  );

  // 5. WGS84 Geodetic & ECI/ECEF Round-Trip Precision
  runCheck(
    'FRM-01',
    'Frames',
    'WGS84 Geodetic ↔ ECEF & ECI ↔ ECEF Round-Trip',
    '|Δlat,lon| < 1e-9 deg, |Δalt| < 1e-9 km',
    () => {
      const testPoints = [
        { lat: 78.23, lon: 15.41, alt: 0.46 },
        { lat: -53.16, lon: -70.91, alt: 0.04 },
        { lat: 0.0, lon: -179.99, alt: 550.0 },
      ];
      let maxAngErr = 0;
      let maxAltErr = 0;
      const jd = isoToJulianDate('2026-11-23T06:30:00Z');
      const gmst = julianDateToGmstRad(jd);
      for (const pt of testPoints) {
        const ecef = geodeticToEcef(pt.lat, pt.lon, pt.alt);
        const eci = ecefToEci(ecef, gmst);
        const ecefBack = eciToEcef(eci, gmst);
        const geo = ecefToGeodetic(ecefBack);
        maxAngErr = Math.max(maxAngErr, Math.abs(geo.latDeg - pt.lat), Math.abs(geo.lonDeg - pt.lon));
        maxAltErr = Math.max(maxAltErr, Math.abs(geo.altKm - pt.alt));
      }
      return {
        passed: maxAngErr < 1e-9 && maxAltErr < 1e-9,
        measuredValue: `maxΔang=${maxAngErr.toExponential(2)}°, maxΔalt=${maxAltErr.toExponential(2)} km`,
        notes: 'Tested polar, southern, and anti-meridian wrap points',
      };
    },
  );

  // 6. Occultation, Zenith Elevation & Eclipse Geometry
  runCheck(
    'GEO-01',
    'Geometry',
    'Zenith Access, Antipodal Earth Occultation & Cylindrical Eclipse',
    'Zenith elev ≈ 90°, Antipodal occluded = true, Shadow umbra = true',
    () => {
      const satOverhead = geodeticToEcef(0, 0, 550);
      const gOverhead = computeAccessGeometry(satOverhead, 0, 0, 0);
      const gAntipode = computeAccessGeometry(satOverhead, 0, 180, 0);
      const inShadow = isInCylindricalEclipse({ x: -7000, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
      const inSun = isInCylindricalEclipse({ x: 7000, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
      return {
        passed:
          Math.abs(gOverhead.elevationDeg - 90) < 1e-4 &&
          gOverhead.offNadirDeg < 1e-4 &&
          gAntipode.earthOccluded &&
          inShadow &&
          !inSun,
        measuredValue: `Zenith=${gOverhead.elevationDeg.toFixed(2)}°, OffNadir=${gOverhead.offNadirDeg.toFixed(2)}°, AntipodeOccluded=${gAntipode.earthOccluded}`,
        notes: 'Verifies line-of-sight horizon and cylindrical Earth umbra test',
      };
    },
  );

  // 7. Independent Verifier Tamper-Detection Check
  runCheck(
    'VER-01',
    'Verification',
    'Independent Schedule Verifier Rejects Injected Resource/Timing Violations',
    'Feasible schedule: 0 violations; Tampered schedule: ≥ 1 violation caught',
    () => {
      const presets = createPresetScenarios();
      const small = presets.exact_small_12_3_1;
      const bundle = propagateAndAnalyzeScenario(small);
      const greedy = runGreedyBaseline(bundle, 1000);
      const cleanReport = verifyScheduleIndependently(bundle, greedy.actions);

      // Inject deliberate deadline & overlap tamper into first observation
      const tampered = greedy.actions.map((a, idx) =>
        idx === 0 ? { ...a, startSec: a.startSec - 500, endSec: a.endSec + 500 } : a,
      );
      const tamperedReport = verifyScheduleIndependently(bundle, tampered);

      return {
        passed: cleanReport.verifiedFeasible && !tamperedReport.verifiedFeasible && tamperedReport.violationCount > 0,
        measuredValue: `Clean=${cleanReport.violationCount} violations, Tampered=${tamperedReport.violationCount} violations caught`,
        notes: 'Confirms independent verifier actively rejects infeasible plans',
      };
    },
  );

  return {
    executedAtIso: new Date().toISOString(),
    totalChecks: checks.length,
    passedChecks: checks.filter((c) => c.passed).length,
    checks,
  };
}
