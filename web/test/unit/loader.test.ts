import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { blockAt, blockBoundsLocal, blockDistanceM, blocksForDisc, type BlockId } from "../../src/map/blocks";
import { IdbBlockCache, MemoryBlockCache, SCHEMA_VERSION, type CachedBlock } from "../../src/map/cache";
import { project } from "../../src/map/osm";
import { CLIP_MARGIN_M, snapshotHash, type BuildingChunk } from "../../src/map/chunks";
import { DEFAULT_COVERAGE_SLACK_M, MapLoader, matchRingRadii } from "../../src/map/loader";
import { fakeOverpass, loadConfig, loadLevel, parseBboxes, timeoutBody, waysFromLevel, type FakeCall } from "./fixtures";

const cfg = loadConfig();
const level = loadLevel("paris-marais");
const CENTER = { lat: level.center_lat, lon: level.center_lon };
const ways = waysFromLevel(level);
const RINGS = matchRingRadii(cfg.match.ring_radius_m, cfg.wave8_radius_m, cfg.wave8_radius_m);
const MARGIN = cfg.match.block_margin_m;
/// The default coverage slack: one cell diagonal.
const SLACK = cfg.cell_size_m * Math.SQRT2;

/// The block ids a query asked for (each box's centre).
const blocksOf = (c: FakeCall): BlockId[] => c.bboxes.map(([s, w, n, e]) => blockAt((s + n) / 2, (w + e) / 2));
const noSleep = async () => {};

function makeLoader(fake: ReturnType<typeof fakeOverpass>, extra: Partial<ConstructorParameters<typeof MapLoader>[0]> = {}) {
  return new MapLoader({ center: CENTER, ringRadii: RINGS, cache: new MemoryBlockCache(), fetch: fake.fetch, urls: ["https://overpass.test/api"], sleep: noSleep, ...extra });
}

describe("matchRingRadii (port of Match::ring_radii)", () => {
  it("keeps the config rings on a full-size level", () => {
    expect(RINGS).toEqual(cfg.match.ring_radius_m);
  });
  it("squeezes the outer rings on a small level", () => {
    const r = matchRingRadii(cfg.match.ring_radius_m, cfg.wave8_radius_m, 400);
    expect(r[0]).toBe(150);
    expect(r[7]).toBe(400);
    expect(r[1]).toBeCloseTo(150 + 150 * (250 / 1150), 3);
    for (let i = 1; i < 8; i++) expect(r[i]).toBeGreaterThan(r[i - 1]);
    const tiny = matchRingRadii(cfg.match.ring_radius_m, cfg.wave8_radius_m, 100);
    expect(tiny[0]).toBeCloseTo(150 * (100 / 1300), 4);
  });
});

