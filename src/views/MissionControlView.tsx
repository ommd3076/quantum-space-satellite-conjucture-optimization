import { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Eye,
  Pause,
  Play,
  RotateCcw,
  SlidersHorizontal,
} from 'lucide-react';
import { EarthGlobe3D, type GlobeLayerVisibility } from '../components/EarthGlobe3D';
import type { PropagationBundle } from '../../backend/src/types';

function formatMissionTime(tSec: number): string {
  const h = Math.floor(tSec / 3600);
  const m = Math.floor((tSec % 3600) / 60);
  const s = Math.floor(tSec % 60);
  return `T+${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

interface MissionControlViewProps {
  bundle: PropagationBundle | null;
  loading: boolean;
}

export function MissionControlView({ bundle, loading }: MissionControlViewProps) {
  const [timeIndex, setTimeIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speedStepsPerSec, setSpeedStepsPerSec] = useState(2);
  const [selectedSatId, setSelectedSatId] = useState<string | null>(null);
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [cameraPreset, setCameraPreset] = useState<'global' | 'polar' | 'equatorial' | 'follow'>('global');
  const [layers, setLayers] = useState<GlobeLayerVisibility>({
    showOrbits: true,
    showFootprints: true,
    showAccessLinks: true,
    showGroundStations: true,
    showTargets: true,
  });

  // Reset timeline index & default selected satellite when scenario changes
  useEffect(() => {
    setTimeIndex(0);
    setIsPlaying(false);
    if (bundle && bundle.satellites.length > 0) {
      setSelectedSatId((prev) =>
        bundle.satellites.some((s) => s.satId === prev) ? prev : bundle.satellites[0].satId,
      );
    }
  }, [bundle?.scenarioHash]);

  // Playback timer driving numerically propagated discrete states (never scripted fake orbits)
  useEffect(() => {
    if (!isPlaying || !bundle || bundle.timeStepsSec.length <= 1) return;
    const intervalMs = Math.max(90, Math.round(1000 / speedStepsPerSec));
    const timer = window.setInterval(() => {
      setTimeIndex((prev) => (prev + 1) % bundle.timeStepsSec.length);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [isPlaying, speedStepsPerSec, bundle]);

  const currentTSec = bundle ? bundle.timeStepsSec[Math.min(timeIndex, bundle.timeStepsSec.length - 1)] ?? 0 : 0;

  const selectedSat = useMemo(() => {
    if (!bundle) return null;
    return bundle.satellites.find((s) => s.satId === selectedSatId) ?? bundle.satellites[0] ?? null;
  }, [bundle, selectedSatId]);

  const selectedState = useMemo(() => {
    if (!selectedSat) return null;
    return selectedSat.states[Math.min(timeIndex, selectedSat.states.length - 1)] ?? null;
  }, [selectedSat, timeIndex]);

  const activeContactsAtTime = useMemo(() => {
    if (!bundle) return { obsCount: 0, dlCount: 0, satObs: [] as string[], satDl: [] as string[] };
    const obs = bundle.observationWindows.filter((w) => currentTSec >= w.startSec && currentTSec <= w.endSec);
    const dl = bundle.downlinkWindows.filter((d) => currentTSec >= d.startSec && currentTSec <= d.endSec);
    return {
      obsCount: obs.length,
      dlCount: dl.length,
      satObs: selectedSat ? obs.filter((w) => w.satId === selectedSat.satId).map((w) => w.targetId) : [],
      satDl: selectedSat ? dl.filter((d) => d.satId === selectedSat.satId).map((d) => d.stationId) : [],
    };
  }, [bundle, currentTSec, selectedSat]);

  const toggleLayer = (key: keyof GlobeLayerVisibility) => {
    setLayers((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  if (loading && !bundle) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[#07090E] text-slate-300">
        <div className="text-center space-y-2">
          <p className="text-sm font-medium text-slate-100">Propagating Walker Delta Constellation</p>
          <p className="text-xs font-mono text-slate-400">
            Computing Two-Body + J2 RK4 ECI/ECEF trajectories and WGS84 access windows...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col lg:flex-row min-h-0 overflow-hidden bg-[#05080F]">
      {/* Primary unobstructed 3D Orbital Viewport */}
      <div className="relative flex-1 min-h-[460px] overflow-hidden">
        <EarthGlobe3D
          bundle={bundle}
          timeIndex={timeIndex}
          isPlaying={isPlaying}
          selectedSatId={selectedSatId}
          layers={layers}
          cameraPreset={cameraPreset}
          onSelectSat={(satId) => {
            setSelectedSatId(satId);
            setDrawerOpen(true);
          }}
        />

        {/* Minimal Top-Left Ephemeris Header (solid translucent dark, NO backdrop-blur over WebGL) */}
        {bundle && (
          <div className="absolute top-4 left-4 z-10 pointer-events-auto bg-[#0b0f19]/92 border border-slate-800 rounded-md px-3.5 py-2.5 max-w-md">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span className="font-mono text-cyan-400">
                {formatMissionTime(currentTSec)}
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono">
                Walker {bundle.scenario.constellation.totalSatellites}/
                {bundle.scenario.constellation.planes}/
                {bundle.scenario.constellation.phasing}
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono uppercase">
                {bundle.scenario.constellation.propagator === 'j2_rk4' ? 'J2 RK4' : 'Kepler 2-Body'}
              </span>
            </div>
            <p className="text-sm font-semibold text-slate-100 mt-0.5 truncate">
              {bundle.scenario.name}
            </p>
            <div className="flex items-center gap-3 mt-1 text-[11px] font-mono text-slate-400 tabular-nums">
              <span>Access links: {activeContactsAtTime.obsCount}</span>
              <span aria-hidden="true">·</span>
              <span>Downlinks: {activeContactsAtTime.dlCount}</span>
              <span aria-hidden="true">·</span>
              <span>Hash: {bundle.scenarioHash.slice(0, 8)}</span>
            </div>
          </div>
        )}

        {/* Drawer Toggle Button Top-Right */}
        <div className="absolute top-4 right-4 z-10 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setDrawerOpen((o) => !o)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#0b0f19]/92 hover:bg-[#131a2a] border border-slate-700 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            <SlidersHorizontal className="w-3.5 h-3.5 text-cyan-400" />
            {drawerOpen ? 'Hide Diagnostics' : 'Show Diagnostics'}
          </button>
        </div>

        {/* Collapsible Unified Bottom Control Dock */}
        {bundle && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 w-[min(920px,94%)] flex flex-col items-center">
            <button
              type="button"
              onClick={() => setDockCollapsed((c) => !c)}
              className="flex items-center gap-1.5 px-3 py-1 text-[11px] font-medium text-slate-300 bg-[#0b0f19]/95 hover:text-white border border-b-0 border-slate-700 rounded-t-md transition-colors"
            >
              {dockCollapsed ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              {dockCollapsed ? 'Show Timeline Controls' : 'Hide Controls'}
            </button>

            {!dockCollapsed && (
              <div className="w-full bg-[#0b0f19]/95 border border-slate-700/90 rounded-md px-4 py-3 space-y-2.5">
                {/* Row 1: Playback + Scrubber */}
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    aria-label={isPlaying ? 'Pause propagation playback' : 'Play propagation playback'}
                    onClick={() => setIsPlaying((p) => !p)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded transition-colors whitespace-nowrap shrink-0"
                  >
                    {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                    {isPlaying ? 'Pause' : 'Play'}
                  </button>

                  <button
                    type="button"
                    aria-label="Reset timeline to epoch"
                    onClick={() => {
                      setIsPlaying(false);
                      setTimeIndex(0);
                    }}
                    className="p-1.5 text-slate-300 hover:text-white bg-slate-900 border border-slate-700 rounded transition-colors"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>

                  <label htmlFor="mission-timeline-slider" className="sr-only">
                    Mission Timeline Scrubber
                  </label>
                  <input
                    id="mission-timeline-slider"
                    type="range"
                    min={0}
                    max={Math.max(0, bundle.timeStepsSec.length - 1)}
                    value={timeIndex}
                    onChange={(e) => setTimeIndex(Number(e.target.value))}
                    className="flex-1 accent-cyan-400 h-1.5 bg-slate-800 rounded cursor-pointer"
                  />

                  <span className="font-mono text-xs text-slate-200 tabular-nums whitespace-nowrap shrink-0 w-24 text-right">
                    {formatMissionTime(currentTSec)}
                  </span>

                  <div className="flex items-center gap-1 bg-slate-900 p-0.5 rounded border border-slate-800 shrink-0">
                    {[1, 2, 5].map((spd) => (
                      <button
                        key={spd}
                        type="button"
                        onClick={() => setSpeedStepsPerSec(spd)}
                        className={`px-2 py-0.5 text-[11px] font-mono rounded transition-colors ${
                          speedStepsPerSec === spd
                            ? 'bg-slate-700 text-cyan-300'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {spd}x
                      </button>
                    ))}
                  </div>
                </div>

                {/* Row 2: Layer toggles + Camera presets */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-800/80 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-slate-400 mr-1 flex items-center gap-1">
                      <Eye className="w-3 h-3" /> Layers:
                    </span>
                    {(
                      [
                        ['showOrbits', 'Orbits'],
                        ['showFootprints', 'Footprints'],
                        ['showAccessLinks', 'Access Links'],
                        ['showGroundStations', 'Stations'],
                        ['showTargets', 'Targets'],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => toggleLayer(key)}
                        className={`px-2.5 py-1 text-[11px] font-medium rounded border transition-colors whitespace-nowrap ${
                          layers[key]
                            ? 'bg-cyan-500/15 border-cyan-500/50 text-cyan-200'
                            : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center gap-1">
                    <span className="text-[11px] text-slate-400 mr-1">Camera:</span>
                    {(['global', 'polar', 'equatorial', 'follow'] as const).map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => setCameraPreset(preset)}
                        className={`px-2 py-1 text-[11px] capitalize rounded border transition-colors whitespace-nowrap ${
                          cameraPreset === preset
                            ? 'bg-slate-800 border-cyan-500/60 text-cyan-300'
                            : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {preset}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Right Docked Per-Satellite Diagnostics Panel (outside 3D canvas so zero overlap) */}
      {drawerOpen && bundle && (
        <aside className="w-full lg:w-[340px] border-t lg:border-t-0 lg:border-l border-slate-800 bg-[#0B0E17] flex flex-col min-h-0 overflow-y-auto shrink-0">
          <div className="p-4 border-b border-slate-800">
            <h2 className="text-sm font-semibold text-slate-100">Satellite State Diagnostics</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Numerically propagated ECI/ECEF coordinates and orbital invariants.
            </p>
            <div className="mt-3">
              <label htmlFor="sat-selector" className="block text-xs text-slate-400 mb-1">
                Inspect Spacecraft ({bundle.satellites.length} active)
              </label>
              <select
                id="sat-selector"
                value={selectedSat?.satId ?? ''}
                onChange={(e) => setSelectedSatId(e.target.value)}
                className="w-full bg-[#07090E] border border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-slate-100 focus:outline-none focus:border-cyan-500"
              >
                {bundle.satellites.map((s) => (
                  <option key={s.satId} value={s.satId}>
                    {s.satId} (Plane {s.planeIndex + 1}, Slot {s.slotIndex + 1})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {selectedSat && selectedState && (
            <div className="p-4 space-y-5 text-xs">
              {/* Geodetic Subsatellite State */}
              <div>
                <h3 className="text-[11px] font-medium text-slate-400 mb-2">
                  Geodetic WGS84 Sub-Satellite Point
                </h3>
                <div className="grid grid-cols-2 gap-2.5 font-mono tabular-nums">
                  <div className="bg-[#0F1522] border border-slate-800 rounded p-2.5">
                    <div className="text-[10px] text-slate-400">Latitude</div>
                    <div className="text-sm font-semibold text-slate-100 mt-0.5">
                      {selectedState.latDeg.toFixed(3)}°
                    </div>
                  </div>
                  <div className="bg-[#0F1522] border border-slate-800 rounded p-2.5">
                    <div className="text-[10px] text-slate-400">Longitude</div>
                    <div className="text-sm font-semibold text-slate-100 mt-0.5">
                      {selectedState.lonDeg.toFixed(3)}°
                    </div>
                  </div>
                  <div className="bg-[#0F1522] border border-slate-800 rounded p-2.5">
                    <div className="text-[10px] text-slate-400">Altitude (WGS84)</div>
                    <div className="text-sm font-semibold text-cyan-300 mt-0.5">
                      {selectedState.altKm.toFixed(2)} <span className="text-[10px] text-slate-400">km</span>
                    </div>
                  </div>
                  <div className="bg-[#0F1522] border border-slate-800 rounded p-2.5">
                    <div className="text-[10px] text-slate-400">Illumination</div>
                    <div
                      className={`text-sm font-semibold mt-0.5 ${
                        selectedState.inEclipse ? 'text-amber-400' : 'text-emerald-400'
                      }`}
                    >
                      {selectedState.inEclipse ? 'Umbra Eclipse' : 'Sunlit'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Cartesian ECI & ECEF Vectors */}
              <div className="border-t border-slate-800/80 pt-4">
                <h3 className="text-[11px] font-medium text-slate-400 mb-2">
                  ECI State Vector (J2000-Aligned)
                </h3>
                <dl className="space-y-1.5 font-mono text-[11px] tabular-nums">
                  <div className="flex justify-between">
                    <dt className="text-slate-400">r_ECI (km)</dt>
                    <dd className="text-slate-200">
                      [{selectedState.eciPosKm.x.toFixed(1)}, {selectedState.eciPosKm.y.toFixed(1)},{' '}
                      {selectedState.eciPosKm.z.toFixed(1)}]
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-400">v_ECI (km/s)</dt>
                    <dd className="text-slate-200">
                      [{selectedState.eciVelKmS.x.toFixed(3)}, {selectedState.eciVelKmS.y.toFixed(3)},{' '}
                      {selectedState.eciVelKmS.z.toFixed(3)}]
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-400">r_ECEF (km)</dt>
                    <dd className="text-slate-300">
                      [{selectedState.ecefPosKm.x.toFixed(1)}, {selectedState.ecefPosKm.y.toFixed(1)},{' '}
                      {selectedState.ecefPosKm.z.toFixed(1)}]
                    </dd>
                  </div>
                </dl>
              </div>

              {/* Classical Elements & Invariants */}
              <div className="border-t border-slate-800/80 pt-4">
                <h3 className="text-[11px] font-medium text-slate-400 mb-2">
                  Initial Elements & Mechanical Invariants
                </h3>
                <dl className="space-y-1.5 font-mono text-[11px] tabular-nums">
                  <div className="flex justify-between">
                    <dt className="text-slate-400">Semi-Major Axis (a)</dt>
                    <dd className="text-slate-200">{selectedSat.initialElements.aKm.toFixed(3)} km</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-400">Inclination / RAAN</dt>
                    <dd className="text-slate-200">
                      {selectedSat.initialElements.incDeg.toFixed(2)}° / {selectedSat.initialElements.raanDeg.toFixed(1)}°
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-400">Specific Energy (ε)</dt>
                    <dd className="text-slate-200">{selectedState.specificEnergyKm2S2.toFixed(4)} km²/s²</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-400">Angular Momentum (|h|)</dt>
                    <dd className="text-slate-200">{selectedState.angularMomentumKm2S.toFixed(2)} km²/s</dd>
                  </div>
                </dl>
              </div>

              {/* Active Access Links at Current Timestep */}
              <div className="border-t border-slate-800/80 pt-4">
                <h3 className="text-[11px] font-medium text-slate-400 mb-2">
                  Active Links for {selectedSat.satId}
                </h3>
                <div className="space-y-1.5 font-mono text-[11px]">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Targets in FOV:</span>
                    <span className="text-cyan-300">
                      {activeContactsAtTime.satObs.length > 0
                        ? activeContactsAtTime.satObs.join(', ')
                        : 'None'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Ground Contacts:</span>
                    <span className="text-amber-300">
                      {activeContactsAtTime.satDl.length > 0
                        ? activeContactsAtTime.satDl.join(', ')
                        : 'None'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </aside>
      )}
    </div>
  );
}
