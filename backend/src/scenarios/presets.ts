import { computeSsoInclinationDeg } from '../orbits/kepler';
import { createSeededRng } from './prng';
import type {
  GroundStation,
  ObservationTarget,
  ResourceModelConfig,
  ScenarioConfig,
} from '../types';

export const DEFAULT_GROUND_STATIONS: GroundStation[] = [
  {
    id: 'GS-SVL',
    name: 'Svalbard (SvalSat)',
    latDeg: 78.23,
    lonDeg: 15.41,
    altKm: 0.46,
    minElevationDeg: 5,
    downlinkRateGbps: 0.4,
    outageProb: 0.06,
    provenance: 'SYNTHETIC_ASSUMPTION',
  },
  {
    id: 'GS-FBK',
    name: 'Fairbanks (Alaska)',
    latDeg: 64.86,
    lonDeg: -147.85,
    altKm: 0.14,
    minElevationDeg: 5,
    downlinkRateGbps: 0.4,
    outageProb: 0.06,
    provenance: 'SYNTHETIC_ASSUMPTION',
  },
  {
    id: 'GS-PUN',
    name: 'Punta Arenas',
    latDeg: -53.16,
    lonDeg: -70.91,
    altKm: 0.04,
    minElevationDeg: 5,
    downlinkRateGbps: 0.4,
    outageProb: 0.07,
    provenance: 'SYNTHETIC_ASSUMPTION',
  },
  {
    id: 'GS-HAR',
    name: 'Hartebeesthoek',
    latDeg: -25.89,
    lonDeg: 27.69,
    altKm: 1.54,
    minElevationDeg: 7,
    downlinkRateGbps: 0.35,
    outageProb: 0.05,
    provenance: 'SYNTHETIC_ASSUMPTION',
  },
  {
    id: 'GS-DON',
    name: 'Dongara',
    latDeg: -29.25,
    lonDeg: 114.93,
    altKm: 0.05,
    minElevationDeg: 7,
    downlinkRateGbps: 0.35,
    outageProb: 0.05,
    provenance: 'SYNTHETIC_ASSUMPTION',
  },
  {
    id: 'GS-MAD',
    name: 'Madrid',
    latDeg: 40.43,
    lonDeg: -4.25,
    altKm: 0.8,
    minElevationDeg: 7,
    downlinkRateGbps: 0.35,
    outageProb: 0.05,
    provenance: 'SYNTHETIC_ASSUMPTION',
  },
];

export const DEFAULT_RESOURCES: ResourceModelConfig = {
  batteryCapacityWh: 120,
  batteryMinWh: 24,
  batteryInitialWh: 96,
  solarChargePowerW: 95,
  idlePowerW: 28,
  imagingPowerW: 110,
  downlinkPowerW: 90,
  storageCapacityGb: 64,
  storageInitialGb: 0,
  slewRateDegPerSec: 2.0,
  setupTimeSec: 15,
  captureCreditFraction: 0.25,
};

interface SeedTargetTemplate {
  name: string;
  region: ObservationTarget['region'];
  latDeg: number;
  lonDeg: number;
  baseCloud: number;
}