describe("MapLoader", () => {
  it("splits the blocks by wave (disc of ring radius + margin + slack)", () => {
    const l = makeLoader(fakeOverpass([]));
    expect(l.coverageSlackM).toBe(SLACK);
    expect(DEFAULT_COVERAGE_SLACK_M).toBeCloseTo(2.828, 3);
    expect(l.waveBlocks).toHaveLength(8);
    for (let w = 1; w <= 8; w++) {
      const union = l.waveBlocks.slice(0, w).flat().sort((a, b) => a - b);
      expect(union).toEqual(blocksForDisc(CENTER.lat, CENTER.lon, RINGS[w - 1] + MARGIN + SLACK).sort((a, b) => a - b));
      // A superset of the blocks for today's sim-core rule (radius + margin).
      const today = new Set(union);
      for (const id of blocksForDisc(CENTER.lat, CENTER.lon, RINGS[w - 1] + MARGIN)) expect(today.has(id)).toBe(true);
    }
    const tight = makeLoader(fakeOverpass([]), { coverageSlackM: 0 });
    for (let w = 1; w <= 8; w++) {
      const union = tight.waveBlocks.slice(0, w).flat().sort((a, b) => a - b);
      expect(union).toEqual(blocksForDisc(CENTER.lat, CENTER.lon, RINGS[w - 1] + MARGIN).sort((a, b) => a - b));
    }
    expect(() => makeLoader(fakeOverpass([]), { coverageSlackM: -1 })).toThrow(/coverageSlackM/);
  });

  it("requests only the waves 1–2 blocks first, then the rest closest ring first", async () => {
    const fake = fakeOverpass(ways);
    const l = makeLoader(fake, { concurrency: 1, batchSize: 4 });
    const events: BuildingChunk[] = [];
    const rings: number[] = [];
    l.on("chunk", (c) => events.push(c));
    l.on("ring", (w) => rings.push(w));
    const first = await l.start();
    const initial = new Set([...l.waveBlocks[0], ...l.waveBlocks[1]]);
    const firstCalls = fake.calls.length;
    expect(firstCalls).toBe(Math.ceil(initial.size / 4));
    const askedFirst = fake.calls.flatMap(blocksOf);
    expect(new Set(askedFirst)).toEqual(initial);
    expect(first.map((c) => c.block_id)).toEqual([...initial].sort((a, b) => a - b));
    expect(l.ringReady(2)).toBe(true);
    expect(l.ringReady(3)).toBe(false);
    expect(first.reduce((n, c) => n + c.buildings.length, 0)).toBeGreaterThan(100);

    await l.done();
    expect(l.ringReady(8)).toBe(true);
    expect(rings).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const later = fake.calls.slice(firstCalls).flatMap(blocksOf);
    expect(later).toEqual(l.waveBlocks.slice(2).flat()); // ring by ring, closest first
    expect(events.map((c) => c.block_id)).toEqual(later);
    const waveOf = new Map(l.waveBlocks.flatMap((ids, w) => ids.map((id) => [id, w] as const)));
    const ws = events.map((c) => waveOf.get(c.block_id)!);
    for (let i = 1; i < ws.length; i++) expect(ws[i]).toBeGreaterThanOrEqual(ws[i - 1]);
    // Every block of the wave-8 disc is delivered exactly once.
    expect(first.length + events.length).toBe(l.waveBlocks.flat().length);
    expect(l.chunks().map((c) => c.block_id)).toEqual(l.waveBlocks.flat().sort((a, b) => a - b));
    expect(l.stats).toMatchObject({ queries: fake.calls.length, cacheHits: 0, fetched: l.waveBlocks.flat().length });
  });

  it("serves a second visit from the IndexedDB cache with zero requests", async () => {
    const idb = new IDBFactory();
    const fake = fakeOverpass(ways);
    const c1 = await IdbBlockCache.open({ indexedDB: idb });
    const a = makeLoader(fake, { cache: c1 });
    await a.start();
    await a.done();
    const n = fake.calls.length;
    expect(n).toBeGreaterThan(0);
    c1.close();

    const fake2 = fakeOverpass(ways);
    const c2 = await IdbBlockCache.open({ indexedDB: idb });
    const b = makeLoader(fake2, { cache: c2 });
    const events: number[] = [];
    b.on("chunk", (c) => events.push(c.block_id));
    const first = await b.start();
    await b.done();
    expect(fake2.calls).toHaveLength(0);
    expect(b.stats.queries).toBe(0);
    expect(b.stats.cacheHits).toBe(b.waveBlocks.flat().length);
    expect(b.snapshotHash()).toBe(a.snapshotHash());
    expect(b.chunks()).toEqual(a.chunks());
    expect(first.length + events.length).toBe(b.waveBlocks.flat().length);
    expect(b.blockHashes()).toEqual(a.blockHashes());
    c2.close();
  });

  it("shares cached blocks with a nearby match centre", async () => {
    const cache = new MemoryBlockCache();
    const fake = fakeOverpass(ways);
    const a = makeLoader(fake, { cache, ringRadii: [150, 300] });
    await a.start();
    const n = fake.calls.length;
    const b = new MapLoader({ center: { lat: CENTER.lat + 0.001, lon: CENTER.lon }, ringRadii: [150, 300], cache, fetch: fake.fetch, urls: ["u"], sleep: noSleep });
    await b.start();
    const newBlocks = fake.calls.slice(n).flatMap(blocksOf);
    const reused = b.waveBlocks.flat().filter((id) => a.waveBlocks.flat().includes(id));
    expect(reused.length).toBeGreaterThan(0);
    for (const id of reused) expect(newBlocks).not.toContain(id);
    expect(b.stats.cacheHits).toBe(reused.length);
  });

  it("retries with exponential backoff", async () => {
    const fake = fakeOverpass(ways);
    fake.failNext(2, 504);
    const delays: number[] = [];
    const l = makeLoader(fake, { ringRadii: [150], batchSize: 50, backoffMs: 1000, sleep: async (ms) => void delays.push(ms) });
    const first = await l.start();
    expect(first.length).toBe(l.waveBlocks[0].length);
    expect(fake.calls).toHaveLength(3);
    expect(delays).toEqual([1000, 2000]);
    expect(l.ringReady(1)).toBe(true);
  });

  it("rejects start() when the first waves can't be loaded", async () => {
    const fake = fakeOverpass(ways);
    fake.failNext(100, 429);
    const l = makeLoader(fake, { ringRadii: [150], maxAttempts: 3, batchSize: 50 });
    await expect(l.start()).rejects.toThrow(/busy/);
    expect(fake.calls).toHaveLength(3);
    expect(l.ringReady(1)).toBe(false);
  });

  it("reports failed background blocks and loads them on retryFailed()", async () => {
    const fake = fakeOverpass(ways);
    const l = makeLoader(fake, { ringRadii: [150, 300, 450], maxAttempts: 2, batchSize: 50 });
    const errors: BlockId[][] = [];
    l.on("error", (e) => errors.push(e.blocks));
    const gate = fake.hold((c) => blocksOf(c).includes(l.waveBlocks[2][0]));
    await l.start();
    fake.failNext(2); // both attempts of the held wave-3 query
    gate.release();
    await l.done();
    expect(errors).toEqual([l.waveBlocks[2]]);
    expect(l.ringReady(3)).toBe(false);
    await l.retryFailed();
    expect(l.ringReady(3)).toBe(true);
  });

  it("ringReady waits for a slow block, with the sim-core coverage rule", async () => {
    const fake = fakeOverpass(ways);
    const l = makeLoader(fake, { batchSize: 1, concurrency: 3 });
    const slow = l.waveBlocks[3][l.waveBlocks[3].length - 1]; // farthest block of wave 4
    const gate = fake.hold((c) => blocksOf(c).includes(slow));
    await l.start();
    const ready4 = l.whenRingReady(4);
    let resolved = false;
    void ready4.then(() => (resolved = true));
    await l.whenRingReady(3);
    // Let every other request finish.
    for (let i = 0; i < 50 && l.chunks().length < l.waveBlocks.flat().length - 1; i++) await new Promise((r) => setTimeout(r, 5));
    expect(l.chunks().length).toBe(l.waveBlocks.flat().length - 1);
    expect(l.ringReady(3)).toBe(true);
    expect(l.ringReady(4)).toBe(false);
    expect(l.ringReady(8)).toBe(false);
    expect(resolved).toBe(false);
    gate.release();
    await ready4;
    await l.done();
    expect(l.ringReady(8)).toBe(true);

    // Coverage rule: when wave w is ready, every point within radius +
    // margin + slack lies in a loaded block's bounds; the slow block is
    // within wave 4's.
    expect(blockDistanceM(slow, CENTER)).toBeLessThanOrEqual(RINGS[3] + MARGIN + SLACK + 0.05);
    expect(blockDistanceM(slow, CENTER)).toBeGreaterThan(RINGS[2] + MARGIN + SLACK);
    const bounds = l.chunks().map((c) => c.bounds);
    for (let w = 0; w < 8; w++) {
      const R = RINGS[w] + MARGIN + SLACK;
      for (let k = 0; k < 720; k++) {
        const t = (k / 720) * 2 * Math.PI;
        const [x, y] = [R * Math.cos(t), R * Math.sin(t)];
        expect(bounds.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1)).toBe(true);
      }
    }
  });

  it("gives the same chunks and hash whatever the arrival order", async () => {
    const a = makeLoader(fakeOverpass(ways), { concurrency: 1, batchSize: 1 });
    await a.start();
    await a.done();
    const fake = fakeOverpass(ways);
    const first = blocksForDisc(CENTER.lat, CENTER.lon, 600)[0];
    const gate = fake.hold((c) => !blocksOf(c).includes(first) && blocksOf(c).some((id) => blockBoundsLocal(id, CENTER)[0] > 300));
    const b = makeLoader(fake, { concurrency: 8, batchSize: 3 });
    const started = b.start();
    setTimeout(() => gate.release(), 20);
    await started;
    await b.done();
    expect(snapshotHash(b.chunks())).toBe(snapshotHash(a.chunks()));
    expect(b.chunks()).toEqual(a.chunks());
  });
});

