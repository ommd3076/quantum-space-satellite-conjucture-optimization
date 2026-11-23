import type {
  AlgorithmId,
  ExperimentBatchResult,
  PropagationBundle,
  ProposedAblationFlags,
  ScenarioConfig,
  SolverRunResult,
} from '../../backend/src/types';
import type { AuditCheckResult } from '../../backend/src/validation/auditSuite';
import type { ProvenanceLedgerEntry } from '../../backend/src/physics/constants';

export interface PresetWithHash extends ScenarioConfig {
  scenarioHash: string;
}

export interface AuditResponse {
  suite: {
    executedAtIso: string;
    totalChecks: number;
    passedChecks: number;
    checks: AuditCheckResult[];
  };
  provenanceLedger: ProvenanceLedgerEntry[];
  researchDocs: string[];
}

// --- Python/C++ Scientific Backend Types ---

export interface ScienceHealthResponse {
  status: 'CONNECTED' | 'OFFLINE';
  service?: string;
  timestamp_utc?: string;
  python_version?: string;
  packages?: {
    numpy: string;
    scipy: string;
    sgp4: string;
    sgp4_cpp_accelerated: boolean;
    pyarrow: string;
    ortools: string;
  };
  hardware?: {
    cpu_cores: number;
    total_ram_gb: number;
    process_rss_mb: number;
  };
  synthetic_50k_ready?: boolean;
  synthetic_50k_count?: number;
  real_catalog_loaded?: boolean;
  real_catalog_group?: string | null;
  real_catalog_count?: number;
  frame_note?: string;
  error?: string;
}

export interface RealCatalogProvenance {
  status: 'RETRIEVED_LIVE' | 'LOADED_FROM_CACHE' | 'DATA_NOT_RETRIEVED';
  source_provider: string;
  group: string;
  source_url: string;
  retrieved_at_utc: string | null;
  snapshot_file: string | null;
  sha256_raw: string | null;
  actual_ingested_raw: number;
  deduplicated_count: number;
  duplicate_records_removed: number;
  missing_elements_count: number;
  stale_count_gt_7d: number;
  classification_counts: Record<string, number>;
  epoch_min_utc: string | null;
  epoch_max_utc: string | null;
  median_element_age_hours: number | null;
  warnings: string[];
  error_detail: string | null;
}

export interface RealCatalogFrameResponse {
  mode: 'REAL_CATALOG';
  status: string;
  group: string;
  classification_filter: string;
  eval_epoch_utc: string;
  t_offset_sec: number;
  propagator: string;
  sgp4_cpp_accelerated: boolean;
  frame: string;
  frame_note: string;
  wall_time_ms: number;
  throughput_states_per_sec: number;
  provenance: RealCatalogProvenance | null;
  counts: {
    actual_ingested_raw: number;
    deduplicated?: number;
    filtered_eligible?: number;
    actual_propagated: number;
    failed: number;
    stale_gt_7d: number;
    rendered: number;
  };
  error_code_histogram?: Record<string, number>;
  positions_f32_b64: string;
  object_ids: string[];
  object_names?: string[];
  classification_codes?: number[];
}

export interface RealCatalogObjectDetail {
  mode: 'REAL_CATALOG';
  norad_cat_id: string;
  object_name: string;
  object_id: string;
  classification: string;
  source_provider: string;
  source_url: string;
  element_epoch_utc: string;
  element_age_hours: number;
  is_stale_gt_7d: boolean;
  propagator: string;
  frame: string;
  sgp4_error_code: number;
  sgp4_error_message: string;
  eval_epoch_utc: string;
  orbital_period_sec: number;
  omm_elements: {
    mean_motion_rev_day: number;
    eccentricity: number;
    inclination_deg: number;
    ra_of_asc_node_deg: number;
    arg_of_pericenter_deg: number;
    mean_anomaly_deg: number;
    bstar: number;
  };
  state: {
    r_teme_km: number[] | null;
    v_teme_km_s: number[] | null;
    r_ecef_km: number[] | null;
    lat_deg: number | null;
    lon_deg: number | null;
    alt_km: number | null;
    speed_km_s: number | null;
  };
  track_threejs: number[][];
  maneuver_note: string;
}

