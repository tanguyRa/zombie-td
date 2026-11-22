// Test hook: `window.__zt` (version 2), installed only when the page is
// opened with `?test=1` (main.ts loads this module dynamically, so the
// normal page never runs it). Playwright tests use it for setup and
// assertions.
//
// Rules: getters are read-only snapshots (copies), and every action helper
// goes through main.ts's `act`, exactly like the UI controls: a worker
// `action` message applied at the next tick boundary. Nothing here touches
// sim state directly. The only test-only powers are speeds 16 and 0 ("as
// fast as possible"), `pauseAt` (and `startPaused`, built on it), and the
// `agents` query; the worker accepts them only from a page opened with
// `?test=1`. Queries, records and hashes reject with "aborted" when there
// is no match (after "← Map"); actions resolve with an `aborted` error.
import type { Map as MlMap } from "maplibre-gl";
import type {
  Action,
  ActionError,
  FromWorker,
  HandCard,
  MatchStatus,
  Perf,
  Pick,
  Query,
  QueryResult,
  StaticLevel,
  Structure,
  Target,
  ToWorker,
  WaveAttempt,
  WaveResult,
} from "./protocol";

export type PhaseName = "loading" | MatchStatus["phase"];

/** A building as the bot and the tests see it (WasmMatch.building_info). */
export interface HookBuilding {
  index: number;
  x: number;
  y: number;
  area: number;
  floors: number;
  cells: number;
  wave: number;
}

/** What main.ts hands to the hook: live views of its state and its own UI entry points. */
export interface TestHookDeps {
  send(m: ToWorker): void;
  act(a: Action): Promise<ActionError | null>;
  query(q: Query): Promise<QueryResult>;
  record(): Promise<string>;
  map: MlMap;
  overlay: unknown;
  presets: string[];
  screen(): string;
  status(): MatchStatus | null;
  perf(): Perf | null;
  hand(): HandCard[];
  structures(): Structure[];
  results(): WaveResult[];
  attempts(): WaveAttempt[];
  towers(): Float32Array<ArrayBufferLike>;
  level(): StaticLevel | null;
  placeName(): string | null;
  buildings(): (HookBuilding & { polygon: number[][] })[];
  /** The result panel's kind (wave_won, wave_lost, match_won) or null when hidden. */
  result(): string | null;
  toast(): string;
  uiActions(): { count: number; type: string; error: ActionError | null };
  drawn(): { layers: string[]; fogRadius: { revealed: number; next: number }; agents: number };
  hint(): string;
  selection(): { handIndex: number; card: string; picked: number[] } | null;
  /** The inspect panel's structure and the costs it shows, or null. */
  inspected(): { id: number; repairCost: number; refund: number } | null;
  toSim(ll: { lng: number; lat: number }): number[] | null;
  toLngLat(x: number, y: number): { lng: number; lat: number } | null;
  enterPreset(i: number): void;
  /** Same as typing a seed and pressing Enter (without the confirmation):
   *  a new match on the current level. A string keeps seeds above 2^53 exact. */
  newMatch(seed: number | string): void;
}