/// Wait (real time, a few ms per step) until `cond()` holds.
async function until(cond: () => boolean, what = "condition") {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
}

describe("MapLoader: Overpass runtime errors", () => {
  it("never caches a timed-out answer as empty blocks: retries instead", async () => {
    const fake = fakeOverpass(ways);
    const cache = new MemoryBlockCache();
    fake.bodyNext(1, timeoutBody());
    const l = makeLoader(fake, { cache, ringRadii: [150], batchSize: 50 });
    const first = await l.start();
    expect(fake.calls).toHaveLength(2); // the timeout, then the retry
    expect(first.reduce((n, c) => n + c.buildings.length, 0)).toBeGreaterThan(50);
    const ok = makeLoader(fakeOverpass(ways), { ringRadii: [150], batchSize: 50 });
    expect(snapshotHash(first)).toBe(snapshotHash(await ok.start()));
    expect(cache.size).toBe(l.waveBlocks[0].length);
  });

  it("caches nothing when every attempt times out (partial elements included)", async () => {
    const fake = fakeOverpass(ways);
    const cache = new MemoryBlockCache();
    fake.bodyNext(100, timeoutBody(ways.slice(0, 20)));
    const l = makeLoader(fake, { cache, ringRadii: [150], batchSize: 50, maxAttempts: 2 });
    await expect(l.start()).rejects.toThrow(/runtime error/);
    expect(fake.calls).toHaveLength(2);
    expect(cache.size).toBe(0);
    expect(l.chunks()).toHaveLength(0);
  });

  it("rejects a body whose elements is not an array", async () => {
    for (const body of [{}, { elements: null }, { elements: "x" }, [], 7]) {
      const fake = fakeOverpass(ways);
      const cache = new MemoryBlockCache();
      fake.bodyNext(1, body);
      const l = makeLoader(fake, { cache, ringRadii: [150], batchSize: 50, maxAttempts: 1 });
      await expect(l.start()).rejects.toThrow(/malformed/);
      expect(cache.size).toBe(0);
    }
  });
});

