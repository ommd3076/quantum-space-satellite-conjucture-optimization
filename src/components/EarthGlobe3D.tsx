import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { PropagationBundle, Vec3 } from '../../backend/src/types';

const R_EARTH_KM = 6378.137;
const DEG_TO_RAD = Math.PI / 180;

// Higher-detail continental outlines (lat/lon polygon loops) for procedural WGS84 globe texture
const CONTINENT_LOOPS: Array<Array<[number, number]>> = [
  // North & Central America
  [
    [71,-156],[70,-141],[69,-130],[68,-115],[67,-95],[63,-92],[58,-94],[55,-82],[52,-79],
    [60,-77],[62,-73],[58,-64],[53,-56],[47,-53],[44,-64],[41,-70],[39,-75],[35,-76],
    [30,-81],[25,-80],[25,-82],[29,-84],[30,-89],[29,-95],[26,-97],[21,-97],[19,-91],
    [21,-87],[18,-88],[15,-84],[10,-83],[9,-79],[8,-77],[9,-82],[11,-86],[15,-93],
    [18,-103],[23,-106],[28,-111],[31,-114],[24,-110],[28,-114],[33,-117],[38,-123],
    [42,-124],[48,-125],[54,-130],[59,-139],[61,-148],[57,-156],[55,-163],[60,-166],
    [65,-168],[69,-163],
  ],
  // Greenland
  [
    [83,-34],[81,-18],[76,-19],[70,-22],[65,-38],[60,-44],[64,-52],[69,-53],[74,-57],
    [77,-68],[80,-65],[82,-50],
  ],
  // Cuba / Caribbean
  [[23,-84],[22,-79],[20,-74],[20,-77],[22,-82]],
  // South America
  [
    [11,-75],[12,-71],[10,-67],[9,-61],[6,-55],[2,-50],[0,-49],[-2,-44],[-5,-35],
    [-10,-36],[-15,-39],[-22,-41],[-23,-44],[-28,-49],[-34,-53],[-38,-57],[-42,-64],
    [-47,-66],[-52,-68],[-55,-67],[-54,-72],[-49,-75],[-42,-74],[-33,-72],[-23,-70],
    [-18,-71],[-12,-77],[-5,-81],[1,-80],[7,-78],
  ],
  // UK & Ireland
  [[58,-5],[57,-2],[53,1],[51,1],[50,-5],[54,-5]],
  [[55,-8],[54,-6],[52,-6],[52,-10]],
  // Continental Europe
  [
    [71,28],[70,21],[66,13],[62,5],[58,6],[59,11],[55,13],[56,17],[60,18],[65,22],
    [65,25],[60,22],[60,29],[57,24],[54,19],[54,10],[57,9],[54,8],[52,4],[50,2],
    [48,-4],[44,-2],[43,-9],[37,-9],[36,-5],[39,0],[43,4],[44,9],[41,13],[38,16],
    [41,18],[45,14],[42,19],[38,21],[37,24],[40,26],[42,28],[46,31],[45,35],[47,39],
    [52,40],[60,42],[67,41],[69,34],
  ],
  // Iceland
  [[66,-23],[66,-15],[64,-14],[64,-22]],
  // Africa
  [
    [36,-6],[37,10],[33,12],[31,19],[32,25],[31,32],[27,34],[20,37],[13,43],[11,51],
    [4,48],[-2,41],[-10,40],[-18,37],[-25,35],[-31,30],[-34,25],[-34,18],[-28,16],
    [-20,13],[-12,13],[-5,12],[1,9],[4,9],[6,2],[5,-4],[5,-9],[10,-15],[15,-17],
    [21,-17],[27,-13],[32,-9],
  ],
  // Madagascar
  [[-12,49],[-16,50],[-25,47],[-25,44],[-17,44]],
  // Asia
  [
    [69,34],[68,44],[70,60],[73,72],[75,90],[77,104],[73,125],[71,140],[69,165],
    [66,179],[60,165],[54,158],[51,156],[54,142],[48,140],[43,134],[39,128],[35,129],
    [37,126],[40,122],[37,122],[34,120],[30,122],[24,118],[21,110],[17,107],[12,109],
    [9,105],[13,100],[7,100],[1,104],[6,100],[15,97],[21,92],[22,88],[16,81],[8,77],
    [15,74],[22,69],[25,66],[25,57],[29,48],[24,52],[22,59],[15,51],[13,43],[20,40],
    [28,35],[32,35],[36,36],[37,27],[41,29],[42,41],[47,39],[52,40],[60,42],[67,41],
  ],
  // Japan
  [[45,142],[43,145],[40,142],[35,140],[33,135],[31,131],[34,130],[36,136],[41,140]],
  // Maritime Southeast Asia
  [[5,95],[1,100],[-5,105],[-4,102],[2,98]],
  [[-6,106],[-7,114],[-8,114],[-7,106]],
  [[6,117],[2,118],[-3,116],[-2,110],[2,109],[5,115]],
  [[18,121],[14,123],[8,126],[7,122],[13,120]],
  // New Guinea & Australia
  [[-1,131],[-4,138],[-9,147],[-9,141],[-4,134]],
  [
    [-12,131],[-12,136],[-15,136],[-16,141],[-11,142],[-17,146],[-23,151],[-28,153],
    [-34,151],[-38,148],[-38,141],[-35,136],[-32,131],[-34,122],[-34,115],[-26,113],
    [-21,116],[-16,123],[-14,129],
  ],
  // New Zealand
  [[-35,173],[-38,178],[-41,175],[-46,167],[-44,168],[-40,173]],
  // Antarctica rim
  [
    [-64,-58],[-70,-62],[-73,-35],[-71,-5],[-70,25],[-68,60],[-67,95],[-66,135],
    [-71,170],[-77,-165],[-74,-120],[-72,-85],[-68,-68],
  ],
];

