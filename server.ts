import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createViteServer } from 'vite';
import { createPresetScenarios, generateSyntheticTargets } from './backend/src/scenarios/presets';
import { propagateAndAnalyzeScenario } from './backend/src/geometry/access';
import { runAlgorithm, runAllAlgorithmsOnBundle } from './backend/src/algorithms/runner';
import { runPairedExperimentBatch } from './experiments/runner';
import { runScientificAuditSuite } from './backend/src/validation/auditSuite';
import { PROVENANCE_LEDGER } from './backend/src/physics/constants';
import { computeSsoInclinationDeg } from './backend/src/orbits/kepler';
import { sha256Canonical } from './backend/src/scenarios/prng';
import type {
  AlgorithmId,
  PropagationBundle,
  ProposedAblationFlags,
  ScenarioConfig,
} from './backend/src/types';

const PORT = Number(process.env.PORT) || 3000;
const PYTHON_SCIENCE_URL = (process.env.PYTHON_SCIENCE_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
const RESEARCH_DIR = path.resolve(process.cwd(), 'research');
const MANIFEST_DIR = path.resolve(process.cwd(), 'data/manifests');

// Validate PYTHON_SCIENCE_URL at startup (allow only http/https configured service URL)
let parsedScienceOrigin: URL;
try {
  parsedScienceOrigin = new URL(PYTHON_SCIENCE_URL);
  if (parsedScienceOrigin.protocol !== 'http:' && parsedScienceOrigin.protocol !== 'https:') {
    throw new Error('Unsupported protocol');
  }
} catch {
  throw new Error(`Invalid PYTHON_SCIENCE_URL: ${PYTHON_SCIENCE_URL}`);
}

let pythonChild: ChildProcess | null = null;

async function isPythonScienceUp(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1200);
    const resp = await fetch(`${PYTHON_SCIENCE_URL}/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    return resp.ok;
  } catch {
    return false;
  }
}

async function maybeStartLocalPythonScience(): Promise<void> {
  if (process.env.AUTO_START_PYTHON_SCIENCE === 'false') return;
  if (parsedScienceOrigin.hostname !== '127.0.0.1' && parsedScienceOrigin.hostname !== 'localhost') return;
  if (await isPythonScienceUp()) {
    console.log(`Connected to existing Python scientific service at ${PYTHON_SCIENCE_URL}`);
    return;
  }

  const venvUvicorn = path.resolve(process.cwd(), 'scientific_backend/.venv/bin/uvicorn');
  const scienceDir = path.resolve(process.cwd(), 'scientific_backend');
  if (!fs.existsSync(venvUvicorn)) {
    console.warn(
      `Python scientific venv not found at ${venvUvicorn}. ` +
      'Run scientific_backend separately (see README_RUN_SCIENCE.md). Gateway will report OFFLINE without fake fallback.',
    );
    return;
  }

  const port = parsedScienceOrigin.port || '8000';
  pythonChild = spawn(
    venvUvicorn,
    ['app.api.main:app', '--host', '127.0.0.1', '--port', port],
    {
      cwd: scienceDir,
      env: { ...process.env, PYTHONPATH: scienceDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  pythonChild.stdout?.on('data', (d) => process.stdout.write(`[python-science] ${d}`));
  pythonChild.stderr?.on('data', (d) => process.stderr.write(`[python-science] ${d}`));
  pythonChild.on('exit', (code) => {
    console.warn(`[python-science] process exited with code ${code}`);
    pythonChild = null;
  });

  // Wait up to 8s for uvicorn startup readiness
  for (let i = 0; i < 32; i++) {
    if (await isPythonScienceUp()) {
      console.log(`Python scientific service ready at ${PYTHON_SCIENCE_URL}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

const cleanupChild = () => {
  if (pythonChild && !pythonChild.killed) {
    pythonChild.kill('SIGTERM');
  }
};
process.on('SIGTERM', () => {
  cleanupChild();
  process.exit(0);
});
process.on('SIGINT', () => {
  cleanupChild();
  process.exit(0);
});

// In-memory LRU cache for legacy 24-sat sandbox routes (never substituted for Python /api/science/*)
const bundleCache = new Map<string, PropagationBundle>();
const savedScenarios = new Map<string, ScenarioConfig>();

const initialPresets = createPresetScenarios();
for (const [id, sc] of Object.entries(initialPresets)) {
  savedScenarios.set(id, sc);
}

function getOrComputeBundle(scenario: ScenarioConfig): PropagationBundle {
  const hash = sha256Canonical(scenario);
  const cached = bundleCache.get(hash);
  if (cached) return cached;
  const bundle = propagateAndAnalyzeScenario(scenario);
  if (bundleCache.size > 16) {
    const firstKey = bundleCache.keys().next().value;
    if (firstKey) bundleCache.delete(firstKey);
  }
  bundleCache.set(hash, bundle);
  return bundle;
}

async function startServer() {
  await maybeStartLocalPythonScience();

  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Health endpoint (reports both Express gateway & Python scientific backend reachability)
  app.get('/api/health', async (_req, res) => {
    const pyUp = await isPythonScienceUp();
    res.json({
      status: 'ok',
      service: 'constellation-lab-gateway',
      nodeVersion: process.version,
      pythonScienceUrl: PYTHON_SCIENCE_URL,
      pythonScienceConnected: pyUp,
      timestampIso: new Date().toISOString(),
    });
  });

  // Strict reverse proxy for Python/C++ Scientific Backend (/api/science/* -> PYTHON_SCIENCE_URL/*)
  // NEVER silently falls back to TypeScript synthetic data when Python is offline.
  app.use('/api/science', async (req, res) => {
    const subPath = req.url.startsWith('/') ? req.url : `/${req.url}`;
    const targetUrl = new URL(subPath, `${PYTHON_SCIENCE_URL}/`);
    // Guard against SSRF / host override
    if (targetUrl.origin !== parsedScienceOrigin.origin) {
      res.status(400).json({ status: 'ERROR', error: 'Invalid proxy target path.' });
      return;
    }

    const ctrl = new AbortController();
    const timeoutMs = req.url.includes('bench50k') || req.url.includes('ingest') || req.url.includes('optimization')
      ? 60_000
      : 25_000;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const fetchInit: RequestInit = {
        method: req.method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        signal: ctrl.signal,
      };
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined) {
        fetchInit.body = JSON.stringify(req.body);
      }
      const upstream = await fetch(targetUrl.toString(), fetchInit);
      clearTimeout(timer);
      const text = await upstream.text();
      res.status(upstream.status);
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
      res.send(text);
    } catch (err) {
      clearTimeout(timer);
      res.status(503).json({
        status: 'OFFLINE',
        code: 'PYTHON_BACKEND_OFFLINE',
        pythonScienceUrl: PYTHON_SCIENCE_URL,
        error:
          'Python/C++ scientific backend is unreachable. No synthetic fallback values are generated. ' +
          'Start scientific_backend (see README_RUN_SCIENCE.md).',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Legacy Designer / Sandbox endpoints preserved for backward compatibility
  app.get('/api/presets', (_req, res) => {
    const list = Array.from(savedScenarios.values()).map((sc) => ({
      ...sc,
      scenarioHash: sha256Canonical(sc),
    }));
    res.json({ presets: list });
  });

  app.get('/api/sso-inclination', (req, res) => {
    try {
      const altitudeKm = Number(req.query.altitudeKm ?? 550);
      const eccentricity = Number(req.query.eccentricity ?? 0.001);
      const inclinationDeg = +computeSsoInclinationDeg(altitudeKm, eccentricity).toFixed(4);
      res.json({ altitudeKm, eccentricity, inclinationDeg });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/targets/generate', (req, res) => {
    try {
      const count = Math.max(4, Math.min(80, Number(req.body?.count ?? 36)));
      const seed = Number(req.body?.seed ?? 20261123);
      const horizonSec = Number(req.body?.horizonSec ?? 21600);
      const deadlinePressure = Number(req.body?.deadlinePressure ?? 1.0);
      const cloudScale = Number(req.body?.cloudScale ?? 1.0);
      const targets = generateSyntheticTargets(count, seed, horizonSec, deadlinePressure, cloudScale);
      res.json({ targets });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/scenarios/save', (req, res) => {
    try {
      const scenario = req.body?.scenario as ScenarioConfig;
      if (!scenario || !scenario.constellation) {
        res.status(400).json({ error: 'Invalid scenario payload.' });
        return;
      }
      const scenarioHash = sha256Canonical(scenario);
      const id = scenario.id || `custom_${scenarioHash.slice(0, 8)}`;
      const frozen: ScenarioConfig = { ...scenario, id };
      savedScenarios.set(id, frozen);

      try {
        fs.mkdirSync(MANIFEST_DIR, { recursive: true });
        const outFile = path.resolve(MANIFEST_DIR, `${path.basename(id)}_${scenarioHash.slice(0, 12)}.json`);
        if (outFile.startsWith(MANIFEST_DIR + path.sep)) {
          fs.writeFileSync(
            outFile,
            JSON.stringify({ scenarioHash, savedAtIso: new Date().toISOString(), scenario: frozen }, null, 2),
            'utf8',
          );
        }
      } catch {
        // Ignore disk write restriction
      }

      res.json({ id, scenarioHash, scenario: frozen });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/propagate', (req, res) => {
    try {
      const scenario = (req.body?.scenario as ScenarioConfig) ?? savedScenarios.get('reference_24_6_1')!;
      const bundle = getOrComputeBundle(scenario);
      res.json(bundle);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/solve', (req, res) => {
    try {
      const scenario = (req.body?.scenario as ScenarioConfig) ?? savedScenarios.get('reference_24_6_1')!;
      const algorithmId = req.body?.algorithmId as AlgorithmId | 'all';
      const computeBudgetMs = Math.max(100, Math.min(8000, Number(req.body?.computeBudgetMs ?? 1500)));
      const ablationFlags = req.body?.ablationFlags as ProposedAblationFlags | undefined;

      const bundle = getOrComputeBundle(scenario);

      if (algorithmId === 'all') {
        const results = runAllAlgorithmsOnBundle(bundle, computeBudgetMs, ablationFlags);
        res.json({ scenarioHash: bundle.scenarioHash, results });
      } else {
        const result = runAlgorithm(algorithmId, bundle, computeBudgetMs, ablationFlags);
        res.json({ scenarioHash: bundle.scenarioHash, results: [result] });
      }
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/experiments/run', (req, res) => {
    try {
      const scenario = (req.body?.scenario as ScenarioConfig) ?? savedScenarios.get('reference_24_6_1')!;
      const seedsInput = Array.isArray(req.body?.seeds)
        ? (req.body.seeds as unknown[]).map(Number).filter((n) => Number.isFinite(n))
        : [101, 202, 303, 404, 505];
      const computeBudgetMs = Math.max(150, Math.min(4000, Number(req.body?.computeBudgetMs ?? 800)));
      const includeAblations = req.body?.includeAblations !== false;
      const includeExactSolver = Boolean(req.body?.includeExactSolver);

      const batch = runPairedExperimentBatch({
        baseScenario: scenario,
        seeds: seedsInput,
        computeBudgetMs,
        includeAblations,
        includeExactSolver,
      });
      res.json(batch);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/audit', (_req, res) => {
    try {
      const suite = runScientificAuditSuite();
      const docs = fs.existsSync(RESEARCH_DIR)
        ? fs.readdirSync(RESEARCH_DIR).filter((f) => f.endsWith('.md')).sort()
        : [];
      res.json({
        suite,
        provenanceLedger: PROVENANCE_LEDGER,
        researchDocs: docs,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/research/:filename', (req, res) => {
    const filename = path.basename(req.params.filename);
    if (!filename.endsWith('.md')) {
      res.status(400).json({ error: 'Only .md research documents are accessible.' });
      return;
    }
    const fullPath = path.resolve(RESEARCH_DIR, filename);
    if (!fullPath.startsWith(RESEARCH_DIR + path.sep) || !fs.existsSync(fullPath)) {
      res.status(404).json({ error: `Document not found: ${filename}` });
      return;
    }
    res.json({ filename, content: fs.readFileSync(fullPath, 'utf8') });
  });

  // Mount Vite middleware in dev, or serve static dist in production
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Constellation Lab gateway running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start Constellation Lab server:', err);
  process.exit(1);
});
