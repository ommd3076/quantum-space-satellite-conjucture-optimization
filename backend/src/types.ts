export type ProvenanceTag =
  | 'VERIFIED_SOURCE'
  | 'SYNTHETIC_ASSUMPTION'
  | 'MODEL_ESTIMATE'
  | 'MEASURED_EXPERIMENT'
  | 'UNVERIFIED';

export type PropagatorModel = 'kepler_2body' | 'j2_rk4';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface OrbitalElements {
  /** Semi-major axis (km) */
  aKm: number;
  /** Eccentricity (dimensionless, 0 <= e < 1) */
  e: number;
  /** Inclination (deg) */
  incDeg: number;
  /** Right Ascension of Ascending Node (deg) */
  raanDeg: number;
  /** Argument of Perigee (deg) */
  argPerigeeDeg: number;
  /** Mean Anomaly at Epoch (deg) */
  meanAnomalyDeg: number;
}

export interface SatelliteState {
  satId: string;
  planeIndex: number;
  slotIndex: number;
  tSec: number;
  eciPosKm: Vec3;
  eciVelKmS: Vec3;
  ecefPosKm: Vec3;
  latDeg: number;
  lonDeg: number;
  altKm: number;
  inEclipse: boolean;
  specificEnergyKm2S2: number;
  angularMomentumKm2S: number;
}

export interface WalkerConstellationConfig {
  /** Total satellites T (must be divisible by P) */
  totalSatellites: number;
  /** Orbital planes P */
  planes: number;
  /** Phasing factor F in [0, P-1] */
  phasing: number;
  /** Reference altitude above WGS84 equatorial radius (km) */
  altitudeKm: number;
  /** Orbital inclination (deg) */
  inclinationDeg: number;
  /** Eccentricity (0 <= e < 0.2 for LEO) */
  eccentricity: number;
  /** Base RAAN of plane 0 (deg) */
  raan0Deg: number;
  /** Argument of perigee (deg) */
  argPerigeeDeg: number;
  /** Base mean anomaly of sat 0 in plane 0 (deg) */
  meanAnomaly0Deg: number;
  /** Max agile off-nadir sensor look angle (deg) */
  fovHalfAngleDeg: number;
  /** UTC ISO epoch timestamp */
  epochIso: string;
  /** Orbital propagator model */
  propagator: PropagatorModel;
  /** RK4 integration sub-step (s) when propagator === 'j2_rk4' */
  rk4StepSec: number;
}

export interface GroundStation {
  id: string;
  name: string;
  latDeg: number;
  lonDeg: number;
  altKm: number;
  minElevationDeg: number;
  downlinkRateGbps: number;
  outageProb: number;
  provenance: ProvenanceTag;
}

export interface ObservationTarget {
  id: string;
  name: string;
  region: 'Equatorial' | 'Mid-Latitude' | 'High-Latitude' | 'Disaster-Cluster';
  latDeg: number;
  lonDeg: number;
  priority: number;
  deadlineSec: number;
  durationSec: number;
  dataVolumeGb: number;
  baseCloudProb: number;
  provenance: ProvenanceTag;
}

export interface ResourceModelConfig {
  batteryCapacityWh: number;
  batteryMinWh: number;
  batteryInitialWh: number;
  solarChargePowerW: number;
  idlePowerW: number;
  imagingPowerW: number;
  downlinkPowerW: number;
  storageCapacityGb: number;
  storageInitialGb: number;
  slewRateDegPerSec: number;
  setupTimeSec: number;
  /** Partial credit fraction for captured-not-yet-downlinked observations */
  captureCreditFraction: number;
}

export interface ScenarioConfig {
  id: string;
  name: string;
  description: string;
  seed: number;
  horizonSec: number;
  sampleStepSec: number;
  constellation: WalkerConstellationConfig;
  groundStations: GroundStation[];
  targets: ObservationTarget[];
  resources: ResourceModelConfig;
  /** Cloud correlation scale (0 = independent, 0.7 = strongly correlated across nearby passes) */
  cloudCorrelation: number;
  /** Ground station outage severity multiplier */
  outageRateMultiplier: number;
  provenance: ProvenanceTag;
}