describe("MapLoader: re-running start()", () => {
  it("after a failed initial load, start() again gives every initial chunk", async () => {
    const fake = fakeOverpass(ways);
    fake.failNext(3);
    const l = makeLoader(fake, { batchSize: 2, concurrency: 1, maxAttempts: 3 });
    const initial = [...l.waveBlocks[0], ...l.waveBlocks[1]].sort((a, b) => a - b);
    await expect(l.start()).rejects.toThrow(/busy/);
    expect(fake.calls).toHaveLength(3);
    const again = await l.start();
    expect(again).toHaveLength(initial.length);
    expect(again.every((c) => c !== undefined)).toBe(true);
    expect(again.map((c) => c.block_id)).toEqual(initial);
    expect(l.ringReady(2)).toBe(true);
    await l.done();
    expect(l.ringReady(8)).toBe(true);
  });

  it("only re-fetches the initial blocks still missing", async () => {
    const fake = fakeOverpass(ways);
    const probe = makeLoader(fake);
    const initial = [...probe.waveBlocks[0], ...probe.waveBlocks[1]];
    const bad = initial[4]; // third batch of 2
    let failing = true;
    const fetch: typeof fake.fetch = async (url, init) => {
      const query = (init!.body as URLSearchParams).get("data") ?? "";
      if (failing && blocksOf({ url, query, bboxes: parseBboxes(query) }).includes(bad)) return new Response("busy", { status: 504 });
      return fake.fetch(url, init);
    };
    const l = makeLoader(fake, { fetch, batchSize: 2, concurrency: 1, maxAttempts: 2 });
    await expect(l.start()).rejects.toThrow(/busy/);
    expect(l.chunks().map((c) => c.block_id).sort((a, b) => a - b)).toEqual(initial.slice(0, 4).sort((a, b) => a - b));
    failing = false;
    const n = fake.calls.length;
    const [x, y] = [l.start(), l.start()];
    expect(x).toBe(y); // concurrent calls share one load
    const got = await x;
    expect(got.map((c) => c.block_id)).toEqual([...initial].sort((a, b) => a - b));
    expect(fake.calls.slice(n).flatMap(blocksOf)).toEqual(initial.slice(4));
    expect(await l.start()).toBe(got); // after success: the same chunks, no new load
  });
});

