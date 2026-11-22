// MapLoader: streams the blocks of a match, waves 1–2 first, the rest in the
// background closest ring first, served from the block cache when present.
//
// Usage:
//   const loader = new MapLoader({ center, ringRadii, cache: await IdbBlockCache.open() });
//   loader.on("chunk", (c) => match.add_buildings(c));   // background chunks only
//   const first = await loader.start();                  // waves 1–2, for Match::new_streaming
//   if (!loader.ringReady(3)) await loader.whenRingReady(3);
//
// Subscribe before `start()`: background chunks served from the cache are
// emitted right after `start()` resolves. `start()`'s chunks are not emitted
// as events (they go to `new_streaming`), so every block is delivered once.

import { blocksForDisc, blocksForRing, type BlockId, type LatLon } from "./blocks";
import { MemoryBlockCache, makeCachedBlock, type BlockStore, type CachedBlock } from "./cache";
import { BLOCK_MARGIN_M, projectBlock, snapshotHash, type BuildingChunk } from "./chunks";
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

export interface MapLoaderOptions {
  center: LatLon;
  /// Each wave's radius in meters (`Match::ring_radii` / `matchRingRadii`).
  ringRadii: number[];
  /// `match.block_margin_m`: a ring needs its blocks out to radius + margin.
  marginM?: number;
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
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface MapLoaderEvents {
  /// A background block is ready (in its level-local projection).
  chunk: BuildingChunk;
  /// Every block of waves 1..wave is now loaded.
  ring: number;
  /// A batch failed `maxAttempts` times; its blocks stay missing until `retryFailed()`.
  error: { blocks: BlockId[]; error: unknown };
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

export class MapLoader {
  readonly center: LatLon;
  readonly marginM: number;
  /// Blocks first needed by each wave (index 0 = wave 1), closest first.
  /// Wave w's blocks touch the disc of ringRadii[w-1] + margin but not the
  /// previous wave's disc; the union over waves 1..w covers disc w.
  readonly waveBlocks: BlockId[][];
  readonly stats: MapLoaderStats = { queries: 0, cacheHits: 0, fetched: 0 };

  private opts: Required<Omit<MapLoaderOptions, "fetch" | "urls" | "center" | "ringRadii" | "marginM">> & Pick<MapLoaderOptions, "fetch" | "urls">;
  private loaded = new Map<BlockId, BuildingChunk>();
  private hashes = new Map<BlockId, string>();
  private pending = new Set<BlockId>();
  private failed: BlockId[] = [];
  private listeners: { [K in keyof MapLoaderEvents]: Set<Listener<MapLoaderEvents[K]>> } = { chunk: new Set(), ring: new Set(), error: new Set() };
  private readyWaves = 0;
  private abortCtl = new AbortController();
  private background: Promise<void> | null = null;
  private emitChunks = false;

  constructor(o: MapLoaderOptions) {
    this.center = o.center;
    this.marginM = o.marginM ?? BLOCK_MARGIN_M;
    this.opts = {
      cache: o.cache ?? new MemoryBlockCache(),
      fetch: o.fetch,
      urls: o.urls,
      initialWaves: o.initialWaves ?? 2,
      concurrency: o.concurrency ?? 2,
      batchSize: o.batchSize ?? 6,
      maxAttempts: o.maxAttempts ?? 5,
      backoffMs: o.backoffMs ?? 1000,
      sleep: o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      now: o.now ?? (() => new Date()),
    };
    const discs = o.ringRadii.map((r) => r + this.marginM);
    this.waveBlocks = discs.map((r, w) =>
      w === 0 ? blocksForDisc(this.center.lat, this.center.lon, r) : blocksForRing(this.center, discs[w - 1], r),
    );
  }

  on<K extends keyof MapLoaderEvents>(ev: K, fn: Listener<MapLoaderEvents[K]>): () => void {
    this.listeners[ev].add(fn);
    return () => this.listeners[ev].delete(fn);
  }

  private emit<K extends keyof MapLoaderEvents>(ev: K, v: MapLoaderEvents[K]) {
    for (const fn of this.listeners[ev]) fn(v);
  }

  /// Load waves 1..initialWaves (cache, then network) and resolve with their
  /// chunks in block id order. Then starts the background load.
  async start(): Promise<BuildingChunk[]> {
    const n = Math.min(this.opts.initialWaves, this.waveBlocks.length);
    const first = this.waveBlocks.slice(0, n).flat();
    await this.load(first, true);
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
    const p = this.load(ids, false);
    this.background = Promise.all([this.background, p]).then(() => undefined);
    return p;
  }

  abort() {
    this.abortCtl.abort();
  }

  /// Same rule as sim-core `ring_ready`: every block touching the disc of
  /// wave `wave`'s radius + margin is loaded (waves <= 0 are always ready).
  ringReady(wave: number): boolean {
    const w = Math.min(wave, this.waveBlocks.length);
    for (let k = 0; k < w; k++) for (const id of this.waveBlocks[k]) if (!this.loaded.has(id)) return false;
    return true;
  }

  whenRingReady(wave: number): Promise<void> {
    if (this.ringReady(wave)) return Promise.resolve();
    return new Promise((res) => {
      const off = this.on("ring", () => {
        if (this.ringReady(wave)) {
          off();
          res();
        }
      });
    });
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
    while (this.readyWaves < this.waveBlocks.length && this.ringReady(this.readyWaves + 1)) {
      this.readyWaves++;
      this.emit("ring", this.readyWaves);
    }
  }

  /// Load `ids` in order: cached ones first, then the rest in batches.
  /// `initial`: failures reject instead of being reported as events.
  private async load(ids: BlockId[], initial: boolean): Promise<void> {
    const todo = ids.filter((id) => !this.loaded.has(id) && !this.pending.has(id));
    if (!todo.length) return;
    const cached = await this.opts.cache.getMany(todo);
    for (const id of todo) {
      const b = cached.get(id);
      if (b) {
        this.stats.cacheHits++;
        this.add(b);
      }
    }
    const missing = todo.filter((id) => !cached.has(id));
    missing.forEach((id) => this.pending.add(id));
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
          if (this.abortCtl.signal.aborted) {
            firstError = e;
            return;
          }
          if (initial) {
            firstError = e;
            return;
          }
          this.failed.push(...batch);
          this.emit("error", { blocks: batch, error: e });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.opts.concurrency, batches.length) }, worker));
    if (firstError !== null && (initial || !this.abortCtl.signal.aborted)) throw firstError;
  }

  private async fetchBatch(batch: BlockId[]): Promise<void> {
    const { maxAttempts, backoffMs, sleep } = this.opts;
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1));
      if (this.abortCtl.signal.aborted) throw new Error("aborted");
      this.stats.queries++;
      try {
        const got = await fetchBlocks(batch, { fetch: this.opts.fetch, urls: this.opts.urls, signal: this.abortCtl.signal });
        const now = this.opts.now();
        for (const id of batch) {
          const block = makeCachedBlock(id, got.get(id) ?? [], now);
          try {
            await this.opts.cache.put(block);
          } catch {
            // The cache is best effort (quota, private mode): keep playing.
          }
          this.stats.fetched++;
          this.pending.delete(id);
          this.add(block);
        }
        return;
      } catch (e) {
        lastErr = e;
        if (this.abortCtl.signal.aborted) throw e;
      }
    }
    throw lastErr;
  }
}
