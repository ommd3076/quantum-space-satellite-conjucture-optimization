import { useMemo, useState } from 'react';
import { Play, ShieldCheck, AlertTriangle } from 'lucide-react';
import { solveScenarioApi } from '../api/client';
import type {
  AlgorithmId,
  PropagationBundle,
  ProposedAblationFlags,
  ScenarioConfig,
  SolverRunResult,
} from '../../backend/src/types';

interface AlgorithmLabViewProps {
  scenario: ScenarioConfig;
  bundle: PropagationBundle | null;
  solverResults: SolverRunResult[];
  onResultsUpdated: (results: SolverRunResult[]) => void;
}

const ALGORITHM_OPTIONS: Array<{ id: AlgorithmId | 'all'; label: string }> = [
  { id: 'all', label: 'Run All 5 Algorithms (Paired Comparison)' },
  { id: 'greedy', label: 'Baseline 1: Deterministic Greedy' },
  { id: 'deadline_heuristic', label: 'Baseline 2: Deadline-Urgency Heuristic' },
  { id: 'exact_bnb', label: 'Baseline 3: Exact / Bounded Branch-and-Bound' },
  { id: 'rolling_horizon', label: 'Baseline 4: Standard Rolling-Horizon' },
  { id: 'proposed', label: 'Candidate: SRA-RHR (Submodular Risk-Aware Repair)' },
];