export interface Synthetic50kFrameResponse {
  mode: 'SYNTHETIC_50K';
  status: string;
  provenance: string;
  config_hash: string;
  seed: number;
  epoch_utc: string;
  eval_epoch_utc: string;
  t_offset_sec: number;
  propagator: string;
  frame: string;
  frame_note: string;
  wall_time_ms: number;
  throughput_states_per_sec: number;
  counts: {
    actual_ingested_raw: number;
    synthetic_configured: number;
    synthetic_propagated: number;
    failed: number;
    controllable_total: number;
    rendered: number;
  };
  positions_f32_b64: string;
  shell_u8_b64: string;
  controllable_u8_b64: string;
  sample_controllable_ids: string[];
  shell_filter: string;
}

export interface SyntheticObjectDetail {
  mode: 'SYNTHETIC_50K';
  provenance: string;
  sat_id: string;
  index: number;
  shell_id: string;
  shell_name: string;
  plane_index: number;
  slot_index: number;
  controllable: boolean;
  propagator: string;
  frame: string;
  epoch_utc: string;
  eval_epoch_utc: string;
  t_offset_sec: number;
  orbital_period_sec: number;
  initial_elements: {
    a_km: number;
    eccentricity: number;
    inclination_deg: number;
    raan_deg: number;
    arg_perigee_deg: number;
    mean_anomaly_deg: number;
  };
  state: {
    r_eci_km: number[];
    v_eci_km_s: number[];
    r_ecef_km: number[];
    lat_deg: number;
    lon_deg: number;
    alt_km: number;
    speed_km_s: number;
  };
  track_threejs: number[][];
}

export interface ManeuverSimulationResult {
  sat_id: string;
  maneuver_type: string;
  propagator: string;
  frame: string;
  provenance: string;
  epoch_utc: string;
  horizon_sec: number;
  propulsion_budget: {
    wet_mass_kg: number;
    dry_mass_kg: number;
    available_propellant_kg: number;
    isp_s: number;
    total_dv_m_s: number;
    total_propellant_used_kg: number;
    remaining_propellant_kg: number;
    final_mass_kg: number;
  };
  burn_events: Array<{
    label: string;
    t_burn_sec: number;
    burn_epoch_utc: string;
    commanded_frame: string;
    dv_commanded_m_s: number[];
    dv_applied_eci_m_s: number[];
    dv_magnitude_m_s: number;
    velocity_discontinuity_verified_m_s: number;
    propellant_used_kg: number;
    mass_after_burn_kg: number;
    delta_a_km: number;
    delta_inc_deg: number;
    delta_perigee_alt_km: number;
    delta_apogee_alt_km: number;
  }>;
  trajectory_divergence: {
    max_position_separation_km: number;
    final_position_separation_km: number;
  };
  baseline_track_threejs: number[][];
  maneuvered_track_threejs: number[][];
}

export interface ProximityScreeningResponse {
  status: string;
  mode: string;
  frame: string;
  method: string;
  objects_screened: number;
  objects_skipped_non_finite: number;
  naive_all_pairs_avoided: number;
  broad_phase_radius_km: number;
  threshold_km: number;
  candidate_pairs_broad_phase: number;
  pairs_within_threshold: number;
  broad_phase_ms: number;
  wall_time_ms: number;
  close_approaches: Array<{
    object_a: string;
    object_b: string;
    instantaneous_dist_km: number;
    narrow_phase_min_dist_km: number;
    tca_offset_sec: number;
    relative_speed_km_s: number;
  }>;
  disclaimer: string;
}

export interface PythonValidationResponse {
  executed_at_utc: string;
  executed_checks_count: number;
  executed_checks_passed: number;
  unverified_checks_count: number;
  checks: Array<{
    check_id: string;
    title: string;
    reference_source: string;
    passed: boolean;
    status: 'PASSED' | 'FAILED' | 'UNVERIFIED';
    metrics: Record<string, unknown>;
  }>;
}