export interface TestHook {
  readonly version: 2;
  readonly screen: string;
  readonly phase: PhaseName;
  readonly tick: number;
  readonly wave: number;
  readonly supply: number;
  readonly status: MatchStatus | null;
  readonly perf: Perf | null;
  readonly hand: HandCard[];
  readonly structures: Structure[];
  readonly results: WaveResult[];
  readonly attempts: WaveAttempt[];
  /** Shooters: building (or -1 for units), position, range, kills. */
  readonly towers: { building: number; x: number; y: number; range: number; kills: number }[];
  readonly buildings: HookBuilding[];
  readonly level: { place: string | null; buildings: number; center: [number, number]; rings: number[]; cell: number; gridW: number } | null;
  readonly presets: string[];
  readonly result: string | null;
  readonly resultVisible: boolean;
  readonly toast: string;
  /** How many actions the UI controls sent, the last one's type and refusal. */
  readonly uiActions: { count: number; type: string; error: ActionError | null };
  readonly hint: string;
  /** What the last frame drew: deck.gl layer ids, the fog's radii (revealed
   *  disc, next ring) and the number of agents drawn. */
  readonly drawn: { layers: string[]; fogRadius: { revealed: number; next: number }; agents: number };
  readonly selection: { handIndex: number; card: string; picked: number[] } | null;
  readonly inspected: { id: number; repairCost: number; refund: number } | null;
  readonly mapIdle: boolean;
  stateHash(): Promise<{ tick: number; hash: string }>;
  /** The run record JSON (`WasmMatch.record()`), as the Download button saves it. */
  record(): Promise<string>;
  // Actions: each resolves with the core's refusal (ActionError) or null.
  act(a: Action): Promise<ActionError | null>;
  playCard(handIndex: number, target: Target): Promise<ActionError | null>;
  mulligan(): Promise<ActionError | null>;
  keep(handIndices: number[]): Promise<ActionError | null>;
  repair(fenceId: number): Promise<ActionError | null>;
  pullDown(id: number): Promise<ActionError | null>;
  startWave(): Promise<ActionError | null>;
  nextWave(): Promise<ActionError | null>;
  retryWave(): Promise<ActionError | null>;
  restartMatch(): Promise<ActionError | null>;
  // Read-only queries answered by the worker.
  pick(x: number, y: number): Promise<Pick>;
  fenceLength(pts: [number, number][]): Promise<number | null>;
  /** Every agent in play: position and render state (0 civilian, 1 infected, 2 zombie, 3 corpse, 5 fresh kill). */
  agents(): Promise<{ x: number; y: number; state: number }[]>;
  zombies(): Promise<[number, number][]>;
  // Clock (never reaches the sim).
  pause(paused: boolean): void;
  /** 1, 2, 4, or test-only 16 and 0 (= as fast as possible). */
  speed(s: number): void;
  /** Pause by itself once the match tick reaches `tick` while a wave runs
   *  (null clears; entering prep clears it). */
  pauseAt(tick: number | null): void;
  /** In prep: the next wave starts paused on its first tick (`pauseAt` the
   *  prep's tick; `pause` itself only works while a wave runs). */
  startPaused(): void;
  // Geometry helpers.
  buildingPoint(i: number): [number, number] | null;
  toScreen(x: number, y: number): { x: number; y: number } | null;
  toSimPoint(clientX: number, clientY: number): [number, number] | null;
  enterPreset(i: number): void;
  newMatch(seed: number | string): void;
  debug: { map: MlMap; overlay: unknown };
}

