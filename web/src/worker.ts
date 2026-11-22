// Simulation worker: owns the WASM match (sim-core `Match`), runs it on a
// fixed 20 Hz accumulator while a wave runs, applies the player's actions at
// tick boundaries and publishes positions/states to the main thread.
//
// Determinism: the only inputs that reach the sim are `Action`s (applied
// with `WasmMatch.apply`) and `step`s. Pause, speed and frame timing only
// decide *when* the worker steps, never what a step does. The sim is only
// stepped while a wave runs: prep and the result screens are static (no
// cosmetic wander), so the run record holds no idle prep ticks and a replay
// never pays for them (DECISIONS.md, "Browser match (T5)").
import init, { WasmMatch } from "./wasm/pkg/sim_wasm.js";
import configJson from "../../config.default.json?raw";
import {
  Action,
  ActionError,
  FromWorker,
  H_COUNT,
  H_INTERVAL,
  H_LATEST,
  H_SEQ,
  H_TICK,
  H_TIME,
  MatchPhase,
  MatchStatus,
  Pick,
  Query,
  QueryResult,
  SLOTS,
  SPEEDS,
  Structure,
  TEST_SPEEDS,
  ToWorker,
  headerViews,
  nowAbs,
  sharedBytes,
  slotViews,
} from "./protocol";

const config = JSON.parse(configJson);
const TICK_MS = 1000 / config.tick_hz;
const CAPACITY: number = config.max_population;
const LEVEL_FENCE_HP: number = config.fence_cell_hp;
/** Fast mode: step for at most this long per loop turn, then yield so
 *  messages (actions, pause) get through. */
const FAST_SLICE_MS = 40;

let wasmReady: Promise<unknown> | null = null;
let m: WasmMatch | null = null;
let memory: WebAssembly.Memory | null = null;
let shared: SharedArrayBuffer | null = null;
let testMode = false;
let latest = 0;
let lastWrite = 0;
let paused = false;
let speed = 1;
let pauseAt: number | null = null;
let acc = 0;
let lastTime = 0;
let loopTimer: ReturnType<typeof setTimeout> | null = null;
let tickMs: number[] = [];
let lastPlacementsSend = 0;
let generation = 0;
let lastPhase: MatchPhase | null = null;
let lastPausedSent = false;
let buildingCount = -1;
let gridW = 0;
let cell = 2;
const queue: { id: number; action: Action }[] = [];

const post = (msg: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

const ABORTED: ActionError = { error: "aborted", message: "the match was stopped" };
/** Settle every queued action with `aborted` (stop, re-init): nothing waits forever. */
function abortQueue() {
  for (const { id, action } of queue.splice(0)) post({ type: "action", id, action, error: ABORTED });
}

function status(): MatchStatus {
  return JSON.parse(m!.status_json());
}

function publish() {
  if (!m || !memory) return;
  m.pack();
  const n = m.count();
  const pos = new Float32Array(memory.buffer, m.positions_ptr(), n * 2);
  const render = new Uint8Array(memory.buffer, m.render_ptr(), n);
  const t = nowAbs();
  const tick = Number(m.tick());
  if (shared) {
    const next = (latest + 1) % SLOTS;
    const v = slotViews(shared, CAPACITY, next);
    v.pos.set(pos);
    v.render.set(render);
    const h = headerViews(shared);
    h.f64[H_INTERVAL] = lastWrite ? Math.min(250, t - lastWrite) : TICK_MS;
    h.f64[H_TIME] = t;
    Atomics.store(h.i32, H_TICK, tick);
    Atomics.store(h.i32, H_COUNT, n);
    Atomics.store(h.i32, H_LATEST, next);
    Atomics.add(h.i32, H_SEQ, 1);
    latest = next;
  } else {
    const p = pos.slice();
    const r = render.slice();
    post({ type: "frame", tick, time: t, count: n, pos: p, render: r }, [p.buffer, r.buffer]);
  }
  lastWrite = t;
}

function sendStatus(st: MatchStatus = status()) {
  const sorted = [...tickMs].sort((a, b) => a - b);
  post({
    type: "status",
    status: st,
    perf: {
      simMsLast: tickMs.length ? tickMs[tickMs.length - 1] : 0,
      simMsP95: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0,
      paused,
      speed,
      pauseAt,
    },
  });
}

let structures: Structure[] = [];
function sendState() {
  if (!m) return;
  structures = JSON.parse(m.structures_json());
  post({
    type: "state",
    hand: JSON.parse(m.hand_json()),
    structures,
    results: JSON.parse(m.results_json()),
    attempts: JSON.parse(m.attempts_json()),
  });
  sendPlacements();
}

/** Fence cells as [x, y, hp share]: hp over the owning card's cell hp (the
 *  level's own fences use the config's). */
function fenceShares(): Float32Array {
  const raw = m!.fences();
  const full = new Map<number, number>();
  for (const s of structures) if (s.kind.type === "fence") for (const c of s.kind.cells) full.set(c, s.kind.cell_hp);
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i += 3) {
    const c = Math.floor(raw[i + 1] / cell) * gridW + Math.floor(raw[i] / cell);
    out[i] = raw[i];
    out[i + 1] = raw[i + 1];
    out[i + 2] = raw[i + 2] / (full.get(c) ?? LEVEL_FENCE_HP);
  }
  return out;
}