function ecefToThree(v: Vec3, out: THREE.Vector3): THREE.Vector3 {
  // Right-handed Y-up mapping: ECEF +X (0°E) -> +X, ECEF +Z (North) -> +Y, ECEF +Y (90°E) -> -Z
  return out.set(v.x / R_EARTH_KM, v.z / R_EARTH_KM, -v.y / R_EARTH_KM);
}

function latLonToThree(latDeg: number, lonDeg: number, radiusScale = 1.004): THREE.Vector3 {
  const lat = latDeg * DEG_TO_RAD;
  const lon = lonDeg * DEG_TO_RAD;
  const cosLat = Math.cos(lat);
  return new THREE.Vector3(
    radiusScale * cosLat * Math.cos(lon),
    radiusScale * Math.sin(lat),
    -radiusScale * cosLat * Math.sin(lon),
  );
}

function createProceduralEarthTextures(): {
  albedo: THREE.CanvasTexture;
  roughness: THREE.CanvasTexture;
} {
  const w = 2048;
  const h = 1024;

  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = w;
  colorCanvas.height = h;
  const ctx = colorCanvas.getContext('2d')!;

  // Calibrated deep bathymetric ocean gradient
  const oceanGrad = ctx.createLinearGradient(0, 0, 0, h);
  oceanGrad.addColorStop(0, '#162f49');
  oceanGrad.addColorStop(0.14, '#0d223a');
  oceanGrad.addColorStop(0.5, '#08182b');
  oceanGrad.addColorStop(0.86, '#0d223a');
  oceanGrad.addColorStop(1, '#18324d');
  ctx.fillStyle = oceanGrad;
  ctx.fillRect(0, 0, w, h);

  // Calibrated matte roughness map (ocean ~0.75, land ~0.96) to prevent studio IBL glare on Earth
  const roughCanvas = document.createElement('canvas');
  roughCanvas.width = w;
  roughCanvas.height = h;
  const rctx = roughCanvas.getContext('2d')!;
  rctx.fillStyle = '#c0c0c0';
  rctx.fillRect(0, 0, w, h);

  const lonToX = (lon: number) => ((lon + 180) / 360) * w;
  const latToY = (lat: number) => ((90 - lat) / 180) * h;

  const traceSmoothLoop = (c: CanvasRenderingContext2D, loop: Array<[number, number]>) => {
    const pts = loop.map(([lat, lon]) => [lonToX(lon), latToY(lat)] as const);
    if (pts.length < 3) return;
    c.beginPath();
    const last = pts[pts.length - 1];
    const first = pts[0];
    c.moveTo((last[0] + first[0]) * 0.5, (last[1] + first[1]) * 0.5);
    for (let i = 0; i < pts.length; i++) {
      const curr = pts[i];
      const next = pts[(i + 1) % pts.length];
      if (Math.abs(next[0] - curr[0]) > w * 0.5) {
        c.lineTo(curr[0], curr[1]);
      } else {
        c.quadraticCurveTo(curr[0], curr[1], (curr[0] + next[0]) * 0.5, (curr[1] + next[1]) * 0.5);
      }
    }
    c.closePath();
  };

  // Subtle continental shelf halo
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(34, 102, 148, 0.25)';
  ctx.lineWidth = 10;
  for (const loop of CONTINENT_LOOPS) {
    traceSmoothLoop(ctx, loop);
    ctx.stroke();
  }
  ctx.restore();

  // Landmass polygons with crisp, understated aerospace cartography styling
  const landGrad = ctx.createLinearGradient(0, 0, 0, h);
  landGrad.addColorStop(0, '#2c4660');
  landGrad.addColorStop(0.24, '#1f3850');
  landGrad.addColorStop(0.5, '#1b3348');
  landGrad.addColorStop(0.76, '#1f3850');
  landGrad.addColorStop(1, '#314c66');

  ctx.fillStyle = landGrad;
  ctx.strokeStyle = 'rgba(100, 170, 210, 0.62)';
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  rctx.fillStyle = '#f5f5f5';

  for (const loop of CONTINENT_LOOPS) {
    traceSmoothLoop(ctx, loop);
    ctx.fill();
    ctx.stroke();

    traceSmoothLoop(rctx, loop);
    rctx.fill();
  }

  // Scientific lat/lon graticule (30 deg spacing)
  ctx.lineWidth = 1.0;
  for (let lon = -180; lon <= 180; lon += 30) {
    const x = lonToX(lon);
    ctx.strokeStyle = lon === 0 ? 'rgba(56, 189, 248, 0.16)' : 'rgba(148, 163, 184, 0.11)';
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const y = latToY(lat);
    ctx.strokeStyle = lat === 0 ? 'rgba(6, 182, 212, 0.26)' : 'rgba(148, 163, 184, 0.11)';
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  const albedo = new THREE.CanvasTexture(colorCanvas);
  albedo.colorSpace = THREE.SRGBColorSpace;
  albedo.wrapS = THREE.RepeatWrapping;
  albedo.wrapT = THREE.ClampToEdgeWrapping;
  albedo.needsUpdate = true;

  const roughness = new THREE.CanvasTexture(roughCanvas);
  roughness.wrapS = THREE.RepeatWrapping;
  roughness.wrapT = THREE.ClampToEdgeWrapping;
  roughness.needsUpdate = true;

  return { albedo, roughness };
}

/**
 * Composite 5-part procedural LEO Earth-Observation spacecraft mesh (never a single primitive).
 */
function buildCompositeSatelliteGroup(accentHex: number): THREE.Group {
  const group = new THREE.Group();

  // 1. Primary silhouette: octagonal metallic bus
  const busGeo = new THREE.CylinderGeometry(0.015, 0.017, 0.026, 8);
  const busMat = new THREE.MeshStandardMaterial({
    color: 0xd4af37,
    metalness: 0.78,
    roughness: 0.28,
  });
  const bus = new THREE.Mesh(busGeo, busMat);
  group.add(bus);

  // 2. Secondary read: twin photovoltaic solar wings
  const wingGeo = new THREE.BoxGeometry(0.095, 0.0025, 0.024);
  const wingMat = new THREE.MeshStandardMaterial({
    color: 0x16325b,
    metalness: 0.45,
    roughness: 0.22,
    emissive: new THREE.Color(accentHex),
    emissiveIntensity: 0.14,
  });
  const wings = new THREE.Mesh(wingGeo, wingMat);
  group.add(wings);

  // 3. Accent: optical telescope nadir baffle pointing along -Y
  const baffleGeo = new THREE.CylinderGeometry(0.008, 0.011, 0.016, 12);
  const baffleMat = new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    metalness: 0.2,
    roughness: 0.78,
  });
  const baffle = new THREE.Mesh(baffleGeo, baffleMat);
  baffle.position.y = -0.018;
  group.add(baffle);

  // 4. Accent: high-gain X-band downlink dish
  const dishGeo = new THREE.ConeGeometry(0.009, 0.007, 12, 1, true);
  const dishMat = new THREE.MeshStandardMaterial({
    color: 0xe2e8f0,
    metalness: 0.65,
    roughness: 0.3,
    side: THREE.DoubleSide,
  });
  const dish = new THREE.Mesh(dishGeo, dishMat);
  dish.position.set(0, 0.017, 0);
  dish.rotation.x = Math.PI;
  group.add(dish);

  // 5. Plane-identification beacon ring
  const ringGeo = new THREE.TorusGeometry(0.022, 0.0022, 8, 24);
  const ringMat = new THREE.MeshBasicMaterial({ color: accentHex });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = Math.PI / 2;
  group.add(ring);

  return group;
}