describe("MapLoader: cache read failures", () => {
  it("treats a throwing getMany as nothing cached", async () => {
    const fake = fakeOverpass(ways);
    const broken = new MemoryBlockCache();
    broken.getMany = async () => {
      throw new DOMException("The database connection is closing.", "InvalidStateError");
    };
    const l = makeLoader(fake, { cache: broken, ringRadii: [150, 300] });
    const first = await l.start();
    expect(first).toHaveLength(l.waveBlocks.flat().length);
    expect(l.stats.cacheHits).toBe(0);
    expect(fake.calls.length).toBeGreaterThan(0);
  });

  it("keeps loading after another tab opens a newer schema", async () => {
    const idb = new IDBFactory();
    const old = await IdbBlockCache.open({ indexedDB: idb, schema: SCHEMA_VERSION });
    const a = makeLoader(fakeOverpass(ways), { cache: old, ringRadii: [150] });
    await a.start();
    // Another tab upgrades the database: this connection is closed for us.
    const newer = await IdbBlockCache.open({ indexedDB: idb, schema: SCHEMA_VERSION + 1 });
    expect(old.isClosed).toBe(true);
    expect(await old.getMany(a.waveBlocks[0])).toEqual(new Map());
    const fake = fakeOverpass(ways);
    const b = makeLoader(fake, { cache: old, ringRadii: [150, 300] });
    const first = await b.start();
    expect(first).toHaveLength(b.waveBlocks.flat().length);
    expect(b.stats.cacheHits).toBe(0);
    expect(fake.calls.length).toBeGreaterThan(0);
    newer.close();
  });
});