export interface ObservationWindow {
  windowId: string;
  satId: string;
  targetId: string;
  startSec: number;
  endSec: number;
  midSec: number;
  durationSec: number;
  minOffNadirDeg: number;
  maxElevationDeg: number;
  targetPriority: number;
  deadlineSec: number;
  requiredObsSec: number;
  dataVolumeGb: number;
  cloudProb: number;
  /** Deterministic seeded stochastic realization for evaluation (true = cloud obscured / failed) */
  realizedCloudBlocked: boolean;
  /** Approximate boresight unit vector at midSec in ECEF for slew-angle computation */
  lookVecEcef: Vec3;
}

export interface DownlinkWindow {
  contactId: string;
  satId: string;
  stationId: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  maxElevationDeg: number;
  downlinkRateGbps: number;
  maxVolumeGb: number;
  outageProb: number;
  /** Deterministic seeded outage realization */
  realizedOutage: boolean;
}

export interface CoverageAnalytics {
  scenarioHash: string;
  orbitalPeriodSec: number;
  analyticalJ2RaanRateDegPerDay: number;
  ssoTargetRateDegPerDay: number;
  ssoDeviationDegPerDay: number;
  energyDriftMaxRelative: number;
  angularMomentumDriftMaxRelative: number;
  globalTargetCoverageFraction: number;
  targetsWithAccessCount: number;
  totalTargetsCount: number;
  totalObservationWindows: number;
  totalDownlinkContacts: number;
  meanRevisitGapSec: number;
  medianRevisitGapSec: number;
  maxRevisitGapSec: number;
  jainsFairnessIndex: number;
  eclipseFractionMean: number;
  perTargetStats: Array<{
    targetId: string;
    name: string;
    region: string;
    windowCount: number;
    meanGapSec: number;
    maxGapSec: number;
    covered: boolean;
  }>;
  coverageOverTime: Array<{
    tSec: number;
    cumulativeCoveredTargets: number;
    cumulativeCoveragePct: number;
    activeAccessLinks: number;
    activeDownlinks: number;
    sunlitSatellites: number;
  }>;
  perSatelliteContactSec: Array<{
    satId: string;
    planeIndex: number;
    obsWindowCount: number;
    contactCount: number;
    totalContactSec: number;
    maxDownlinkCapacityGb: number;
  }>;
}

export interface PropagationBundle {
  scenario: ScenarioConfig;
  scenarioHash: string;
  computedAtIso: string;
  computeRuntimeMs: number;
  timeStepsSec: number[];
  satellites: Array<{
    satId: string;
    planeIndex: number;
    slotIndex: number;
    initialElements: OrbitalElements;
    states: SatelliteState[];
  }>;
  observationWindows: ObservationWindow[];
  downlinkWindows: DownlinkWindow[];
  analytics: CoverageAnalytics;
}

export type AlgorithmId =
  | 'greedy'
  | 'deadline_heuristic'
  | 'exact_bnb'
  | 'rolling_horizon'
  | 'proposed';

export interface ProposedAblationFlags {
  useRiskAware: boolean;
  useShadowPricing: boolean;
  useIncrementalRepair: boolean;
}

export interface ScheduledAction {
  actionId: string;
  type: 'observation' | 'downlink';
  satId: string;
  windowId: string;
  entityId: string;
  entityName: string;
  startSec: number;
  endSec: number;
  dataDeltaGb: number;
  energyDeltaWh: number;
  priority: number;
  cloudProb?: number;
  realizedFailed?: boolean;
  delivered?: boolean;
}

export interface SatelliteResourceTracePoint {
  tSec: number;
  batteryWh: number;
  storageGb: number;
  event: string;
}

