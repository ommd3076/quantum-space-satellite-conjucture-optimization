import { performance } from 'node:perf_hooks';
import { CONSTANTS } from '../physics/constants';
import { computeAccessGeometry } from '../frames/transforms';
import { analyticalJ2RaanRateDegPerDay, orbitalPeriodSec } from '../orbits/kepler';
import {
  generateWalkerDeltaConstellation,
  propagateSatelliteStates,
} from '../orbits/propagator';
import { createSeededRng, sha256Canonical } from '../scenarios/prng';
import type {
  CoverageAnalytics,
  DownlinkWindow,
  ObservationWindow,
  PropagationBundle,
  ScenarioConfig,
  Vec3,
} from '../types';

/**
 * Run complete orbital propagation, geometric access & contact extraction,
 * deterministic seeded cloud/outage realizations, and coverage analytics.
 */
export function propagateAndAnalyzeScenario(scenario: ScenarioConfig): PropagationBundle {
  const t0 = performance.now();
  const scenarioHash = sha256Canonical(scenario);
  const { constellation, horizonSec, sampleStepSec, targets, groundStations } = scenario;

  if (horizonSec <= 0 || horizonSec > 86400) {
    throw new Error(`Horizon must be in (0, 86400] seconds, got ${horizonSec}`);
  }
  if (sampleStepSec < 5 || sampleStepSec > 300) {
    throw new Error(`Sample step must be in [5, 300] seconds, got ${sampleStepSec}`);
  }

  const timeStepsSec: number[] = [];
  for (let t = 0; t <= horizonSec; t += sampleStepSec) {
    timeStepsSec.push(t);
  }
  if (timeStepsSec[timeStepsSec.length - 1] < horizonSec) {
    timeStepsSec.push(horizonSec);
  }

  const walkerSats = generateWalkerDeltaConstellation(constellation);
  const satellites = walkerSats.map((sat) => ({
    satId: sat.satId,
    planeIndex: sat.planeIndex,
    slotIndex: sat.slotIndex,
    initialElements: sat.elements,
    states: propagateSatelliteStates(
      sat.satId,
      sat.planeIndex,
      sat.slotIndex,
      sat.elements,
      constellation.epochIso,
      timeStepsSec,
      constellation.propagator,
      constellation.rk4StepSec,
    ),
  }));

  // Conservation diagnostics
  let energyDriftMaxRelative = 0;
  let angularMomentumDriftMaxRelative = 0;
  let eclipseSamples = 0;
  let totalSatSamples = 0;

  for (const sat of satellites) {
    const e0 = Math.abs(sat.states[0].specificEnergyKm2S2);
    const h0 = Math.abs(sat.states[0].angularMomentumKm2S);
    for (const st of sat.states) {
      totalSatSamples++;
      if (st.inEclipse) eclipseSamples++;
      const dE = Math.abs(st.specificEnergyKm2S2 - sat.states[0].specificEnergyKm2S2) / Math.max(e0, 1e-12);
      const dH = Math.abs(st.angularMomentumKm2S - sat.states[0].angularMomentumKm2S) / Math.max(h0, 1e-12);
      if (dE > energyDriftMaxRelative) energyDriftMaxRelative = dE;
      if (dH > angularMomentumDriftMaxRelative) angularMomentumDriftMaxRelative = dH;
    }
  }

  // Deterministic RNG for synthetic cloud-cover and ground-station outage realizations
  const rng = createSeededRng(scenario.seed ^ 0x2c9e7f31);
  // Regional weather latent factor per target (models spatial/temporal cloud correlation)
  const targetLatentWeather = new Map<string, number>();
  for (const tgt of targets) {
    targetLatentWeather.set(tgt.id, rng());
  }

  const observationWindows: ObservationWindow[] = [];
  const downlinkWindows: DownlinkWindow[] = [];

  // Track active access links per time step for coverage-over-time series
  const activeObsPerStep = new Int32Array(timeStepsSec.length);
  const activeDlPerStep = new Int32Array(timeStepsSec.length);
  const targetFirstCoveredStep = new Map<string, number>();

  let obsCounter = 0;
  let dlCounter = 0;

  for (const sat of satellites) {
    const nSteps = sat.states.length;

    // 1. Target observation windows
    for (const tgt of targets) {
      let inWin = false;
      let startIdx = 0;
      let minOffNadir = 90;
      let maxElev = -90;
      let bestLookVec: Vec3 = { x: 0, y: 0, z: -1 };

      const flushWindow = (endIdx: number) => {
        const startSec = timeStepsSec[startIdx];
        const endSec = Math.min(horizonSec, timeStepsSec[endIdx] + sampleStepSec);
        const durationSec = endSec - startSec;
        if (durationSec >= tgt.durationSec) {
          obsCounter++;
          const midSec = 0.5 * (startSec + endSec);
          // Correlated cloud realization (synthetic, deterministic by seed)
          const latent = targetLatentWeather.get(tgt.id) ?? 0.5;
          const timePhase = Math.sin((midSec / 3600) * 0.7 + tgt.lonDeg * 0.03) * 0.12;
          const effCloudProb = Math.max(
            0.02,
            Math.min(0.95, tgt.baseCloudProb + timePhase),
          );
          const corrDraw =
            scenario.cloudCorrelation * latent + (1 - scenario.cloudCorrelation) * rng();
          const realizedCloudBlocked = corrDraw < effCloudProb;

          observationWindows.push({
            windowId: `OBS-${String(obsCounter).padStart(4, '0')}`,
            satId: sat.satId,
            targetId: tgt.id,
            startSec,
            endSec,
            midSec,
            durationSec,
            minOffNadirDeg: +minOffNadir.toFixed(2),
            maxElevationDeg: +maxElev.toFixed(2),
            targetPriority: tgt.priority,
            deadlineSec: tgt.deadlineSec,
            requiredObsSec: tgt.durationSec,
            dataVolumeGb: tgt.dataVolumeGb,
            cloudProb: +effCloudProb.toFixed(3),
            realizedCloudBlocked,
            lookVecEcef: bestLookVec,
          });
        }
      };

      for (let i = 0; i < nSteps; i++) {
        const st = sat.states[i];
        const geom = computeAccessGeometry(st.ecefPosKm, tgt.latDeg, tgt.lonDeg, 0);
        const visible = !geom.earthOccluded && geom.offNadirDeg <= constellation.fovHalfAngleDeg;

        if (visible) {
          activeObsPerStep[i]++;
          const prevFirst = targetFirstCoveredStep.get(tgt.id);
          if (prevFirst === undefined || i < prevFirst) {
            targetFirstCoveredStep.set(tgt.id, i);
          }

          if (!inWin) {
            inWin = true;
            startIdx = i;
            minOffNadir = geom.offNadirDeg;
            maxElev = geom.elevationDeg;
            bestLookVec = geom.lookVecEcef;
          } else {
            if (geom.offNadirDeg < minOffNadir) {
              minOffNadir = geom.offNadirDeg;
              bestLookVec = geom.lookVecEcef;
            }
            if (geom.elevationDeg > maxElev) {
              maxElev = geom.elevationDeg;
            }
          }
        } else if (inWin) {
          flushWindow(i - 1);
          inWin = false;
        }
      }
      if (inWin) {
        flushWindow(nSteps - 1);
      }
    }

    // 2. Ground station downlink contact windows
    for (const gs of groundStations) {
      let inContact = false;
      let startIdx = 0;
      let maxElev = -90;

      const flushContact = (endIdx: number) => {
        const startSec = timeStepsSec[startIdx];
        const endSec = Math.min(horizonSec, timeStepsSec[endIdx] + sampleStepSec);
        const durationSec = endSec - startSec;
        if (durationSec >= 30) {
          dlCounter++;
          const effOutageProb = Math.min(0.8, gs.outageProb * scenario.outageRateMultiplier);
          const realizedOutage = rng() < effOutageProb;
          const maxVolumeGb = +(durationSec * gs.downlinkRateGbps).toFixed(2);
          downlinkWindows.push({
            contactId: `DL-${String(dlCounter).padStart(4, '0')}`,
            satId: sat.satId,
            stationId: gs.id,
            startSec,
            endSec,
            durationSec,
            maxElevationDeg: +maxElev.toFixed(2),
            downlinkRateGbps: gs.downlinkRateGbps,
            maxVolumeGb,
            outageProb: +effOutageProb.toFixed(3),
            realizedOutage,
          });
        }
      };

      for (let i = 0; i < nSteps; i++) {
        const st = sat.states[i];
        const geom = computeAccessGeometry(st.ecefPosKm, gs.latDeg, gs.lonDeg, gs.altKm);
        const inView = !geom.earthOccluded && geom.elevationDeg >= gs.minElevationDeg;

        if (inView) {
          activeDlPerStep[i]++;
          if (!inContact) {
            inContact = true;
            startIdx = i;
            maxElev = geom.elevationDeg;
          } else if (geom.elevationDeg > maxElev) {
            maxElev = geom.elevationDeg;
          }
        } else if (inContact) {
          flushContact(i - 1);
          inContact = false;
        }
      }
      if (inContact) {
        flushContact(nSteps - 1);
      }
    }
  }

  // Coverage & revisit gap calculations per target
  const windowsByTarget = new Map<string, ObservationWindow[]>();
  for (const w of observationWindows) {
    const arr = windowsByTarget.get(w.targetId) ?? [];
    arr.push(w);
    windowsByTarget.set(w.targetId, arr);
  }

  const allRevisitGaps: number[] = [];
  const perTargetStats = targets.map((tgt) => {
    const wins = (windowsByTarget.get(tgt.id) ?? []).slice().sort((a, b) => a.startSec - b.startSec);
    if (wins.length === 0) {
      allRevisitGaps.push(horizonSec);
      return {
        targetId: tgt.id,
        name: tgt.name,
        region: tgt.region,
        windowCount: 0,
        meanGapSec: horizonSec,
        maxGapSec: horizonSec,
        covered: false,
      };
    }

    // Merge overlapping intervals across satellites for true constellation revisit gaps
    const merged: Array<[number, number]> = [];
    for (const w of wins) {
      if (merged.length === 0 || w.startSec > merged[merged.length - 1][1]) {
        merged.push([w.startSec, w.endSec]);
      } else {
        merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], w.endSec);
      }
    }

    const gaps: number[] = [];
    if (merged[0][0] > 0) gaps.push(merged[0][0]);
    for (let i = 1; i < merged.length; i++) {
      gaps.push(Math.max(0, merged[i][0] - merged[i - 1][1]));
    }
    if (merged[merged.length - 1][1] < horizonSec) {
      gaps.push(horizonSec - merged[merged.length - 1][1]);
    }
    if (gaps.length === 0) gaps.push(0);

    for (const g of gaps) allRevisitGaps.push(g);
    const meanGapSec = gaps.reduce((s, v) => s + v, 0) / gaps.length;
    const maxGapSec = Math.max(...gaps);

    return {
      targetId: tgt.id,
      name: tgt.name,
      region: tgt.region,
      windowCount: wins.length,
      meanGapSec: +meanGapSec.toFixed(1),
      maxGapSec: +maxGapSec.toFixed(1),
      covered: true,
    };
  });

  const sortedGaps = allRevisitGaps.slice().sort((a, b) => a - b);
  const meanRevisitGapSec =
    sortedGaps.length > 0 ? sortedGaps.reduce((s, v) => s + v, 0) / sortedGaps.length : horizonSec;
  const medianRevisitGapSec =
    sortedGaps.length > 0 ? sortedGaps[Math.floor(sortedGaps.length / 2)] : horizonSec;
  const maxRevisitGapSec = sortedGaps.length > 0 ? sortedGaps[sortedGaps.length - 1] : horizonSec;

  // Jain's Fairness Index across per-target observation opportunity counts
  const counts = perTargetStats.map((t) => t.windowCount);
  const sumX = counts.reduce((s, v) => s + v, 0);
  const sumX2 = counts.reduce((s, v) => s + v * v, 0);
  const jainsFairnessIndex =
    counts.length > 0 && sumX2 > 0 ? (sumX * sumX) / (counts.length * sumX2) : 0;

  // Coverage over time series (downsampled to ~60 points for smooth analytics charts)
  const stride = Math.max(1, Math.floor(timeStepsSec.length / 60));
  const coverageOverTime: CoverageAnalytics['coverageOverTime'] = [];
  for (let i = 0; i < timeStepsSec.length; i += stride) {
    let cumCovered = 0;
    for (const stepIdx of targetFirstCoveredStep.values()) {
      if (stepIdx <= i) cumCovered++;
    }
    let sunlit = 0;
    for (const sat of satellites) {
      if (!sat.states[i].inEclipse) sunlit++;
    }
    coverageOverTime.push({
      tSec: timeStepsSec[i],
      cumulativeCoveredTargets: cumCovered,
      cumulativeCoveragePct: targets.length > 0 ? +((100 * cumCovered) / targets.length).toFixed(1) : 0,
      activeAccessLinks: activeObsPerStep[i],
      activeDownlinks: activeDlPerStep[i],
      sunlitSatellites: sunlit,
    });
  }

  // Per-satellite contact summary
  const perSatelliteContactSec = satellites.map((sat) => {
    const satObs = observationWindows.filter((w) => w.satId === sat.satId);
    const satDl = downlinkWindows.filter((d) => d.satId === sat.satId);
    const totalContactSec = satDl.reduce((s, d) => s + d.durationSec, 0);
    const maxDownlinkCapacityGb = satDl.reduce((s, d) => s + d.maxVolumeGb, 0);
    return {
      satId: sat.satId,
      planeIndex: sat.planeIndex,
      obsWindowCount: satObs.length,
      contactCount: satDl.length,
      totalContactSec: +totalContactSec.toFixed(0),
      maxDownlinkCapacityGb: +maxDownlinkCapacityGb.toFixed(1),
    };
  });

  const aKm = CONSTANTS.R_EARTH_KM + constellation.altitudeKm;
  const periodSec = orbitalPeriodSec(aKm);
  const j2RaanDegDay = analyticalJ2RaanRateDegPerDay(
    aKm,
    constellation.eccentricity,
    constellation.inclinationDeg,
  );
  const targetsWithAccessCount = perTargetStats.filter((t) => t.covered).length;

  const analytics: CoverageAnalytics = {
    scenarioHash,
    orbitalPeriodSec: +periodSec.toFixed(2),
    analyticalJ2RaanRateDegPerDay: +j2RaanDegDay.toFixed(4),
    ssoTargetRateDegPerDay: +CONSTANTS.SSO_RAAN_RATE_DEG_DAY.toFixed(4),
    ssoDeviationDegPerDay: +(j2RaanDegDay - CONSTANTS.SSO_RAAN_RATE_DEG_DAY).toFixed(4),
    energyDriftMaxRelative,
    angularMomentumDriftMaxRelative,
    globalTargetCoverageFraction:
      targets.length > 0 ? +(targetsWithAccessCount / targets.length).toFixed(4) : 0,
    targetsWithAccessCount,
    totalTargetsCount: targets.length,
    totalObservationWindows: observationWindows.length,
    totalDownlinkContacts: downlinkWindows.length,
    meanRevisitGapSec: +meanRevisitGapSec.toFixed(1),
    medianRevisitGapSec: +medianRevisitGapSec.toFixed(1),
    maxRevisitGapSec: +maxRevisitGapSec.toFixed(1),
    jainsFairnessIndex: +jainsFairnessIndex.toFixed(4),
    eclipseFractionMean: totalSatSamples > 0 ? +(eclipseSamples / totalSatSamples).toFixed(4) : 0,
    perTargetStats,
    coverageOverTime,
    perSatelliteContactSec,
  };

  return {
    scenario,
    scenarioHash,
    computedAtIso: new Date().toISOString(),
    computeRuntimeMs: +(performance.now() - t0).toFixed(2),
    timeStepsSec,
    satellites,
    observationWindows,
    downlinkWindows,
    analytics,
  };
}
