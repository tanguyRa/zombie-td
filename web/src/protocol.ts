// Messages and shared-memory layout between the main thread and the sim
// worker. The worker owns the WASM `WasmMatch` (sim-core `Match`); the main
// thread only renders and sends actions (DECISIONS.md, "Browser match").

import type { BuildingChunk } from "./map/chunks";

// ------------------------------------------------------------ match types
// Mirrors of the sim-core serde types (`match_.rs`). Coordinates are sim
// meters (grid origin at a corner).

export type MatchPhase = "prep" | "running" | "wave_won" | "wave_lost" | "match_won";
export type CardKind = "fortification" | "armament" | "tactical";
export type TargetKind = "buildings" | "polyline" | "point";
export type Target = { buildings: number[] } | { polyline: [number, number][] } | { point: [number, number] };

/** sim-core `Action` (tagged `type`, snake_case): the input log. */
export type Action =
  | { type: "play_card"; hand_index: number; target: Target }
  | { type: "mulligan" }
  | { type: "keep_cards"; hand_indices: number[] }
  | { type: "repair"; fence_id: number }
  | { type: "pull_down"; placement_id: number }
  | { type: "start_wave" }
  | { type: "next_wave" }
  | { type: "retry_wave" }
  | { type: "restart_match" };

/** sim-core `ActionError` as thrown by `WasmMatch.apply` (tagged `error`,
 *  plus a readable `message`). */
export interface ActionError {
  error: string;
  message: string;
  [k: string]: unknown;
}

/** `WasmMatch.status_json()`. */
export interface MatchStatus {
  tick: number;
  wave: number;
  waves: number;
  phase: MatchPhase;
  wave_tick: number;
  radius_m: number;
  next_radius_m: number;
  next_ring_ready: boolean;
  supply: number;
  income: { base: number; civilians: number };
  deck_count: number;
  discard_count: number;
  reshuffles: number;
  retries: number;
  restarts: number;
  fatigue: number;
  defeat_threshold: number;
  wave_start_civilians: number;
  newcomers: number;
  mulligan_available: boolean;
  mulligan_cost: number;
  stats: { civilians: number; infected: number; zombies: number; dead: number; zombies_killed: number; bites: number; fence_cells_broken: number };
}

/** sim-core `HandCardView`. */
export interface HandCard {
  hand_index: number;
  card: string;
  name: string;
  kind: CardKind;
  rarity: "common" | "uncommon" | "rare" | "legendary";
  cost: number;
  target: TargetKind;
  keep: boolean;
  playable: boolean;
}

/** sim-core `Structure`. */
export interface Structure {
  id: number;
  card: string;
  cost: number;
  wave: number;
  kind: { type: "fence"; cells: number[]; cell_hp: number; length_m: number } | { type: "garrison"; buildings: number[] };
}

/** sim-core `WaveResult` (hashes are lossy JS numbers: use attempts). */
export interface WaveResult {
  wave: number;
  won: boolean;
  ticks: number;
  radius_m: number;
  newcomers: number;
  start_civilians: number;
  end_civilians: number;
  zombies_killed: number;
  bites: number;
  fence_cells_broken: number;
  outbreak_clusters: number;
  supply_earned: number;
  cards_played: number;
}

/** sim-core `WaveAttempt`. */
export interface WaveAttempt {
  wave: number;
  result: "won" | "lost" | "abandoned";
  start_tick: number;
  end_tick: number;
  prep_hash: string;
  end_hash: string;
}

/** What the worker answers to a `pick` query at a map point. */
export interface Pick {
  /** `Match::building_at` (the clicked cell only), or -1. */
  building: number;
  /** A structure at or within a few meters of the point (a fence cell, or
   *  a garrison on the clicked building), or -1. */
  structure: number;
  /** Repair cost of that structure, or -1 if nothing to repair or not a fence. */
  repairCost: number;
  /** Pull-down refund of that structure, or -1. */
  refund: number;
  revealed: boolean;
  wave: number;
}

export type Query =
  | { q: "pick"; x: number; y: number }
  | { q: "fence_length"; pts: number[] }
  /** Repair cost and pull-down refund of structure `id` now (the inspect panel). */
  | { q: "costs"; id: number }
  | { q: "agents" }; // test hook only: positions and render states of the agents in play

export type QueryResult =
  | { q: "pick"; pick: Pick }
  | { q: "fence_length"; length: number | null; error: string | null }
  /** -1: nothing to repair (or not a fence) / no refund. */
  | { q: "costs"; exists: boolean; repairCost: number; refund: number }
  | { q: "agents"; pts: number[]; states: number[] };

// ------------------------------------------------------------ messages

/** The map a match is built on: a whole level pack (`Match::new`, the
 *  built-in levels) or a streamed shell plus the chunks loaded so far
 *  (`Match::new_streaming`, picked places; later chunks come as `chunk`). */
