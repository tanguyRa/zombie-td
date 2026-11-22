// Messages and shared-memory layout between the main thread and the sim worker.

export type LevelName = "paris-marais" | "suburb";

export type ToWorker =
  | { type: "init"; levelUrl: string; population: number; seed: number; replay?: Placement[] }
  | { type: "tower"; x: number; y: number }
  | { type: "fence"; pts: number[] }
  | { type: "undo" }
  | { type: "clear" }
  | { type: "start" }
  | { type: "pause"; paused: boolean }
  | { type: "speed"; speed: number }
  | { type: "field"; kind: "chase" | "flee" };

export type Placement = { type: "tower"; x: number; y: number } | { type: "fence"; pts: number[] };

export interface StaticLevel {
  count: number;
  gridW: number;
  gridH: number;
  cell: number;
  center: [number, number];
  radius: number;
  towerRange: number;
  buildingCoords: Float32Array;
  buildingOffsets: Uint32Array;
  hashDims: [number, number, number];
}

export interface Stats {
  civilians: number;
  infected: number;
  zombies: number;
  dead: number;
  dormant: number;
  initial: number;
  killed: number;
  tick: number;
  towersLeft: number;
  fenceLeft: number;
  phase: number; // 0 setup, 1 running, 2 win, 3 loss, 4 timeout
  simMsLast: number;
  simMsP95: number;
  paused: boolean;
  speed: number;
}

export type FromWorker =
  | { type: "ready"; level: StaticLevel; shared: SharedArrayBuffer | null; replayed: Placement[] }
  | { type: "frame"; tick: number; time: number; pos: Float32Array; render: Uint8Array } // fallback mode only
  | { type: "stats"; stats: Stats }
  | { type: "placements"; towers: Float32Array; fences: Float32Array; history: Placement[] }
  | { type: "fences"; fences: Float32Array }
  | { type: "error"; message: string }
  | { type: "field"; kind: "chase" | "flee"; data: Int32Array; w: number; h: number };

// ---- shared buffer: header, then 3 slots of (positions f32 x,y; render u8) ----
// Triple buffering: the worker writes slot (latest + 1) % 3 while the main
// thread reads `latest` and `latest - 1` to interpolate between two ticks.
export const SLOTS = 3;
export const HEADER_BYTES = 64;
// Int32 header indices
export const H_LATEST = 0;
export const H_TICK = 1;
export const H_SEQ = 2;
// Float64 header indices (byte offset 32)
export const H_TIME = 0; // absolute ms (timeOrigin + now) when `latest` was written
export const H_INTERVAL = 1; // ms between the last two written ticks

export function slotBytes(n: number): number {
  const pos = n * 2 * 4;
  const render = Math.ceil(n / 4) * 4;
  return pos + render;
}

export function sharedBytes(n: number): number {
  return HEADER_BYTES + SLOTS * slotBytes(n);
}

export function slotViews(buf: ArrayBufferLike, n: number, slot: number) {
  const base = HEADER_BYTES + slot * slotBytes(n);
  return {
    pos: new Float32Array(buf, base, n * 2),
    render: new Uint8Array(buf, base + n * 2 * 4, n),
  };
}

export function headerViews(buf: ArrayBufferLike) {
  return { i32: new Int32Array(buf, 0, 8), f64: new Float64Array(buf, 32, 4) };
}

export const nowAbs = () => performance.timeOrigin + performance.now();
