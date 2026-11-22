// Main thread: renders the level and agents with deck.gl on top of the street
// map, handles input and UI.
// All game logic runs in the worker (WASM sim-core).
import { COORDINATE_SYSTEM } from "@deck.gl/core";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { BitmapLayer, LineLayer, PathLayer, PolygonLayer, ScatterplotLayer, SolidPolygonLayer } from "@deck.gl/layers";
import parisUrl from "../../levels/paris-marais.json?url";
import suburbUrl from "../../levels/suburb.json?url";
import { Place, createExplore } from "./explore";
import { generateLevel } from "./levelgen";
import {
  FromWorker,
  H_INTERVAL,
  H_LATEST,
  H_SEQ,
  H_TIME,
  Placement,
  SLOTS,
  StaticLevel,
  Stats,
  ToWorker,
  headerViews,
  nowAbs,
  slotViews,
} from "./protocol";
import "./style.css";

// Built-in levels (committed level packs, no download needed).
const PRESETS: Place[] = [
  { name: "Paris — Le Marais", lat: 48.858, lon: 2.358, presetUrl: parisUrl },
  { name: "Le Vésinet (suburb)", lat: 48.8935, lon: 2.133, presetUrl: suburbUrl },
];

// Agent colours (RGBA) indexed by render state: civilian, infected, zombie,
// corpse, hidden, fresh kill (flashes for kill_flash_seconds, then corpse).
const COLORS: [number, number, number, number][] = [
  [0x4a, 0xa3, 0xff, 255],
  [0xff, 0xd2, 0x3f, 255],
  [0xff, 0x3b, 0x3b, 255],
  [0x9b, 0x6b, 0xe0, 255],
  [0, 0, 0, 0],
  [0xf3, 0xe8, 0xff, 255],
];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------- state
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
const send = (m: ToWorker) => worker.postMessage(m);

let level: StaticLevel | null = null;
let currentPlace: Place | null = null;
let currentLevelJson = "";
const levelCache = new Map<string, string>();
let prepAbort: AbortController | null = null;
let shared: SharedArrayBuffer | null = null;
let n = 0;
let stats: Stats | null = null;
let history: Placement[] = [];
type F32 = Float32Array<ArrayBufferLike>;
type U8 = Uint8Array<ArrayBufferLike>;
let towers: F32 = new Float32Array(0);
let fences: F32 = new Float32Array(0);
let buildings: { polygon: number[][]; index: number }[] = [];
let tool: "pan" | "tower" | "fence" = "pan";
let fenceDraft: number[][] | null = null;
let fieldKind: "none" | "chase" | "flee" = "none";
let fieldImage: HTMLCanvasElement | null = null;
let showHash = false;
let autoStartAfterReady = false;
let fitted = false;

// Interpolation buffers (alternated so deck.gl sees a new array each frame).
let posBufs: F32[] = [new Float32Array(0), new Float32Array(0)];
let colBufs: U8[] = [new Uint8Array(0), new Uint8Array(0)];
let posFlip = 0;
let colFlip = 0;
let lastSeq = -1;
// Fallback (no SharedArrayBuffer): the last two frames from the worker.
let fbPrev: { pos: F32; render: U8; time: number } | null = null;
let fbCur: { pos: F32; render: U8; time: number } | null = null;
let fbSeq = 0;

// ---------------------------------------------------------------- map + deck overlay
// The street map from the map screen stays on screen; deck.gl draws the game
// on top of it. The sim works in local meters (grid origin at a corner), the
// level pack in meters around (lat0, lon0) with an equirectangular projection.
// Layers keep their data in sim meters and a model matrix turns them into
// lng/lat offsets from (lon0, lat0), the exact inverse of that projection, so
// footprints land on the map's buildings.
const explore = createExplore({ presets: PRESETS, onStart: enterGame });
const map = explore.map;
const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
map.addControl(overlay);

let geo: { lat0: number; lon0: number; kx: number; ky: number } | null = null;
let geoProps: Record<string, unknown> = {};

function setGeo(lat0: number, lon0: number) {
  geo = { lat0, lon0, kx: Math.cos((lat0 * Math.PI) / 180) * 111320, ky: 110540 };
}

