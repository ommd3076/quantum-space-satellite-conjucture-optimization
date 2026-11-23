import type { PropagationBundle } from '../../backend/src/types';

interface CoverageAnalyticsViewProps {
  bundle: PropagationBundle | null;
}

export function CoverageAnalyticsView({ bundle }: CoverageAnalyticsViewProps) {
  if (!bundle) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[#07090E] text-slate-400 text-sm">
        No propagation data loaded. Run propagation to compute coverage and revisit analytics.
      </div>
    );
  }

  const a = bundle.analytics;
  const horizonHrs = bundle.scenario.horizonSec / 3600;
  const series = a.coverageOverTime;
  const maxActiveLinks = Math.max(1, ...series.map((p) => Math.max(p.activeAccessLinks, p.activeDownlinks)));

  // SVG dimensions for Coverage-Over-Time chart
  const cw = 640;
  const ch = 220;
  const padL = 48;
  const padR = 20;
  const padT = 16;
  const padB = 30;
  const plotW = cw - padL - padR;
  const plotH = ch - padT - padB;

  const covPolyline = series
    .map((pt, i) => {
      const x = padL + (i / Math.max(1, series.length - 1)) * plotW;
      const y = padT + plotH - (pt.cumulativeCoveragePct / 100) * plotH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const linksPolyline = series
    .map((pt, i) => {
      const x = padL + (i / Math.max(1, series.length - 1)) * plotW;
      const y = padT + plotH - (pt.activeAccessLinks / maxActiveLinks) * plotH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const worstTargets = a.perTargetStats
    .slice()
    .sort((x, y) => y.maxGapSec - x.maxGapSec)
    .slice(0, 10);
  const maxTargetGap = Math.max(600, ...worstTargets.map((t) => t.maxGapSec));

  return (
    <div className="flex-1 overflow-y-auto bg-[#07090E] p-6">
      <div className="max-w-[1280px] mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-3 border-b border-slate-800 pb-4">
          <div>
            <p className="text-xs font-mono text-slate-400">
              Propagator: {bundle.scenario.constellation.propagator === 'j2_rk4' ? 'Two-Body + J2 (RK4)' : 'Two-Body Keplerian'} ·
              Horizon: {horizonHrs.toFixed(1)} h · Sample Δt: {bundle.scenario.sampleStepSec} s ·
              Compute: {bundle.computeRuntimeMs} ms
            </p>
            <h1 className="text-2xl font-semibold text-slate-100 mt-1">
              Orbit & Coverage Analytics
            </h1>
          </div>
          <div className="text-xs font-mono text-slate-400 tabular-nums">
            Scenario Hash: {bundle.scenarioHash.slice(0, 16)}
          </div>
        </div>

        {/* Key Computed Physical & Coverage Metrics */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <div className="bg-[#0E131D] border border-slate-800 rounded-md p-3.5">
            <div className="text-[11px] text-slate-400">Target Coverage</div>
            <div className="text-2xl font-mono font-semibold text-cyan-300 tabular-nums mt-1">
              {(a.globalTargetCoverageFraction * 100).toFixed(1)}
              <span className="text-xs text-slate-400 ml-1">%</span>
            </div>
            <div className="text-[11px] font-mono text-slate-400 mt-1">
              {a.targetsWithAccessCount}/{a.totalTargetsCount} targets
            </div>
          </div>

          <div className="bg-[#0E131D] border border-slate-800 rounded-md p-3.5">
            <div className="text-[11px] text-slate-400">Mean Revisit Gap</div>
            <div className="text-2xl font-mono font-semibold text-slate-100 tabular-nums mt-1">
              {(a.meanRevisitGapSec / 60).toFixed(1)}
              <span className="text-xs text-slate-400 ml-1">min</span>
            </div>
            <div className="text-[11px] font-mono text-slate-400 mt-1">
              Max: {(a.maxRevisitGapSec / 60).toFixed(0)} min
            </div>
          </div>

          <div className="bg-[#0E131D] border border-slate-800 rounded-md p-3.5">
            <div className="text-[11px] text-slate-400">Regional Fairness (Jain)</div>
            <div className="text-2xl font-mono font-semibold text-slate-100 tabular-nums mt-1">
              {a.jainsFairnessIndex.toFixed(3)}
            </div>
            <div className="text-[11px] font-mono text-slate-400 mt-1">
              1.000 = equal access
            </div>
          </div>

          <div className="bg-[#0E131D] border border-slate-800 rounded-md p-3.5">
            <div className="text-[11px] text-slate-400">Obs / Downlink Windows</div>
            <div className="text-2xl font-mono font-semibold text-slate-100 tabular-nums mt-1">
              {a.totalObservationWindows}
              <span className="text-xs text-amber-300 ml-1.5">/ {a.totalDownlinkContacts}</span>
            </div>
            <div className="text-[11px] font-mono text-slate-400 mt-1">
              FOV ±{bundle.scenario.constellation.fovHalfAngleDeg}°
            </div>
          </div>

          <div className="bg-[#0E131D] border border-slate-800 rounded-md p-3.5">
            <div className="text-[11px] text-slate-400">Orbital Period / Eclipse</div>
            <div className="text-2xl font-mono font-semibold text-slate-100 tabular-nums mt-1">
              {(a.orbitalPeriodSec / 60).toFixed(2)}
              <span className="text-xs text-slate-400 ml-1">min</span>
            </div>
            <div className="text-[11px] font-mono text-slate-400 mt-1">
              Eclipse: {(a.eclipseFractionMean * 100).toFixed(1)}%
            </div>
          </div>

          <div className="bg-[#0E131D] border border-slate-800 rounded-md p-3.5">
            <div className="text-[11px] text-slate-400">J2 Nodal Precession</div>
            <div className="text-2xl font-mono font-semibold text-emerald-300 tabular-nums mt-1">
              {a.analyticalJ2RaanRateDegPerDay >= 0 ? '+' : ''}
              {a.analyticalJ2RaanRateDegPerDay.toFixed(3)}
              <span className="text-xs text-slate-400 ml-1">°/d</span>
            </div>
            <div className="text-[11px] font-mono text-slate-400 mt-1">
              SSO Δ: {a.ssoDeviationDegPerDay >= 0 ? '+' : ''}
              {a.ssoDeviationDegPerDay.toFixed(3)}°/d
            </div>
          </div>
        </div>

        {/* Charts Row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Chart 1: Cumulative Target Coverage & Active Links */}
          <section className="bg-[#0E131D] border border-slate-800 rounded-md p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-100">
                  Cumulative Target Coverage & Simultaneous Access
                </h2>
                <p className="text-xs text-slate-400">
                  Solid cyan: cumulative unique target coverage (%). Dashed amber: active FOV links (scaled).
                </p>
              </div>
              <span className="text-[11px] font-mono text-slate-400">Units: % · links</span>
            </div>

            <svg viewBox={`0 0 ${cw} ${ch}`} className="w-full h-auto" role="img" aria-label="Cumulative Target Coverage over Time">
              {/* Horizontal grid lines */}
              {[0, 25, 50, 75, 100].map((pct) => {
                const y = padT + plotH - (pct / 100) * plotH;
                return (
                  <g key={pct}>
                    <line x1={padL} y1={y} x2={cw - padR} y2={y} stroke="#1e293b" strokeWidth="1" />
                    <text x={padL - 8} y={y + 3} textAnchor="end" className="fill-slate-400 text-[10px] font-mono">
                      {pct}%
                    </text>
                  </g>
                );
              })}
              {/* X-axis ticks */}
              {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
                const x = padL + frac * plotW;
                const hrs = frac * horizonHrs;
                return (
                  <text key={frac} x={x} y={ch - 8} textAnchor="middle" className="fill-slate-400 text-[10px] font-mono">
                    {hrs.toFixed(1)}h
                  </text>
                );
              })}
              {/* Active links dashed line */}
              <polyline
                fill="none"
                stroke="#f59e0b"
                strokeWidth="1.5"
                strokeDasharray="4 3"
                points={linksPolyline}
                opacity="0.8"
              />
              {/* Cumulative coverage solid line */}
              <polyline fill="none" stroke="#06b6d4" strokeWidth="2.2" points={covPolyline} />
            </svg>
          </section>

          {/* Chart 2: Worst-Case Target Revisit Gaps */}
          <section className="bg-[#0E131D] border border-slate-800 rounded-md p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-100">
                  Maximum Revisit Gap by Target (Top 14 Longest Gaps)
                </h2>
                <p className="text-xs text-slate-400">
                  Merged multi-satellite revisit intervals across horizon ({horizonHrs.toFixed(1)} h).
                </p>
              </div>
              <span className="text-[11px] font-mono text-slate-400">Units: minutes</span>
            </div>

            <div className="space-y-1.5 max-h-[225px] overflow-y-auto pr-1">
              {worstTargets.map((t) => {
                const pct = Math.min(100, (t.maxGapSec / maxTargetGap) * 100);
                return (
                  <div key={t.targetId} className="grid grid-cols-[140px_1fr_76px] items-center gap-2 text-xs">
                    <span className="truncate text-slate-300" title={t.name}>
                      {t.name}
                    </span>
                    <div className="h-3 bg-slate-900 rounded overflow-hidden">
                      <div
                        className={`h-full ${t.covered ? 'bg-cyan-500/80' : 'bg-rose-500/80'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="font-mono text-[11px] text-right text-slate-300 tabular-nums">
                      {(t.maxGapSec / 60).toFixed(0)}m ({t.windowCount}w)
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        {/* Per-Satellite Downlink Contact & Conservation Diagnostics */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <section className="lg:col-span-2 bg-[#0E131D] border border-slate-800 rounded-md overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-100">
                Per-Satellite Observation & Ground Contact Capacity
              </h2>
              <span className="text-xs font-mono text-slate-400">
                {a.perSatelliteContactSec.length} spacecraft
              </span>
            </div>
            <div className="overflow-y-auto max-h-60">
              <table className="w-full text-xs text-left">
                <thead className="bg-[#090D14] text-slate-400 border-b border-slate-800 sticky top-0">
                  <tr>
                    <th className="py-2 px-3 font-medium">Satellite</th>
                    <th className="py-2 px-3 font-medium text-right">Plane</th>
                    <th className="py-2 px-3 font-medium text-right">Obs Windows</th>
                    <th className="py-2 px-3 font-medium text-right">GS Contacts</th>
                    <th className="py-2 px-3 font-medium text-right">Contact Time</th>
                    <th className="py-2 px-3 font-medium text-right">Max Downlink</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70 font-mono tabular-nums">
                  {a.perSatelliteContactSec.map((s) => (
                    <tr key={s.satId} className="hover:bg-slate-900/50">
                      <td className="py-2 px-3 text-slate-200">{s.satId}</td>
                      <td className="py-2 px-3 text-right text-slate-400">P{s.planeIndex + 1}</td>
                      <td className="py-2 px-3 text-right text-cyan-300">{s.obsWindowCount}</td>
                      <td className="py-2 px-3 text-right text-amber-300">{s.contactCount}</td>
                      <td className="py-2 px-3 text-right text-slate-300">
                        {(s.totalContactSec / 60).toFixed(1)} min
                      </td>
                      <td className="py-2 px-3 text-right text-slate-200">
                        {s.maxDownlinkCapacityGb.toFixed(1)} Gb
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="bg-[#0E131D] border border-slate-800 rounded-md p-4 space-y-3">
            <h2 className="text-sm font-semibold text-slate-100">Model Fidelity & Conservation</h2>
            <dl className="space-y-2 text-xs font-mono tabular-nums">
              <div className="flex justify-between">
                <dt className="text-slate-400 font-sans">Max Rel. Energy Drift</dt>
                <dd className="text-slate-200">{a.energyDriftMaxRelative.toExponential(2)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-400 font-sans">Max Rel. |h| Drift</dt>
                <dd className="text-slate-200">{a.angularMomentumDriftMaxRelative.toExponential(2)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-400 font-sans">RK4 Sub-step</dt>
                <dd className="text-slate-200">{bundle.scenario.constellation.rk4StepSec} s</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-400 font-sans">Frame Fidelity</dt>
                <dd className="text-amber-300">GMST-only (MODEL_ESTIMATE)</dd>
              </div>
            </dl>
            <p className="text-xs text-slate-400 leading-relaxed pt-2 border-t border-slate-800">
              Note: When J₂ is enabled, instantaneous Keplerian two-body energy oscillates slightly
              (~10⁻³) because J₂ adds a conservative oblateness potential term; pure two-body mode
              preserves ε and |h| to &lt;10⁻⁸. Atmospheric drag, SRP, and third-body perturbations
              are omitted.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