export type MatchMap = { level: string } | { shell: string; chunks: BuildingChunk[] };

export type ToWorker =
  /** Build a match. `test` unlocks the test-only speeds and `pause_at`. */
  | { type: "init"; map: MatchMap; setup: { seed: string; deck?: string[]; population_multiplier?: number }; test?: boolean }
  /** A streamed block for `add_buildings`: added at once unless a wave
   *  runs, else queued until it ends. Answered by `map`. */
  | { type: "chunk"; chunk: BuildingChunk }
  | { type: "stop" }
  /** Queued and applied at the next tick boundary; answered by `action`. */
  | { type: "action"; id: number; action: Action }
  /** Only while a wave runs (ignored otherwise); every prep starts unpaused. */
  | { type: "pause"; paused: boolean }
  /** Flip the worker's own pause (same rule: only while a wave runs). The
   *  Pause button and Space send this, never `pause` with a value read from
   *  the last `status`, which may not reflect a press still in flight. */
  | { type: "pause_toggle" }
  /** 1, 2 or 4; with `test` also 16, and 0 = as fast as possible. */
  | { type: "speed"; speed: number }
  /** Test only: pause by itself once the match tick reaches `tick` while a
   *  wave runs (null clears; entering prep clears it too). Set to the prep's
   *  tick, the next wave starts paused. */
  | { type: "pause_at"; tick: number | null }
  | { type: "query"; id: number; query: Query }
  | { type: "field"; kind: "chase" | "flee" }
  | { type: "record"; id: number }
  | { type: "hash"; id: number }; // test hook only (?test=1)

export interface StaticLevel {
  /** Agent slots (the shared buffer's capacity). */
  capacity: number;
  gridW: number;
  gridH: number;
  cell: number;
  center: [number, number];
  /** Ring radius of each wave (index 0 = wave 1); the last is the level's. */
  rings: number[];
  hashDims: [number, number, number];
}

/** Applied buildings (grows when a reveal applies new chunks). */
export interface Geometry {
  buildingCoords: Float32Array;
  buildingOffsets: Uint32Array;
  /** 6 per building: centroid x, y, area m², floors, cells, wave (WasmMatch.building_info). */
  buildingInfo: Float32Array;
}

export interface Perf {
  simMsLast: number;
  simMsP95: number;
  paused: boolean;
  speed: number;
  pauseAt: number | null;
}

export type FromWorker =
  | { type: "ready"; level: StaticLevel; shared: SharedArrayBuffer | null }
  | { type: "geometry"; geometry: Geometry }
  | { type: "frame"; tick: number; time: number; count: number; pos: Float32Array; render: Uint8Array } // fallback mode only
  /** HUD numbers; sent after every published tick batch and every action. */
  | { type: "status"; status: MatchStatus; perf: Perf }
  /** Hand, structures, results: after actions and phase changes. */
  | { type: "state"; hand: HandCard[]; structures: Structure[]; results: WaveResult[]; attempts: WaveAttempt[] }
  /** Shooters [building or -1, x, y, range, kills] and fence cells [x, y, hp share]. */
  | { type: "placements"; towers: Float32Array; fences: Float32Array }
  | { type: "action"; id: number; action: Action; error: ActionError | null }
  /** `aborted` instead of a result when there is no match to ask (stopped,
   *  re-initialised) or the query is not allowed: the request settles. */
  | { type: "query"; id: number; result: QueryResult }
  | { type: "query"; id: number; aborted: true }
  | { type: "record"; id: number; json: string }
  | { type: "record"; id: number; aborted: true }
  | { type: "error"; message: string; fatal?: boolean }
  /** Streamed map bookkeeping (after an init or a `chunk`): blocks the match
   *  holds, blocks queued until the running wave ends, and the chunks the
   *  core refused (`AreaRevealed` and the like: never expected, reported
   *  loudly by the page). */
  | { type: "map"; stored: number; queued: number; refused: { block: number; error: string }[] }
  | { type: "field"; kind: "chase" | "flee"; data: Int32Array; w: number; h: number }
  | { type: "hash"; id: number; tick: number; hash: string }
  | { type: "hash"; id: number; aborted: true };

// ---- shared buffer: header, then 3 slots of (positions f32 x,y; render u8) ----
// Triple buffering: the worker writes slot (latest + 1) % 3 while the main
// thread reads `latest` and `latest - 1` to interpolate between two ticks.
// Slots hold `capacity` agents; H_COUNT is how many are in play.
export const SLOTS = 3;
export const HEADER_BYTES = 64;
// Int32 header indices
export const H_LATEST = 0;
export const H_TICK = 1;
export const H_SEQ = 2;
export const H_COUNT = 3;
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

/** Speeds the UI offers; the test hook may also use TEST_SPEEDS. */
export const SPEEDS = [1, 2, 4];
export const TEST_SPEEDS = [16, 0];