function sendPlacements() {
  if (!m) return;
  const towers = new Float32Array(m.towers());
  const fences = fenceShares();
  post({ type: "placements", towers, fences }, [towers.buffer, fences.buffer]);
  lastPlacementsSend = performance.now();
}

function sendGeometryIfChanged() {
  if (!m) return;
  const offsets = new Uint32Array(m.building_offsets());
  if (offsets.length - 1 === buildingCount) return;
  buildingCount = offsets.length - 1;
  const coords = new Float32Array(m.building_coords());
  const info = new Float32Array(m.building_info());
  post({ type: "geometry", geometry: { buildingCoords: coords, buildingOffsets: offsets, buildingInfo: info } }, [coords.buffer, offsets.buffer, info.buffer]);
}

/** Everything the main thread shows after the phase may have changed. */
function afterChange() {
  const st = status();
  if (st.phase !== lastPhase) {
    if (st.phase === "prep" || lastPhase === null) sendGeometryIfChanged();
    if (st.phase === "prep") {
      tickMs = [];
      // Every prep starts unpaused: a pause belongs to the wave it was
      // pressed in, not to the next one or a retry. (Tests that need a wave
      // to start paused set `pause_at` to the prep's tick.)
      paused = false;
      pauseAt = null;
    }
    lastPhase = st.phase;
    // Both interpolation slots hold the new positions (a reveal or a
    // retry moves everyone at once).
    publish();
    publish();
  }
  // State first: the main thread shows a result panel when the status
  // changes the phase, and reads the results from the state.
  sendState();
  sendStatus(st);
}

function applyQueued(): boolean {
  if (!m || queue.length === 0) return false;
  const replies: FromWorker[] = [];
  while (queue.length) {
    const { id, action } = queue.shift()!;
    let error: ActionError | null = null;
    try {
      m.apply(JSON.stringify(action));
    } catch (e) {
      try {
        error = JSON.parse(String(e));
      } catch {
        error = { error: "unknown", message: String(e) };
      }
    }
    replies.push({ type: "action", id, action, error });
  }
  publish();
  afterChange();
  // Replies last, so whoever awaits an action sees its state already.
  for (const r of replies) post(r);
  return true;
}

function stepOnce() {
  const t0 = performance.now();
  m!.step(1);
  tickMs.push(performance.now() - t0);
  if (tickMs.length > 100) tickMs.shift();
}