function updateGeoProps() {
  if (!geo || !level) return;
  const sx = 1 / geo.kx;
  const sy = 1 / geo.ky;
  const [cx, cy] = level.center;
  geoProps = {
    coordinateSystem: COORDINATE_SYSTEM.LNGLAT_OFFSETS,
    coordinateOrigin: [geo.lon0, geo.lat0, 0],
    // column-major: translate by -center (sim → pack meters), then meters → degrees
    modelMatrix: [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, 1, 0, -cx * sx, -cy * sy, 0, 1],
  };
}

function toSim(ll: { lng: number; lat: number }): number[] | null {
  if (!geo || !level) return null;
  return [(ll.lng - geo.lon0) * geo.kx + level.center[0], (ll.lat - geo.lat0) * geo.ky + level.center[1]];
}

function fitView(animate = true) {
  if (!geo) return;
  const r = level?.radius ?? 400;
  const dlon = r / geo.kx;
  const dlat = r / geo.ky;
  map.fitBounds(
    [
      [geo.lon0 - dlon, geo.lat0 - dlat],
      [geo.lon0 + dlon, geo.lat0 + dlat],
    ],
    { padding: { top: 68, bottom: 16, left: 228, right: 264 }, duration: animate ? 1200 : 0 },
  );
}

function toLngLat(x: number, y: number): { lng: number; lat: number } | null {
  if (!geo || !level) return null;
  return { lng: geo.lon0 + (x - level.center[0]) / geo.kx, lat: geo.lat0 + (y - level.center[1]) / geo.ky };
}

// Test hook (`?test=1`): loaded on demand so the normal page never runs it.
// See testhook.ts for the `window.__zt` API.
const TEST_MODE = new URLSearchParams(location.search).get("test") === "1";
let testTap: ((m: FromWorker) => boolean) | null = null;
if (TEST_MODE) {
  void import("./testhook").then(({ installTestHook }) => {
    testTap = installTestHook({
      send,
      map,
      overlay,
      presets: PRESETS.map((p) => p.name),
      screen: () => document.body.dataset.screen ?? "",
      stats: () => stats,
      level: () => level,
      placeName: () => currentPlace?.name ?? null,
      history: () => history,
      buildings: () => buildings,
      resultVisible: () => !$("result").hidden,
      toSim,
      toLngLat,
      enterPreset: (i) => enterGame(PRESETS[i]),
      setup: (population, seed) => {
        ($("pop") as HTMLInputElement).value = String(population);
        ($("seed") as HTMLInputElement).value = String(seed);
        popLabel();
        reset();
      },
      reset: () => reset(),
      replay: () => $("replay").click(),
    });
  });
} else if (import.meta.env.DEV) {
  (window as unknown as { __zt: unknown }).__zt = { map, overlay, toSim, get level() { return level; }, get buildings() { return buildings; } };
}

const inGame = () => document.body.dataset.screen === "game";

map.on("click", (e) => {
  if (!inGame() || tool !== "tower" || stats?.phase !== 0) return;
  const p = toSim(e.lngLat);
  if (p) send({ type: "tower", x: p[0], y: p[1] });
});

// Fence drawing: click-drag while the Fence tool is active (map panning is
// disabled meanwhile, see setTool).
map.on("mousedown", (e) => {
  if (!inGame() || tool !== "fence" || stats?.phase !== 0 || e.originalEvent.button !== 0) return;
  const p = toSim(e.lngLat);
  if (!p) return;
  fenceDraft = [p];
  updateFenceHint();
});
map.on("mousemove", (e) => {
  if (!fenceDraft) return;
  const p = toSim(e.lngLat);
  if (!p) return;
  const last = fenceDraft[fenceDraft.length - 1];
  if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 2) fenceDraft.push(p);
  updateFenceHint();
});
window.addEventListener("mouseup", () => {
  if (!fenceDraft) return;
  if (fenceDraft.length >= 2) send({ type: "fence", pts: fenceDraft.flat() });
  fenceDraft = null;
  updateFenceHint();
});

function draftLength(): number {
  if (!fenceDraft) return 0;
  let l = 0;
  for (let i = 1; i < fenceDraft.length; i++) l += Math.hypot(fenceDraft[i][0] - fenceDraft[i - 1][0], fenceDraft[i][1] - fenceDraft[i - 1][1]);
  return l;
}

