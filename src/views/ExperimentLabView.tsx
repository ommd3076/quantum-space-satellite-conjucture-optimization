import { useState } from 'react';
import { Download, FlaskConical } from 'lucide-react';
import { runExperimentBatchApi } from '../api/client';
import type { ExperimentBatchResult, ScenarioConfig } from '../../backend/src/types';

interface ExperimentLabViewProps {
  scenario: ScenarioConfig;
  batchResult: ExperimentBatchResult | null;
  onBatchCompleted: (batch: ExperimentBatchResult) => void;
}

export function ExperimentLabView({
  scenario,
  batchResult,
  onBatchCompleted,
}: ExperimentLabViewProps) {
  const [seedsInput, setSeedsInput] = useState('101, 202, 303, 404, 505');
  const [computeBudgetMs, setComputeBudgetMs] = useState(500);
  const [includeAblations, setIncludeAblations] = useState(true);
  const [includeExactSolver, setIncludeExactSolver] = useState(false);
  const [running, setRunning] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleRunBatch = async () => {
    const parsedSeeds = seedsInput
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
    if (parsedSeeds.length < 2) {
      setErrorMsg('Provide at least 2 comma-separated integer seeds for statistical intervals.');
      return;
    }
    setRunning(true);
    setErrorMsg(null);
    try {
      const res = await runExperimentBatchApi({
        scenario,
        seeds: parsedSeeds,
        computeBudgetMs,
        includeAblations,
        includeExactSolver,
      });
      onBatchCompleted(res);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const handleExportBundle = () => {
    if (!batchResult) return;
    const blob = new Blob([JSON.stringify(batchResult, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `constellation-lab-${batchResult.batchId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const maxChartVal = batchResult
    ? Math.max(
        10,
        ...batchResult.summaryByAlgorithm.map((s) => s.meanRealizedObj + s.ci95RealizedObj),
      ) * 1.12
    : 100;

  return (
    <div className="flex-1 overflow-y-auto bg-[#07090E] p-6">
      <div className="max-w-[1280px] mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-slate-800 pb-4">
          <div>
            <p className="text-xs font-mono text-slate-400">
              Paired Multi-Seed Evaluation · 95% Student-t Confidence Intervals · Mandatory Component Ablation
            </p>
            <h1 className="text-2xl font-semibold text-slate-100 mt-1">
              Experiment & Ablation Lab
            </h1>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {batchResult && (
              <button
                type="button"
                onClick={handleExportBundle}
                className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-200 bg-[#0E131D] hover:bg-slate-800 border border-slate-700 rounded-md transition-colors whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                Export Reproducibility JSON
              </button>
            )}
            <button
              type="button"
              onClick={handleRunBatch}
              disabled={running}
              className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded-md disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              <FlaskConical className="w-3.5 h-3.5" />
              {running ? 'Running Paired Batch...' : 'Run Paired Experiment'}
            </button>
          </div>
        </div>

        {/* Batch Configuration */}
        <section className="bg-[#0E131D] border border-slate-800 rounded-md p-4 grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
          <div className="md:col-span-2">
            <label htmlFor="exp-seeds" className="block text-xs text-slate-400 mb-1">
              Independent Deterministic Seeds (comma-separated, 2–12)
            </label>
            <input
              id="exp-seeds"
              type="text"
              value={seedsInput}
              onChange={(e) => setSeedsInput(e.target.value)}
              className="w-full bg-[#07090E] border border-slate-700 rounded px-2.5 py-2 text-xs font-mono text-slate-100"
            />
          </div>

          <div>
            <label htmlFor="exp-budget" className="block text-xs text-slate-400 mb-1">
              Equal Budget / Run (ms)
            </label>
            <input
              id="exp-budget"
              type="number"
              min={150}
              max={3000}
              step={100}
              value={computeBudgetMs}
              onChange={(e) => setComputeBudgetMs(Number(e.target.value))}
              className="w-full bg-[#07090E] border border-slate-700 rounded px-2.5 py-2 text-xs font-mono tabular-nums text-slate-100"
            />
          </div>

          <div className="space-y-2 text-xs text-slate-200">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={includeAblations}
                onChange={(e) => setIncludeAblations(e.target.checked)}
                className="accent-cyan-400"
              />
              <span>Include 3 SRA-RHR Ablations</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={includeExactSolver}
                onChange={(e) => setIncludeExactSolver(e.target.checked)}
                className="accent-cyan-400"
              />
              <span>Include Exact B&amp;B Solver</span>
            </label>
          </div>
        </section>

        {errorMsg && (
          <div role="alert" className="p-3 bg-rose-950/40 border border-rose-800 rounded text-xs text-rose-200">
            {errorMsg}
          </div>
        )}

        {!batchResult ? (
          <div className="bg-[#0E131D] border border-slate-800 rounded-md p-10 text-center space-y-2">
            <p className="text-sm font-medium text-slate-200">
              No Persisted Experiment Batch Run Yet
            </p>
            <p className="text-xs text-slate-400 max-w-xl mx-auto">
              Plots, confidence intervals, and hypothesis verdicts are generated strictly from
              executed persisted runs. Click{' '}
              <span className="text-cyan-300 font-medium">Run Paired Experiment</span> to evaluate
              all baselines and SRA-RHR ablations across independent seeds on{' '}
              <span className="font-mono text-slate-300">{scenario.name}</span>.
            </p>
          </div>
        ) : (
          <>
            {/* Falsifiable Hypothesis Verdict Banner */}
            <section className="bg-[#0E131D] border border-slate-800 rounded-md p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-mono text-slate-400">
                  Batch {batchResult.batchId} · Seeds: [{batchResult.seeds.join(', ')}] · Node{' '}
                  {batchResult.environment.nodeVersion} · Base Hash{' '}
                  {batchResult.baseScenarioHash.slice(0, 12)}
                </div>
                <span
                  className={`text-xs font-mono font-semibold ${
                    batchResult.hypothesisCheck.verdict === 'SUPPORTED_ON_BATCH'
                      ? 'text-emerald-400'
                      : batchResult.hypothesisCheck.verdict === 'INVALID_VIOLATION'
                        ? 'text-rose-400'
                        : 'text-amber-300'
                  }`}
                >
                  VERDICT: {batchResult.hypothesisCheck.verdict}
                </span>
              </div>
              <p className="text-sm text-slate-200 mt-2">{batchResult.hypothesisCheck.explanation}</p>
            </section>

            {/* Mean ± 95% CI Error-Bar Plot (generated purely from persisted raw runs) */}
            <section className="bg-[#0E131D] border border-slate-800 rounded-md p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h2 className="text-sm font-semibold text-slate-100">
                    Realized Post-Cloud Delivered Priority Utility (Mean ± 95% Student-t CI)
                  </h2>
                  <p className="text-xs text-slate-400">
                    Horizontal whiskers show 95% confidence interval across n={batchResult.seeds.length} paired seeds.
                  </p>
                </div>
                <span className="text-xs font-mono text-slate-400">MEASURED_EXPERIMENT</span>
              </div>

              <div className="space-y-2.5">
                {batchResult.summaryByAlgorithm.map((row) => {
                  const meanPct = Math.min(100, (row.meanRealizedObj / maxChartVal) * 100);
                  const lowPct = Math.max(0, ((row.meanRealizedObj - row.ci95RealizedObj) / maxChartVal) * 100);
                  const highPct = Math.min(100, ((row.meanRealizedObj + row.ci95RealizedObj) / maxChartVal) * 100);
                  const isProposed = row.algorithmKey === 'proposed_full';
                  const isAblation = row.algorithmKey.startsWith('ablation_');
                  return (
                    <div
                      key={row.algorithmKey}
                      className="grid grid-cols-[220px_1fr_135px] items-center gap-3 text-xs"
                    >
                      <span
                        className={`truncate ${
                          isProposed
                            ? 'text-cyan-300 font-semibold'
                            : isAblation
                              ? 'text-slate-300'
                              : 'text-slate-200'
                        }`}
                      >
                        {row.label}
                      </span>
                      <div className="relative h-5 bg-[#07090E] border border-slate-800/80 rounded">
                        <div
                          className={`absolute top-1 bottom-1 left-0 rounded-r ${
                            isProposed
                              ? 'bg-cyan-500/75'
                              : isAblation
                                ? 'bg-indigo-400/55'
                                : 'bg-slate-500/65'
                          }`}
                          style={{ width: `${meanPct}%` }}
                        />
                        {/* 95% CI whisker */}
                        <div
                          className="absolute top-1/2 -translate-y-1/2 h-0.5 bg-slate-100"
                          style={{ left: `${lowPct}%`, width: `${Math.max(0.4, highPct - lowPct)}%` }}
                        />
                        <div
                          className="absolute top-1 bottom-1 w-0.5 bg-slate-100"
                          style={{ left: `${lowPct}%` }}
                        />
                        <div
                          className="absolute top-1 bottom-1 w-0.5 bg-slate-100"
                          style={{ left: `${highPct}%` }}
                        />
                      </div>
                      <span className="font-mono text-[11px] text-right text-slate-200 tabular-nums">
                        {row.meanRealizedObj.toFixed(1)} ± {row.ci95RealizedObj.toFixed(1)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Paired Summary Statistics & Ablation Table */}
            <section className="bg-[#0E131D] border border-slate-800 rounded-md overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-100">
                  Paired Statistical Summary & Failure Accounting
                </h2>
                <span className="text-xs font-mono text-slate-400">
                  Reference Comparator: Standard Rolling-Horizon
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead className="bg-[#090D14] text-slate-400 border-b border-slate-800">
                    <tr>
                      <th className="py-2.5 px-3 font-medium">Algorithm / Ablation</th>
                      <th className="py-2.5 px-3 font-medium text-right">Realized Mean ± 95% CI</th>
                      <th className="py-2.5 px-3 font-medium text-right">Tail [Min, Max]</th>
                      <th className="py-2.5 px-3 font-medium text-right">Paired Δ vs RH</th>
                      <th className="py-2.5 px-3 font-medium text-right">Cohen&apos;s d</th>
                      <th className="py-2.5 px-3 font-medium text-right">Det. Mean</th>
                      <th className="py-2.5 px-3 font-medium text-right">Viol / TO</th>
                      <th className="py-2.5 px-3 font-medium text-right">Runtime</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70 font-mono tabular-nums">
                    {batchResult.summaryByAlgorithm.map((s) => (
                      <tr key={s.algorithmKey} className="hover:bg-slate-900/50">
                        <td className="py-2 px-3 font-sans text-slate-100">{s.label}</td>
                        <td className="py-2 px-3 text-right text-cyan-300">
                          {s.meanRealizedObj.toFixed(1)} ± {s.ci95RealizedObj.toFixed(1)}
                        </td>
                        <td className="py-2 px-3 text-right text-slate-400">
                          [{s.minRealizedObj.toFixed(0)}, {s.maxRealizedObj.toFixed(0)}]
                        </td>
                        <td
                          className={`py-2 px-3 text-right ${
                            s.pairedDeltaVsRH === null
                              ? 'text-slate-500'
                              : s.pairedDeltaVsRH > 0
                                ? 'text-emerald-400'
                                : s.pairedDeltaVsRH < 0
                                  ? 'text-rose-400'
                                  : 'text-slate-300'
                          }`}
                        >
                          {s.pairedDeltaVsRH !== null
                            ? `${s.pairedDeltaVsRH >= 0 ? '+' : ''}${s.pairedDeltaVsRH.toFixed(1)} ± ${s.pairedCi95VsRH?.toFixed(1)}`
                            : 'ref'}
                        </td>
                        <td className="py-2 px-3 text-right text-slate-300">
                          {s.cohensDVsRH !== null ? s.cohensDVsRH.toFixed(2) : '—'}
                        </td>
                        <td className="py-2 px-3 text-right text-slate-300">
                          {s.meanDeterministicObj.toFixed(1)}
                        </td>
                        <td className="py-2 px-3 text-right">
                          <span className={s.violationRuns > 0 ? 'text-rose-400' : 'text-emerald-400'}>
                            {s.violationRuns}
                          </span>
                          <span className="text-slate-500"> / </span>
                          <span className={s.timeoutRuns > 0 ? 'text-amber-300' : 'text-slate-400'}>
                            {s.timeoutRuns}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-right text-slate-300">
                          {s.meanRuntimeMs.toFixed(1)} ms
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Raw Per-Seed Ledger */}
            <section className="bg-[#0E131D] border border-slate-800 rounded-md overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-100">
                  Raw Persisted Run Artifacts ({batchResult.rawRuns.length} executions)
                </h2>
                <span className="text-xs font-mono text-slate-400">
                  Saved to experiments/outputs/{batchResult.batchId}.json
                </span>
              </div>
              <div className="overflow-y-auto max-h-64">
                <table className="w-full text-xs text-left">
                  <thead className="bg-[#090D14] text-slate-400 border-b border-slate-800 sticky top-0">
                    <tr>
                      <th className="py-2 px-3 font-medium">Seed</th>
                      <th className="py-2 px-3 font-medium">Algorithm</th>
                      <th className="py-2 px-3 font-medium">Status</th>
                      <th className="py-2 px-3 font-medium text-right">Det. Obj</th>
                      <th className="py-2 px-3 font-medium text-right">Realized Obj</th>
                      <th className="py-2 px-3 font-medium text-right">Violations</th>
                      <th className="py-2 px-3 font-medium text-right">Repairs</th>
                      <th className="py-2 px-3 font-medium text-right">Runtime</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70 font-mono tabular-nums">
                    {batchResult.rawRuns.map((r, i) => (
                      <tr key={i} className="hover:bg-slate-900/50">
                        <td className="py-1.5 px-3 text-slate-400">{r.seed}</td>
                        <td className="py-1.5 px-3 font-sans text-slate-200">{r.label}</td>
                        <td className="py-1.5 px-3 text-slate-300">{r.status}</td>
                        <td className="py-1.5 px-3 text-right text-slate-300">{r.deterministicObj.toFixed(1)}</td>
                        <td className="py-1.5 px-3 text-right text-cyan-300">{r.realizedObj.toFixed(1)}</td>
                        <td className={`py-1.5 px-3 text-right ${r.violationCount > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                          {r.violationCount}
                        </td>
                        <td className="py-1.5 px-3 text-right text-slate-400">{r.repairEventsTriggered}</td>
                        <td className="py-1.5 px-3 text-right text-slate-300">{r.runtimeMs.toFixed(1)} ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