export interface PythonOptimizationResponse {
  access_summary: {
    sat_count_analyzed: number;
    target_count: number;
    station_count: number;
    horizon_sec: number;
    horizon_refinement: string;
    observation_windows_count: number;
    downlink_windows_count: number;
  };
  optimization: {
    experiment_id: string;
    executed_at_utc: string;
    artifact_file?: string;
    scope_disclosure: string;
    results: Array<{
      algorithm_id: string;
      novelty_status: string;
      solver_status: string;
      best_objective_bound: number | null;
      optimality_gap_pct: number | null;
      wall_time_ms: number;
      verification: {
        verified_feasible: boolean;
        violation_count: number;
        verified_deterministic_utility: number;
        verified_realized_clear_utility: number;
        scheduled_observations_count: number;
        scheduled_downlinks_count: number;
        downlinked_volume_gb: number;
      };
    }>;
  };
}

export interface ScienceJobResponse {
  job_id: string;
  job_type: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'FAILED';
  progress: number;
  message: string;
  wall_time_sec: number | null;
  result: Record<string, unknown> | null;
  error: string | null;
}

// Binary Base64 decoders for zero-fabrication GPU Float32 frames
export function decodeFloat32Base64(b64: string): Float32Array {
  if (!b64) return new Float32Array(0);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new Float32Array(bytes.buffer);
}