function inside(p: [number, number], poly: number[][]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Installs `window.__zt` and returns the worker-message tap main.ts must call. */
export function installTestHook(d: TestHookDeps): (m: FromWorker) => boolean {
  let nextId = 1;
  const waiting = new Map<number, { ok: (r: { tick: number; hash: string }) => void; fail: (e: Error) => void }>();
  const clone = <T>(v: T): T => structuredClone(v);

  const hook: TestHook = {
    version: 2,
    get screen() {
      return d.screen();
    },
    get phase() {
      const s = d.status();
      return s && d.level() ? s.phase : "loading";
    },
    get tick() {
      return d.status()?.tick ?? 0;
    },
    get wave() {
      return d.status()?.wave ?? 0;
    },
    get supply() {
      return d.status()?.supply ?? 0;
    },
    get status() {
      const s = d.status();
      return s ? clone(s) : null;
    },
    get perf() {
      const p = d.perf();
      return p ? { ...p } : null;
    },
    get hand() {
      return clone(d.hand());
    },
    get structures() {
      return clone(d.structures());
    },
    get results() {
      return clone(d.results());
    },
    get attempts() {
      return clone(d.attempts());
    },
    get towers() {
      const t = d.towers();
      const out = [];
      for (let i = 0; i < t.length; i += 5) out.push({ building: t[i], x: t[i + 1], y: t[i + 2], range: t[i + 3], kills: t[i + 4] });
      return out;
    },
    get buildings() {
      return d.buildings().map(({ index, x, y, area, floors, cells, wave }) => ({ index, x, y, area, floors, cells, wave }));
    },
    get level() {
      const l = d.level();
      if (!l) return null;
      return { place: d.placeName(), buildings: d.buildings().length, center: [l.center[0], l.center[1]] as [number, number], rings: [...l.rings], cell: l.cell, gridW: l.gridW };
    },
    get presets() {
      return [...d.presets];
    },
    get result() {
      return d.result();
    },
    get resultVisible() {
      return d.result() !== null;
    },
    get toast() {
      return d.toast();
    },
    get uiActions() {
      return d.uiActions();
    },
    get drawn() {
      return d.drawn();
    },
    get hint() {
      return d.hint();
    },
    get selection() {
      return d.selection();
    },
    get inspected() {
      return d.inspected();
    },
    get mapIdle() {
      return !d.map.isMoving();
    },
    stateHash() {
      const id = nextId++;
      return new Promise((ok, fail) => {
        waiting.set(id, { ok, fail });
        d.send({ type: "hash", id });
      });
    },
    record: () => d.record(),
    act: (a) => d.act(a),
    playCard: (hand_index, target) => d.act({ type: "play_card", hand_index, target }),
    mulligan: () => d.act({ type: "mulligan" }),
    keep: (hand_indices) => d.act({ type: "keep_cards", hand_indices }),
    repair: (fence_id) => d.act({ type: "repair", fence_id }),
    pullDown: (placement_id) => d.act({ type: "pull_down", placement_id }),
    startWave: () => d.act({ type: "start_wave" }),
    nextWave: () => d.act({ type: "next_wave" }),
    retryWave: () => d.act({ type: "retry_wave" }),
    restartMatch: () => d.act({ type: "restart_match" }),
    pick: async (x, y) => ((await d.query({ q: "pick", x, y })) as Extract<QueryResult, { q: "pick" }>).pick,
    fenceLength: async (pts) => ((await d.query({ q: "fence_length", pts: pts.flat() })) as Extract<QueryResult, { q: "fence_length" }>).length,
    agents: async () => {
      const r = (await d.query({ q: "agents" })) as Extract<QueryResult, { q: "agents" }>;
      return r.states.map((state, i) => ({ x: r.pts[2 * i], y: r.pts[2 * i + 1], state }));
    },
    zombies: async () => (await hook.agents()).filter((a) => a.state === 2).map((a) => [a.x, a.y] as [number, number]),
    pause: (paused) => d.send({ type: "pause", paused }),
    speed: (s) => d.send({ type: "speed", speed: s }),
    pauseAt: (tick) => d.send({ type: "pause_at", tick }),
    startPaused: () => d.send({ type: "pause_at", tick: d.status()?.tick ?? 0 }),
    // An interior point of building i (vertex mean if inside, else the
    // first inside point on a coarse scan of its bounding box).
    buildingPoint(i) {
      const b = d.buildings()[i];
      if (!b) return null;
      const poly = b.polygon;
      const n = poly.length;
      const m: [number, number] = [poly.reduce((a, p) => a + p[0], 0) / n, poly.reduce((a, p) => a + p[1], 0) / n];
      if (inside(m, poly)) return m;
      const xs = poly.map((p) => p[0]);
      const ys = poly.map((p) => p[1]);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      for (let gy = 1; gy < 10; gy++)
        for (let gx = 1; gx < 10; gx++) {
          const p: [number, number] = [x0 + ((x1 - x0) * gx) / 10, y0 + ((y1 - y0) * gy) / 10];
          if (inside(p, poly)) return p;
        }
      return null;
    },
    toScreen(x, y) {
      const ll = d.toLngLat(x, y);
      if (!ll) return null;
      const p = d.map.project(ll);
      const r = d.map.getCanvas().getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y };
    },
    toSimPoint(cx, cy) {
      const r = d.map.getCanvas().getBoundingClientRect();
      const s = d.toSim(d.map.unproject([cx - r.left, cy - r.top]));
      return s ? [s[0], s[1]] : null;
    },
    enterPreset: (i) => d.enterPreset(i),
    newMatch: (seed) => d.newMatch(seed),
    debug: { map: d.map, overlay: d.overlay },
  };
  (window as unknown as { __zt: TestHook }).__zt = hook;
  document.documentElement.dataset.testHook = "2";

  return (m) => {
    if (m.type !== "hash") return false;
    const w = waiting.get(m.id);
    waiting.delete(m.id);
    if ("aborted" in m) w?.fail(new Error("aborted"));
    else w?.ok({ tick: m.tick, hash: m.hash });
    return true;
  };
}