const PLANE_COLORS = [0x06b6d4, 0x38bdf8, 0x10b981, 0xf59e0b, 0x818cf8, 0x2dd4bf, 0xfb7185, 0xa3e635];

export interface GlobeLayerVisibility {
  showOrbits: boolean;
  showFootprints: boolean;
  showAccessLinks: boolean;
  showGroundStations: boolean;
  showTargets: boolean;
}

export interface SciencePointCloudOverlay {
  mode: 'REAL_CATALOG' | 'SYNTHETIC_50K';
  positions: Float32Array;       // length = N * 3 (Three.js Y-up Earth-radii)
  colorCodes: Uint8Array;        // length = N (classification code 0..3 or shell index 0..9)
  controllableMask?: Uint8Array; // optional length = N (1 = controllable synthetic spacecraft)
  selectedPos?: [number, number, number] | null;
  selectedTrack?: number[][] | null;
  maneuverBaselineTrack?: number[][] | null;
  maneuveredTrack?: number[][] | null;
  frameVersion: number;
}

export interface EarthGlobe3DProps {
  bundle: PropagationBundle | null;
  timeIndex: number;
  isPlaying: boolean;
  selectedSatId: string | null;
  layers: GlobeLayerVisibility;
  cameraPreset: 'global' | 'polar' | 'equatorial' | 'follow';
  onSelectSat: (satId: string) => void;
  onTickTime?: () => void;
  scienceOverlay?: SciencePointCloudOverlay | null;
  onSelectCloudIndex?: (index: number) => void;
}