export interface VerificationViolation {
  code:
    | 'WINDOW_BOUNDS'
    | 'DEADLINE_EXCEEDED'
    | 'TASK_OVERLAP_OR_SLEW'
    | 'BATTERY_BELOW_MIN'
    | 'STORAGE_OVERFLOW'
    | 'STORAGE_UNDERFLOW'
    | 'DOWNLINK_CAPACITY_EXCEEDED'
    | 'DUPLICATE_TARGET_CREDIT'
    | 'UNKNOWN_WINDOW';
  satId: string;
  actionId: string;
  message: string;
}

export interface IndependentVerificationReport {
  verifiedFeasible: boolean;
  violationCount: number;
  violations: VerificationViolation[];
  verifiedDeterministicObjective: number;
  verifiedRealizedObjective: number;
  uniqueTargetsCaptured: number;
  uniqueTargetsDelivered: number;
  realizedTargetsDelivered: number;
  onTimeDeliveryRate: number;
  totalDataCapturedGb: number;
  totalDataDownlinkedGb: number;
  meanDataLatencySec: number;
  peakStorageUtilizationPct: number;
  minBatteryMarginPct: number;
  resourceTraces: Record<string, SatelliteResourceTracePoint[]>;
}

export type SolverStatus =
  | 'OPTIMAL'
  | 'FEASIBLE_INCUMBENT'
  | 'INFEASIBLE'
  | 'TIMEOUT'
  | 'FAILED';

export interface SolverRunResult {
  algorithmId: AlgorithmId;
  algorithmLabel: string;
  ablationFlags?: ProposedAblationFlags;
  scenarioHash: string;
  seed: number;
  status: SolverStatus;
  solverReportedObjective: number;
  dualUpperBound: number | null;
  optimalityGapPct: number | null;
  runtimeMs: number;
  computeBudgetMs: number;
  nodesExplored?: number;
  repairEventsTriggered?: number;
  notes: string[];
  actions: ScheduledAction[];
  verification: IndependentVerificationReport;
}

export interface SolverSummaryStats {
  algorithmKey: string;
  label: string;
  runs: number;
  validFeasibleRuns: number;
  violationRuns: number;
  timeoutRuns: number;
  meanDeterministicObj: number;
  stdDeterministicObj: number;
  ci95DeterministicObj: number;
  meanRealizedObj: number;
  stdRealizedObj: number;
  ci95RealizedObj: number;
  minRealizedObj: number;
  maxRealizedObj: number;
  meanOnTimeRate: number;
  meanRuntimeMs: number;
  meanLatencySec: number;
  pairedDeltaVsRH: number | null;
  pairedCi95VsRH: number | null;
  cohensDVsRH: number | null;
}

export interface ExperimentBatchResult {
  batchId: string;
  executedAtIso: string;
  baseScenarioHash: string;
  suiteName: string;
  seeds: number[];
  computeBudgetMs: number;
  includeAblations: boolean;
  summaryByAlgorithm: SolverSummaryStats[];
  rawRuns: Array<{
    seed: number;
    algorithmKey: string;
    label: string;
    status: SolverStatus;
    verifiedFeasible: boolean;
    violationCount: number;
    deterministicObj: number;
    realizedObj: number;
    onTimeDeliveryRate: number;
    meanLatencySec: number;
    runtimeMs: number;
    optimalityGapPct: number | null;
    repairEventsTriggered: number;
  }>;
  hypothesisCheck: {
    proposedVsRhDelta: number | null;
    proposedVsRhCi95: number | null;
    strictlyPositiveCi95: boolean;
    zeroViolations: boolean;
    verdict: 'SUPPORTED_ON_BATCH' | 'FALSIFIED_OR_INCONCLUSIVE' | 'INVALID_VIOLATION';
    explanation: string;
  };
  environment: {
    nodeVersion: string;
    platform: string;
    arch: string;
    cpus: number;
  };
}
