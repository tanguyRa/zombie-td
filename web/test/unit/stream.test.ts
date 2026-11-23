// The streaming glue (src/stream.ts): the shell of a picked place, the
// worker's chunk queue, the "next district" gate on a real MapLoader with a
// fake Overpass, and the map bundle.
import { describe, expect, it } from "vitest";
import { blockAt } from "../../src/map/blocks";
import { MemoryBlockCache } from "../../src/map/cache";
import type { BuildingChunk } from "../../src/map/chunks";
import { MapLoader } from "../../src/map/loader";
import { ChunkQueue, DistrictGate, PLAY_RADIUS_M, buildShell, errorText, mapBundle, shellProblem, shellRingRadii, tooEmpty, type GateView } from "../../src/stream";
import { fakeOverpass, parseBboxes, loadConfig, loadLevel, waysFromLevel, type FakeCall } from "./fixtures";

const cfg = loadConfig();
const level = loadLevel("paris-marais");
const ways = waysFromLevel(level);

const chunk = (id: number, buildings = 0): BuildingChunk => ({
  block_id: id,
  bounds: [0, 0, 10, 10],
  buildings: Array.from({ length: buildings }, (_, i) => ({ id: id * 100 + i, kind: "residential" as const, floors: 2, polygon: [[0, 0], [5, 0], [5, 5]] as [number, number][] })),
});