const GEOGRAPHIC_ANCHORS: SeedTargetTemplate[] = [
  { name: 'Amazon Basin NW', region: 'Equatorial', latDeg: -3.1, lonDeg: -60.0, baseCloud: 0.58 },
  { name: 'Congo Rainforest', region: 'Equatorial', latDeg: 0.5, lonDeg: 21.8, baseCloud: 0.54 },
  { name: 'Borneo Peatland', region: 'Equatorial', latDeg: 1.2, lonDeg: 114.2, baseCloud: 0.62 },
  { name: 'Panama Canal Zone', region: 'Equatorial', latDeg: 9.1, lonDeg: -79.7, baseCloud: 0.48 },
  { name: 'Singapore Strait', region: 'Equatorial', latDeg: 1.3, lonDeg: 103.8, baseCloud: 0.52 },
  { name: 'Nairobi Rift Valley', region: 'Equatorial', latDeg: -1.3, lonDeg: 36.8, baseCloud: 0.36 },
  { name: 'California Sierra', region: 'Disaster-Cluster', latDeg: 38.8, lonDeg: -120.2, baseCloud: 0.22 },
  { name: 'Mediterranean Crete', region: 'Disaster-Cluster', latDeg: 35.2, lonDeg: 24.9, baseCloud: 0.18 },
  { name: 'Kyushu Volcanic Arc', region: 'Disaster-Cluster', latDeg: 32.8, lonDeg: 130.7, baseCloud: 0.41 },
  { name: 'Andes Atacama Basin', region: 'Mid-Latitude', latDeg: -23.6, lonDeg: -68.2, baseCloud: 0.12 },
  { name: 'Sahara Solar Belt', region: 'Mid-Latitude', latDeg: 24.5, lonDeg: 11.4, baseCloud: 0.08 },
  { name: 'Ganges Delta', region: 'Disaster-Cluster', latDeg: 22.3, lonDeg: 89.8, baseCloud: 0.45 },
  { name: 'Rhine Industrial Corridor', region: 'Mid-Latitude', latDeg: 50.9, lonDeg: 6.9, baseCloud: 0.44 },
  { name: 'US Midwest Corn Belt', region: 'Mid-Latitude', latDeg: 41.6, lonDeg: -93.6, baseCloud: 0.32 },
  { name: 'Yangtze River Estuary', region: 'Mid-Latitude', latDeg: 31.2, lonDeg: 121.5, baseCloud: 0.46 },
  { name: 'Murray-Darling Basin', region: 'Mid-Latitude', latDeg: -34.2, lonDeg: 142.1, baseCloud: 0.21 },
  { name: 'Cape Town Watershed', region: 'Mid-Latitude', latDeg: -33.9, lonDeg: 18.4, baseCloud: 0.26 },
  { name: 'Texas Gulf Coast', region: 'Disaster-Cluster', latDeg: 29.3, lonDeg: -94.8, baseCloud: 0.34 },
  { name: 'Greenland Jakobshavn', region: 'High-Latitude', latDeg: 69.2, lonDeg: -49.8, baseCloud: 0.39 },
  { name: 'Beaufort Sea Ice Edge', region: 'High-Latitude', latDeg: 71.3, lonDeg: -145.5, baseCloud: 0.47 },
  { name: 'Barents Shipping Lane', region: 'High-Latitude', latDeg: 72.1, lonDeg: 31.5, baseCloud: 0.51 },
  { name: 'Siberia Permafrost Zone', region: 'High-Latitude', latDeg: 66.8, lonDeg: 125.4, baseCloud: 0.37 },
  { name: 'Patagonia Ice Field', region: 'High-Latitude', latDeg: -49.8, lonDeg: -73.2, baseCloud: 0.55 },
  { name: 'Iceland Vatnajokull', region: 'High-Latitude', latDeg: 64.4, lonDeg: -16.8, baseCloud: 0.53 },
  { name: 'Persian Gulf Coast', region: 'Mid-Latitude', latDeg: 26.2, lonDeg: 50.6, baseCloud: 0.1 },
  { name: 'Deccan Plateau', region: 'Mid-Latitude', latDeg: 17.4, lonDeg: 78.5, baseCloud: 0.29 },
  { name: 'Mekong River Delta', region: 'Equatorial', latDeg: 10.0, lonDeg: 105.8, baseCloud: 0.49 },
  { name: 'Red Sea Suez Approach', region: 'Mid-Latitude', latDeg: 29.9, lonDeg: 32.6, baseCloud: 0.09 },
  { name: 'Alps Glacier Basin', region: 'Mid-Latitude', latDeg: 46.5, lonDeg: 8.0, baseCloud: 0.42 },
  { name: 'Kamchatka Peninsula', region: 'High-Latitude', latDeg: 56.1, lonDeg: 160.6, baseCloud: 0.46 },
  { name: 'Andean Lithium Salar', region: 'Mid-Latitude', latDeg: -20.2, lonDeg: -67.5, baseCloud: 0.14 },
  { name: 'Great Barrier Reef North', region: 'Equatorial', latDeg: -14.7, lonDeg: 145.4, baseCloud: 0.33 },
  { name: 'Yukon Wildfire Watch', region: 'High-Latitude', latDeg: 63.5, lonDeg: -136.2, baseCloud: 0.38 },
  { name: 'Horn of Africa Coast', region: 'Equatorial', latDeg: 9.5, lonDeg: 48.2, baseCloud: 0.2 },
  { name: 'Korean Strait Maritime', region: 'Mid-Latitude', latDeg: 34.8, lonDeg: 128.9, baseCloud: 0.37 },
  { name: 'Lake Chad Basin', region: 'Equatorial', latDeg: 13.0, lonDeg: 14.1, baseCloud: 0.18 },
];

