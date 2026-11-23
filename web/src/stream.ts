// Glue between the map loader (`map/`) and the match: the shell of a picked
// place, its ring radii, the worker's chunk queue, the "next district" gate
// and the map bundle a tester downloads next to the run record
// (DECISIONS.md, "Streaming map (T6b)"). No game logic: the core decides what
// a chunk does, this only decides when it is handed over.

import config from "../../config.default.json";
import type { BlockId } from "./map/blocks";
import type { BuildingChunk } from "./map/chunks";
import { matchRingRadii, type MapLoader } from "./map/loader";

/// The wave-8 radius (`wave8_radius_m`, 1300 m): a picked place's play area.
export const PLAY_RADIUS_M: number = config.wave8_radius_m;
/// Below this many buildings in the waves 1–2 blocks the place is too empty to play.
export const PLAYABLE_MIN_BUILDINGS = 40;

/// A level pack without buildings (sim-core `LevelPack` as a shell).
export interface ShellJson {
  name: string;
  center_lat: number;
  center_lon: number;
  radius_m: number;
  buildings: never[];
  fences: never[];
}

/// The shell of a picked place: its centre (rounded to 1e-6°, ~10 cm, so
/// records and file names stay readable), the wave-8 radius, no buildings
/// and no fences. Throws when the centre is not a latitude / longitude.
export function buildShell(name: string, lat: number, lon: number): ShellJson {
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
  const shell: ShellJson = { name, center_lat: r6(lat), center_lon: r6(lon), radius_m: PLAY_RADIUS_M, buildings: [], fences: [] };
  const bad = shellProblem(shell);
  if (bad) throw new Error(bad);
  return shell;
}

/// Why sim-core's `ShellLimits` would refuse this shell, or null. Mirrors
/// the checks a buildings-free, fence-free, radius-only shell can fail.
export function shellProblem(s: ShellJson): string | null {
  if (!Number.isFinite(s.center_lat) || Math.abs(s.center_lat) > 90 || !Number.isFinite(s.center_lon) || Math.abs(s.center_lon) > 180) {
    return `centre ${s.center_lat} / ${s.center_lon} is not a latitude / longitude`;
  }
  // The block grid doesn't handle the antimeridian (DECISIONS "Map blocks").
  if (Math.abs(s.center_lon) > 179) return "places next to the antimeridian are not supported";
  if (Math.abs(s.center_lat) > 85) return "places this close to a pole are not supported";
  if (!(Number.isFinite(s.radius_m) && s.radius_m > 0)) return `radius ${s.radius_m} must be finite and positive`;
  if (s.buildings.length || s.fences.length) return "a shell has no buildings and no fences";
  return null;
}

/// Each wave's ring radius on this shell (`Match::ring_radii`).
export function shellRingRadii(s: ShellJson): number[] {
  return matchRingRadii(config.match.ring_radius_m, config.wave8_radius_m, s.radius_m);
}

export function buildingCount(chunks: BuildingChunk[]): number {
  return chunks.reduce((a, c) => a + c.buildings.length, 0);
}

/// The "too empty" message, or null when the first blocks have enough buildings.
export function tooEmpty(first: BuildingChunk[]): string | null {
  const n = buildingCount(first);
  if (n >= PLAYABLE_MIN_BUILDINGS) return null;
  // The count is over whole blocks (about 250 m on a side), so no distance is claimed.
  return `Only ${n} building${n === 1 ? "" : "s"} around the pin. Pick a more built-up spot.`;
}

// ------------------------------------------------------------ worker queue

export interface ChunkRefusal {
  block: BlockId;
  /// The core's `MatchError` text.
  error: string;
}

/// The worker's chunks waiting for `add_buildings`. Chunks are added only
/// while no wave runs (prep and the result screens); one arriving mid-wave
/// waits for the wave's end. A block is handed over once: repeats (a block
/// the match was built with, a duplicate message) are dropped here.
export class ChunkQueue {
  private q: BuildingChunk[] = [];
  private seen = new Set<BlockId>();
  /// Blocks the match holds (built with or added).
  stored = 0;

  /// Forget everything: a new match built with `initial` blocks.
  reset(initial: BlockId[] = []) {
    this.q = [];
    this.seen = new Set(initial);
    this.stored = initial.length;
  }

  push(c: BuildingChunk) {
    if (this.seen.has(c.block_id)) return;
    this.seen.add(c.block_id);
    this.q.push(c);
  }

  get size(): number {
    return this.q.length;
  }