describe("MapLoader: abort and permanent failures", () => {
  it("abort() cuts a backoff sleep short and rejects pending whenRingReady", async () => {
    const fake = fakeOverpass(ways);
    // Real timers, a 60 s backoff: done() would hang without an abortable sleep.
    const l = new MapLoader({ center: CENTER, ringRadii: [150, 300, 450], cache: new MemoryBlockCache(), fetch: fake.fetch, urls: ["u"], backoffMs: 60_000, batchSize: 50 });
    const gate = fake.hold((c) => blocksOf(c).includes(l.waveBlocks[2][0]));
    await l.start();
    const ready3 = l.whenRingReady(3);
    const ready3Err = ready3.catch((e: Error) => e);
    fake.failNext(100);
    const n = fake.calls.length;
    gate.release();
    await until(() => fake.calls.length > n, "the failed attempt");
    await new Promise((r) => setTimeout(r, 10)); // now in the 60 s backoff
    const t0 = Date.now();
    l.abort();
    await l.done();
    expect(Date.now() - t0).toBeLessThan(1000);
    const e = await ready3Err;
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).name).toBe("AbortError");
    expect(fake.calls.length).toBe(n + 1); // no attempt after the abort
    await expect(l.whenRingReady(3)).rejects.toThrow(/aborted/);
    await expect(l.whenRingReady(2)).resolves.toBeUndefined(); // already ready
  });

  it("abort() during start() rejects start()", async () => {
    const fake = fakeOverpass(ways);
    fake.failNext(100);
    const l = new MapLoader({ center: CENTER, ringRadii: [150], cache: new MemoryBlockCache(), fetch: fake.fetch, urls: ["u"], backoffMs: 60_000 });
    const started = l.start();
    await until(() => fake.calls.length > 0, "the first attempt");
    l.abort();
    await expect(started).rejects.toThrow(/aborted/);
  });

  it("whenRingReady rejects when a needed batch fails for good, and works again after retryFailed()", async () => {
    const fake = fakeOverpass(ways);
    const l = makeLoader(fake, { ringRadii: [150, 300, 450], maxAttempts: 2, batchSize: 50 });
    const gate = fake.hold((c) => blocksOf(c).includes(l.waveBlocks[2][0]));
    await l.start();
    const ready3 = l.whenRingReady(3).catch((e: Error) => e);
    fake.failNext(2);
    gate.release();
    await l.done();
    const e = await ready3;
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toMatch(/ring 3 can't be loaded/);
    await expect(l.whenRingReady(3)).rejects.toThrow(/ring 3/);
    await expect(l.whenRingReady(2)).resolves.toBeUndefined();
    await l.retryFailed();
    await expect(l.whenRingReady(3)).resolves.toBeUndefined();
  });

  it("a failed initial load rejects pending whenRingReady(1)", async () => {
    const fake = fakeOverpass(ways);
    fake.failNext(2);
    const l = makeLoader(fake, { ringRadii: [150], maxAttempts: 2, batchSize: 50 });
    const ready1 = l.whenRingReady(1).catch((e: Error) => e);
    await expect(l.start()).rejects.toThrow(/busy/);
    expect(((await ready1) as Error).message).toMatch(/ring 1 can't be loaded/);
    await l.start(); // the fake answers again
    await expect(l.whenRingReady(1)).resolves.toBeUndefined();
  });
});

describe("MapLoader: cache max age", () => {
  it("re-fetches cached blocks older than maxAgeMs", async () => {
    const cache = new MemoryBlockCache();
    const t = (iso: string) => () => new Date(iso);
    const a = makeLoader(fakeOverpass(ways), { cache, ringRadii: [150], now: t("2026-01-01T00:00:00Z") });
    await a.start();
    const fresh = fakeOverpass(ways);
    const b = makeLoader(fresh, { cache, ringRadii: [150], maxAgeMs: 86_400_000, now: t("2026-01-01T12:00:00Z") });
    await b.start();
    expect(fresh.calls).toHaveLength(0);
    const stale = fakeOverpass(ways);
    const c = makeLoader(stale, { cache, ringRadii: [150], maxAgeMs: 86_400_000, now: t("2026-01-03T00:00:00Z") });
    await c.start();
    expect(stale.calls.length).toBeGreaterThan(0);
    expect(c.stats.cacheHits).toBe(0);
  });
});

