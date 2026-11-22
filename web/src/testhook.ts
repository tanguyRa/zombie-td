// Test hook: `window.__zt`, installed only when the page is opened with
// `?test=1` (main.ts loads this module dynamically, so the normal page never
// runs it). Playwright tests use it for setup and assertions.
//
// Rules: getters are read-only snapshots (copies), and every action helper
// sends exactly the worker message the matching UI control sends. Nothing
// here touches sim state directly.
import type { Map as MlMap } from "maplibre-gl";
import type { FromWorker, Placement, StaticLevel, Stats, ToWorker } from "./protocol";

export type PhaseName = "loading" | "setup" | "running" | "win" | "loss" | "timeout";
const PHASES: PhaseName[] = ["setup", "running", "win", "loss", "timeout"];

/** What main.ts hands to the hook: live views of its state and its own UI entry points. */
export interface TestHookDeps {
  send(m: ToWorker): void;
  map: MlMap;
  overlay: unknown;
  presets: string[];
  screen(): string;
  stats(): Stats | null;
  level(): StaticLevel | null;
  placeName(): string | null;
  history(): Placement[];
  buildings(): { polygon: number[][]; index: number }[];
  resultVisible(): boolean;
  /** Map lng/lat → sim meters (null before a level is loaded). */
  toSim(ll: { lng: number; lat: number }): number[] | null;
  /** Sim meters → map lng/lat. */
  toLngLat(x: number, y: number): { lng: number; lat: number } | null;
  enterPreset(i: number): void;
  /** Same as changing the Population / Seed inputs (re-inits the level). */
  setup(population: number, seed: number): void;
  reset(): void;
  replay(): void;
}

export interface TestHook {
  readonly version: 1;
  readonly screen: string;
  readonly phase: PhaseName;
  readonly tick: number;
  readonly stats: Stats | null;
  readonly placements: Placement[];
  readonly level: { place: string | null; agents: number; buildings: number; center: [number, number]; radius: number; cell: number } | null;
  readonly presets: string[];
  readonly resultVisible: boolean;
  readonly mapIdle: boolean;
  stateHash(): Promise<{ tick: number; hash: string }>;
  buildingPoint(i: number): [number, number] | null;
  toScreen(x: number, y: number): { x: number; y: number } | null;
  toSimPoint(clientX: number, clientY: number): [number, number] | null;
  enterPreset(i: number): void;
  setup(population: number, seed: number): void;
  placeTower(x: number, y: number): void;
  placeFence(pts: [number, number][]): void;
  undo(): void;
  clear(): void;
  start(): void;
  pause(paused: boolean): void;
  speed(s: 1 | 2 | 4): void;
  reset(): void;
  replay(): void;
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
  const waiting = new Map<number, (r: { tick: number; hash: string }) => void>();

  const hook: TestHook = {
    version: 1,
    get screen() {
      return d.screen();
    },
    get phase() {
      const s = d.stats();
      return s && d.level() ? PHASES[s.phase] : "loading";
    },
    get tick() {
      return d.stats()?.tick ?? 0;
    },
    get stats() {
      const s = d.stats();
      return s ? { ...s } : null;
    },
    get placements() {
      return structuredClone(d.history());
    },
    get level() {
      const l = d.level();
      if (!l) return null;
      return { place: d.placeName(), agents: l.count, buildings: d.buildings().length, center: [l.center[0], l.center[1]] as [number, number], radius: l.radius, cell: l.cell };
    },
    get presets() {
      return [...d.presets];
    },
    get resultVisible() {
      return d.resultVisible();
    },
    get mapIdle() {
      return !d.map.isMoving();
    },
    stateHash() {
      const id = nextId++;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        d.send({ type: "hash", id });
      });
    },
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
    setup: (population, seed) => d.setup(population, seed),
    placeTower: (x, y) => d.send({ type: "tower", x, y }),
    placeFence: (pts) => d.send({ type: "fence", pts: pts.flat() }),
    undo: () => d.send({ type: "undo" }),
    clear: () => d.send({ type: "clear" }),
    start: () => d.send({ type: "start" }),
    pause: (paused) => d.send({ type: "pause", paused }),
    speed: (s) => d.send({ type: "speed", speed: s }),
    reset: () => d.reset(),
    replay: () => d.replay(),
    debug: { map: d.map, overlay: d.overlay },
  };
  (window as unknown as { __zt: TestHook }).__zt = hook;
  document.documentElement.dataset.testHook = "1";

  return (m) => {
    if (m.type !== "hash") return false;
    waiting.get(m.id)?.({ tick: m.tick, hash: m.hash });
    waiting.delete(m.id);
    return true;
  };
}
