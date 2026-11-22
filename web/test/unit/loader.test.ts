import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { blockAt, blockBoundsLocal, blockDistanceM, blocksForDisc, type BlockId } from "../../src/map/blocks";
import { IdbBlockCache, MemoryBlockCache } from "../../src/map/cache";
import { snapshotHash, type BuildingChunk } from "../../src/map/chunks";
import { MapLoader, matchRingRadii } from "../../src/map/loader";
import { fakeOverpass, loadConfig, loadLevel, waysFromLevel, type FakeCall } from "./fixtures";

const cfg = loadConfig();
const level = loadLevel("paris-marais");
const CENTER = { lat: level.center_lat, lon: level.center_lon };
const ways = waysFromLevel(level);
const RINGS = matchRingRadii(cfg.match.ring_radius_m, cfg.wave8_radius_m, cfg.wave8_radius_m);
const MARGIN = cfg.match.block_margin_m;

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
  it("splits the blocks by wave (disc of ring radius + margin)", () => {
    const l = makeLoader(fakeOverpass([]));
    expect(l.waveBlocks).toHaveLength(8);
    for (let w = 1; w <= 8; w++) {
      const union = l.waveBlocks.slice(0, w).flat().sort((a, b) => a - b);
      expect(union).toEqual(blocksForDisc(CENTER.lat, CENTER.lon, RINGS[w - 1] + MARGIN).sort((a, b) => a - b));
    }
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

    // Coverage rule: when wave w is ready, every point within radius + margin
    // lies in a loaded block's bounds; the slow block is within wave 4's.
    expect(blockDistanceM(slow, CENTER)).toBeLessThanOrEqual(RINGS[3] + MARGIN + 0.05);
    expect(blockDistanceM(slow, CENTER)).toBeGreaterThan(RINGS[2] + MARGIN);
    const bounds = l.chunks().map((c) => c.bounds);
    for (let w = 0; w < 8; w++) {
      const R = RINGS[w] + MARGIN;
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