function updateFenceHint() {
  const h = $("hint");
  if (fenceDraft) {
    const l = draftLength();
    const left = stats?.fenceLeft ?? 0;
    h.textContent = `Fence ${l.toFixed(0)} m / ${left.toFixed(0)} m left`;
    h.classList.toggle("over", l > left);
  } else {
    h.textContent = tool === "tower" ? "Click a building to garrison it" : tool === "fence" ? "Drag on open ground to draw a fence" : "";
    h.classList.remove("over");
  }
}

// ---------------------------------------------------------------- frame
function fenceColor(hp: number): [number, number, number, number] {
  // Intact fences are near-black (readable on the light map), red when nearly broken.
  const t = Math.max(0, Math.min(1, hp));
  return [Math.round(230 - 190 * t), Math.round(40 + 0 * t), Math.round(40 + 12 * t), 255];
}

function buildFieldImage(data: Int32Array, w: number, h: number): HTMLCanvasElement {
  const INF = Math.floor((2 ** 31 - 1) / 4); // sim-core field::INF = i32::MAX / 4
  const vals: number[] = [];
  for (let i = 0; i < data.length; i += 7) if (data[i] < INF) vals.push(data[i]);
  vals.sort((a, b) => a - b);
  const lo = vals[0] ?? 0;
  const hi = vals[Math.floor(vals.length * 0.98)] ?? 1;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x];
      const o = ((h - 1 - y) * w + x) * 4; // canvas row 0 = top = highest y
      if (v >= INF) continue;
      const t = Math.max(0, Math.min(1, (v - lo) / Math.max(1, hi - lo)));
      // Single-hue sequential ramp: near = dark violet, far = light.
      img.data[o] = 40 + 200 * t;
      img.data[o + 1] = 20 + 180 * t;
      img.data[o + 2] = 120 + 120 * t;
      img.data[o + 3] = 150;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

let frames = 0;
let fps = 0;
let fpsT = performance.now();

function frame() {
  requestAnimationFrame(frame);
  frames++;
  const now = performance.now();
  if (now - fpsT >= 1000) {
    fps = (frames * 1000) / (now - fpsT);
    frames = 0;
    fpsT = now;
    updateHud();
  }
  if (!level || n === 0) return;

  // Pick the two latest snapshots and the interpolation factor.
  let prev: F32, cur: F32, render: U8, seq: number, alpha: number;
  if (shared) {
    const h = headerViews(shared);
    const latest = Atomics.load(h.i32, H_LATEST);
    seq = Atomics.load(h.i32, H_SEQ);
    const a = slotViews(shared, n, (latest + SLOTS - 1) % SLOTS);
    const b = slotViews(shared, n, latest);
    prev = a.pos;
    cur = b.pos;
    render = b.render;
    alpha = (nowAbs() - h.f64[H_TIME]) / Math.max(1, h.f64[H_INTERVAL]);
  } else {
    if (!fbCur) return;
    prev = (fbPrev ?? fbCur).pos;
    cur = fbCur.pos;
    render = fbCur.render;
    seq = fbSeq;
    const interval = fbPrev ? Math.max(1, fbCur.time - fbPrev.time) : 50;
    alpha = (nowAbs() - fbCur.time) / interval;
  }
  if (stats && (stats.paused || stats.phase >= 2)) alpha = 1;
  alpha = Math.max(0, Math.min(1, alpha));

  posFlip ^= 1;
  const pos = posBufs[posFlip];
  for (let i = 0; i < n * 2; i++) pos[i] = prev[i] + (cur[i] - prev[i]) * alpha;

  if (seq !== lastSeq) {
    lastSeq = seq;
    colFlip ^= 1;
    const col = colBufs[colFlip];
    for (let i = 0; i < n; i++) {
      const c = COLORS[render[i]] ?? COLORS[4];
      const o = i * 4;
      col[o] = c[0];
      col[o + 1] = c[1];
      col[o + 2] = c[2];
      col[o + 3] = c[3];
    }
  }
  render_layers(pos, colBufs[colFlip]);
}