  /// Hand every queued chunk to `add` (`WasmMatch.add_buildings`), in
  /// block id order, unless a wave runs (`phase` "running": they wait for
  /// its end). Order never matters to the core (it applies stored chunks in
  /// block id order at each reveal); sorting only makes the worker's calls
  /// reproducible. A refused chunk is reported, not retried.
  flush(phase: string, add: (c: BuildingChunk) => void): ChunkRefusal[] {
    if (phase === "running") return [];
    const todo = this.q.sort((a, b) => a.block_id - b.block_id);
    this.q = [];
    const refused: ChunkRefusal[] = [];
    for (const c of todo) {
      try {
        add(c);
        this.stored++;
      } catch (e) {
        refused.push({ block: c.block_id, error: errorText(e) });
      }
    }
    return refused;
  }
}

/// A WASM error (a JSON string with a `message`, or anything else) as text.
export function errorText(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  try {
    const j = JSON.parse(s);
    if (j && typeof j.message === "string") return j.message;
  } catch {
    /* plain text */
  }
  return s;
}

// ------------------------------------------------------------ district gate

export interface GateView {
  /// Waiting: `loaded` of `needed` blocks of waves 1..wave are in.
  progress(wave: number, loaded: number, needed: number): void;
  /// A block failed for good: show `message` and a Retry loading button.
  failed(wave: number, message: string): void;
  /// Done waiting (ready, or cancelled).
  hide(): void;
}

type GateLoader = Pick<MapLoader, "ringReady" | "ringProgress" | "whenRingReady" | "retryFailed" | "on">;

/// Waits for a ring before Next wave (or Start): "Loading the next
/// district…" with the block count, an error with Retry loading on a
/// permanent failure. One wait at a time; a new wait or `cancel()` ends the
/// previous one with `false`.
export class DistrictGate {
  /// `failed`: the error and Retry loading are showing. Chunks of other
  /// rings keep arriving then (the loader goes on with its other batches);
  /// they must not turn the banner back to progress, which would hide Retry
  /// loading while nothing listens for the ring any more.
  private current: { wave: number; failed: boolean; done: (ok: boolean) => void } | null = null;

  constructor(
    private loader: GateLoader,
    private view: GateView,
  ) {}

  get waiting(): number | null {
    return this.current?.wave ?? null;
  }

  /// Resolves true once ring `wave` is loaded (at once if it already is),
  /// false when cancelled.
  wait(wave: number): Promise<boolean> {
    this.cancel();
    if (this.loader.ringReady(wave)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const show = () => {
        if (this.current?.wave !== wave || this.current.failed) return;
        const p = this.loader.ringProgress(wave);
        this.view.progress(wave, p.loaded, p.needed);
      };
      // Failures need no listener: the loader rejects `whenRingReady`.
      const off = this.loader.on("chunk", show);
      this.current = {
        wave,
        failed: false,
        done: (ok) => {
          off();
          this.view.hide();
          resolve(ok);
        },
      };
      show();
      this.listen(wave);
    });
  }

  /// (Re)subscribe to the ring: resolves the wait, or shows the failure.
  private listen(wave: number) {
    const cur = this.current;
    if (!cur || cur.wave !== wave) return;
    this.loader.whenRingReady(wave).then(
      () => {
        if (this.current === cur) {
          this.current = null;
          cur.done(true);
        }
      },
      (e: unknown) => {
        if (this.current !== cur) return;
        if ((e as Error)?.name === "AbortError") {
          this.current = null;
          cur.done(false);
          return;
        }
        cur.failed = true;
        this.view.failed(wave, (e as Error)?.message ?? String(e));
      },
    );
  }

  /// Retry loading the failed blocks and keep waiting.
  retry() {
    const cur = this.current;
    if (!cur || !cur.failed) return;
    cur.failed = false;
    void this.loader.retryFailed();
    const pr = this.loader.ringProgress(cur.wave);
    this.view.progress(cur.wave, pr.loaded, pr.needed);
    this.listen(cur.wave);
  }

  cancel() {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    cur.done(false);
  }
}

// ------------------------------------------------------------ map bundle

/// What "Download map" saves: the shell (a LevelPack without buildings, so
/// it is `--shell`) plus `chunks`, the blocks the run record lists, in block
/// id order (so it is also `--chunks`): `sim-headless verify run.json
/// --chunks map.json --shell map.json`.
export interface MapBundle extends ShellJson {
  chunks: BuildingChunk[];
}

/// The bundle of a record's blocks (`record.map.blocks`) taken from the
/// loaded chunks. Throws when one is missing (it can't be: the match only
/// holds chunks the loader gave it).
export function mapBundle(shell: ShellJson, loaded: BuildingChunk[], blocks: BlockId[]): MapBundle {
  const byId = new Map(loaded.map((c) => [c.block_id, c]));
  const chunks = [...blocks].sort((a, b) => a - b).map((id) => {
    const c = byId.get(id);
    if (!c) throw new Error(`block ${id} of the record is not loaded`);
    return c;
  });
  return { ...shell, chunks };
}
