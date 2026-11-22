// Simulation worker: owns the WASM sim, runs it on a fixed 20 Hz accumulator,
// and publishes positions/states to the main thread each tick.
import init, { WasmSim } from "./wasm/pkg/sim_wasm.js";
import configJson from "../../config.default.json?raw";
import {
  FromWorker,
  H_INTERVAL,
  H_LATEST,
  H_SEQ,
  H_TICK,
  H_TIME,
  Placement,
  SLOTS,
  Stats,
  ToWorker,
  headerViews,
  nowAbs,
  sharedBytes,
  slotViews,
} from "./protocol";

const config = JSON.parse(configJson);
const TICK_MS = 1000 / config.tick_hz;

let wasmReady: Promise<unknown> | null = null;
let sim: WasmSim | null = null;
let memory: WebAssembly.Memory | null = null;
let shared: SharedArrayBuffer | null = null;
let n = 0;
let latest = 0;
let lastWrite = 0;
let paused = false;
let speed = 1;
let acc = 0;
let lastTime = 0;
let loopTimer: ReturnType<typeof setTimeout> | null = null;
let history: Placement[] = [];
let tickMs: number[] = [];
let lastFenceSend = 0;
let generation = 0;

const post = (m: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

function sendPlacements() {
  if (!sim) return;
  post({ type: "placements", towers: new Float32Array(sim.towers()), fences: new Float32Array(sim.fences()), history: [...history] });
}

function publish() {
  if (!sim || !memory) return;
  sim.pack();
  const pos = new Float32Array(memory.buffer, sim.positions_ptr(), n * 2);
  const render = new Uint8Array(memory.buffer, sim.render_ptr(), n);
  const t = nowAbs();
  if (shared) {
    const next = (latest + 1) % SLOTS;
    const v = slotViews(shared, n, next);
    v.pos.set(pos);
    v.render.set(render);
    const h = headerViews(shared);
    h.f64[H_INTERVAL] = lastWrite ? Math.min(250, t - lastWrite) : TICK_MS;
    h.f64[H_TIME] = t;
    Atomics.store(h.i32, H_TICK, sim.tick());
    Atomics.store(h.i32, H_LATEST, next);
    Atomics.add(h.i32, H_SEQ, 1);
    latest = next;
  } else {
    const p = pos.slice();
    const r = render.slice();
    post({ type: "frame", tick: sim.tick(), time: t, pos: p, render: r }, [p.buffer, r.buffer]);
  }
  lastWrite = t;
}

function sendStats() {
  if (!sim) return;
  const s = sim.stats();
  const sorted = [...tickMs].sort((a, b) => a - b);
  const stats: Stats = {
    civilians: s[0],
    infected: s[1],
    zombies: s[2],
    dead: s[3],
    dormant: s[4],
    initial: s[5],
    killed: s[6],
    tick: s[7],
    towersLeft: s[8],
    fenceLeft: s[9],
    phase: sim.game_phase(),
    simMsLast: tickMs.length ? tickMs[tickMs.length - 1] : 0,
    simMsP95: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0,
    paused,
    speed,
  };
  post({ type: "stats", stats });
}

function loop(gen: number) {
  if (gen !== generation || !sim) return;
  const now = performance.now();
  acc += now - lastTime;
  lastTime = now;
  if (acc > 250) acc = 250; // don't spiral after a stall
  let stepped = false;
  while (acc >= TICK_MS) {
    acc -= TICK_MS;
    const phase = sim.game_phase();
    if (paused || phase >= 2) continue;
    // Setup ticks are cosmetic (civilians wander); speed applies while running.
    const k = phase === 1 ? speed : 1;
    for (let i = 0; i < k; i++) {
      const t0 = performance.now();
      sim.step(1);
      tickMs.push(performance.now() - t0);
      if (tickMs.length > 100) tickMs.shift();
      if (sim.game_phase() >= 2) break;
    }
    stepped = true;
  }
  if (stepped) {
    publish();
    sendStats();
    if (sim.game_phase() >= 1 && now - lastFenceSend > 250) {
      post({ type: "fences", fences: new Float32Array(sim.fences()) });
      lastFenceSend = now;
    }
  }
  loopTimer = setTimeout(() => loop(gen), Math.max(0, TICK_MS - acc - 1));
}

function apply(p: Placement): string | null {
  if (!sim) return "not ready";
  try {
    if (p.type === "tower") sim.place_tower_at(p.x, p.y);
    else sim.place_fence(new Float32Array(p.pts));
    return null;
  } catch (e) {
    return String(e);
  }
}

async function initSim(msg: Extract<ToWorker, { type: "init" }>) {
  const myGen = ++generation;
  if (loopTimer) clearTimeout(loopTimer);
  if (!wasmReady) wasmReady = init();
  const wasm = (await wasmReady) as { memory: WebAssembly.Memory };
  if (myGen !== generation) return; // a newer init or a stop arrived meanwhile
  memory = wasm.memory;
  if (sim) sim.free();
  sim = null;
  try {
    sim = new WasmSim(msg.levelJson, configJson, msg.population, msg.seed);
  } catch (e) {
    post({ type: "error", message: `Could not build the level: ${String(e)}`, fatal: true });
    return;
  }
  n = sim.count();
  history = [];
  const replayed: Placement[] = [];
  for (const p of msg.replay ?? []) {
    if (apply(p) === null) {
      history.push(p);
      replayed.push(p);
    }
  }
  shared = self.crossOriginIsolated ? new SharedArrayBuffer(sharedBytes(n)) : null;
  latest = 0;
  lastWrite = 0;
  tickMs = [];
  paused = false; // speed is kept across resets and replays
  post({
    type: "ready",
    shared,
    replayed,
    level: {
      count: n,
      gridW: sim.grid_w(),
      gridH: sim.grid_h(),
      cell: sim.cell_size(),
      center: Array.from(sim.center()) as [number, number],
      radius: sim.level_radius(),
      towerRange: sim.tower_range(),
      buildingCoords: new Float32Array(sim.building_coords()),
      buildingOffsets: new Uint32Array(sim.building_offsets()),
      hashDims: Array.from(sim.hash_dims()) as [number, number, number],
    },
  });
  // Publish twice so both interpolation slots hold valid data.
  publish();
  publish();
  sendStats();
  sendPlacements();
  lastTime = performance.now();
  acc = 0;
  const gen = generation;
  loop(gen);
}

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  if (m.type === "init") return initSim(m);
  if (m.type === "stop") {
    generation++;
    if (loopTimer) clearTimeout(loopTimer);
    sim?.free();
    sim = null;
    return;
  }
  if (!sim) return;
  switch (m.type) {
    case "tower":
    case "fence": {
      const err = apply(m);
      if (err) post({ type: "error", message: err });
      else history.push(m);
      sendPlacements();
      sendStats();
      if (m.type === "fence") publish();
      break;
    }
    case "undo":
      if (sim.undo()) history.pop();
      sendPlacements();
      sendStats();
      break;
    case "clear":
      sim.clear();
      history = [];
      sendPlacements();
      sendStats();
      break;
    case "start":
      sim.start();
      tickMs = [];
      publish();
      publish();
      sendStats();
      sendPlacements();
      break;
    case "pause":
      paused = m.paused;
      sendStats();
      break;
    case "speed":
      speed = m.speed;
      sendStats();
      break;
    case "field": {
      const data = new Int32Array(m.kind === "chase" ? sim.chase_field() : sim.flee_field());
      post({ type: "field", kind: m.kind, data, w: sim.grid_w(), h: sim.grid_h() }, [data.buffer]);
      break;
    }
  }
};