// Layer data derived from placements, rebuilt only when the arrays change so
// deck.gl doesn't re-process unchanged layers every frame.
let pdCache: { t: F32 | null; f: F32 | null; garrisonData: typeof buildings; towerData: { x: number; y: number }[]; fenceData: { x: number; y: number; hp: number }[] } = {
  t: null,
  f: null,
  garrisonData: [],
  towerData: [],
  fenceData: [],
};
function placementData() {
  if (pdCache.t !== towers) {
    const garrisoned = new Set<number>();
    const towerData: { x: number; y: number }[] = [];
    for (let i = 0; i < towers.length; i += 5) {
      garrisoned.add(towers[i]);
      towerData.push({ x: towers[i + 1], y: towers[i + 2] });
    }
    pdCache.t = towers;
    pdCache.towerData = towerData;
    pdCache.garrisonData = buildings.filter((b) => garrisoned.has(b.index));
  }
  if (pdCache.f !== fences) {
    const fenceData: { x: number; y: number; hp: number }[] = [];
    for (let i = 0; i < fences.length; i += 3) fenceData.push({ x: fences[i], y: fences[i + 1], hp: fences[i + 2] });
    pdCache.f = fences;
    pdCache.fenceData = fenceData;
  }
  return pdCache;
}

// One stable data object for the agent layer: replacing `data` every frame
// would make deck.gl rebuild every attribute (including 100k picking colours).
// Only the external buffers inside it change; updateTriggers re-read just
// those two attributes.
let agentDataObj: { length: number; attributes: Record<string, unknown> } | null = null;
let frameId = 0;
function agentData(pos: F32, col: U8) {
  if (!agentDataObj || agentDataObj.length !== n) agentDataObj = { length: n, attributes: {} };
  agentDataObj.attributes.getPosition = { value: pos, size: 2 };
  agentDataObj.attributes.getFillColor = { value: col, size: 4, normalized: true };
  frameId++;
  return agentDataObj;
}

// Darkens everything outside the play area: a big square with the circle as a hole.
let maskCache: { key: string; poly: number[][][] } | null = null;
function maskPolygon(): number[][][] {
  if (!level) return [];
  const [cx, cy] = level.center;
  const key = `${cx},${cy},${level.radius}`;
  if (maskCache?.key !== key) {
    const R = 20000;
    const outer = [[cx - R, cy - R], [cx + R, cy - R], [cx + R, cy + R], [cx - R, cy + R]];
    const hole: number[][] = [];
    for (let i = 0; i < 96; i++) {
      const t = (-i / 96) * 2 * Math.PI;
      hole.push([cx + level.radius * Math.cos(t), cy + level.radius * Math.sin(t)]);
    }
    maskCache = { key, poly: [outer, hole] };
  }
  return maskCache.poly;
}

function render_layers(pos: F32, col: U8) {
  if (!level || !geo) return;
  const { garrisonData, towerData, fenceData } = placementData();
  const half = level.cell / 2;
  const g = geoProps;
  const layers: unknown[] = [
    new SolidPolygonLayer({
      ...g,
      id: "outside",
      data: [maskPolygon()],
      getPolygon: (d: number[][][]) => d as never,
      getFillColor: [16, 18, 22, 150],
    }),
    fieldImage &&
      new BitmapLayer({
        ...g,
        id: "field",
        image: fieldImage,
        bounds: [0, 0, level.gridW * level.cell, level.gridH * level.cell],
        opacity: 0.75,
        textureParameters: { minFilter: "nearest", magFilter: "nearest" },
      }),
    new PolygonLayer({
      ...g,
      id: "buildings",
      data: buildings,
      getPolygon: (d: { polygon: number[][] }) => d.polygon,
      getFillColor: [70, 62, 56, 40],
      getLineColor: [70, 62, 56, 90],
      lineWidthMinPixels: 0.5,
      stroked: true,
    }),
    new PolygonLayer({
      ...g,
      id: "garrisons",
      data: garrisonData,
      getPolygon: (d: { polygon: number[][] }) => d.polygon,
      filled: true,
      stroked: true,
      getFillColor: [30, 170, 90, 110],
      getLineColor: [20, 140, 70, 255],
      lineWidthMinPixels: 2,
    }),
    new ScatterplotLayer({
      ...g,
      id: "ranges",
      data: towerData,
      getPosition: (d: { x: number; y: number }) => [d.x, d.y],
      getRadius: level.towerRange,
      radiusUnits: "meters",
      stroked: true,
      getFillColor: [30, 170, 90, 28],
      getLineColor: [20, 140, 70, 160],
      lineWidthMinPixels: 1.5,
    }),
    showHash && hashLayer(),
    new SolidPolygonLayer({
      ...g,
      id: "fences",
      data: fenceData,
      getPolygon: (d: { x: number; y: number }) => [
        [d.x - half, d.y - half],
        [d.x + half, d.y - half],
        [d.x + half, d.y + half],
        [d.x - half, d.y + half],
      ],
      getFillColor: (d: { hp: number }) => fenceColor(d.hp),
    }),
    new ScatterplotLayer({
      ...g,
      id: "agents",
      data: agentData(pos, col) as never,
      updateTriggers: { getPosition: frameId, getFillColor: lastSeq },
      radiusUnits: "meters",
      getRadius: 0.8,
      radiusMinPixels: 1.8,
      // A dark rim keeps the dots readable on the light street map.
      stroked: true,
      getLineColor: [20, 20, 24, 170],
      lineWidthUnits: "pixels",
      getLineWidth: 0.6,
      parameters: { depthCompare: "always" },
    }),
    fenceDraft &&
      new PathLayer({
        ...g,
        id: "draft",
        data: [fenceDraft],
        getPath: (d: number[][]) => d as [number, number][],
        getColor: draftLength() > (stats?.fenceLeft ?? 0) ? [230, 40, 40, 255] : [40, 40, 48, 230],
        getWidth: level.cell,
        widthUnits: "meters",
        widthMinPixels: 2,
      }),
  ].filter(Boolean);
  overlay.setProps({ layers: layers as never });
}

