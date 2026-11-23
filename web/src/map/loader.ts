// MapLoader: streams the blocks of a match, waves 1–2 first, the rest in the
// background closest ring first, served from the block cache when present.
//
// Usage:
//   const loader = new MapLoader({ center, ringRadii, cache: await openBlockCache() });
//   loader.on("chunk", (c) => match.add_buildings(c));   // background chunks only
//   const first = await loader.start();                  // waves 1–2, for Match::new_streaming
//   if (!loader.ringReady(3)) await loader.whenRingReady(3);
//
// Subscribe before `start()`: background chunks served from the cache are
// emitted right after `start()` resolves. `start()`'s chunks are not emitted
// as events (they go to `new_streaming`), so every block is delivered once.
// `start()` may be called again after it rejects: it only fetches the
// initial blocks still missing.
//
// Listeners are isolated from the loader: an exception thrown by a `chunk`,
// `ring` or `error` listener is caught (the other listeners still run, the
// block stays loaded, no refetch, `start()` is unaffected) and reported as a
// `listenerError` event. With no `listenerError` listener, or when one of
// those throws too, the error is rethrown from a microtask so it still shows
// as an uncaught error in the console.

import { blocksForDisc, blocksForRing, type BlockId, type LatLon } from "./blocks";
import { MemoryBlockCache, makeCachedBlock, type BlockStore, type CachedBlock } from "./cache";
import { BLOCK_MARGIN_M, CELL_SIZE_M, projectBlock, snapshotHash, type BuildingChunk } from "./chunks";
import type { FetchFn } from "./osm";
import { fetchBlocks } from "./overpass";

/// JS port of sim-core `Match::ring_radii` (f32 arithmetic via Math.fround):
/// each wave's radius on a level of radius `levelR`. On a level at least as
/// large as `wave8RadiusM` the config rings; otherwise the core keeps its
/// size and the other rings are squeezed between it and the level edge.
export function matchRingRadii(ringRadiusM: number[], wave8RadiusM: number, levelR: number): number[] {
  const f = Math.fround;
  const cap = f(wave8RadiusM);
  const l = Math.min(f(levelR), cap);
  const r1 = f(ringRadiusM[0]);
  return ringRadiusM.map((rr) => {
    const r = f(rr);
    if (l >= cap) return r;
    if (l > r1) return f(r1 + f(f(r - r1) * f(f(l - r1) / f(cap - r1))));
    return f(r * f(l / cap));
  });
}

/// Default `coverageSlackM`: one cell diagonal (`cell_size_m × √2`, 2.83 m).
export const DEFAULT_COVERAGE_SLACK_M = CELL_SIZE_M * Math.SQRT2;

export interface MapLoaderOptions {
  center: LatLon;
  /// Each wave's radius in meters (`Match::ring_radii` / `matchRingRadii`).
  ringRadii: number[];
  /// `match.block_margin_m`: a ring needs its blocks out to radius + margin.
  marginM?: number;
  /// Extra radius on top of radius + margin (default `cell_size_m × √2`).
  /// sim-core's `ring_ready` checks the cells within radius +
  /// `match_::ring_band_m` (margin + one cell diagonal, DECISIONS.md
  /// "Match"), so the default slack loads exactly that disc (blocks touching
  /// it, with `TOUCH_EPS_M` to spare). A smaller slack may load less than
  /// `ring_ready` needs.
  coverageSlackM?: number;
  cache?: BlockStore;
  fetch?: FetchFn;
  /// Overpass endpoints (default: `OVERPASS_URLS`).
  urls?: string[];
  /// Waves loaded by `start()` (default 2).
  initialWaves?: number;
  /// Overpass queries in flight at once (default 2).
  concurrency?: number;
  /// Blocks per Overpass query (default 6).
  batchSize?: number;
  /// Attempts per query before giving up (default 5).
  maxAttempts?: number;
  /// Delay before the first retry, doubled after each failure (default 1000 ms).
  backoffMs?: number;
  /// Cached blocks older than this are fetched again (default: no expiry).
  maxAgeMs?: number;
  /// Backoff sleep. `abort()` cuts it short whether or not it honours `signal`.
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => Date;
}

export interface MapLoaderEvents {
  /// A background block is ready (in its level-local projection).
  chunk: BuildingChunk;
  /// Every block of waves 1..wave is now loaded.
  ring: number;
  /// A batch failed `maxAttempts` times; its blocks stay missing until `retryFailed()`.
  error: { blocks: BlockId[]; error: unknown };
  /// A listener of another event threw; the loader carried on regardless.
  listenerError: { event: "chunk" | "ring" | "error"; error: unknown };
}

export interface MapLoaderStats {
  /// Overpass queries attempted (each may try several endpoints).
  queries: number;
  /// Blocks served from the cache.
  cacheHits: number;
  /// Blocks downloaded.
  fetched: number;
}