function loop(gen: number) {
  if (gen !== generation || !m) return;
  // Actions first: they apply at this tick boundary.
  applyQueued();
  const now = performance.now();
  acc += now - lastTime;
  lastTime = now;
  if (acc > 250) acc = 250; // don't spiral after a stall
  let stepped = false;
  const runnable = () => !paused && m!.phase() === "running";
  // `pause_at` is only consumed while a wave runs, so a test can set it to
  // the prep's tick to have the wave start paused.
  const hitPauseAt = () => {
    if (pauseAt !== null && m!.phase() === "running" && Number(m!.tick()) >= pauseAt) {
      paused = true;
      pauseAt = null;
      return true;
    }
    return false;
  };
  if (!hitPauseAt() && runnable()) {
    if (speed === 0) {
      // Test-only "as fast as possible": step for a time slice, then yield.
      const until = performance.now() + FAST_SLICE_MS;
      while (performance.now() < until && runnable() && !hitPauseAt()) {
        stepOnce();
        stepped = true;
      }
      acc = 0;
    } else {
      // `speed` ticks per 50 ms of wall time (1, 2, 4; 16 in test mode).
      while (acc >= TICK_MS) {
        acc -= TICK_MS;
        for (let i = 0; i < speed && runnable() && !hitPauseAt(); i++) {
          stepOnce();
          stepped = true;
        }
      }
    }
  } else acc = 0;
  if (stepped || paused !== lastPausedSent) {
    lastPausedSent = paused;
    publish();
    const st = status();
    if (st.phase !== lastPhase) afterChange();
    else {
      sendStatus(st);
      if (now - lastPlacementsSend > 250) sendPlacements();
    }
  }
  const fast = !paused && speed === 0 && m.phase() === "running";
  loopTimer = setTimeout(() => loop(gen), fast ? 0 : Math.max(0, TICK_MS - acc - 1));
}
function query(q: Query): QueryResult {
  const w = m!;
  switch (q.q) {
    case "pick": {
      const building = w.building_at(q.x, q.y);
      // A click inside a garrisoned building means that garrison, even with
      // a fence just outside its wall. Otherwise a fence cell at the point or
      // within ~3 m (cells are 2 m: a click needn't hit the exact cell),
      // nearest first.
      let structure = -1;
      const garrison = building >= 0 ? structures.find((s) => s.kind.type === "garrison" && s.kind.buildings.includes(building)) : undefined;
      if (garrison) structure = garrison.id;
      const r = 3;
      let best = Infinity;
      if (!garrison)
        for (let dy = -r; dy <= r; dy += 1)
          for (let dx = -r; dx <= r; dx += 1) {
            const d = dx * dx + dy * dy;
            if (d > r * r || d >= best) continue;
            const s = w.structure_at(q.x + dx, q.y + dy);
            if (s >= 0) {
              structure = s;
              best = d;
            }
          }
      const pick: Pick = {
        building,
        structure,
        repairCost: structure >= 0 ? w.repair_cost(structure) : -1,
        refund: structure >= 0 ? w.pull_down_refund(structure) : -1,
        revealed: w.point_revealed(q.x, q.y),
        wave: w.wave_of_point(q.x, q.y),
      };
      return { q: "pick", pick };
    }
    case "fence_length": {
      try {
        return { q: "fence_length", length: w.fence_length_m(new Float32Array(q.pts)), error: null };
      } catch (e) {
        let msg = String(e);
        try {
          msg = JSON.parse(msg).message;
        } catch {
          /* plain string */
        }
        return { q: "fence_length", length: null, error: msg };
      }
    }
    case "costs": {
      const exists = structures.some((s) => s.id === q.id);
      return { q: "costs", exists, repairCost: exists ? w.repair_cost(q.id) : -1, refund: exists ? w.pull_down_refund(q.id) : -1 };
    }
    case "agents": {
      w.pack();
      const n = w.count();
      const pts = Array.from(new Float32Array(memory!.buffer, w.positions_ptr(), n * 2));
      const states = Array.from(new Uint8Array(memory!.buffer, w.render_ptr(), n));
      return { q: "agents", pts, states };
    }
  }
}