let hashLines: { s: number[]; t: number[] }[] = [];
function hashLayer() {
  if (!level) return null;
  if (hashLines.length === 0) {
    const [hw, hh, b] = level.hashDims;
    for (let x = 0; x <= hw; x++) hashLines.push({ s: [x * b, 0], t: [x * b, hh * b] });
    for (let y = 0; y <= hh; y++) hashLines.push({ s: [0, y * b], t: [hw * b, y * b] });
  }
  return new LineLayer({
    ...geoProps,
    id: "hash",
    data: hashLines,
    getSourcePosition: (d: { s: number[] }) => d.s as [number, number],
    getTargetPosition: (d: { t: number[] }) => d.t as [number, number],
    getColor: [0, 0, 0, 40],
    getWidth: 1,
  });
}

// ---------------------------------------------------------------- worker messages
worker.onmessage = (ev: MessageEvent<FromWorker>) => {
  const m = ev.data;
  if (testTap?.(m)) return;
  if (document.body.dataset.screen !== "game") return; // late messages after "← Map"
  switch (m.type) {
    case "ready": {
      level = m.level;
      shared = m.shared;
      n = level.count;
      posBufs = [new Float32Array(n * 2), new Float32Array(n * 2)];
      colBufs = [new Uint8Array(n * 4), new Uint8Array(n * 4)];
      lastSeq = -1;
      fbPrev = fbCur = null;
      hashLines = [];
      fieldImage = null;
      buildings = [];
      pdCache = { t: null, f: null, garrisonData: [], towerData: [], fenceData: [] };
      const o = level.buildingOffsets;
      const c = level.buildingCoords;
      for (let b = 0; b + 1 < o.length; b++) {
        const poly: number[][] = [];
        for (let k = o[b]; k < o[b + 1]; k++) poly.push([c[2 * k], c[2 * k + 1]]);
        buildings.push({ polygon: poly, index: b });
      }
      $("fallback").hidden = !!shared;
      $("result").hidden = true;
      maskCache = null;
      updateGeoProps();
      if (!fitted) {
        fitView();
        fitted = true;
      }
      $("loading").hidden = true;
      if (autoStartAfterReady) {
        autoStartAfterReady = false;
        send({ type: "start" });
      }
      break;
    }
    case "frame":
      fbPrev = fbCur;
      fbCur = { pos: m.pos, render: m.render, time: m.time };
      fbSeq++;
      break;
    case "stats": {
      const was = stats?.phase;
      stats = m.stats;
      if (was !== undefined && was < 2 && stats.phase >= 2) showResult();
      updateControls();
      break;
    }
    case "placements":
      towers = m.towers;
      fences = m.fences;
      history = m.history;
      updateControls();
      break;
    case "fences":
      fences = m.fences;
      break;
    case "error":
      if (m.fatal) prepError(m.message);
      else toast(m.message);
      break;
    case "field":
      fieldImage = buildFieldImage(m.data, m.w, m.h);
      break;
  }
};

// ---------------------------------------------------------------- UI
function toast(msg: string) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout((t as unknown as { _h: number })._h);
  (t as unknown as { _h: number })._h = window.setTimeout(() => (t.hidden = true), 2600);
}