type Listener<T> = (v: T) => void;

interface Waiter {
  wave: number;
  res: () => void;
  rej: (e: Error) => void;
}

export function abortError(): Error {
  const e = new Error("map loading aborted");
  e.name = "AbortError";
  return e;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), res()), { once: true });
  });

/// `sleep(ms)`, rejected with `abortError()` as soon as `signal` aborts.
function abortableSleep(sleep: (ms: number, signal?: AbortSignal) => Promise<void>, ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((res, rej) => {
    const onAbort = () => rej(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    sleep(ms, signal).then(
      () => (signal.removeEventListener("abort", onAbort), res()),
      (e) => (signal.removeEventListener("abort", onAbort), rej(e)),
    );
  });
}

export class MapLoader {
  readonly center: LatLon;
  readonly marginM: number;
  readonly coverageSlackM: number;
  /// Blocks first needed by each wave (index 0 = wave 1), closest first.
  /// Wave w's blocks touch the disc of ringRadii[w-1] + margin + slack but
  /// not the previous wave's disc; the union over waves 1..w covers disc w.
  readonly waveBlocks: BlockId[][];
  readonly stats: MapLoaderStats = { queries: 0, cacheHits: 0, fetched: 0 };

  private opts: Required<Omit<MapLoaderOptions, "fetch" | "urls" | "center" | "ringRadii" | "marginM" | "coverageSlackM">> & Pick<MapLoaderOptions, "fetch" | "urls">;
  private loaded = new Map<BlockId, BuildingChunk>();
  private hashes = new Map<BlockId, string>();
  /// Blocks claimed by a running `load` (cache read or network).
  private pending = new Set<BlockId>();
  /// Background blocks that failed, for `retryFailed()`.
  private failed: BlockId[] = [];
  /// Blocks that failed for good (until `retryFailed()` or `start()` again).
  private unavailable = new Map<BlockId, unknown>();
  /// Wave index (0-based) of each block.
  private waveOf = new Map<BlockId, number>();
  private waiters = new Set<Waiter>();
  private listeners: { [K in keyof MapLoaderEvents]: Set<Listener<MapLoaderEvents[K]>> } = {
    chunk: new Set(),
    ring: new Set(),
    error: new Set(),
    listenerError: new Set(),
  };
  private readyWaves = 0;
  private abortCtl = new AbortController();
  private starting: Promise<BuildingChunk[]> | null = null;
  private background: Promise<void> | null = null;
  private emitChunks = false;

  constructor(o: MapLoaderOptions) {
    this.center = o.center;
    this.marginM = o.marginM ?? BLOCK_MARGIN_M;
    this.coverageSlackM = o.coverageSlackM ?? DEFAULT_COVERAGE_SLACK_M;
    if (!(this.coverageSlackM >= 0)) throw new Error(`coverageSlackM must be >= 0 (${this.coverageSlackM})`);
    this.opts = {
      cache: o.cache ?? new MemoryBlockCache(),
      fetch: o.fetch,
      urls: o.urls,
      initialWaves: o.initialWaves ?? 2,
      concurrency: o.concurrency ?? 2,
      batchSize: o.batchSize ?? 6,
      maxAttempts: o.maxAttempts ?? 5,
      backoffMs: o.backoffMs ?? 1000,
      maxAgeMs: o.maxAgeMs ?? Infinity,
      sleep: o.sleep ?? defaultSleep,
      now: o.now ?? (() => new Date()),
    };
    const discs = o.ringRadii.map((r) => r + this.marginM + this.coverageSlackM);
    this.waveBlocks = discs.map((r, w) =>
      w === 0 ? blocksForDisc(this.center.lat, this.center.lon, r) : blocksForRing(this.center, discs[w - 1], r),
    );
    this.waveBlocks.forEach((ids, w) => ids.forEach((id) => this.waveOf.set(id, w)));
  }

  on<K extends keyof MapLoaderEvents>(ev: K, fn: Listener<MapLoaderEvents[K]>): () => void {
    this.listeners[ev].add(fn);
    return () => this.listeners[ev].delete(fn);
  }

  /// Calls every listener of `ev`; a throwing listener never reaches the
  /// loader (see the header: `listenerError`, else a microtask rethrow).
  /// Once aborted (possibly by one of these listeners) no further `chunk` or
  /// `ring` listener is called.
  private emit<K extends keyof MapLoaderEvents>(ev: K, v: MapLoaderEvents[K]) {
    const stopOnAbort = ev === "chunk" || ev === "ring";
    for (const fn of [...this.listeners[ev]]) {
      if (stopOnAbort && this.abortCtl.signal.aborted) return;
      try {
        fn(v);
      } catch (error) {
        if (ev === "listenerError" || !this.listeners.listenerError.size) {
          queueMicrotask(() => {
            throw error;
          });
        } else {
          this.emit("listenerError", { event: ev as "chunk" | "ring" | "error", error });
        }
      }
    }
  }

  /// Load waves 1..initialWaves (cache, then network) and resolve with their
  /// chunks in block id order. Then starts the background load. Concurrent
  /// calls share one load; after a success it resolves with the same chunks;
  /// after a rejection it can be called again (only the missing blocks are
  /// fetched).
  start(): Promise<BuildingChunk[]> {
    if (!this.starting) {
      const p = this.runStart();
      this.starting = p;
      p.catch(() => {
        if (this.starting === p) this.starting = null;
      });
    }
    return this.starting;
  }

  private async runStart(): Promise<BuildingChunk[]> {
    const n = Math.min(this.opts.initialWaves, this.waveBlocks.length);
    const first = this.waveBlocks.slice(0, n).flat();
    const signal = this.abortCtl.signal;
    if (signal.aborted) throw abortError();
    for (const id of first) this.unavailable.delete(id);
    await this.load(first, true);
    // A warm cache makes `load` succeed without a network await: check again.
    if (signal.aborted) throw abortError();
    const missing = first.filter((id) => !this.loaded.has(id));
    if (missing.length) throw new Error(`${missing.length} map blocks of the first waves are not loaded`);
    const chunks = first.map((id) => this.loaded.get(id)!).sort((a, b) => a.block_id - b.block_id);
    this.emitChunks = true;
    this.background = this.load(this.waveBlocks.slice(n).flat(), false);
    return chunks;
  }

  /// Resolves when the background load has finished (failed batches included).
  async done(): Promise<void> {
    await this.background;
  }

  /// Re-queue the blocks of failed batches (background).
  retryFailed(): Promise<void> {
    const ids = this.failed;
    this.failed = [];
    for (const id of ids) this.unavailable.delete(id);
    const p = this.load(ids, false);
    this.background = Promise.all([this.background, p]).then(() => undefined);
    return p;
  }

  /// Stop loading: requests and backoff sleeps are cut short, `start()`
  /// rejects (even when every initial block is cached) and pending
  /// `whenRingReady` promises reject with an AbortError. No block is added
  /// and no `chunk` or `ring` event is emitted after it.
  abort() {
    this.abortCtl.abort();
    const e = abortError();
    for (const w of this.waiters) w.rej(e);
    this.waiters.clear();
  }

  /// Every block touching the disc of wave `wave`'s radius + margin + slack
  /// is loaded (waves <= 0 are always ready). With slack >= one cell
  /// diagonal (the default) this implies sim-core's `ring_ready`: every
  /// cell within radius + `ring_band_m` (margin + one cell diagonal) is
  /// covered.
  ringReady(wave: number): boolean {
    const w = Math.min(wave, this.waveBlocks.length);
    for (let k = 0; k < w; k++) for (const id of this.waveBlocks[k]) if (!this.loaded.has(id)) return false;
    return true;
  }

  /// How many of the blocks waves 1..wave need are loaded, out of how many.
  ringProgress(wave: number): { loaded: number; needed: number } {
    const w = Math.min(Math.max(wave, 0), this.waveBlocks.length);
    let loaded = 0;
    let needed = 0;
    for (let k = 0; k < w; k++)
      for (const id of this.waveBlocks[k]) {
        needed++;
        if (this.loaded.has(id)) loaded++;
      }
    return { loaded, needed };
  }

  /// Resolves when `ringReady(wave)`. Rejects after `abort()`, or when a
  /// block the wave needs failed for good (all attempts used; a later
  /// `retryFailed()` can still load it, call `whenRingReady` again then).
  whenRingReady(wave: number): Promise<void> {
    if (this.ringReady(wave)) return Promise.resolve();
    const err = this.ringError(wave);
    if (err) return Promise.reject(err);
    return new Promise((res, rej) => this.waiters.add({ wave, res, rej }));
  }

  /// Why wave `wave` can't become ready without outside help, or null.
  private ringError(wave: number): Error | null {
    if (this.abortCtl.signal.aborted) return abortError();
    let n = 0;
    let cause: unknown;
    for (const [id, e] of this.unavailable) {
      if (this.waveOf.get(id)! < wave) {
        n++;
        cause ??= e;
      }
    }
    if (!n) return null;
    return new Error(`map ring ${wave} can't be loaded: ${n} block${n > 1 ? "s" : ""} failed (${String((cause as Error)?.message ?? cause)})`, { cause });
  }

  private markUnavailable(ids: BlockId[], error: unknown) {
    for (const id of ids) this.unavailable.set(id, error);
    for (const w of [...this.waiters]) {
      const e = this.ringError(w.wave);
      if (e) {
        this.waiters.delete(w);
        w.rej(e);
      }
    }
  }

  /// Every loaded chunk, in block id order.
  chunks(): BuildingChunk[] {
    return [...this.loaded.values()].sort((a, b) => a.block_id - b.block_id);
  }

  /// The map snapshot hash of every chunk loaded so far.
  snapshotHash(): string {
    return snapshotHash(this.chunks());
  }

  /// Content hashes (raw lat/lon, `blockContentHash`) of the loaded blocks.
  blockHashes(): Map<BlockId, string> {
    return new Map(this.hashes);
  }

  private add(block: CachedBlock) {
    if (this.loaded.has(block.id)) return;
    const chunk = projectBlock(block, this.center);
    this.loaded.set(block.id, chunk);
    this.hashes.set(block.id, block.hash);
    if (this.emitChunks) this.emit("chunk", chunk);
    // A chunk or ring listener may abort: then no ring event follows.
    if (this.abortCtl.signal.aborted) return;
    while (!this.abortCtl.signal.aborted && this.readyWaves < this.waveBlocks.length && this.ringReady(this.readyWaves + 1)) {
      this.readyWaves++;
      this.emit("ring", this.readyWaves);
    }
    for (const w of [...this.waiters]) {
      if (this.ringReady(w.wave)) {
        this.waiters.delete(w);
        w.res();
      }
    }
  }

  private fresh(b: CachedBlock): boolean {
    const max = this.opts.maxAgeMs;
    if (max === Infinity) return true;
    const age = this.opts.now().getTime() - Date.parse(b.fetchedAt);
    return age <= max;
  }

  /// Load `ids` in order: cached ones first, then the rest in batches.
  /// `initial`: failures reject instead of being reported as events.
  /// Whatever happens, the blocks it claimed and didn't load are released.
  private async load(ids: BlockId[], initial: boolean): Promise<void> {
    const todo = ids.filter((id) => !this.loaded.has(id) && !this.pending.has(id));
    if (!todo.length) return;
    for (const id of todo) this.pending.add(id);
    try {
      let cached: Map<BlockId, CachedBlock>;
      try {
        cached = await this.opts.cache.getMany(todo);
      } catch {
        // Like writes, reads are best effort (closed connection, quota, ...).
        cached = new Map();
      }
      for (const id of todo) {
        // Once aborted nothing more is added (a listener may abort mid-loop).
        if (this.abortCtl.signal.aborted) break;
        const b = cached.get(id);
        if (b && this.fresh(b)) {
          this.stats.cacheHits++;
          this.pending.delete(id);
          this.add(b);
        }
      }
      if (this.abortCtl.signal.aborted) {
        if (initial) throw abortError();
        return;
      }
      const missing = todo.filter((id) => !this.loaded.has(id));
      const batches: BlockId[][] = [];
      for (let i = 0; i < missing.length; i += this.opts.batchSize) batches.push(missing.slice(i, i + this.opts.batchSize));
      let next = 0;
      let firstError: unknown = null;
      const worker = async () => {
        while (next < batches.length && firstError === null) {
          const batch = batches[next++];
          try {
            await this.fetchBatch(batch);
          } catch (e) {
            batch.forEach((id) => this.pending.delete(id));
            if (initial || this.abortCtl.signal.aborted) {
              firstError = e;
              return;
            }
            this.failed.push(...batch);
            this.markUnavailable(batch, e);
            this.emit("error", { blocks: batch, error: e });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.opts.concurrency, batches.length) }, worker));
      if (firstError !== null) {
        if (!this.abortCtl.signal.aborted) this.markUnavailable(todo.filter((id) => !this.loaded.has(id)), firstError);
        if (initial || !this.abortCtl.signal.aborted) throw firstError;
      }
    } finally {
      for (const id of todo) if (!this.loaded.has(id)) this.pending.delete(id);
    }
  }

  private async fetchBatch(batch: BlockId[]): Promise<void> {
    const { maxAttempts, backoffMs, sleep } = this.opts;
    const signal = this.abortCtl.signal;
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) await abortableSleep(sleep, backoffMs * 2 ** (attempt - 1), signal);
      if (signal.aborted) throw abortError();
      this.stats.queries++;
      try {
        const got = await fetchBlocks(batch, { fetch: this.opts.fetch, urls: this.opts.urls, signal });
        if (signal.aborted) throw abortError();
        const now = this.opts.now();
        for (const id of batch) {
          const block = makeCachedBlock(id, got.get(id) ?? [], now);
          try {
            await this.opts.cache.put(block);
          } catch {
            // The cache is best effort (quota, private mode): keep playing.
          }
          if (signal.aborted) throw abortError();
          this.stats.fetched++;
          this.pending.delete(id);
          this.add(block);
        }
        return;
      } catch (e) {
        lastErr = e;
        if (signal.aborted) throw abortError();
      }
    }
    throw lastErr;
  }
}
