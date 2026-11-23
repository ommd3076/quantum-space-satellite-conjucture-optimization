import { useCallback, useEffect, useState } from 'react';
import {
  fetchPresets,
  propagateScenario,
  type PresetWithHash,
} from './api/client';
import { MissionControlView } from './views/MissionControlView';
import { ConstellationDesignerView } from './views/ConstellationDesignerView';
import { CoverageAnalyticsView } from './views/CoverageAnalyticsView';
import { AlgorithmLabView } from './views/AlgorithmLabView';
import { ExperimentLabView } from './views/ExperimentLabView';
import { ScientificAuditView } from './views/ScientificAuditView';
import type {
  ExperimentBatchResult,
  PropagationBundle,
  ScenarioConfig,
  SolverRunResult,
} from '../backend/src/types';

type ActiveTab =
  | 'mission'
  | 'designer'
  | 'coverage'
  | 'algorithms'
  | 'experiments'
  | 'audit';

const NAV_ITEMS: Array<{ id: ActiveTab; label: string }> = [
  { id: 'mission', label: 'Mission' },
  { id: 'designer', label: 'Designer' },
  { id: 'coverage', label: 'Coverage' },
  { id: 'algorithms', label: 'Algorithms' },
  { id: 'experiments', label: 'Experiments' },
  { id: 'audit', label: 'Audit' },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('mission');
  const [presets, setPresets] = useState<PresetWithHash[]>([]);
  const [scenario, setScenario] = useState<ScenarioConfig | null>(null);
  const [bundle, setBundle] = useState<PropagationBundle | null>(null);
  const [propagating, setPropagating] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [solverResults, setSolverResults] = useState<SolverRunResult[]>([]);
  const [experimentBatch, setExperimentBatch] = useState<ExperimentBatchResult | null>(null);

  const runPropagation = useCallback(async (sc: ScenarioConfig) => {
    setPropagating(true);
    setInitError(null);
    try {
      const nextBundle = await propagateScenario(sc);
      setBundle(nextBundle);
      // Clear stale solver results if scenario hash changed
      setSolverResults((prev) =>
        prev.length > 0 && prev[0].scenarioHash === nextBundle.scenarioHash ? prev : [],
      );
    } catch (err) {
      setInitError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setPropagating(false);
    }
  }, []);

  // Load frozen presets and run initial real orbital propagation on boot
  useEffect(() => {
    let active = true;
    fetchPresets()
      .then(async ({ presets: loaded }) => {
        if (!active || loaded.length === 0) return;
        setPresets(loaded);
        const initial = loaded.find((p) => p.id === 'reference_24_6_1') ?? loaded[0];
        setScenario(initial);
        await runPropagation(initial);
      })
      .catch((err) => {
        if (active) setInitError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [runPropagation]);

  const handleSavedScenario = (saved: ScenarioConfig, hash: string) => {
    setScenario(saved);
    setPresets((prev) => {
      const exists = prev.some((p) => p.id === saved.id);
      const item: PresetWithHash = { ...saved, scenarioHash: hash };
      return exists ? prev.map((p) => (p.id === saved.id ? item : p)) : [...prev, item];
    });
  };

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-[#07090E] text-slate-100">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="h-14 px-5 border-b border-slate-800 bg-[#0B0E17] flex items-center justify-between gap-8 shrink-0">
        {/* Zone 1: Single-line Brand Wordmark */}
        <button
          type="button"
          onClick={() => setActiveTab('mission')}
          className="text-base font-bold tracking-tight text-slate-100 hover:text-cyan-300 transition-colors whitespace-nowrap shrink-0"
        >
          Constellation Lab
        </button>

        {/* Zone 2: Clean Single-Line Navigation Links */}
        <nav aria-label="Primary workspace views" className="flex items-center gap-6 overflow-x-auto">
          {NAV_ITEMS.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => setActiveTab(item.id)}
                className={`py-4 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                  active
                    ? 'border-cyan-400 text-cyan-300'
                    : 'border-transparent text-slate-400 hover:text-slate-100'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: Single Primary Action */}
        <div className="shrink-0">
          <button
            type="button"
            disabled={!scenario || propagating}
            onClick={() => scenario && runPropagation(scenario)}
            className="px-4 py-1.5 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded-md disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
          >
            {propagating ? 'Propagating...' : 'Run Propagation'}
          </button>
        </div>
      </header>

      {initError && (
        <div role="alert" className="px-5 py-2 bg-rose-950/60 border-b border-rose-800 text-xs text-rose-200">
          Backend computation error: {initError}
        </div>
      )}

      {/* Active Research Workspace */}
      <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {activeTab === 'mission' && (
          <MissionControlView bundle={bundle} loading={propagating} />
        )}

        {activeTab === 'designer' && scenario && (
          <ConstellationDesignerView
            scenario={scenario}
            presets={presets}
            scenarioHash={bundle?.scenarioHash ?? 'pending'}
            propagating={propagating}
            onChangeScenario={setScenario}
            onRunPropagation={runPropagation}
            onSavedScenario={handleSavedScenario}
          />
        )}

        {activeTab === 'coverage' && <CoverageAnalyticsView bundle={bundle} />}

        {activeTab === 'algorithms' && scenario && (
          <AlgorithmLabView
            scenario={scenario}
            bundle={bundle}
            solverResults={solverResults}
            onResultsUpdated={setSolverResults}
          />
        )}

        {activeTab === 'experiments' && scenario && (
          <ExperimentLabView
            scenario={scenario}
            batchResult={experimentBatch}
            onBatchCompleted={setExperimentBatch}
          />
        )}

        {activeTab === 'audit' && (
          <ScientificAuditView scenarioHash={bundle?.scenarioHash ?? 'not-propagated'} />
        )}
      </main>
    </div>
  );
}