export function decodeUint8Base64(b64: string): Uint8Array {
  if (!b64) return new Uint8Array(0);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const data = await res.json();
  if (!res.ok) {
    const msg =
      (data as { detail?: string; error?: string })?.detail ||
      (data as { error?: string })?.error ||
      `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

// --- Python/C++ Scientific API Functions ---

export async function fetchScienceHealth(): Promise<ScienceHealthResponse> {
  try {
    const res = await fetch('/api/science/health');
    const data = (await res.json()) as ScienceHealthResponse;
    if (!res.ok) {
      return { status: 'OFFLINE', error: data.error || `HTTP ${res.status}` };
    }
    return data;
  } catch (err) {
    return { status: 'OFFLINE', error: err instanceof Error ? err.message : String(err) };
  }
}

export function fetchCatalogGroups(): Promise<{ groups: Record<string, string> }> {
  return apiJson('/api/science/catalog/groups');
}

export function ingestRealCatalog(params: {
  provider?: 'celestrak' | 'spacetrack';
  group: string;
  force_refresh?: boolean;
}): Promise<RealCatalogProvenance> {
  return apiJson('/api/science/catalog/ingest', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export function fetchRealCatalogFrame(params: {
  group: string;
  t_offset_sec: number;
  classification?: string;
}): Promise<RealCatalogFrameResponse> {
  const q = new URLSearchParams({
    group: params.group,
    t_offset_sec: String(params.t_offset_sec),
    classification: params.classification || 'ALL',
  });
  return apiJson(`/api/science/catalog/frame?${q.toString()}`);
}

export function fetchRealCatalogObject(
  noradCatId: string,
  tOffsetSec = 0,
): Promise<RealCatalogObjectDetail> {
  return apiJson(
    `/api/science/catalog/object/${encodeURIComponent(noradCatId)}?t_offset_sec=${encodeURIComponent(tOffsetSec)}`,
  );
}

export function fetchSynthetic50kFrame(params: {
  t_offset_sec: number;
  fidelity?: 'j2_secular_kepler' | 'j2_rk4_numerical';
  shell_filter?: string;
}): Promise<Synthetic50kFrameResponse> {
  const q = new URLSearchParams({
    t_offset_sec: String(params.t_offset_sec),
    fidelity: params.fidelity || 'j2_secular_kepler',
    shell_filter: params.shell_filter || 'ALL',
  });
  return apiJson(`/api/science/synthetic/frame?${q.toString()}`);
}

export function fetchSynthetic50kObject(
  satId: string,
  tOffsetSec = 0,
): Promise<SyntheticObjectDetail> {
  return apiJson(
    `/api/science/synthetic/object/${encodeURIComponent(satId)}?t_offset_sec=${encodeURIComponent(tOffsetSec)}`,
  );
}

export function fetchSynthetic50kObjectByIndex(
  index: number,
  tOffsetSec = 0,
): Promise<SyntheticObjectDetail> {
  return apiJson(
    `/api/science/synthetic/object-by-index/${index}?t_offset_sec=${encodeURIComponent(tOffsetSec)}`,
  );
}

export function simulateImpulsiveManeuver(params: {
  sat_id: string;
  burns: Array<{
    t_burn_sec: number;
    frame: 'RTN' | 'ECI';
    dv_m_s: [number, number, number];
    label?: string;
  }>;
  horizon_sec?: number;
  wet_mass_kg?: number;
  dry_mass_kg?: number;
  isp_s?: number;
}): Promise<ManeuverSimulationResult> {
  return apiJson('/api/science/maneuvers/simulate', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export function runProximityScreening(params: {
  mode: 'REAL_CATALOG' | 'SYNTHETIC_50K';
  t_offset_sec: number;
  threshold_km: number;
}): Promise<ProximityScreeningResponse> {
  return apiJson('/api/science/screening/run', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export function runPythonOptimization(params: {
  controllable_sat_count?: number;
  target_count?: number;
  horizon_sec?: number;
  cpsat_time_limit_sec?: number;
  seed?: number;
}): Promise<PythonOptimizationResponse> {
  return apiJson('/api/science/optimization/solve', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export function fetchPythonValidation(): Promise<PythonValidationResponse> {
  return apiJson('/api/science/validation/run');
}

export function submitBench50kJob(params: {
  horizon_sec: number;
  step_sec: number;
  chunk_size?: number;
  fidelity?: 'j2_secular_kepler' | 'j2_rk4_numerical';
  write_parquet?: boolean;
}): Promise<ScienceJobResponse> {
  return apiJson('/api/science/jobs/bench50k', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export function fetchScienceJob(jobId: string): Promise<ScienceJobResponse> {
  return apiJson(`/api/science/jobs/${encodeURIComponent(jobId)}`);
}

export function cancelScienceJob(jobId: string): Promise<ScienceJobResponse> {
  return apiJson(`/api/science/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
}

// --- Legacy Sandbox API Functions (kept for backward compatibility) ---

export function fetchPresets(): Promise<{ presets: PresetWithHash[] }> {
  return apiJson('/api/presets');
}

export function fetchSsoInclination(
  altitudeKm: number,
  eccentricity = 0.001,
): Promise<{ altitudeKm: number; eccentricity: number; inclinationDeg: number }> {
  return apiJson(
    `/api/sso-inclination?altitudeKm=${encodeURIComponent(altitudeKm)}&eccentricity=${encodeURIComponent(eccentricity)}`,
  );
}

export function propagateScenario(scenario: ScenarioConfig): Promise<PropagationBundle> {
  return apiJson('/api/propagate', {
    method: 'POST',
    body: JSON.stringify({ scenario }),
  });
}

export function saveScenarioManifest(
  scenario: ScenarioConfig,
): Promise<{ id: string; scenarioHash: string; scenario: ScenarioConfig }> {
  return apiJson('/api/scenarios/save', {
    method: 'POST',
    body: JSON.stringify({ scenario }),
  });
}

export function generateTargetsApi(params: {
  count: number;
  seed: number;
  horizonSec: number;
  deadlinePressure?: number;
  cloudScale?: number;
}): Promise<{ targets: ScenarioConfig['targets'] }> {
  return apiJson('/api/targets/generate', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export function solveScenarioApi(params: {
  scenario: ScenarioConfig;
  algorithmId: AlgorithmId | 'all';
  computeBudgetMs: number;
  ablationFlags?: ProposedAblationFlags;
}): Promise<{ scenarioHash: string; results: SolverRunResult[] }> {
  return apiJson('/api/solve', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export function runExperimentBatchApi(params: {
  scenario: ScenarioConfig;
  seeds: number[];
  computeBudgetMs: number;
  includeAblations: boolean;
  includeExactSolver: boolean;
}): Promise<ExperimentBatchResult> {
  return apiJson('/api/experiments/run', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export function fetchAuditSuite(): Promise<AuditResponse> {
  return apiJson('/api/audit');
}

export function fetchResearchDoc(
  filename: string,
): Promise<{ filename: string; content: string }> {
  return apiJson(`/api/research/${encodeURIComponent(filename)}`);
}