/// A warm cache: every block of `ringRadii` loaded once into a MemoryBlockCache.
async function warmCache(ringRadii: number[]): Promise<MemoryBlockCache> {
  const cache = new MemoryBlockCache();
  const l = makeLoader(fakeOverpass(ways), { cache, ringRadii });
  await l.start();
  await l.done();
  return cache;
}

describe("MapLoader: abort with a warm cache", () => {
  it("abort() before start() rejects start() and emits nothing", async () => {
    const cache = await warmCache(RINGS);
    const fake = fakeOverpass(ways);
    const l = makeLoader(fake, { cache });
    const events: string[] = [];
    l.on("chunk", (c) => events.push(`chunk ${c.block_id}`));
    l.on("ring", (w) => events.push(`ring ${w}`));
    l.abort();
    await expect(l.start()).rejects.toThrow(/aborted/);
    await l.done();
    expect(events).toEqual([]);
    expect(l.chunks()).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it("abort() while start() reads the cache rejects start() and loads nothing more", async () => {
    const warm = await warmCache(RINGS);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    class SlowRead extends MemoryBlockCache {
      override async getMany(ids: BlockId[]) {
        const got = await warm.getMany(ids);
        await gate;
        return got;
      }
    }
    const fake = fakeOverpass(ways);
    const l = makeLoader(fake, { cache: new SlowRead() });
    const events: string[] = [];
    l.on("chunk", (c) => events.push(`chunk ${c.block_id}`));
    l.on("ring", (w) => events.push(`ring ${w}`));
    const started = l.start();
    l.abort();
    release();
    await expect(started).rejects.toThrow(/aborted/);
    await l.done();
    expect(events).toEqual([]);
    expect(l.chunks()).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it("an abort from a ring listener stops start() even with every block cached", async () => {
    const cache = await warmCache(RINGS);
    const l = makeLoader(fakeOverpass(ways), { cache });
    const events: string[] = [];
    l.on("ring", (w) => {
      events.push(`ring ${w}`);
      l.abort();
    });
    l.on("chunk", (c) => events.push(`chunk ${c.block_id}`));
    await expect(l.start()).rejects.toThrow(/aborted/);
    await l.done();
    expect(events).toEqual(["ring 1"]);
    expect(l.ringReady(2)).toBe(false);
  });

  it("an abort during a cache put adds no more blocks and emits no more events", async () => {
    let held: (() => void) | null = null;
    let puts = 0;
    let holdAt = Infinity;
    class SlowPut extends MemoryBlockCache {
      override async put(b: CachedBlock) {
        await super.put(b);
        if (++puts === holdAt) await new Promise<void>((r) => (held = r));
      }
    }
    const fake = fakeOverpass(ways);
    const l = makeLoader(fake, { cache: new SlowPut(), concurrency: 1, batchSize: 6 });
    await l.start();
    holdAt = puts + 2; // the second block of the first background batch
    const events: string[] = [];
    l.on("chunk", (c) => events.push(`chunk ${c.block_id}`));
    l.on("ring", (w) => events.push(`ring ${w}`));
    await until(() => held !== null, "the held put");
    expect(events).toHaveLength(1); // the first block of the batch
    const loaded = l.chunks().length;
    l.abort();
    held!();
    await l.done();
    expect(events).toHaveLength(1);
    expect(l.chunks()).toHaveLength(loaded);
    expect(fake.calls.length).toBe(l.stats.queries);
  });
});

describe("MapLoader: throwing listeners", () => {
  it("a throwing chunk or ring listener doesn't refetch, fail blocks or reject start()", async () => {
    const ref = makeLoader(fakeOverpass(ways));
    await ref.start();
    await ref.done();

    const fake = fakeOverpass(ways);
    const l = makeLoader(fake);
    const boom = new Error("add_buildings failed");
    const reported: { event: string; error: unknown }[] = [];
    const errors: unknown[] = [];
    const seen: number[] = [];
    l.on("chunk", () => {
      throw boom;
    });
    l.on("chunk", (c) => seen.push(c.block_id)); // later listeners still run
    l.on("ring", () => {
      throw boom;
    });
    l.on("error", (e) => errors.push(e));
    l.on("listenerError", (e) => reported.push(e));
    const first = await l.start();
    await l.done();
    expect(first).toEqual(await ref.start());
    expect(l.ringReady(8)).toBe(true);
    expect(errors).toEqual([]);
    expect(l.stats.queries).toBe(ref.stats.queries);
    expect(fake.calls).toHaveLength(ref.stats.queries);
    expect(l.chunks()).toEqual(ref.chunks());
    expect(l.snapshotHash()).toBe(ref.snapshotHash());
    const background = l.waveBlocks.slice(2).flat();
    expect([...seen].sort((a, b) => a - b)).toEqual([...background].sort((a, b) => a - b));
    expect(reported.filter((r) => r.event === "chunk")).toHaveLength(background.length);
    expect(reported.filter((r) => r.event === "ring")).toHaveLength(8);
    expect(reported.every((r) => r.error === boom)).toBe(true);
  });

  it("without a listenerError listener the error is rethrown from a microtask", async () => {
    const thrown: unknown[] = [];
    const orig = globalThis.queueMicrotask;
    globalThis.queueMicrotask = (cb) =>
      orig(() => {
        try {
          cb();
        } catch (e) {
          thrown.push(e);
        }
      });
    try {
      const l = makeLoader(fakeOverpass(ways), { ringRadii: [150] });
      l.on("ring", () => {
        throw new Error("ring listener");
      });
      await expect(l.start()).resolves.toHaveLength(l.waveBlocks[0].length);
      await new Promise((r) => setTimeout(r, 0));
      expect(thrown.map((e) => (e as Error).message)).toEqual(["ring listener"]);
    } finally {
      globalThis.queueMicrotask = orig;
    }
  });
});

describe("Building clipping on the Marais fixture (anchor vertex vs vertex mean)", () => {
  /// For the block chosen by `pick`: the share of buildings with a vertex more
  /// than CLIP_MARGIN_M outside it (projectBlock clips those) and the largest
  /// overshoot of any vertex beyond the block edge.
  function overshoot(pick: (g: { lat: number; lon: number }[]) => BlockId) {
    let clipped = 0;
    let max = 0;
    for (const w of ways) {
      const g = w.geometry!.slice(0, -1);
      const [x0, y0, x1, y1] = blockBoundsLocal(pick(g), CENTER);
      let out = 0;
      for (const p of g) {
        const [x, y] = project(p.lat, p.lon, CENTER.lat, CENTER.lon);
        out = Math.max(out, x0 - x, x - x1, y0 - y, y - y1);
      }
      if (out > CLIP_MARGIN_M) clipped++;
      max = Math.max(max, out);
    }
    return { share: clipped / ways.length, max };
  }
  it("reports the clipped share and worst overshoot (anchor can overshoot by a full width)", () => {
    const anchor = overshoot((g) => {
      const v = g.reduce((a, p) => (p.lat < a.lat || (p.lat === a.lat && p.lon < a.lon) ? p : a));
      return blockAt(v.lat, v.lon);
    });
    const mean = overshoot((g) => blockAt(g.reduce((s, p) => s + p.lat, 0) / g.length, g.reduce((s, p) => s + p.lon, 0) / g.length));
    const f = (r: { share: number; max: number }) => `${(r.share * 100).toFixed(2)}% clipped, worst overshoot ${r.max.toFixed(1)} m`;
    console.log(`Marais (${ways.length} buildings): anchor vertex ${f(anchor)}; vertex mean ${f(mean)}`);
    expect(anchor.share).toBeLessThan(0.01);
    expect(anchor.max).toBeGreaterThanOrEqual(mean.max);
  });
});
