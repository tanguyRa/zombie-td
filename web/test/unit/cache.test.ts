import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdbBlockCache, MemoryBlockCache, SCHEMA_VERSION, blockContentHash, makeCachedBlock, openBlockCache, type BlockStore } from "../../src/map/cache";

afterEach(() => vi.unstubAllGlobals());

describe("openBlockCache", () => {
  it("uses IndexedDB when it is there", async () => {
    const c = await openBlockCache({ indexedDB: new IDBFactory() });
    expect(c).toBeInstanceOf(IdbBlockCache);
    await roundTrip(c);
    (c as IdbBlockCache).close();
  });

  it("falls back to memory when indexedDB is undefined", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(IdbBlockCache.open()).rejects.toThrow(/not available/);
    const c = await openBlockCache();
    expect(c).toBeInstanceOf(MemoryBlockCache);
    await roundTrip(c);
  });

  it("falls back to memory when open throws or errors", async () => {
    const throwing = { open: () => { throw new DOMException("denied", "SecurityError"); } } as unknown as IDBFactory;
    expect(await openBlockCache({ indexedDB: throwing })).toBeInstanceOf(MemoryBlockCache);
    const erroring = {
      open: () => {
        const r: { onerror?: () => void; error: DOMException } = { error: new DOMException("broken", "UnknownError") };
        setTimeout(() => r.onerror?.());
        return r;
      },
    } as unknown as IDBFactory;
    expect(await openBlockCache({ indexedDB: erroring })).toBeInstanceOf(MemoryBlockCache);
  });

  it("falls back to memory when the upgrade is blocked by another tab", async () => {
    const idb = new IDBFactory();
    // A connection (another tab, older code) that never closes on versionchange.
    const stubborn = await new Promise<IDBDatabase>((res, rej) => {
      const r = idb.open("zt-map-blocks", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("blocks", { keyPath: "id" });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const c = await openBlockCache({ indexedDB: idb, schema: 2 });
    expect(c).toBeInstanceOf(MemoryBlockCache);
    expect((c as MemoryBlockCache).schema).toBe(2);
    stubborn.close();
  });
});
import type { RawBuilding } from "../../src/map/overpass";

const B1: RawBuilding = { id: 11, kind: "residential", floors: 3, ring: [48.85, 2.35, 48.8501, 2.35, 48.8501, 2.3502] };
const B2: RawBuilding = { id: 5, kind: "other", floors: 2, ring: [48.86, 2.36, 48.8601, 2.36, 48.8601, 2.3602] };

describe("block content hash", () => {
  it("is stable, order-independent and content-sensitive", () => {
    const h = blockContentHash(7, [B1, B2]);
    expect(blockContentHash(7, [B2, B1])).toBe(h);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(blockContentHash(8, [B1, B2])).not.toBe(h);
    expect(blockContentHash(7, [B1, { ...B2, floors: 2.1 }])).not.toBe(h);
    expect(blockContentHash(7, [B1, { ...B2, ring: [...B2.ring.slice(0, 5), 2.3603] }])).not.toBe(h);
    const c = makeCachedBlock(7, [B1, B2], new Date("2026-11-22T10:00:00Z"));
    expect(c).toEqual({ id: 7, schema: SCHEMA_VERSION, fetchedAt: "2026-11-22T10:00:00.000Z", hash: h, buildings: [B2, B1] });
  });
});

async function roundTrip(store: BlockStore) {
  const a = makeCachedBlock(16016265130, [B1, B2]);
  const empty = makeCachedBlock(16016265131, []);
  expect(await store.has(a.id)).toBe(false);
  expect(await store.get(a.id)).toBeUndefined();
  await store.put(a);
  await store.put(empty);
  expect(await store.has(a.id)).toBe(true);
  expect(await store.has(empty.id)).toBe(true); // empty blocks are cached too
  expect(await store.get(a.id)).toEqual(a);
  const many = await store.getMany([empty.id, 1, a.id]);
  expect([...many.keys()]).toEqual([empty.id, a.id]);
  expect(many.get(empty.id)).toEqual(empty);
  await store.clear();
  expect(await store.has(a.id)).toBe(false);
}

describe("memory cache", () => {
  it("round-trips", () => roundTrip(new MemoryBlockCache()));
  it("ignores blocks of another schema", async () => {
    const m = new MemoryBlockCache(2);
    await m.put(makeCachedBlock(1, [B1], new Date(), 1));
    expect(await m.has(1)).toBe(false);
  });
});

describe("IndexedDB cache", () => {
  it("round-trips", async () => {
    const c = await IdbBlockCache.open({ indexedDB: new IDBFactory() });
    await roundTrip(c);
    c.close();
  });

  it("persists across opens", async () => {
    const idb = new IDBFactory();
    const a = await IdbBlockCache.open({ indexedDB: idb });
    await a.put(makeCachedBlock(3, [B1]));
    a.close();
    const b = await IdbBlockCache.open({ indexedDB: idb });
    expect((await b.get(3))?.buildings).toEqual([B1]);
    b.close();
  });

  it("is cleared by a schema bump (and by a downgrade)", async () => {
    const idb = new IDBFactory();
    const v1 = await IdbBlockCache.open({ indexedDB: idb, schema: 1 });
    await v1.put(makeCachedBlock(3, [B1], new Date(), 1));
    v1.close();
    const v2 = await IdbBlockCache.open({ indexedDB: idb, schema: 2 });
    expect(await v2.has(3)).toBe(false);
    await v2.put(makeCachedBlock(4, [B2], new Date(), 2));
    expect(await v2.has(4)).toBe(true);
    v2.close();
    // Older code opening a newer database: deleted and recreated, not an error.
    const back = await IdbBlockCache.open({ indexedDB: idb, schema: 1 });
    expect(await back.has(4)).toBe(false);
    back.close();
  });

  it("closes itself when another tab opens a newer schema: empty reads, no-op writes", async () => {
    const idb = new IDBFactory();
    const old = await IdbBlockCache.open({ indexedDB: idb, schema: 1 });
    await old.put(makeCachedBlock(3, [B1], new Date(), 1));
    expect(await old.has(3)).toBe(true);
    const newer = await IdbBlockCache.open({ indexedDB: idb, schema: 2 });
    expect(old.isClosed).toBe(true);
    expect(newer.isClosed).toBe(false);
    expect(await old.getMany([3])).toEqual(new Map());
    expect(await old.get(3)).toBeUndefined();
    await old.put(makeCachedBlock(4, [B1], new Date(), 1)); // no throw
    await old.clear();
    await newer.put(makeCachedBlock(5, [B2], new Date(), 2));
    expect(await newer.has(5)).toBe(true);
    newer.close();
    expect(newer.isClosed).toBe(true);
    expect(await newer.has(5)).toBe(false);
  });

  it("ignores records written with another schema", async () => {
    const c = await IdbBlockCache.open({ indexedDB: new IDBFactory(), schema: 3 });
    await c.put(makeCachedBlock(5, [B1], new Date(), 2));
    expect(await c.has(5)).toBe(false);
    c.close();
  });
});