function settings() {
  return {
    population: Number(($("pop") as HTMLInputElement).value),
    seed: Math.max(0, Math.floor(Number(($("seed") as HTMLInputElement).value) || 0)),
  };
}

function reset(replay?: Placement[]) {
  if (!currentLevelJson) return;
  const s = settings();
  prepStatus(`Spawning ${s.population.toLocaleString()} civilians…`);
  stats = null;
  towers = new Float32Array(0);
  fences = new Float32Array(0);
  history = [];
  updateControls();
  send({ type: "init", levelJson: currentLevelJson, population: s.population, seed: s.seed, replay });
}

// ---------------------------------------------------------------- screens
function prepStatus(msg: string) {
  $("loading").hidden = false;
  $("prep-spin").hidden = false;
  $("prep-actions").hidden = true;
  $("prep-msg").textContent = msg;
}

function prepError(msg: string) {
  $("loading").hidden = false;
  $("prep-spin").hidden = true;
  $("prep-actions").hidden = false;
  $("prep-msg").textContent = msg;
}

const placeKey = (p: Place) => p.presetUrl ?? `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;

async function enterGame(place: Place) {
  document.body.dataset.screen = "game";
  explore.setActive(false);
  overlay.setProps({ layers: [] });
  setGeo(place.lat, place.lon);
  fitView(); // fly to the spot while the buildings download
  currentPlace = place;
  $("place").textContent = place.name;
  $("place").title = place.name;
  $("result").hidden = true;
  level = null;
  n = 0;
  stats = null;
  updateControls();
  prepAbort?.abort();
  const abort = new AbortController();
  prepAbort = abort;
  try {
    let json = levelCache.get(placeKey(place));
    if (!json) {
      if (place.presetUrl) {
        prepStatus("Loading level…");
        json = await (await fetch(place.presetUrl, { signal: abort.signal })).text();
      } else {
        const pack = await generateLevel(place.name, place.lat, place.lon, prepStatus, abort.signal);
        json = JSON.stringify(pack);
      }
      levelCache.set(placeKey(place), json);
    }
    if (abort.signal.aborted) return;
    const meta = JSON.parse(json) as { radius_m: number; center_lat: number; center_lon: number; buildings: unknown[] };
    const radius = meta.radius_m;
    const count = meta.buildings.length;
    setGeo(meta.center_lat, meta.center_lon);
    $("place").title = `${place.name} · ${count} buildings · radius ${radius} m`;
    currentLevelJson = json;
    fitted = false;
    reset();
  } catch (e) {
    if (abort.signal.aborted) return;
    prepError(e instanceof Error ? e.message : String(e));
  }
}

function backToMap() {
  prepAbort?.abort();
  send({ type: "stop" });
  level = null;
  n = 0;
  stats = null;
  currentLevelJson = "";
  $("result").hidden = true;
  setTool("pan");
  document.body.dataset.screen = "explore";
  overlay.setProps({ layers: [] });
  explore.setActive(true);
}

function setTool(t: typeof tool) {
  tool = t;
  for (const id of ["tool-pan", "tool-tower", "tool-fence"]) $(id).classList.toggle("on", id === `tool-${t}`);
  if (t === "fence") map.dragPan.disable();
  else map.dragPan.enable();
  map.getCanvas().style.cursor = t === "fence" ? "crosshair" : t === "tower" ? "pointer" : "";
  updateFenceHint();
}

function fmtTime(ticks: number) {
  const s = Math.floor(ticks / 20);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function updateControls() {
  const setup = stats?.phase === 0;
  const running = stats?.phase === 1;
  for (const id of ["tool-tower", "tool-fence", "undo", "clear"]) ($(id) as HTMLButtonElement).disabled = !setup;
  ($("undo") as HTMLButtonElement).disabled = !setup || history.length === 0;
  ($("clear") as HTMLButtonElement).disabled = !setup || history.length === 0;
  ($("start") as HTMLButtonElement).disabled = !setup;
  ($("pause") as HTMLButtonElement).disabled = !running;
  $("pause").textContent = stats?.paused ? "Resume" : "Pause";
  for (const s of [1, 2, 4]) $(`speed-${s}`).classList.toggle("on", stats?.speed === s);
  $("towers-left").textContent = String(stats?.towersLeft ?? "–");
  $("fence-left").textContent = stats ? `${stats.fenceLeft.toFixed(0)} m` : "–";
  if (!setup && tool !== "pan") setTool("pan");
  $("phase").textContent = !stats ? "Loading" : stats.phase === 0 ? "Setup" : stats.phase === 1 ? (stats.paused ? "Paused" : "Outbreak") : "Over";
  $("phase").dataset.phase = String(stats?.phase ?? -1);
}

function updateHud() {
  const s = stats;
  if (!s) return;
  const set = (id: string, v: string) => ($(id).textContent = v);
  set("h-time", fmtTime(s.phase === 0 ? 0 : s.tick));
  set("h-civ", s.civilians.toLocaleString());
  set("h-inf", s.infected.toLocaleString());
  set("h-zom", s.zombies.toLocaleString());
  set("h-dead", s.dead.toLocaleString());
  set("h-surv", s.initial ? `${((100 * s.civilians) / s.initial).toFixed(1)}%` : "–");
  set("h-sim", `${s.simMsLast.toFixed(1)} / ${s.simMsP95.toFixed(1)} ms`);
  set("h-fps", fps.toFixed(0));
  set("h-dorm", s.phase === 1 && s.civilians ? `${((100 * s.dormant) / s.civilians).toFixed(0)}%` : "–");
  if (fieldKind !== "none" && s.phase >= 1) send({ type: "field", kind: fieldKind });
}

function showResult() {
  if (!stats) return;
  const s = stats;
  const label = s.phase === 2 ? "Outbreak contained" : s.phase === 3 ? "Everyone is lost" : "Time's up";
  $("r-title").textContent = label;
  $("r-outcome").textContent = s.phase === 2 ? "Win" : s.phase === 3 ? "Loss" : "Timeout";
  $("r-surv").textContent = s.initial ? `${((100 * s.civilians) / s.initial).toFixed(1)}%` : "–";
  $("r-killed").textContent = s.killed.toLocaleString();
  $("r-time").textContent = fmtTime(s.tick);
  $("result").hidden = false;
}

$("back").addEventListener("click", backToMap);
$("prep-back").addEventListener("click", backToMap);
$("r-map").addEventListener("click", backToMap);
$("prep-retry").addEventListener("click", () => currentPlace && enterGame(currentPlace));
const pop = $("pop") as HTMLInputElement;
const popLabel = () => ($("pop-label").textContent = `${(Number(pop.value) / 1000).toFixed(0)}k`);
pop.addEventListener("input", popLabel);
pop.addEventListener("change", () => reset());
$("seed").addEventListener("change", () => reset());
$("start").addEventListener("click", () => send({ type: "start" }));
$("pause").addEventListener("click", () => send({ type: "pause", paused: !stats?.paused }));
for (const s of [1, 2, 4]) $(`speed-${s}`).addEventListener("click", () => send({ type: "speed", speed: s }));
$("reset").addEventListener("click", () => reset());
$("tool-pan").addEventListener("click", () => setTool("pan"));
$("tool-tower").addEventListener("click", () => setTool("tower"));
$("tool-fence").addEventListener("click", () => setTool("fence"));
$("undo").addEventListener("click", () => send({ type: "undo" }));
$("clear").addEventListener("click", () => send({ type: "clear" }));
$("replay").addEventListener("click", () => {
  autoStartAfterReady = true;
  reset(history);
});
$("r-close").addEventListener("click", () => ($("result").hidden = true));
$("fit").addEventListener("click", () => fitView());
for (const k of ["none", "chase", "flee"] as const) {
  $(`field-${k}`).addEventListener("click", () => {
    fieldKind = k;
    for (const j of ["none", "chase", "flee"]) $(`field-${j}`).classList.toggle("on", j === k);
    fieldImage = null;
    if (k !== "none") send({ type: "field", kind: k });
  });
}
$("hash-toggle").addEventListener("change", (e) => (showHash = (e.target as HTMLInputElement).checked));
window.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).tagName === "INPUT") return;
  if (e.key === "Escape") setTool("pan");
  if ((e.metaKey || e.ctrlKey) && e.key === "z") send({ type: "undo" });
  if (e.key === " " && stats?.phase === 1) {
    e.preventDefault();
    send({ type: "pause", paused: !stats.paused });
  }
});

popLabel();
setTool("pan");
requestAnimationFrame(frame);