export function EarthGlobe3D({
  bundle,
  timeIndex,
  isPlaying,
  selectedSatId,
  layers,
  cameraPreset,
  onSelectSat,
  scienceOverlay,
  onSelectCloudIndex,
}: EarthGlobe3DProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const onSelectSatRef = useRef(onSelectSat);
  onSelectSatRef.current = onSelectSat;
  const onSelectCloudIndexRef = useRef(onSelectCloudIndex);
  onSelectCloudIndexRef.current = onSelectCloudIndex;

  const stateRef = useRef({
    bundle,
    timeIndex,
    isPlaying,
    selectedSatId,
    layers,
    cameraPreset,
    scienceOverlay,
  });
  stateRef.current = {
    bundle,
    timeIndex,
    isPlaying,
    selectedSatId,
    layers,
    cameraPreset,
    scienceOverlay,
  };

  const sceneApiRef = useRef<{
    rebuildBundle: (b: PropagationBundle) => void;
    updateFrameState: () => void;
    updateScienceOverlay: () => void;
    applyCameraPreset: (preset: EarthGlobe3DProps['cameraPreset']) => void;
    requestRender: () => void;
  } | null>(null);

  // Mount Three.js renderer and scene ONCE
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const isSoftwareGl = (() => {
      try {
        const gl = document.createElement('canvas').getContext('webgl2');
        if (!gl) return true;
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
        const gpu = String(gl.getParameter(param));
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
      } catch {
        return true;
      }
    })();

    const width = Math.max(300, container.clientWidth);
    const height = Math.max(300, container.clientHeight);
    let lastW = width;
    let lastH = height;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05080f);

    const camera = new THREE.PerspectiveCamera(40, width / height, 0.05, 100);
    camera.position.set(2.75, 1.38, 2.75);
    camera.lookAt(0, -0.06, 0);

    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = false;
    renderer.domElement.style.display = 'block';
    container.appendChild(renderer.domElement);

    // Subtle studio environment reflection for metallic spacecraft ONLY (Earth uses envMapIntensity=0.06)
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
    scene.environmentIntensity = 0.65;
    pmrem.dispose();

    // Solar key light (illuminates day hemisphere cleanly without studio softbox artifacts)
    const sunKeyLight = new THREE.DirectionalLight(0xfff5e4, 2.1);
    sunKeyLight.position.set(8.0, 2.6, 5.8);
    scene.add(sunKeyLight);

    const hemiFill = new THREE.HemisphereLight(0x527da8, 0x0a1324, 0.85);
    scene.add(hemiFill);

    const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.45);
    rimLight.position.set(-7.5, -1.8, -5.0);
    scene.add(rimLight);

    // Subtle procedural starfield (single Points draw call)
    const starCount = 900;
    const starPositions = new Float32Array(starCount * 3);
    let seed = 1337;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    for (let i = 0; i < starCount; i++) {
      const u = rand() * 2 - 1;
      const theta = rand() * Math.PI * 2;
      const r = 24 + rand() * 14;
      const s = Math.sqrt(1 - u * u);
      starPositions[i * 3] = r * s * Math.cos(theta);
      starPositions[i * 3 + 1] = r * u;
      starPositions[i * 3 + 2] = r * s * Math.sin(theta);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0xcbd5e1,
      size: 0.045,
      transparent: true,
      opacity: 0.55,
      sizeAttenuation: true,
    });
    scene.add(new THREE.Points(starGeo, starMat));

    // WGS84 Earth sphere (slightly oblate polar scaling 1 - f), matte calibrated so no studio box glare
    const { albedo, roughness } = createProceduralEarthTextures();
    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    albedo.anisotropy = maxAniso;
    roughness.anisotropy = maxAniso;

    const earthGeo = new THREE.SphereGeometry(1, 64, 42);
    const earthMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: albedo,
      roughnessMap: roughness,
      roughness: 0.96,
      metalness: 0.02,
      envMapIntensity: 0.06,
    });
    const earthMesh = new THREE.Mesh(earthGeo, earthMat);
    earthMesh.scale.set(1, 1 - 1 / 298.257223563, 1);
    scene.add(earthMesh);

    // Subtle atmospheric Rayleigh limb shell
    const atmoGeo = new THREE.SphereGeometry(1.024, 48, 32);
    const atmoMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.085,
      side: THREE.BackSide,
      depthWrite: false,
    });
    scene.add(new THREE.Mesh(atmoGeo, atmoMat));

    // Equator reference ring
    const eqPoints: THREE.Vector3[] = [];
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      eqPoints.push(new THREE.Vector3(Math.cos(a) * 1.003, 0, Math.sin(a) * 1.003));
    }
    const eqLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(eqPoints),
      new THREE.LineBasicMaterial({ color: 0x06b6d4, transparent: true, opacity: 0.22 }),
    );
    scene.add(eqLine);

    // Dynamic scenario groups (legacy 24-sat mode + Python scientific cloud mode)
    const orbitLinesGroup = new THREE.Group();
    const satellitesGroup = new THREE.Group();
    const footprintsGroup = new THREE.Group();
    const stationsGroup = new THREE.Group();
    const targetsGroup = new THREE.Group();
    const linksGroup = new THREE.Group();
    const scienceGroup = new THREE.Group();
    scene.add(
      orbitLinesGroup,
      satellitesGroup,
      footprintsGroup,
      stationsGroup,
      targetsGroup,
      linksGroup,
      scienceGroup,
    );

    // Pre-allocated GPU Points cloud for up to 60,000 objects (1 draw call)
    const MAX_CLOUD_POINTS = 60_000;
    const cloudPosBuf = new Float32Array(MAX_CLOUD_POINTS * 3);
    const cloudColBuf = new Float32Array(MAX_CLOUD_POINTS * 3);
    const cloudGeo = new THREE.BufferGeometry();
    cloudGeo.setAttribute('position', new THREE.BufferAttribute(cloudPosBuf, 3));
    cloudGeo.setAttribute('color', new THREE.BufferAttribute(cloudColBuf, 3));
    cloudGeo.setDrawRange(0, 0);
    const cloudMat = new THREE.PointsMaterial({
      size: 0.022,
      vertexColors: true,
      transparent: true,
      opacity: 0.88,
      sizeAttenuation: true,
      depthWrite: false,
    });
    const cloudPoints = new THREE.Points(cloudGeo, cloudMat);
    cloudPoints.frustumCulled = false;
    scienceGroup.add(cloudPoints);

    // Detailed composite spacecraft + orbit polyline + dual maneuver tracks for inspected object
    const inspectedSatMesh = buildCompositeSatelliteGroup(0x22d3ee);
    inspectedSatMesh.visible = false;
    inspectedSatMesh.scale.set(1.7, 1.7, 1.7);
    scienceGroup.add(inspectedSatMesh);

    const selectedTrackGroup = new THREE.Group();
    scienceGroup.add(selectedTrackGroup);
    scienceGroup.visible = false;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, -0.06, 0);
    controls.enableDamping = !isSoftwareGl;
    controls.dampingFactor = 0.07;
    controls.minDistance = 1.55;
    controls.maxDistance = 8.5;
    controls.enablePan = false;

    // Pre-allocated scratch math objects (zero GC in render/update)
    const _vSat = new THREE.Vector3();
    const _vNadir = new THREE.Vector3();
    const _vUp = new THREE.Vector3(0, 1, 0);
    const _quat = new THREE.Quaternion();
    const _mouse = new THREE.Vector2();
    const raycaster = new THREE.Raycaster();

    const satMeshes = new Map<string, THREE.Group>();
    const satPickProxies: THREE.Mesh[] = [];
    const satFootprints = new Map<string, THREE.Mesh>();
    const targetPositions = new Map<string, THREE.Vector3>();
    const stationPositions = new Map<string, THREE.Vector3>();

    // Dynamic access-link LineSegments buffers
    const maxLinks = 256;
    const obsLinkPos = new Float32Array(maxLinks * 6);
    const obsLinkGeo = new THREE.BufferGeometry();
    obsLinkGeo.setAttribute('position', new THREE.BufferAttribute(obsLinkPos, 3));
    obsLinkGeo.setDrawRange(0, 0);
    const obsLinkLines = new THREE.LineSegments(
      obsLinkGeo,
      new THREE.LineBasicMaterial({ color: 0x06b6d4, transparent: true, opacity: 0.78 }),
    );
    obsLinkLines.frustumCulled = false;

    const dlLinkPos = new Float32Array(maxLinks * 6);
    const dlLinkGeo = new THREE.BufferGeometry();
    dlLinkGeo.setAttribute('position', new THREE.BufferAttribute(dlLinkPos, 3));
    dlLinkGeo.setDrawRange(0, 0);
    const dlLinkLines = new THREE.LineSegments(
      dlLinkGeo,
      new THREE.LineBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.9 }),
    );
    dlLinkLines.frustumCulled = false;
    linksGroup.add(obsLinkLines, dlLinkLines);

    // Coalesced on-demand renderer with bounded software-WebGL afterDraw pacing
    let rafId = 0;
    let timerId = 0;
    let disposed = false;
    let renderBusy = false;
    let renderDirty = false;
    let cameraTargetPos: THREE.Vector3 | null = null;

    function afterDraw(cb: () => void) {
      if (disposed) return;
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const sync = typeof gl.fenceSync === 'function' ? gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) : null;
      if (!sync) {
        timerId = window.setTimeout(cb, 70);
        return;
      }
      gl.flush();
      let polls = 0;
      const poll = () => {
        if (disposed) return;
        polls++;
        const st = gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (st === gl.UNSIGNALED && polls < 12) {
          timerId = window.setTimeout(poll, 5);
        } else {
          gl.deleteSync(sync);
          timerId = window.setTimeout(cb, 70);
        }
      };
      timerId = window.setTimeout(poll, 5);
    }

    function requestRender() {
      if (disposed) return;
      if (renderBusy) {
        renderDirty = true;
        return;
      }
      renderBusy = true;
      rafId = requestAnimationFrame(() => {
        if (disposed) return;
        renderDirty = false;

        if (cameraTargetPos) {
          camera.position.lerp(cameraTargetPos, isSoftwareGl ? 1.0 : 0.16);
          if (camera.position.distanceTo(cameraTargetPos) < 0.015) {
            camera.position.copy(cameraTargetPos);
            cameraTargetPos = null;
          } else {
            renderDirty = true;
          }
        }

        controls.update();
        renderer.render(scene, camera);

        const done = () => {
          renderBusy = false;
          if (renderDirty && !disposed) requestRender();
        };
        if (isSoftwareGl) afterDraw(done);
        else done();
      });
    }

    controls.addEventListener('start', () => {
      cameraTargetPos = null;
    });
    controls.addEventListener('change', () => {
      requestRender();
    });

    function clearGroup(grp: THREE.Group) {
      const disposedGeos = new Set<THREE.BufferGeometry>();
      const disposedMats = new Set<THREE.Material>();
      while (grp.children.length > 0) {
        const child = grp.children[0];
        grp.remove(child);
        child.traverse((obj) => {
          const geo = (obj as THREE.Mesh).geometry;
          if (geo && !disposedGeos.has(geo)) {
            disposedGeos.add(geo);
            geo.dispose();
          }
          const m = (obj as THREE.Mesh).material;
          if (Array.isArray(m)) {
            m.forEach((mat) => {
              if (!disposedMats.has(mat)) {
                disposedMats.add(mat);
                mat.dispose();
              }
            });
          } else if (m && !disposedMats.has(m)) {
            disposedMats.add(m);
            m.dispose();
          }
        });
      }
    }

    function rebuildBundle(b: PropagationBundle) {
      clearGroup(orbitLinesGroup);
      clearGroup(satellitesGroup);
      clearGroup(footprintsGroup);
      clearGroup(stationsGroup);
      clearGroup(targetsGroup);
      satMeshes.clear();
      satPickProxies.length = 0;
      satFootprints.clear();
      targetPositions.clear();
      stationPositions.clear();

      // Footprint radius on Earth sphere from off-nadir FOV half-angle
      const hKm = b.scenario.constellation.altitudeKm;
      const fovRad = b.scenario.constellation.fovHalfAngleDeg * DEG_TO_RAD;
      const sinRho = Math.min(0.98, ((R_EARTH_KM + hKm) / R_EARTH_KM) * Math.sin(fovRad));
      const earthCentralAngle = Math.max(0.02, Math.asin(sinRho) - fovRad);
      const footprintRadius = Math.sin(earthCentralAngle);

      const fpGeo = new THREE.RingGeometry(footprintRadius * 0.88, footprintRadius, 28);
      const proxyGeo = new THREE.SphereGeometry(0.065, 8, 8);
      const proxyMat = new THREE.MeshBasicMaterial({ visible: false });

      // Build orbit track lines & composite satellite meshes
      for (const sat of b.satellites) {
        const colorHex = PLANE_COLORS[sat.planeIndex % PLANE_COLORS.length];

        // Orbit track in ECEF (first ~1 full orbital period for crisp visual legibility)
        const periodSteps = Math.min(
          sat.states.length,
          Math.max(24, Math.ceil(b.analytics.orbitalPeriodSec / Math.max(5, b.scenario.sampleStepSec)) + 2),
        );
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i < periodSteps; i++) {
          pts.push(ecefToThree(sat.states[i].ecefPosKm, new THREE.Vector3()));
        }
        const trackGeo = new THREE.BufferGeometry().setFromPoints(pts);
        const trackMat = new THREE.LineBasicMaterial({
          color: colorHex,
          transparent: true,
          opacity: sat.slotIndex === 0 ? 0.36 : 0.14,
        });
        orbitLinesGroup.add(new THREE.Line(trackGeo, trackMat));

        // Composite 5-part satellite group
        const satGroup = buildCompositeSatelliteGroup(colorHex);
        satGroup.userData.satId = sat.satId;
        const proxy = new THREE.Mesh(proxyGeo, proxyMat);
        proxy.userData.satId = sat.satId;
        satGroup.add(proxy);
        satPickProxies.push(proxy);
        satellitesGroup.add(satGroup);
        satMeshes.set(sat.satId, satGroup);

        // Nadir sensor footprint ring on Earth surface
        const fpMat = new THREE.MeshBasicMaterial({
          color: colorHex,
          transparent: true,
          opacity: 0.28,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        const fpMesh = new THREE.Mesh(fpGeo, fpMat);
        footprintsGroup.add(fpMesh);
        satFootprints.set(sat.satId, fpMesh);
      }

      // Ground stations (amber pyramidal antenna beacons)
      const gsGeo = new THREE.ConeGeometry(0.016, 0.036, 4);
      const gsMat = new THREE.MeshStandardMaterial({
        color: 0xf59e0b,
        emissive: 0xd97706,
        emissiveIntensity: 0.45,
        roughness: 0.3,
        metalness: 0.4,
      });
      for (const gs of b.scenario.groundStations) {
        const pos = latLonToThree(gs.latDeg, gs.lonDeg, 1.005);
        stationPositions.set(gs.id, pos);
        const m = new THREE.Mesh(gsGeo, gsMat);
        m.position.copy(pos);
        m.quaternion.setFromUnitVectors(_vUp, pos.clone().normalize());
        stationsGroup.add(m);
      }

      // Observation targets (crisp cyan/rose surface pins)
      const tgtGeo = new THREE.OctahedronGeometry(0.011, 0);
      for (const tgt of b.scenario.targets) {
        const pos = latLonToThree(tgt.latDeg, tgt.lonDeg, 1.005);
        targetPositions.set(tgt.id, pos);
        const color =
          tgt.region === 'Disaster-Cluster'
            ? 0xf43f5e
            : tgt.region === 'High-Latitude'
              ? 0x38bdf8
              : tgt.region === 'Equatorial'
                ? 0x10b981
                : 0x94a3b8;
        const m = new THREE.Mesh(
          tgtGeo,
          new THREE.MeshBasicMaterial({ color }),
        );
        m.position.copy(pos);
        targetsGroup.add(m);
      }

      updateFrameState();
    }

    function updateFrameState() {
      const { bundle: b, timeIndex: tIdx, selectedSatId: selId, layers: vis, scienceOverlay: sci } =
        stateRef.current;
      const inScienceMode = Boolean(sci);
      scienceGroup.visible = inScienceMode;
      stationsGroup.visible = vis.showGroundStations;

      if (inScienceMode) {
        orbitLinesGroup.visible = false;
        satellitesGroup.visible = false;
        footprintsGroup.visible = false;
        linksGroup.visible = false;
        targetsGroup.visible = false;
        requestRender();
        return;
      }

      if (!b) return;
      satellitesGroup.visible = true;
      orbitLinesGroup.visible = vis.showOrbits;
      footprintsGroup.visible = vis.showFootprints;
      linksGroup.visible = vis.showAccessLinks;
      targetsGroup.visible = vis.showTargets;

      const clampedIdx = Math.max(0, Math.min(b.timeStepsSec.length - 1, tIdx));
      const tSec = b.timeStepsSec[clampedIdx];
      const satPosCache = new Map<string, THREE.Vector3>();

      for (const sat of b.satellites) {
        const st = sat.states[clampedIdx];
        const grp = satMeshes.get(sat.satId);
        if (!st || !grp) continue;

        ecefToThree(st.ecefPosKm, _vSat);
        grp.position.copy(_vSat);
        satPosCache.set(sat.satId, _vSat.clone());

        // Orient nadir (-Y) toward Earth center
        _vNadir.copy(_vSat).normalize();
        _quat.setFromUnitVectors(_vUp, _vNadir);
        grp.quaternion.copy(_quat);

        const isSelected = sat.satId === selId;
        const sc = isSelected ? 1.55 : 1.0;
        grp.scale.set(sc, sc, sc);

        // Update surface footprint ring aligned tangent to Earth surface
        const fp = satFootprints.get(sat.satId);
        if (fp) {
          fp.position.copy(_vNadir).multiplyScalar(1.006);
          fp.lookAt(0, 0, 0);
          (fp.material as THREE.MeshBasicMaterial).opacity = isSelected ? 0.72 : 0.24;
        }
      }

      // Update active observation & downlink line-of-sight beams at tSec
      let obsCount = 0;
      for (const w of b.observationWindows) {
        if (obsCount >= maxLinks) break;
        if (tSec >= w.startSec && tSec <= w.endSec) {
          const sp = satPosCache.get(w.satId);
          const tp = targetPositions.get(w.targetId);
          if (sp && tp) {
            const base = obsCount * 6;
            obsLinkPos[base] = sp.x;
            obsLinkPos[base + 1] = sp.y;
            obsLinkPos[base + 2] = sp.z;
            obsLinkPos[base + 3] = tp.x;
            obsLinkPos[base + 4] = tp.y;
            obsLinkPos[base + 5] = tp.z;
            obsCount++;
          }
        }
      }
      obsLinkGeo.attributes.position.needsUpdate = true;
      obsLinkGeo.setDrawRange(0, obsCount * 2);

      let dlCount = 0;
      for (const dl of b.downlinkWindows) {
        if (dlCount >= maxLinks) break;
        if (tSec >= dl.startSec && tSec <= dl.endSec) {
          const sp = satPosCache.get(dl.satId);
          const gp = stationPositions.get(dl.stationId);
          if (sp && gp) {
            const base = dlCount * 6;
            dlLinkPos[base] = sp.x;
            dlLinkPos[base + 1] = sp.y;
            dlLinkPos[base + 2] = sp.z;
            dlLinkPos[base + 3] = gp.x;
            dlLinkPos[base + 4] = gp.y;
            dlLinkPos[base + 5] = gp.z;
            dlCount++;
          }
        }
      }
      dlLinkGeo.attributes.position.needsUpdate = true;
      dlLinkGeo.setDrawRange(0, dlCount * 2);

      requestRender();
    }

    const REAL_CLASS_RGB: Array<[number, number, number]> = [
      [0.09, 0.78, 0.92], // 0: PAYLOAD (cyan)
      [0.96, 0.62, 0.05], // 1: ROCKET_BODY (amber)
      [0.96, 0.25, 0.37], // 2: DEBRIS (rose)
      [0.58, 0.64, 0.72], // 3: UNKNOWN (slate)
    ];
    const SHELL_RGB: Array<[number, number, number]> = [
      [0.06, 0.78, 0.92],
      [0.22, 0.74, 0.97],
      [0.10, 0.73, 0.51],
      [0.51, 0.55, 0.97],
      [0.18, 0.83, 0.75],
      [0.96, 0.62, 0.05],
      [0.64, 0.90, 0.21],
      [0.98, 0.44, 0.52],
      [0.75, 0.52, 0.99],
      [0.89, 0.91, 0.94],
    ];

    function updateScienceOverlay() {
      const sci = stateRef.current.scienceOverlay;
      if (!sci) {
        scienceGroup.visible = false;
        updateFrameState();
        return;
      }

      scienceGroup.visible = true;
      orbitLinesGroup.visible = false;
      satellitesGroup.visible = false;
      footprintsGroup.visible = false;
      linksGroup.visible = false;
      targetsGroup.visible = false;
      stationsGroup.visible = stateRef.current.layers.showGroundStations;

      const count = Math.min(MAX_CLOUD_POINTS, Math.floor(sci.positions.length / 3));
      cloudPosBuf.set(sci.positions.subarray(0, count * 3));

      const palette = sci.mode === 'REAL_CATALOG' ? REAL_CLASS_RGB : SHELL_RGB;
      const ctrlMask = sci.controllableMask;
      for (let i = 0; i < count; i++) {
        const code = sci.colorCodes[i] ?? 0;
        const rgb = palette[code % palette.length];
        const boost = ctrlMask && ctrlMask[i] === 1 ? 1.25 : 0.85;
        cloudColBuf[i * 3] = Math.min(1, rgb[0] * boost);
        cloudColBuf[i * 3 + 1] = Math.min(1, rgb[1] * boost);
        cloudColBuf[i * 3 + 2] = Math.min(1, rgb[2] * boost);
      }

      cloudGeo.attributes.position.needsUpdate = true;
      cloudGeo.attributes.color.needsUpdate = true;
      cloudGeo.setDrawRange(0, count);
      cloudGeo.computeBoundingSphere();

      // Adjust point size smoothly for 50k density vs 16k real catalog
      cloudMat.size = count > 25_000 ? 0.017 : 0.025;

      // Update inspected object composite spacecraft + orbit/maneuver tracks
      clearGroup(selectedTrackGroup);
      if (sci.selectedPos) {
        _vSat.set(sci.selectedPos[0], sci.selectedPos[1], sci.selectedPos[2]);
        inspectedSatMesh.position.copy(_vSat);
        _vNadir.copy(_vSat).normalize();
        _quat.setFromUnitVectors(_vUp, _vNadir);
        inspectedSatMesh.quaternion.copy(_quat);
        inspectedSatMesh.visible = true;
      } else {
        inspectedSatMesh.visible = false;
      }

      const addTrackLine = (ptsArr: number[][] | null | undefined, colorHex: number, opacity: number) => {
        if (!ptsArr || ptsArr.length < 2) return;
        const pts = ptsArr.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineBasicMaterial({ color: colorHex, transparent: true, opacity });
        selectedTrackGroup.add(new THREE.Line(geo, mat));
      };

      if (sci.maneuverBaselineTrack && sci.maneuveredTrack) {
        addTrackLine(sci.maneuverBaselineTrack, 0x94a3b8, 0.55);
        addTrackLine(sci.maneuveredTrack, 0xf59e0b, 0.95);
      } else if (sci.selectedTrack && stateRef.current.layers.showOrbits) {
        addTrackLine(sci.selectedTrack, 0x22d3ee, 0.85);
      }

      requestRender();
    }

    function applyCameraPreset(preset: EarthGlobe3DProps['cameraPreset']) {
      if (preset === 'global') {
        cameraTargetPos = new THREE.Vector3(2.75, 1.38, 2.75);
      } else if (preset === 'polar') {
        cameraTargetPos = new THREE.Vector3(0.14, 3.65, 0.45);
      } else if (preset === 'equatorial') {
        cameraTargetPos = new THREE.Vector3(3.75, 0.22, 0.38);
      } else if (preset === 'follow') {
        if (stateRef.current.scienceOverlay?.selectedPos) {
          const sp = stateRef.current.scienceOverlay.selectedPos;
          cameraTargetPos = new THREE.Vector3(sp[0], sp[1], sp[2]).normalize().multiplyScalar(2.75);
        } else if (stateRef.current.selectedSatId) {
          const grp = satMeshes.get(stateRef.current.selectedSatId);
          if (grp) {
            cameraTargetPos = grp.position.clone().normalize().multiplyScalar(2.75);
          }
        }
      }
      requestRender();
    }

    // Click raycasting on satellite proxies (legacy) or GPU point cloud (REAL_CATALOG / SYNTHETIC_50K)
    const onPointerClick = (ev: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      _mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      _mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(_mouse, camera);

      if (stateRef.current.scienceOverlay && onSelectCloudIndexRef.current) {
        raycaster.params.Points.threshold = 0.045;
        const hits = raycaster.intersectObject(cloudPoints, false);
        if (hits.length > 0 && typeof hits[0].index === 'number') {
          onSelectCloudIndexRef.current(hits[0].index);
        }
        return;
      }

      const hits = raycaster.intersectObjects(satPickProxies, false);
      if (hits.length > 0 && hits[0].object.userData.satId) {
        onSelectSatRef.current(String(hits[0].object.userData.satId));
      }
    };
    renderer.domElement.addEventListener('click', onPointerClick);

    const onResize = () => {
      if (!container || disposed) return;
      const w = Math.max(300, container.clientWidth);
      const h = Math.max(300, container.clientHeight);
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      controls.update();
      renderer.render(scene, camera);
      requestRender();
    };
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(container);

    const onContextLost = (e: Event) => {
      e.preventDefault();
    };
    renderer.domElement.addEventListener('webglcontextlost', onContextLost);

    sceneApiRef.current = {
      rebuildBundle,
      updateFrameState,
      updateScienceOverlay,
      applyCameraPreset,
      requestRender,
    };

    if (stateRef.current.bundle) {
      rebuildBundle(stateRef.current.bundle);
    }
    if (stateRef.current.scienceOverlay) {
      updateScienceOverlay();
    } else if (!stateRef.current.bundle) {
      requestRender();
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      clearTimeout(timerId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('click', onPointerClick);
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
      controls.dispose();
      cloudGeo.dispose();
      cloudMat.dispose();
      clearGroup(selectedTrackGroup);
      envTex.dispose();
      albedo.dispose();
      roughness.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
      sceneApiRef.current = null;
    };
  }, []);

  // Rebuild geometry when scenarioHash changes
  useEffect(() => {
    if (bundle && sceneApiRef.current) {
      sceneApiRef.current.rebuildBundle(bundle);
    }
  }, [bundle?.scenarioHash]);

  // Update positions, links, and visibility on time/layer/selection changes
  useEffect(() => {
    if (sceneApiRef.current) {
      sceneApiRef.current.updateFrameState();
    }
  }, [timeIndex, selectedSatId, layers, bundle]);

  // Update Python scientific point cloud overlay
  useEffect(() => {
    if (sceneApiRef.current) {
      sceneApiRef.current.updateScienceOverlay();
    }
  }, [scienceOverlay, layers]);

  // Camera preset transitions
  useEffect(() => {
    if (sceneApiRef.current) {
      sceneApiRef.current.applyCameraPreset(cameraPreset);
    }
  }, [cameraPreset]);

  return (
    <div
      ref={mountRef}
      data-testid="earth-globe-canvas-container"
      className="w-full h-full relative select-none cursor-grab active:cursor-grabbing"
    />
  );
}
