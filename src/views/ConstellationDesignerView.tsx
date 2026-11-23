import { useState } from 'react';
import { Check, RefreshCw, Save } from 'lucide-react';
import {
  fetchSsoInclination,
  generateTargetsApi,
  saveScenarioManifest,
  type PresetWithHash,
} from '../api/client';
import type { ScenarioConfig } from '../../backend/src/types';

interface ConstellationDesignerViewProps {
  scenario: ScenarioConfig;
  presets: PresetWithHash[];
  scenarioHash: string;
  propagating: boolean;
  onChangeScenario: (next: ScenarioConfig) => void;
  onRunPropagation: (sc: ScenarioConfig) => Promise<void>;
  onSavedScenario: (saved: ScenarioConfig, hash: string) => void;
}

export function ConstellationDesignerView({
  scenario,
  presets,
  scenarioHash,
  propagating,
  onChangeScenario,
  onRunPropagation,
  onSavedScenario,
}: ConstellationDesignerViewProps) {
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [targetCount, setTargetCount] = useState(scenario.targets.length);

  const c = scenario.constellation;
  const res = scenario.resources;

  const isWalkerDivisible = c.planes > 0 && c.totalSatellites % c.planes === 0;
  const isPhasingValid = c.phasing >= 0 && c.phasing < c.planes;
  const isConfigValid = isWalkerDivisible && isPhasingValid && c.altitudeKm >= 250 && c.altitudeKm <= 2000;

  const updateConstellation = <K extends keyof ScenarioConfig['constellation']>(
    key: K,
    val: ScenarioConfig['constellation'][K],
  ) => {
    setErrorMsg(null);
    setStatusMsg(null);
    onChangeScenario({
      ...scenario,
      constellation: { ...scenario.constellation, [key]: val },
    });
  };

  const updateResources = <K extends keyof ScenarioConfig['resources']>(
    key: K,
    val: ScenarioConfig['resources'][K],
  ) => {
    setStatusMsg(null);
    onChangeScenario({
      ...scenario,
      resources: { ...scenario.resources, [key]: val },
    });
  };

  const handleComputeSso = async () => {
    try {
      const r = await fetchSsoInclination(c.altitudeKm, c.eccentricity);
      updateConstellation('inclinationDeg', r.inclinationDeg);
      setStatusMsg(
        `Matched J2 Sun-Synchronous inclination: ${r.inclinationDeg.toFixed(3)}° for h=${c.altitudeKm} km.`,
      );
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const handleRegenerateTargets = async () => {
    try {
      const { targets } = await generateTargetsApi({
        count: targetCount,
        seed: scenario.seed,
        horizonSec: scenario.horizonSec,
      });
      onChangeScenario({ ...scenario, targets });
      setStatusMsg(`Generated ${targets.length} deterministic synthetic targets (seed ${scenario.seed}).`);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const handleSave = async () => {
    if (!isConfigValid) {
      setErrorMsg('Cannot save: Walker T must be divisible by P and phasing F must be in [0, P-1].');
      return;
    }
    try {
      const saved = await saveScenarioManifest(scenario);
      onSavedScenario(saved.scenario, saved.scenarioHash);
      setStatusMsg(`Frozen scenario manifest saved · SHA-256: ${saved.scenarioHash.slice(0, 16)}...`);
      setErrorMsg(null);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const handlePropagate = async () => {
    if (!isConfigValid) {
      setErrorMsg('Cannot propagate: fix Walker T/P/F constraints first.');
      return;
    }
    setErrorMsg(null);
    try {
      await onRunPropagation(scenario);
      setStatusMsg('Orbital propagation, access windows, and coverage analytics updated.');
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex-1 overflow-y-auto bg-[#07090E] p-6">
      <div className="max-w-[1280px] mx-auto space-y-6">
        {/* Header & Actions */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-slate-800 pb-5">
          <div>
            <p className="text-xs font-mono text-slate-400">
              Provenance: {scenario.provenance} · Manifest Hash: {scenarioHash.slice(0, 14)}
            </p>
            <h1 className="text-2xl font-semibold text-slate-100 mt-1">
              Constellation & Mission Designer
            </h1>
            <p className="text-sm text-slate-400 mt-1 max-w-2xl">
              Configure Walker Delta orbital geometry (T/P/F), propagator fidelity, onboard payload
              resources, targets, and ground stations. Freeze a manifest before comparing algorithms.
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={handleSave}
              disabled={!isConfigValid}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-slate-200 bg-[#0E131D] hover:bg-slate-800 border border-slate-700 rounded-md disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              <Save className="w-3.5 h-3.5" />
              Save Scenario
            </button>
            <button
              type="button"
              onClick={handlePropagate}
              disabled={propagating || !isConfigValid}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded-md disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${propagating ? 'animate-spin' : ''}`} />
              {propagating ? 'Propagating...' : 'Run Propagation'}
            </button>
          </div>
        </div>

        {/* Feedback banners */}
        {errorMsg && (
          <div role="alert" className="p-3 bg-rose-950/40 border border-rose-800 rounded-md text-xs text-rose-200">
            Error: {errorMsg}
          </div>
        )}
        {statusMsg && (
          <div className="p-3 bg-emerald-950/30 border border-emerald-800/80 rounded-md text-xs text-emerald-200 flex items-center gap-2">
            <Check className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{statusMsg}</span>
          </div>
        )}

        {/* Benchmark Presets Selector */}
        <section className="bg-[#0E131D] border border-slate-800 rounded-md p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h2 className="text-sm font-semibold text-slate-100">Frozen Benchmark Scenarios</h2>
            <span className="text-xs text-slate-400">
              Provisional synthetic benchmarks (not real fleet telemetry)
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            {presets.map((p) => {
              const active = p.id === scenario.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    onChangeScenario(p);
                    setTargetCount(p.targets.length);
                    setStatusMsg(`Loaded scenario "${p.name}". Click Run Propagation to recompute.`);
                  }}
                  className={`text-left p-3 rounded border transition-colors ${
                    active
                      ? 'bg-cyan-500/10 border-cyan-500/60'
                      : 'bg-[#090D14] border-slate-800 hover:border-slate-600'
                  }`}
                >
                  <div className="text-xs font-mono text-cyan-400 tabular-nums">
                    Walker {p.constellation.totalSatellites}/{p.constellation.planes}/
                    {p.constellation.phasing} · {p.constellation.altitudeKm} km
                  </div>
                  <div className="text-xs font-semibold text-slate-100 mt-1 line-clamp-1">{p.name}</div>
                  <div className="text-[11px] text-slate-400 mt-1 font-mono tabular-nums">
                    {p.targets.length} targets · {p.groundStations.length} stations ·{' '}
                    {(p.horizonSec / 3600).toFixed(0)}h
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {/* Main Configuration Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Walker Delta & Orbit Parameters */}
          <section className="bg-[#0E131D] border border-slate-800 rounded-md p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h2 className="text-sm font-semibold text-slate-100">Walker Delta Orbital Parameters</h2>
              <span className="text-xs font-mono text-slate-400">
                Convention: ΔΩ=360°/P, ΔM=360°·F/T
              </span>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label htmlFor="walker-t" className="block text-xs text-slate-400 mb-1">
                  Satellites (T)
                </label>
                <input
                  id="walker-t"
                  type="number"
                  min={1}
                  max={96}
                  value={c.totalSatellites}
                  onChange={(e) => updateConstellation('totalSatellites', Number(e.target.value))}
                  className="w-full bg-[#07090E] border border-slate-700 rounded px-2.5 py-1.5 text-sm font-mono tabular-nums text-slate-100"
                />
              </div>
              <div>
                <label htmlFor="walker-p" className="block text-xs text-slate-400 mb-1">
                  Planes (P)
                </label>
                <input
                  id="walker-p"
                  type="number"
                  min={1}
                  max={24}
                  value={c.planes}
                  onChange={(e) => updateConstellation('planes', Number(e.target.value))}
                  className="w-full bg-[#07090E] border border-slate-700 rounded px-2.5 py-1.5 text-sm font-mono tabular-nums text-slate-100"
                />
              </div>
              <div>
                <label htmlFor="walker-f" className="block text-xs text-slate-400 mb-1">
                  Phasing (F)
                </label>
                <input
                  id="walker-f"
                  type="number"
                  min={0}
                  max={Math.max(0, c.planes - 1)}
                  value={c.phasing}
                  onChange={(e) => updateConstellation('phasing', Number(e.target.value))}
                  className="w-full bg-[#07090E] border border-slate-700 rounded px-2.5 py-1.5 text-sm font-mono tabular-nums text-slate-100"
                />
              </div>
            </div>

            {!isWalkerDivisible && (
              <p className="text-xs text-rose-400">
                Invalid Walker Delta: T ({c.totalSatellites}) must be evenly divisible by P ({c.planes}).
              </p>
            )}
            {!isPhasingValid && (
              <p className="text-xs text-rose-400">
                Invalid phasing: F ({c.phasing}) must satisfy 0 ≤ F &lt; P ({c.planes}).
              </p>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="orbit-alt" className="block text-xs text-slate-400 mb-1">
                  Altitude h (km)
                </label>
                <input
                  id="orbit-alt"
                  type="number"
                  min={250}
                  max={2000}
                  step={10}
                  value={c.altitudeKm}
                  onChange={(e) => updateConstellation('altitudeKm', Number(e.target.value))}
                  className="w-full bg-[#07090E] border border-slate-700 rounded px-2.5 py-1.5 text-sm font-mono tabular-nums text-slate-100"
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label htmlFor="orbit-inc" className="text-xs text-slate-400">
                    Inclination i (°)
                  </label>
                  <button
                    type="button"
                    onClick={handleComputeSso}
                    className="text-[11px] text-cyan-400 hover:text-cyan-300 underline"
                  >
                    Match J2 SSO
                  </button>
                </div>
                <input
                  id="orbit-inc"
                  type="number"
                  min={0}
                  max={180}
                  step={0.1}
                  value={c.inclinationDeg}
                  onChange={(e) => updateConstellation('inclinationDeg', Number(e.target.value))}
                  className="w-full bg-[#07090E] border border-slate-700 rounded px-2.5 py-1.5 text-sm font-mono tabular-nums text-slate-100"
                />
              </div>
              <div>
                <label htmlFor="orbit-ecc" className="block text-xs text-slate-400 mb-1">
                  Eccentricity e
                </label>
                <input
                  id="orbit-ecc"
                  type="number"
                  min={0}
                  max={0.2}
                  step={0.001}
                  value={c.eccentricity}
                  onChange={(e) => updateConstellation('eccentricity', Number(e.target.value))}
                  className="w-full bg-[#07090E] border border-slate-700 rounded px-2.5 py-1.5 text-sm font-mono tabular-nums text-slate-100"
                />
              </div>
              <div>
                <label htmlFor="sensor-fov" className="block text-xs text-slate-400 mb-1">
                  Sensor Max Off-Nadir (°)
                </label>
                <input
                  id="sensor-fov"
                  type="number"
                  min={5}
                  max={60}
                  step={1}
                  value={c.fovHalfAngleDeg}
                  onChange={(e) => updateConstellation('fovHalfAngleDeg', Number(e.target.value))}
                  className="w-full bg-[#07090E] border border-slate-700 rounded px-2.5 py-1.5 text-sm font-mono tabular-nums text-slate-100"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-800/70">
              <div>
                <label htmlFor="prop-model" className="block text-xs text-slate-400 mb-1">
                  Propagator Dynamics
                </label>
                <select
                  id="prop-model"
                  value={c.propagator}
                  onChange={(e) =>
                    updateConstellation('propagator', e.target.value as 'kepler_2body' | 'j2_rk4')
                  }
                  className="w-full bg-[#07090E] border border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-slate-100"
                >
                  <option value="j2_rk4">Two-Body + J2 (RK4 Numerical)</option>
                  <option value="kepler_2body">Two-Body Keplerian (Analytical)</option>
                </select>
              </div>
              <div>
                <label htmlFor="horizon-hours" className="block text-xs text-slate-400 mb-1">
                  Planning Horizon (hours)
                </label>
                <select
                  id="horizon-hours"
                  value={scenario.horizonSec}
                  onChange={(e) =>
                    onChangeScenario({ ...scenario, horizonSec: Number(e.target.value) })
                  }
                  className="w-full bg-[#07090E] border border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-slate-100"
                >
                  <option value={10800}>3 hours (10,800 s)</option>
                  <option value={14400}>4 hours (14,400 s)</option>
                  <option value={21600}>6 hours (21,600 s)</option>
                  <option value={43200}>12 hours (43,200 s)</option>
                </select>
              </div>
              <div>
                <label htmlFor="epoch-iso" className="block text-xs text-slate-400 mb-1">
                  UTC Epoch (ISO-8601)
                </label>
                <input
                  id="epoch-iso"
                  type="text"
                  value={c.epochIso}
                  onChange={(e) => updateConstellation('epochIso', e.target.value)}
                  className="w-full bg-[#07090E] border border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-slate-100"
                />
              </div>
              <div>
                <label htmlFor="scenario-seed" className="block text-xs text-slate-400 mb-1">
                  Deterministic Seed
                </label>
                <input
                  id="scenario-seed"
                  type="number"
                  value={scenario.seed}
                  onChange={(e) =>
                    onChangeScenario({ ...scenario, seed: Number(e.target.value) })
                  }
                  className="w-full bg-[#07090E] border border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono tabular-nums text-slate-100"
                />
              </div>
            </div>
          </section>

          {/* Payload & Bus Resource Bounds */}
          <section className="bg-[#0E131D] border border-slate-800 rounded-md p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h2 className="text-sm font-semibold text-slate-100">
                Onboard Resource & Uncertainty Bounds
              </h2>
              <span className="text-xs font-mono text-slate-400">SYNTHETIC_ASSUMPTION</span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="res-bat-cap" className="block text-xs text-slate-400 mb-1">
                  Battery Capacity (Wh)
                </label>
                <input
                  id="res-bat-cap"
                  type="number"
                  min={30}
                  max={500}
                  value={res.batteryCapacityWh}
                  onChange={(e) => updateResources('batteryCapacityWh', Number(e.target.value))}
                  className="w-full bg-[#07090E] border border-slate-700 rounded px-2.5 py-1.5 text-sm font-mono tabular-nums text-slate-100"
                />
              </div>
              <div>
                <label htmlFor="res-bat-min" className="block text-xs text-slate-400 mb-1">
                  Battery Reserve Floor (Wh)
                </label>
                <input
                  id="res-bat-min"
                  type="number"
                  min={5}
                  max={res.batteryCapacityWh - 10}
                  value={res.batteryMinWh}
                  onChange={(e) => updateResources('batteryMinWh', Number(e.target.value))}
                  className="w-full bg-[#07090E] border border-slate-700 rounded px-2.5 py-1.5 text-sm font-mono tabular-nums text-slate-100"
                />
              </div>
              <div>
                <label htmlFor="res-ssr" className="block text-xs text-slate-400 mb-1">
                  Solid-State Storage (Gb)
                </label>
                <input
                  id="res-ssr"
                  type="number"
                  min={10}
                  max={512}
                  value={res.storageCapacityGb}
                  onChange={(e) => updateResources('storageCapacityGb', Number(e.target.value))}
                  className="w-full bg-[#07090E] border border-slate-700 rounded px-2.5 py-1.5 text-sm font-mono tabular-nums text-slate-100"
                />
              </div>
              <div>
                <label htmlFor="res-slew" className="block text-xs text-slate-400 mb-1">
                  Agile Slew Rate (°/s)
                </label>
                <input
                  id="res-slew"
                  type="number"
                  min={0.5}
                  max={10}
                  step={0.25}
                  value={res.slewRateDegPerSec}
                  onChange={(e) => updateResources('slewRateDegPerSec', Number(e.target.value))}
                  className="w-full bg-[#07090E] border border-slate-700 rounded px-2.5 py-1.5 text-sm font-mono tabular-nums text-slate-100"
                />
              </div>
              <div>
                <label htmlFor="res-cloud-corr" className="block text-xs text-slate-400 mb-1">
                  Cloud Correlation (0–1)
                </label>
                <input
                  id="res-cloud-corr"
                  type="number"
                  min={0}
                  max={0.95}
                  step={0.05}
                  value={scenario.cloudCorrelation}
                  onChange={(e) =>
                    onChangeScenario({ ...scenario, cloudCorrelation: Number(e.target.value) })
                  }
                  className="w-full bg-[#07090E] border border-slate-700 rounded px-2.5 py-1.5 text-sm font-mono tabular-nums text-slate-100"
                />
              </div>
              <div>
                <label htmlFor="res-outage-mult" className="block text-xs text-slate-400 mb-1">
                  Station Outage Multiplier
                </label>
                <input
                  id="res-outage-mult"
                  type="number"
                  min={0}
                  max={4}
                  step={0.25}
                  value={scenario.outageRateMultiplier}
                  onChange={(e) =>
                    onChangeScenario({ ...scenario, outageRateMultiplier: Number(e.target.value) })
                  }
                  className="w-full bg-[#07090E] border border-slate-700 rounded px-2.5 py-1.5 text-sm font-mono tabular-nums text-slate-100"
                />
              </div>
            </div>

            <div className="pt-3 border-t border-slate-800/70">
              <div className="flex items-end gap-3">
                <div className="flex-1">
                  <label htmlFor="target-count" className="block text-xs text-slate-400 mb-1">
                    Synthetic Target Deck Size
                  </label>
                  <input
                    id="target-count"
                    type="number"
                    min={8}
                    max={72}
                    value={targetCount}
                    onChange={(e) => setTargetCount(Number(e.target.value))}
                    className="w-full bg-[#07090E] border border-slate-700 rounded px-2.5 py-1.5 text-sm font-mono tabular-nums text-slate-100"
                  />
                </div>
                <button
                  type="button"
                  onClick={handleRegenerateTargets}
                  className="px-3.5 py-2 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded transition-colors whitespace-nowrap"
                >
                  Regenerate Targets
                </button>
              </div>
            </div>
          </section>
        </div>

        {/* Ground Stations & Targets Tables */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <section className="bg-[#0E131D] border border-slate-800 rounded-md overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-100">
                Ground Station Network ({scenario.groundStations.length})
              </h2>
              <span className="text-xs font-mono text-slate-400">Min Elev / Rate / Outage</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-[#090D14] text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="py-2 px-3 font-medium">Station</th>
                    <th className="py-2 px-3 font-medium">Lat / Lon (°)</th>
                    <th className="py-2 px-3 font-medium text-right">Min El</th>
                    <th className="py-2 px-3 font-medium text-right">Rate</th>
                    <th className="py-2 px-3 font-medium text-right">P(Outage)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70 font-mono tabular-nums">
                  {scenario.groundStations.map((gs) => (
                    <tr key={gs.id} className="hover:bg-slate-900/50">
                      <td className="py-2 px-3 font-sans text-slate-200">{gs.name}</td>
                      <td className="py-2 px-3 text-slate-300">
                        {gs.latDeg.toFixed(2)}, {gs.lonDeg.toFixed(2)}
                      </td>
                      <td className="py-2 px-3 text-right text-slate-300">{gs.minElevationDeg}°</td>
                      <td className="py-2 px-3 text-right text-cyan-300">
                        {gs.downlinkRateGbps.toFixed(2)} Gbps
                      </td>
                      <td className="py-2 px-3 text-right text-amber-300">
                        {(gs.outageProb * 100).toFixed(0)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="bg-[#0E131D] border border-slate-800 rounded-md overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-100">
                Observation Targets ({scenario.targets.length})
              </h2>
              <span className="text-xs font-mono text-slate-400">Priority / Data / Base Cloud</span>
            </div>
            <div className="overflow-y-auto max-h-64">
              <table className="w-full text-xs text-left">
                <thead className="bg-[#090D14] text-slate-400 border-b border-slate-800 sticky top-0">
                  <tr>
                    <th className="py-2 px-3 font-medium">Target</th>
                    <th className="py-2 px-3 font-medium">Region</th>
                    <th className="py-2 px-3 font-medium text-right">Pri</th>
                    <th className="py-2 px-3 font-medium text-right">Vol</th>
                    <th className="py-2 px-3 font-medium text-right">Cloud</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70 font-mono tabular-nums">
                  {scenario.targets.map((t) => (
                    <tr key={t.id} className="hover:bg-slate-900/50">
                      <td className="py-2 px-3 font-sans text-slate-200">{t.name}</td>
                      <td className="py-2 px-3 font-sans text-slate-400">{t.region}</td>
                      <td className="py-2 px-3 text-right text-slate-100">{t.priority}</td>
                      <td className="py-2 px-3 text-right text-cyan-300">{t.dataVolumeGb} Gb</td>
                      <td className="py-2 px-3 text-right text-slate-300">
                        {(t.baseCloudProb * 100).toFixed(0)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