export function AlgorithmLabView({
  scenario,
  bundle,
  solverResults,
  onResultsUpdated,
}: AlgorithmLabViewProps) {
  const [selectedAlg, setSelectedAlg] = useState<AlgorithmId | 'all'>('all');
  const [computeBudgetMs, setComputeBudgetMs] = useState(1200);
  const [ablationFlags, setAblationFlags] = useState<ProposedAblationFlags>({
    useRiskAware: true,
    useShadowPricing: true,
    useIncrementalRepair: true,
  });
  const [running, setRunning] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [inspectedIdx, setInspectedIdx] = useState(0);
  const [inspectedSatId, setInspectedSatId] = useState<string>('');

  const inspectedResult = solverResults[Math.min(inspectedIdx, Math.max(0, solverResults.length - 1))] ?? null;

  const activeSatIds = useMemo(() => {
    if (!bundle) return [];
    return bundle.satellites.map((s) => s.satId);
  }, [bundle]);

  const effectiveSatId =
    inspectedSatId && activeSatIds.includes(inspectedSatId)
      ? inspectedSatId
      : activeSatIds[0] ?? '';

  const handleRunSolver = async () => {
    setRunning(true);
    setErrorMsg(null);
    try {
      const resp = await solveScenarioApi({
        scenario,
        algorithmId: selectedAlg,
        computeBudgetMs,
        ablationFlags,
      });
      if (selectedAlg === 'all') {
        onResultsUpdated(resp.results);
        setInspectedIdx(resp.results.length - 1);
      } else {
        const merged = [
          ...solverResults.filter((r) => r.algorithmId !== selectedAlg),
          ...resp.results,
        ];
        onResultsUpdated(merged);
        setInspectedIdx(merged.length - 1);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const horizonSec = bundle?.scenario.horizonSec ?? scenario.horizonSec;

  // Resource trace for selected satellite in inspected result
  const satTrace = inspectedResult?.verification.resourceTraces[effectiveSatId] ?? [];
  const resCfg = scenario.resources;

  return (
    <div className="flex-1 overflow-y-auto bg-[#07090E] p-6">
      <div className="max-w-[1280px] mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-slate-800 pb-4">
          <div>
            <p className="text-xs font-mono text-slate-400">
              Frozen Scenario Hash: {bundle?.scenarioHash.slice(0, 16) ?? 'Not propagated'} ·
              Equal Objective & Constraints · Independent Verifier Enforced
            </p>
            <h1 className="text-2xl font-semibold text-slate-100 mt-1">
              Algorithm Lab & Independent Schedule Verifier
            </h1>
          </div>
          <button
            type="button"
            onClick={handleRunSolver}
            disabled={running}
            className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded-md disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
          >
            <Play className="w-3.5 h-3.5" />
            {running ? 'Solving & Verifying...' : 'Run Optimization'}
          </button>
        </div>

        {/* Controls Bar */}
        <section className="bg-[#0E131D] border border-slate-800 rounded-md p-4 grid grid-cols-1 lg:grid-cols-3 gap-4 items-end">
          <div>
            <label htmlFor="alg-select" className="block text-xs text-slate-400 mb-1">
              Solver Selection
            </label>
            <select
              id="alg-select"
              value={selectedAlg}
              onChange={(e) => setSelectedAlg(e.target.value as AlgorithmId | 'all')}
              className="w-full bg-[#07090E] border border-slate-700 rounded px-2.5 py-2 text-xs font-mono text-slate-100"
            >
              {ALGORITHM_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="budget-ms" className="block text-xs text-slate-400 mb-1">
              Equal Wall-Clock Budget (ms per solver)
            </label>
            <input
              id="budget-ms"
              type="number"
              min={200}
              max={6000}
              step={200}
              value={computeBudgetMs}
              onChange={(e) => setComputeBudgetMs(Number(e.target.value))}
              className="w-full bg-[#07090E] border border-slate-700 rounded px-2.5 py-2 text-xs font-mono tabular-nums text-slate-100"
            />
          </div>

          <div>
            <div className="text-xs text-slate-400 mb-1.5">
              Candidate SRA-RHR Mechanism Toggles (Ablation)
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs text-slate-200">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={ablationFlags.useRiskAware}
                  onChange={(e) =>
                    setAblationFlags((f) => ({ ...f, useRiskAware: e.target.checked }))
                  }
                  className="accent-cyan-400"
                />
                <span>Risk-Aware</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={ablationFlags.useShadowPricing}
                  onChange={(e) =>
                    setAblationFlags((f) => ({ ...f, useShadowPricing: e.target.checked }))
                  }
                  className="accent-cyan-400"
                />
                <span>Shadow Price</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={ablationFlags.useIncrementalRepair}
                  onChange={(e) =>
                    setAblationFlags((f) => ({ ...f, useIncrementalRepair: e.target.checked }))
                  }
                  className="accent-cyan-400"
                />
                <span>Repair</span>
              </label>
            </div>
          </div>
        </section>

        {errorMsg && (
          <div role="alert" className="p-3 bg-rose-950/40 border border-rose-800 rounded text-xs text-rose-200">
            Solver Error: {errorMsg}
          </div>
        )}

        {/* Comparison Table */}
        {solverResults.length === 0 ? (
          <div className="bg-[#0E131D] border border-slate-800 rounded-md p-10 text-center space-y-2">
            <p className="text-sm font-medium text-slate-200">
              No Solver Runs Recorded for Current Session
            </p>
            <p className="text-xs text-slate-400 max-w-lg mx-auto">
              Constellation Lab never displays fabricated placeholder numbers. Click{' '}
              <span className="text-cyan-300 font-medium">Run Optimization</span> above to execute
              all classical baselines and the candidate SRA-RHR method on the frozen scenario.
            </p>
          </div>
        ) : (
          <>
            <section className="bg-[#0E131D] border border-slate-800 rounded-md overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-100">
                  Verified Solver Comparison (Click Row to Inspect Gantt & Resources)
                </h2>
                <span className="text-xs font-mono text-slate-400">
                  Provenance: MEASURED_EXPERIMENT
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead className="bg-[#090D14] text-slate-400 border-b border-slate-800">
                    <tr>
                      <th className="py-2.5 px-3 font-medium">Algorithm</th>
                      <th className="py-2.5 px-3 font-medium">Solver Status</th>
                      <th className="py-2.5 px-3 font-medium">Independent Verifier</th>
                      <th className="py-2.5 px-3 font-medium text-right">Det. Obj</th>
                      <th className="py-2.5 px-3 font-medium text-right">Realized Obj</th>
                      <th className="py-2.5 px-3 font-medium text-right">Dual Bound / Gap</th>
                      <th className="py-2.5 px-3 font-medium text-right">Delivered</th>
                      <th className="py-2.5 px-3 font-medium text-right">Runtime</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70 font-mono tabular-nums">
                    {solverResults.map((r, idx) => {
                      const isSelected = idx === inspectedIdx;
                      return (
                        <tr
                          key={`${r.algorithmId}-${idx}`}
                          onClick={() => setInspectedIdx(idx)}
                          className={`cursor-pointer transition-colors ${
                            isSelected ? 'bg-cyan-500/10' : 'hover:bg-slate-900/60'
                          }`}
                        >
                          <td className="py-2.5 px-3 font-sans font-medium text-slate-100">
                            {r.algorithmLabel}
                          </td>
                          <td className="py-2.5 px-3 text-slate-300">{r.status}</td>
                          <td className="py-2.5 px-3">
                            {r.verification.verifiedFeasible ? (
                              <span className="inline-flex items-center gap-1 text-emerald-400">
                                <ShieldCheck className="w-3.5 h-3.5" />
                                Verified (0 viol)
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-rose-400">
                                <AlertTriangle className="w-3.5 h-3.5" />
                                Failed ({r.verification.violationCount} viol)
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-right text-slate-200">
                            {r.verification.verifiedDeterministicObjective.toFixed(1)}
                          </td>
                          <td className="py-2.5 px-3 text-right font-semibold text-cyan-300">
                            {r.verification.verifiedRealizedObjective.toFixed(1)}
                          </td>
                          <td className="py-2.5 px-3 text-right text-slate-300">
                            {r.dualUpperBound !== null
                              ? `${r.dualUpperBound.toFixed(1)} (${r.optimalityGapPct?.toFixed(1)}%)`
                              : '—'}
                          </td>
                          <td className="py-2.5 px-3 text-right text-slate-300">
                            {r.verification.realizedTargetsDelivered}/{scenario.targets.length}
                          </td>
                          <td className="py-2.5 px-3 text-right text-slate-300">
                            {r.runtimeMs.toFixed(1)} ms
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Inspected Schedule Gantt & Resource Traces */}
            {inspectedResult && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Multi-Satellite Gantt Schedule */}
                <section className="lg:col-span-2 bg-[#0E131D] border border-slate-800 rounded-md p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2.5">
                    <div>
                      <h2 className="text-sm font-semibold text-slate-100">
                        Schedule Gantt Timeline — {inspectedResult.algorithmLabel}
                      </h2>
                      <p className="text-xs text-slate-400">
                        Cyan: clear observation · Rose dashed: cloud-blocked realization · Amber: ground downlink
                      </p>
                    </div>
                    <span className="text-xs font-mono text-slate-400 tabular-nums">
                      {inspectedResult.actions.length} actions · Latency{' '}
                      {(inspectedResult.verification.meanDataLatencySec / 60).toFixed(1)} min
                    </span>
                  </div>

                  <div className="space-y-1.5 max-h-[340px] overflow-y-auto pr-1">
                    {activeSatIds.map((satId) => {
                      const satActs = inspectedResult.actions.filter((a) => a.satId === satId);
                      const isSelSat = satId === effectiveSatId;
                      return (
                        <button
                          key={satId}
                          type="button"
                          onClick={() => setInspectedSatId(satId)}
                          className={`w-full grid grid-cols-[92px_1fr] items-center gap-2 py-1 px-1.5 rounded text-left transition-colors ${
                            isSelSat ? 'bg-slate-800/80' : 'hover:bg-slate-900/60'
                          }`}
                        >
                          <span className="font-mono text-[11px] text-slate-300 truncate">
                            {satId}
                          </span>
                          <div className="relative h-4 bg-[#07090E] border border-slate-800/80 rounded overflow-hidden">
                            {satActs.map((act) => {
                              const leftPct = (act.startSec / Math.max(1, horizonSec)) * 100;
                              const widthPct = Math.max(
                                0.9,
                                ((act.endSec - act.startSec) / Math.max(1, horizonSec)) * 100,
                              );
                              const colorClass =
                                act.type === 'downlink'
                                  ? act.realizedFailed
                                    ? 'bg-rose-500/50 border border-rose-400'
                                    : 'bg-amber-400/90'
                                  : act.realizedFailed
                                    ? 'bg-rose-500/80'
                                    : 'bg-cyan-400/90';
                              return (
                                <div
                                  key={act.actionId}
                                  title={`${act.type.toUpperCase()} ${act.entityName} [${(act.startSec / 60).toFixed(1)}m–${(act.endSec / 60).toFixed(1)}m] ΔData=${act.dataDeltaGb}Gb${act.realizedFailed ? ' (REALIZED FAILED)' : ''}`}
                                  className={`absolute top-0.5 bottom-0.5 rounded-[2px] ${colorClass}`}
                                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                                />
                              );
                            })}
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {/* Solver Notes & Diagnostics */}
                  <div className="pt-2 border-t border-slate-800 text-xs text-slate-400 space-y-1">
                    {inspectedResult.notes.map((n, i) => (
                      <p key={i}>• {n}</p>
                    ))}
                  </div>
                </section>

                {/* Per-Satellite Battery & Storage Verification Trace */}
                <section className="bg-[#0E131D] border border-slate-800 rounded-md p-4 space-y-3">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
                    <div>
                      <h2 className="text-sm font-semibold text-slate-100">
                        Resource Trace ({effectiveSatId})
                      </h2>
                      <p className="text-xs text-slate-400">
                        Cyan: Battery (Wh) · Amber: Storage (Gb)
                      </p>
                    </div>
                  </div>

                  <svg viewBox="0 0 320 180" className="w-full h-auto" role="img" aria-label="Battery and Storage Trace">
                    {/* Battery reserve floor dashed line */}
                    {(() => {
                      const floorY =
                        152 - (resCfg.batteryMinWh / Math.max(1, resCfg.batteryCapacityWh)) * 136;
                      return (
                        <g>
                          <line
                            x1={32}
                            y1={floorY}
                            x2={308}
                            y2={floorY}
                            stroke="#f43f5e"
                            strokeWidth="1"
                            strokeDasharray="3 3"
                          />
                          <text x={36} y={floorY - 3} className="fill-rose-400 text-[9px] font-mono">
                            E_min ({resCfg.batteryMinWh} Wh)
                          </text>
                        </g>
                      );
                    })()}
                    <line x1={32} y1={16} x2={32} y2={152} stroke="#334155" strokeWidth="1" />
                    <line x1={32} y1={152} x2={308} y2={152} stroke="#334155" strokeWidth="1" />

                    {satTrace.length > 1 && (
                      <>
                        <polyline
                          fill="none"
                          stroke="#06b6d4"
                          strokeWidth="2"
                          points={satTrace
                            .map((pt) => {
                              const x = 32 + (pt.tSec / Math.max(1, horizonSec)) * 276;
                              const y =
                                152 -
                                (pt.batteryWh / Math.max(1, resCfg.batteryCapacityWh)) * 136;
                              return `${x.toFixed(1)},${y.toFixed(1)}`;
                            })
                            .join(' ')}
                        />
                        <polyline
                          fill="none"
                          stroke="#f59e0b"
                          strokeWidth="2"
                          points={satTrace
                            .map((pt) => {
                              const x = 32 + (pt.tSec / Math.max(1, horizonSec)) * 276;
                              const y =
                                152 -
                                (pt.storageGb / Math.max(1, resCfg.storageCapacityGb)) * 136;
                              return `${x.toFixed(1)},${y.toFixed(1)}`;
                            })
                            .join(' ')}
                        />
                      </>
                    )}
                    <text x={32} y={168} className="fill-slate-400 text-[9px] font-mono">0h</text>
                    <text x={308} y={168} textAnchor="end" className="fill-slate-400 text-[9px] font-mono">
                      {(horizonSec / 3600).toFixed(1)}h
                    </text>
                  </svg>

                  <dl className="space-y-1.5 text-xs font-mono tabular-nums pt-2 border-t border-slate-800">
                    <div className="flex justify-between">
                      <dt className="text-slate-400 font-sans">Peak Storage Used</dt>
                      <dd className="text-amber-300">
                        {inspectedResult.verification.peakStorageUtilizationPct.toFixed(1)}%
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-slate-400 font-sans">Min Battery Margin</dt>
                      <dd className="text-emerald-300">
                        {inspectedResult.verification.minBatteryMarginPct.toFixed(1)}%
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-slate-400 font-sans">Captured / Downlinked</dt>
                      <dd className="text-slate-200">
                        {inspectedResult.verification.totalDataCapturedGb.toFixed(1)} /{' '}
                        {inspectedResult.verification.totalDataDownlinkedGb.toFixed(1)} Gb
                      </dd>
                    </div>
                  </dl>
                </section>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