describe("shell", () => {
  it("is the centre, the wave-8 radius, no buildings and no fences", () => {
    const s = buildShell("Somewhere", 48.8580001234, 2.35799996);
    expect(s).toEqual({ name: "Somewhere", center_lat: 48.858, center_lon: 2.358, radius_m: cfg.wave8_radius_m, buildings: [], fences: [] });
    expect(PLAY_RADIUS_M).toBe(1300);
    // Within ShellLimits: a radius-only shell has no bounds or fences to check.
    expect(shellProblem(s)).toBeNull();
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it("has the config rings (the level is as large as the wave-8 cap)", () => {
    expect(shellRingRadii(buildShell("x", 48.8, 2.3))).toEqual(cfg.match.ring_radius_m);
  });

  it("refuses centres sim-core or the block grid can't take", () => {
    expect(() => buildShell("x", NaN, 2)).toThrow(/latitude/);
    expect(() => buildShell("x", 91, 2)).toThrow(/latitude/);
    expect(() => buildShell("x", 10, 181)).toThrow(/latitude/);
    expect(() => buildShell("x", 10, 179.5)).toThrow(/antimeridian/);
    expect(() => buildShell("x", 86, 0)).toThrow(/pole/);
    expect(shellProblem({ ...buildShell("x", 1, 1), radius_m: 0 })).toMatch(/radius/);
  });

  it("calls a place with fewer than 40 buildings in its first blocks too empty", () => {
    expect(tooEmpty([chunk(1, 20), chunk(2, 19)])).toMatch(/^Only 39 buildings around the pin\. Pick a more built-up spot\.$/);
    expect(tooEmpty([chunk(1, 20), chunk(2, 20)])).toBeNull();
    expect(tooEmpty([])).toMatch(/^Only 0 buildings/);
  });
});

describe("ChunkQueue (the worker's add_buildings queue)", () => {
  it("adds at once outside a wave, in block id order, each block once", () => {
    const q = new ChunkQueue();
    q.reset([5]); // the match was built with block 5
    expect(q.stored).toBe(1);
    q.push(chunk(9));
    q.push(chunk(5)); // already in the match
    q.push(chunk(7));
    q.push(chunk(9)); // a repeat
    expect(q.size).toBe(2);
    const added: number[] = [];
    expect(q.flush("prep", (c) => added.push(c.block_id))).toEqual([]);
    expect(added).toEqual([7, 9]);
    expect(q.size).toBe(0);
    expect(q.stored).toBe(3);
  });

  it("keeps chunks that arrive while a wave runs until it ends", () => {
    const q = new ChunkQueue();
    q.reset([1]);
    q.push(chunk(3));
    q.push(chunk(2));
    const added: number[] = [];
    expect(q.flush("running", (c) => added.push(c.block_id))).toEqual([]);
    expect(added).toEqual([]);
    expect(q.size).toBe(2);
    for (const phase of ["wave_won", "wave_lost", "match_won"]) {
      const q2 = new ChunkQueue();
      q2.push(chunk(4));
      const got: number[] = [];
      q2.flush(phase, (c) => got.push(c.block_id));
      expect(got).toEqual([4]);
    }
    q.flush("prep", (c) => added.push(c.block_id));
    expect(added).toEqual([2, 3]);
  });

  it("reports a refusal with the core's message and carries on", () => {
    const q = new ChunkQueue();
    q.push(chunk(1));
    q.push(chunk(2));
    q.push(chunk(3));
    const refused = q.flush("prep", (c) => {
      if (c.block_id === 2) throw JSON.stringify({ error: "area_revealed", message: "block 2 lies in area already revealed" });
    });
    expect(refused).toEqual([{ block: 2, error: "block 2 lies in area already revealed" }]);
    expect(q.stored).toBe(2);
    expect(q.size).toBe(0);
  });

  it("forgets everything on reset (a new match or a stop)", () => {
    const q = new ChunkQueue();
    q.push(chunk(1));
    q.reset([1, 2]);
    expect(q.size).toBe(0);
    q.push(chunk(2));
    expect(q.size).toBe(0);
    q.reset();
    q.push(chunk(2));
    expect(q.size).toBe(1);
  });

  it("reads WASM errors", () => {
    expect(errorText(JSON.stringify({ error: "x", message: "readable" }))).toBe("readable");
    expect(errorText(new Error("plain"))).toBe("plain");
    expect(errorText("not json")).toBe("not json");
  });
});

/** A gate view that records what it was told. */
function recorder() {
  const log: string[] = [];
  const view: GateView = {
    progress: (w, l, n) => log.push(`progress ${w} ${l}/${n}`),
    failed: (w, m) => log.push(`failed ${w} ${m}`),
    hide: () => log.push("hide"),
  };
  return { log, view };
}

describe("DistrictGate", () => {
  const center = { lat: level.center_lat, lon: level.center_lon };
  const ringRadii = shellRingRadii(buildShell("x", center.lat, center.lon));
  const make = (fake: ReturnType<typeof fakeOverpass>) =>
    new MapLoader({ center, ringRadii, cache: new MemoryBlockCache(), fetch: fake.fetch, urls: ["https://overpass.test/api"], sleep: async () => {}, maxAttempts: 2 });

  it("resolves at once for a loaded ring", async () => {
    const fake = fakeOverpass(ways);
    const loader = make(fake);
    await loader.start();
    const { log, view } = recorder();
    const gate = new DistrictGate(loader, view);
    expect(await gate.wait(2)).toBe(true);
    expect(log).toEqual([]);
    loader.abort();
  });

  it("shows progress while a slow block holds the ring, then resolves", async () => {
    const fake = fakeOverpass(ways);
    const loader = make(fake);
    await loader.start();
    const wave3 = new Set(loader.waveBlocks[2]);
    // Hold every query of the third ring.
    const held = fake.hold((c) => queryBlocks(c).some((id) => wave3.has(id)));
    const { log, view } = recorder();
    const gate = new DistrictGate(loader, view);
    const p = gate.wait(3);
    expect(gate.waiting).toBe(3);
    const needed = loader.waveBlocks.slice(0, 3).flat().length;
    expect(log[0]).toMatch(new RegExp(`^progress 3 \\d+/${needed}$`));
    held.release();
    expect(await p).toBe(true);
    expect(gate.waiting).toBeNull();
    expect(log[log.length - 1]).toBe("hide");
    expect(log.filter((l) => l.startsWith("progress")).length).toBeGreaterThan(1);
    expect(loader.ringReady(3)).toBe(true);
    loader.abort();
  });

  it("shows a permanent failure, and Retry loading resolves it", async () => {
    const fake = fakeOverpass(ways);
    const loader = make(fake);
    await loader.start();
    // Every background query fails (2 attempts each): ring 3 can't load.
    fake.failNext(1_000_000);
    const { log, view } = recorder();
    const gate = new DistrictGate(loader, view);
    const p = gate.wait(3);
    await expect.poll(() => log.some((l) => l.startsWith("failed 3 map ring 3 can't be loaded"))).toBe(true);
    expect(gate.waiting).toBe(3);
    await loader.done();
    fake.failNext(0);
    gate.retry();
    expect(await p).toBe(true);
    expect(loader.ringReady(3)).toBe(true);
    expect(log[log.length - 1]).toBe("hide");
    loader.abort();
  });

  it("keeps the failure (and Retry loading) while other rings' chunks arrive", async () => {
    const fake = fakeOverpass(ways);
    let failWave3 = true;
    const wave3 = new Set<number>();
    const outer = new Set<number>();
    const ids = (init?: RequestInit) => queryBlocks({ url: "", query: "", bboxes: parseBboxesOf(init) });
    // Queries with a wave-3 block fail while `failWave3`; the others are held.
    let releaseLater!: () => void;
    const later = new Promise<void>((r) => (releaseLater = r));
    const fetch: typeof fake.fetch = async (url, init) => {
      const q = ids(init);
      if (failWave3 && q.some((id) => wave3.has(id))) return new Response("busy", { status: 504 });
      else if (q.every((id) => outer.has(id))) await later;
      return fake.fetch(url, init);
    };
    const loader = new MapLoader({ center, ringRadii, cache: new MemoryBlockCache(), fetch, urls: ["https://overpass.test/api"], sleep: async () => {}, maxAttempts: 2 });
    loader.waveBlocks[2].forEach((id) => wave3.add(id));
    loader.waveBlocks.slice(3).flat().forEach((id) => outer.add(id));
    await loader.start();
    const { log, view } = recorder();
    const gate = new DistrictGate(loader, view);
    const p = gate.wait(3);
    await expect.poll(() => log.some((l) => l.startsWith("failed 3 "))).toBe(true);
    const atFailure = log.length;
    const before = loader.chunks().length;
    // Later rings' batches come in after the failure.
    releaseLater();
    await expect.poll(() => loader.chunks().length).toBeGreaterThan(before);
    await loader.done();
    expect(log.slice(atFailure)).toEqual([]);
    expect(log[log.length - 1]).toMatch(/^failed 3 map ring 3 can't be loaded/);
    expect(gate.waiting).toBe(3);
    failWave3 = false;
    gate.retry();
    expect(await p).toBe(true);
    expect(loader.ringReady(3)).toBe(true);
    expect(log[log.length - 1]).toBe("hide");
    loader.abort();
  });

  it("ends with false when cancelled or when the loader is aborted", async () => {
    const fake = fakeOverpass(ways);
    const loader = make(fake);
    const held = fake.hold(() => true);
    const startP = loader.start();
    const { log, view } = recorder();
    const gate = new DistrictGate(loader, view);
    const a = gate.wait(1);
    gate.cancel();
    expect(await a).toBe(false);
    expect(log[log.length - 1]).toBe("hide");
    const b = gate.wait(1);
    loader.abort();
    expect(await b).toBe(false);
    held.release();
    await expect(startP).rejects.toThrow(/aborted/);
  });
});

/** The bboxes of a query's request body. */
function parseBboxesOf(init?: RequestInit): FakeCall["bboxes"] {
  return parseBboxes((init?.body as URLSearchParams).get("data") ?? "");
}

/** Block ids of a fake call (each box's centre). */
function queryBlocks(c: FakeCall): number[] {
  return c.bboxes.map(([s, w, n, e]) => blockAt((s + n) / 2, (w + e) / 2));
}

describe("map bundle", () => {
  it("holds the shell and the record's blocks, in block id order", () => {
    const shell = buildShell("x", 48.8, 2.3);
    const b = mapBundle(shell, [chunk(3), chunk(1), chunk(2)], [3, 1]);
    expect(b.chunks.map((c) => c.block_id)).toEqual([1, 3]);
    const { chunks, ...rest } = b;
    expect(rest).toEqual(shell);
    expect(chunks).toHaveLength(2);
    expect(() => mapBundle(shell, [chunk(1)], [1, 4])).toThrow(/block 4/);
  });
});
