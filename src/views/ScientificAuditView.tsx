import { useEffect, useState } from 'react';
import { CheckCircle2, FileText, RefreshCw, XCircle } from 'lucide-react';
import { fetchAuditSuite, fetchResearchDoc, type AuditResponse } from '../api/client';

interface ScientificAuditViewProps {
  scenarioHash: string;
}

export function ScientificAuditView({ scenarioHash }: ScientificAuditViewProps) {
  const [audit, setAudit] = useState<AuditResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [activeDoc, setActiveDoc] = useState<string>('problem_definition.md');
  const [docContent, setDocContent] = useState<string>('');
  const [docLoading, setDocLoading] = useState(false);

  const loadAudit = async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetchAuditSuite();
      setAudit(res);
      if (res.researchDocs.length > 0 && !res.researchDocs.includes(activeDoc)) {
        setActiveDoc(res.researchDocs[0]);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAudit();
  }, []);

  useEffect(() => {
    if (!activeDoc) return;
    setDocLoading(true);
    fetchResearchDoc(activeDoc)
      .then((d) => setDocContent(d.content))
      .catch(() => setDocContent('Failed to load research document.'))
      .finally(() => setDocLoading(false));
  }, [activeDoc]);

  return (
    <div className="flex-1 overflow-y-auto bg-[#07090E] p-6">
      <div className="max-w-[1280px] mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-slate-800 pb-4">
          <div>
            <p className="text-xs font-mono text-slate-400">
              Active Manifest SHA-256: {scenarioHash}
            </p>
            <h1 className="text-2xl font-semibold text-slate-100 mt-1">
              Scientific Audit Center & Provenance Ledger
            </h1>
          </div>
          <button
            type="button"
            onClick={loadAudit}
            disabled={loading}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded-md disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'Running Validation...' : 'Re-run Validation Suite'}
          </button>
        </div>

        {errorMsg && (
          <div role="alert" className="p-3 bg-rose-950/40 border border-rose-800 rounded text-xs text-rose-200">
            {errorMsg}
          </div>
        )}

        {/* Explicit Fidelity & Environment Limitations Warning */}
        <section className="bg-[#0E131D] border border-amber-800/60 rounded-md p-4 space-y-1.5 text-xs">
          <div className="font-semibold text-amber-300">
            Explicit Fidelity Warnings, Unverified Claims & Runtime Blockers
          </div>
          <p className="text-slate-300">
            1. <strong>Provisional Reference Problem:</strong> No historical constellation proposal
            existed in the workspace; the Walker 24/6/1 SSO scenario is a locked synthetic benchmark
            and is NOT presumed optimal.
          </p>
          <p className="text-slate-300">
            2. <strong>External Cross-Validation Blocker (`UNVERIFIED`):</strong> Orekit, GMAT,
            Basilisk, NumPy/SciPy, and OR-Tools are not installed in the interactive Node.js
            container. Physics and optimization checks below execute directly in deterministic
            double-precision TypeScript; external Orekit/GMAT trajectory parity remains untested
            inside this container.
          </p>
          <p className="text-slate-300">
            3. <strong>Candidate Algorithm Novelty (`UNESTABLISHED`):</strong> SRA-RHR is a
            structured synthesis of established techniques (submodular backup risk, shadow pricing,
            local repair). No publication or universal optimality claim is made.
          </p>
        </section>

        {/* Live Executed Physics & Verifier Validation Suite */}
        {audit && (
          <section className="bg-[#0E131D] border border-slate-800 rounded-md overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-100">
                Executed Physics, Numerical & Verifier Validation Tests ({audit.suite.passedChecks}/
                {audit.suite.totalChecks} Passed)
              </h2>
              <span className="text-xs font-mono text-slate-400">
                Executed: {audit.suite.executedAtIso}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-[#090D14] text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="py-2.5 px-3 font-medium">ID</th>
                    <th className="py-2.5 px-3 font-medium">Check</th>
                    <th className="py-2.5 px-3 font-medium">Acceptance Tolerance</th>
                    <th className="py-2.5 px-3 font-medium">Measured Result</th>
                    <th className="py-2.5 px-3 font-medium text-right">Time</th>
                    <th className="py-2.5 px-3 font-medium text-right">Outcome</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70 font-mono tabular-nums">
                  {audit.suite.checks.map((c) => (
                    <tr key={c.id} className="hover:bg-slate-900/50">
                      <td className="py-2 px-3 text-slate-400">{c.id}</td>
                      <td className="py-2 px-3 font-sans text-slate-100">
                        <div>{c.name}</div>
                        <div className="text-[11px] text-slate-400">{c.notes}</div>
                      </td>
                      <td className="py-2 px-3 text-slate-300">{c.toleranceSpec}</td>
                      <td className="py-2 px-3 text-cyan-300">{c.measuredValue}</td>
                      <td className="py-2 px-3 text-right text-slate-400">{c.runtimeMs} ms</td>
                      <td className="py-2 px-3 text-right">
                        {c.passed ? (
                          <span className="inline-flex items-center gap-1 text-emerald-400">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            PASS
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-rose-400">
                            <XCircle className="w-3.5 h-3.5" />
                            FAIL
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Provenance Classification Ledger */}
        {audit && (
          <section className="bg-[#0E131D] border border-slate-800 rounded-md overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-100">
                Parameter Provenance & Assumptions Register
              </h2>
              <span className="text-xs font-mono text-slate-400">
                {audit.provenanceLedger.length} tracked entries
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-[#090D14] text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="py-2 px-3 font-medium">ID</th>
                    <th className="py-2 px-3 font-medium">Parameter / Model</th>
                    <th className="py-2 px-3 font-medium">Value / Units</th>
                    <th className="py-2 px-3 font-medium">Provenance</th>
                    <th className="py-2 px-3 font-medium">Source / Simplification Bounds</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {audit.provenanceLedger.map((entry) => (
                    <tr key={entry.id} className="hover:bg-slate-900/50">
                      <td className="py-2 px-3 font-mono text-slate-400">{entry.id}</td>
                      <td className="py-2 px-3 text-slate-100 font-medium">{entry.parameter}</td>
                      <td className="py-2 px-3 font-mono text-slate-300">
                        {entry.value} <span className="text-slate-500">({entry.units})</span>
                      </td>
                      <td className="py-2 px-3 font-mono">
                        <span
                          className={
                            entry.provenance === 'VERIFIED_SOURCE'
                              ? 'text-emerald-400'
                              : entry.provenance === 'UNVERIFIED'
                                ? 'text-rose-400'
                                : entry.provenance === 'MODEL_ESTIMATE'
                                  ? 'text-cyan-300'
                                  : 'text-amber-300'
                          }
                        >
                          {entry.provenance}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-slate-400">{entry.sourceOrJustification}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Phase 0 Research Documentation Reader */}
        {audit && audit.researchDocs.length > 0 && (
          <section className="bg-[#0E131D] border border-slate-800 rounded-md overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-1.5">
                <FileText className="w-4 h-4 text-cyan-400" />
                Research Documentation Repository (research/*.md)
              </h2>
              <div className="flex flex-wrap items-center gap-1.5">
                {audit.researchDocs.map((doc) => (
                  <button
                    key={doc}
                    type="button"
                    onClick={() => setActiveDoc(doc)}
                    className={`px-2.5 py-1 text-[11px] font-mono rounded transition-colors ${
                      activeDoc === doc
                        ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-500/50'
                        : 'bg-[#090D14] text-slate-400 hover:text-slate-200 border border-slate-800'
                    }`}
                  >
                    {doc.replace('.md', '')}
                  </button>
                ))}
              </div>
            </div>
            <div className="p-5 bg-[#090D14] max-h-96 overflow-y-auto">
              {docLoading ? (
                <p className="text-xs font-mono text-slate-400">Loading {activeDoc}...</p>
              ) : (
                <pre className="text-xs font-mono text-slate-300 whitespace-pre-wrap leading-relaxed">
                  {docContent}
                </pre>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