export function generateSyntheticTargets(
  count: number,
  seed: number,
  horizonSec: number,
  deadlinePressure = 1.0,
  cloudScale = 1.0,
): ObservationTarget[] {
  const rng = createSeededRng(seed ^ 0x51a7c0de);
  const targets: ObservationTarget[] = [];

  for (let i = 0; i < count; i++) {
    const template = GEOGRAPHIC_ANCHORS[i % GEOGRAPHIC_ANCHORS.length];
    const jitterLat = i >= GEOGRAPHIC_ANCHORS.length ? (rng() - 0.5) * 14 : 0;
    const jitterLon = i >= GEOGRAPHIC_ANCHORS.length ? (rng() - 0.5) * 24 : 0;
    const latDeg = Math.max(-78, Math.min(78, +(template.latDeg + jitterLat).toFixed(2)));
    const lonDeg = Math.max(-179, Math.min(179, +(template.lonDeg + jitterLon).toFixed(2)));

    const isDisaster = template.region === 'Disaster-Cluster';
    const basePriority = isDisaster ? 65 + Math.round(rng() * 35) : 20 + Math.round(rng() * 55);
    const minDeadline = Math.max(2400, horizonSec * (0.4 / Math.max(0.5, deadlinePressure)));
    const maxDeadline = horizonSec * (1.0 / Math.max(0.6, deadlinePressure));
    const deadlineSec = Math.min(
      horizonSec,
      Math.round((minDeadline + rng() * Math.max(600, maxDeadline - minDeadline)) / 60) * 60,
    );
    const durationSec = 30 + Math.floor(rng() * 3) * 15; // 30, 45, or 60 s
    const dataVolumeGb = +(4.5 + rng() * 9.5).toFixed(1); // 4.5 - 14.0 Gb
    const baseCloudProb = Math.min(0.85, Math.max(0.05, +(template.baseCloud * cloudScale).toFixed(2)));

    targets.push({
      id: `TGT-${String(i + 1).padStart(2, '0')}`,
      name: i < GEOGRAPHIC_ANCHORS.length ? template.name : `${template.name} #${Math.floor(i / GEOGRAPHIC_ANCHORS.length) + 1}`,
      region: template.region,
      latDeg,
      lonDeg,
      priority: basePriority,
      deadlineSec,
      durationSec,
      dataVolumeGb,
      baseCloudProb,
      provenance: 'SYNTHETIC_ASSUMPTION',
    });
  }

  return targets;
}