async function initMatch(msg: Extract<ToWorker, { type: "init" }>) {
  const myGen = ++generation;
  if (loopTimer) clearTimeout(loopTimer);
  if (!wasmReady) wasmReady = init();
  const wasm = (await wasmReady) as { memory: WebAssembly.Memory };
  if (myGen !== generation) return; // a newer init or a stop arrived meanwhile
  memory = wasm.memory;
  if (m) m.free();
  m = null;
  abortQueue();
  testMode = !!msg.test;
  try {
    m = new WasmMatch(msg.levelJson, JSON.stringify(msg.setup));
  } catch (e) {
    let text = String(e);
    try {
      text = JSON.parse(text).message;
    } catch {
      /* plain string */
    }
    post({ type: "error", message: `Could not build the match: ${text}`, fatal: true });
    return;
  }
  gridW = m.grid_w();
  cell = m.cell_size();
  shared = self.crossOriginIsolated ? new SharedArrayBuffer(sharedBytes(CAPACITY)) : null;
  latest = 0;
  lastWrite = 0;
  tickMs = [];
  paused = false; // speed is kept across matches
  pauseAt = null;
  lastPhase = null;
  buildingCount = -1;
  structures = [];
  const st = status();
  const rings: number[] = [];
  for (let w = 1; w <= st.waves; w++) rings.push(m.ring_radius_m(w));
  post({
    type: "ready",
    shared,
    level: {
      capacity: CAPACITY,
      gridW,
      gridH: m.grid_h(),
      cell,
      center: Array.from(m.center()) as [number, number],
      rings,
      hashDims: Array.from(m.hash_dims()) as [number, number, number],
    },
  });
  afterChange();
  lastTime = performance.now();
  acc = 0;
  loop(generation);
}

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  if (msg.type === "init") return initMatch(msg);
  if (msg.type === "stop") {
    generation++;
    if (loopTimer) clearTimeout(loopTimer);
    m?.free();
    m = null;
    abortQueue();
    return;
  }
  if (!m) {
    // No match (stopped, or the first init is still loading): answer every
    // request so its promise settles.
    if (msg.type === "action") post({ type: "action", id: msg.id, action: msg.action, error: ABORTED });
    else if (msg.type === "query" || msg.type === "record" || msg.type === "hash") post({ type: msg.type, id: msg.id, aborted: true } as FromWorker);
    return;
  }
  switch (msg.type) {
    case "action":
      // Applied at the next tick boundary (the start of the next loop turn).
      queue.push({ id: msg.id, action: msg.action });
      break;
    case "pause":
      // Only a running wave can be paused (prep and the result screens
      // never step anyway); entering prep clears it.
      if (m.phase() === "running") paused = msg.paused;
      sendStatus();
      break;
    case "speed":
      if (SPEEDS.includes(msg.speed) || (testMode && TEST_SPEEDS.includes(msg.speed))) speed = msg.speed;
      else post({ type: "error", message: `speed ${msg.speed} is not allowed` });
      sendStatus();
      break;
    case "pause_at":
      if (testMode) pauseAt = msg.tick;
      sendStatus();
      break;
    case "query":
      if (msg.query.q === "agents" && !testMode) {
        post({ type: "query", id: msg.id, aborted: true });
        break;
      }
      post({ type: "query", id: msg.id, result: query(msg.query) });
      break;
    case "record":
      post({ type: "record", id: msg.id, json: m.record() });
      break;
    case "hash":
      post({ type: "hash", id: msg.id, tick: Number(m.tick()), hash: m.state_hash() });
      break;
    case "field": {
      const data = new Int32Array(msg.kind === "chase" ? m.chase_field() : m.flee_field());
      post({ type: "field", kind: msg.kind, data, w: m.grid_w(), h: m.grid_h() }, [data.buffer]);
      break;
    }
  }
};