export function createPresetScenarios(): Record<string, ScenarioConfig> {
  const ssoInc550 = +computeSsoInclinationDeg(550, 0.001).toFixed(3);
  const ssoInc620 = +computeSsoInclinationDeg(620, 0.001).toFixed(3);

  return {
    reference_24_6_1: {
      id: 'reference_24_6_1',
      name: 'Provisional Reference: Walker 24/6/1 (550 km SSO)',
      description:
        'PROVISIONAL starting benchmark (not historically confirmed, not presumed optimal): 24 satellites across 6 SSO planes at 550 km with 36 global targets and 6 ground stations.',
      seed: 20261123,
      horizonSec: 21600, // 6 hours
      sampleStepSec: 30,
      constellation: {
        totalSatellites: 24,
        planes: 6,
        phasing: 1,
        altitudeKm: 550,
        inclinationDeg: ssoInc550,
        eccentricity: 0.001,
        raan0Deg: 0,
        argPerigeeDeg: 0,
        meanAnomaly0Deg: 0,
        fovHalfAngleDeg: 30,
        epochIso: '2026-11-23T00:00:00Z',
        propagator: 'j2_rk4',
        rk4StepSec: 10,
      },
      groundStations: DEFAULT_GROUND_STATIONS,
      targets: generateSyntheticTargets(36, 20261123, 21600, 1.0, 1.0),
      resources: { ...DEFAULT_RESOURCES },
      cloudCorrelation: 0.55,
      outageRateMultiplier: 1.0,
      provenance: 'SYNTHETIC_ASSUMPTION',
    },

    exact_small_12_3_1: {
      id: 'exact_small_12_3_1',
      name: 'Small Fleet Exact-Verification: Walker 12/3/1 (550 km)',
      description:
        '12-satellite / 3-plane benchmark sized for fast exact Branch-and-Bound certification and tight optimality gap analysis over 24 targets.',
      seed: 20261124,
      horizonSec: 14400, // 4 hours
      sampleStepSec: 30,
      constellation: {
        totalSatellites: 12,
        planes: 3,
        phasing: 1,
        altitudeKm: 550,
        inclinationDeg: ssoInc550,
        eccentricity: 0.001,
        raan0Deg: 15,
        argPerigeeDeg: 0,
        meanAnomaly0Deg: 0,
        fovHalfAngleDeg: 32,
        epochIso: '2026-11-23T00:00:00Z',
        propagator: 'j2_rk4',
        rk4StepSec: 10,
      },
      groundStations: DEFAULT_GROUND_STATIONS.slice(0, 4),
      targets: generateSyntheticTargets(24, 20261124, 14400, 1.05, 1.0),
      resources: { ...DEFAULT_RESOURCES, storageCapacityGb: 36 },
      cloudCorrelation: 0.5,
      outageRateMultiplier: 1.0,
      provenance: 'SYNTHETIC_ASSUMPTION',
    },

    stress_downlink_cloud: {
      id: 'stress_downlink_cloud',
      name: 'Stress Regime: Scarce Downlink & High Cloud Risk (18/6/1)',
      description:
        'Tests downlink bottlenecks (3 stations, 28 Gb SSR) coupled with elevated correlated cloud uncertainty and higher outage rates.',
      seed: 20261125,
      horizonSec: 21600,
      sampleStepSec: 30,
      constellation: {
        totalSatellites: 18,
        planes: 6,
        phasing: 1,
        altitudeKm: 620,
        inclinationDeg: ssoInc620,
        eccentricity: 0.001,
        raan0Deg: 0,
        argPerigeeDeg: 0,
        meanAnomaly0Deg: 0,
        fovHalfAngleDeg: 30,
        epochIso: '2026-11-23T00:00:00Z',
        propagator: 'j2_rk4',
        rk4StepSec: 10,
      },
      groundStations: DEFAULT_GROUND_STATIONS.slice(0, 3).map((gs) => ({
        ...gs,
        downlinkRateGbps: 0.22,
        outageProb: 0.14,
      })),
      targets: generateSyntheticTargets(42, 20261125, 21600, 1.2, 1.35),
      resources: {
        ...DEFAULT_RESOURCES,
        storageCapacityGb: 28,
        batteryCapacityWh: 95,
        batteryInitialWh: 72,
      },
      cloudCorrelation: 0.7,
      outageRateMultiplier: 1.5,
      provenance: 'SYNTHETIC_ASSUMPTION',
    },

    large_48_8_1: {
      id: 'large_48_8_1',
      name: 'Scale Stress: Walker 48/8/1 (550 km, 60 Targets)',
      description:
        '48-satellite / 8-plane scaling benchmark measuring solver wall-clock runtime and solution quality under high window density.',
      seed: 20261126,
      horizonSec: 14400,
      sampleStepSec: 45,
      constellation: {
        totalSatellites: 48,
        planes: 8,
        phasing: 1,
        altitudeKm: 550,
        inclinationDeg: ssoInc550,
        eccentricity: 0.001,
        raan0Deg: 0,
        argPerigeeDeg: 0,
        meanAnomaly0Deg: 0,
        fovHalfAngleDeg: 28,
        epochIso: '2026-11-23T00:00:00Z',
        propagator: 'j2_rk4',
        rk4StepSec: 15,
      },
      groundStations: DEFAULT_GROUND_STATIONS,
      targets: generateSyntheticTargets(60, 20261126, 14400, 1.1, 1.05),
      resources: { ...DEFAULT_RESOURCES },
      cloudCorrelation: 0.55,
      outageRateMultiplier: 1.0,
      provenance: 'SYNTHETIC_ASSUMPTION',
    },
  };
}
