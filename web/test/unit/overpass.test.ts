import { describe, expect, it } from "vitest";
import { blockAt, blockBoundsLocal, blockLatLonBounds, blockRowCol, blockId, blocksForDisc, type BlockId } from "../../src/map/blocks";
import { assignToBlocks, blocksQuery, fetchBlocks, rawBuildingOf } from "../../src/map/overpass";
import { overpassBodyError, overpassQuery, project, type FetchFn, type OsmWay } from "../../src/map/osm";
import { fakeOverpass, loadLevel, parseBboxes, timeoutBody, wayInBbox, waysFromLevel, wayFromPolygon } from "./fixtures";

const PARIS = { lat: 48.858, lon: 2.358 };

/// A 60 × 20 m building centred on the given local point.
function rect(id: number, cx: number, cy: number, w = 60, h = 20): OsmWay {
  return wayFromPolygon(id, [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]], PARIS.lat, PARIS.lon, {
    building: "house",
  });
}

describe("overpass block queries", () => {
  it("builds one union query with a box per block", () => {
    const ids = blocksForDisc(PARIS.lat, PARIS.lon, 300).slice(0, 3);
    const q = blocksQuery(ids);
    expect(q.startsWith("[out:json]")).toBe(true);
    expect(q.endsWith("out tags geom;")).toBe(true);
    const boxes = parseBboxes(q);
    expect(boxes).toHaveLength(3);
    boxes.forEach(([s, w, n, e], i) => {
      const b = blockLatLonBounds(ids[i]);
      expect(s).toBeLessThan(b.south);
      expect(n).toBeGreaterThan(b.north);
      expect(w).toBeLessThan(b.west);
      expect(e).toBeGreaterThan(b.east);
      expect(blockAt((s + n) / 2, (w + e) / 2)).toBe(ids[i]);
    });
  });

  it("puts a building straddling a block edge in exactly one block", async () => {
    const home = blockAt(PARIS.lat, PARIS.lon);
    const [r, c] = blockRowCol(home);
    const east = blockId(r, c + 1);
    const b = blockLatLonBounds(home);
    const [edgeX] = project(PARIS.lat, b.east, PARIS.lat, PARIS.lon);
    const [, midY] = project((b.south + b.north) / 2, PARIS.lon, PARIS.lat, PARIS.lon);
    // Anchored by the south-west corner: 1 and 3 in `home` (3 sticks 59 m
    // into `east`), 2 in `east` (starts 0.5 m east of the edge).
    const ways = [rect(1, edgeX - 10, midY), rect(2, edgeX + 30.5, midY), rect(3, edgeX + 29, midY)];
    const fake = fakeOverpass(ways);
    // Fetched one block at a time, or both in one batch: same assignment.
    const a = await fetchBlocks([home], { fetch: fake.fetch, urls: ["x"] });
    const e = await fetchBlocks([east], { fetch: fake.fetch, urls: ["x"] });
    const both = await fetchBlocks([east, home], { fetch: fake.fetch, urls: ["x"] });
    expect(a.get(home)!.map((x) => x.id)).toEqual([1, 3]);
    expect(e.get(east)!.map((x) => x.id)).toEqual([2]);
    expect(both.get(home)).toEqual(a.get(home));
    expect(both.get(east)).toEqual(e.get(east));
    expect(fake.calls).toHaveLength(3);
  });

  it("assigns every building of a real area to exactly one block", () => {
    const level = loadLevel("paris-marais");
    const ways = waysFromLevel(level);
    const ids = blocksForDisc(level.center_lat, level.center_lon, 450);
    const got = assignToBlocks(ways, ids);
    const seen = new Map<number, BlockId>();
    for (const [id, list] of got) {
      for (const b of list) {
        expect(seen.has(b.id)).toBe(false);
        seen.set(b.id, id);
        expect(rawBuildingOf(ways.find((w) => w.id === b.id)!)!.block).toBe(id);
      }
      const sorted = [...list].sort((x, y) => x.id - y.id);
      expect(list).toEqual(sorted);
    }
    expect(seen.size).toBe(level.buildings.length);
  });

  it("keeps lat/lon geometry, drops degenerate ways and duplicates", () => {
    const w = rect(7, 0, 0);
    const res = assignToBlocks([w, w, { type: "way", id: 8, geometry: w.geometry!.slice(0, 3) }, { type: "node", id: 9 }], [blockAt(PARIS.lat, PARIS.lon)]);
    const list = [...res.values()][0];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 7, kind: "residential", floors: 2 });
    expect(list[0].ring).toHaveLength(8); // 4 vertices, closing one removed
    expect(list[0].ring[0]).toBe(w.geometry![0].lat);
    expect(list[0].ring[1]).toBe(w.geometry![0].lon);
  });

  it("falls back to the next endpoint", async () => {
    const fake = fakeOverpass([rect(1, 0, 0)]);
    fake.failNext(1, 429);
    const got = await fetchBlocks([blockAt(PARIS.lat, PARIS.lon)], { fetch: fake.fetch, urls: ["a", "b"] });
    expect([...got.values()][0]).toHaveLength(1);
    expect(fake.calls.map((c) => c.url)).toEqual(["a", "b"]);
    fake.failNext(2, 504);
    await expect(fetchBlocks([blockAt(PARIS.lat, PARIS.lon)], { fetch: fake.fetch, urls: ["a", "b"] })).rejects.toThrow(/busy/);
  });

  it("treats a runtime-error remark (HTTP 200) as a failure and tries the next endpoint", async () => {
    const home = blockAt(PARIS.lat, PARIS.lon);
    const [x0, y0, x1, y1] = blockBoundsLocal(home, PARIS);
    const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
    const fake = fakeOverpass([rect(1, cx, cy), rect(2, cx, cy + 40)]);
    fake.bodyNext(1, timeoutBody([rect(1, cx, cy)])); // partial elements, as Overpass does
    const got = await fetchBlocks([home], { fetch: fake.fetch, urls: ["a", "b"] });
    expect(got.get(home)!.map((b) => b.id)).toEqual([1, 2]);
    expect(fake.calls.map((c) => c.url)).toEqual(["a", "b"]);
    fake.bodyNext(2, { elements: [], remark: "runtime error: Query run out of memory using about 2048 MB of RAM." });
    await expect(fetchBlocks([home], { fetch: fake.fetch, urls: ["a", "b"] })).rejects.toThrow(/out of memory/);
    // A harmless remark is not an error.
    expect(overpassBodyError({ elements: [], remark: "note: nothing" })).toBeNull();
    expect(overpassBodyError({ elements: [] })).toBeNull();
    expect(overpassBodyError({ elements: {} })).toMatch(/malformed/);
    expect(overpassBodyError(null)).toMatch(/malformed/);
  });

  it("the fake answers like Overpass way(bbox): a vertex or a segment in the box", () => {
    const box: [number, number, number, number] = [48.85, 2.35, 48.86, 2.36];
    const way = (pts: [number, number][]): OsmWay => ({ type: "way", id: 1, geometry: pts.map(([lat, lon]) => ({ lat, lon })) });
    expect(wayInBbox(way([[48.855, 2.355], [48.87, 2.37]]), box)).toBe(true); // vertex inside
    expect(wayInBbox(way([[48.855, 2.34], [48.855, 2.37]]), box)).toBe(true); // segment crosses
    expect(wayInBbox(way([[48.84, 2.34], [48.84, 2.37], [48.87, 2.37], [48.87, 2.34], [48.84, 2.34]]), box)).toBe(false); // surrounds it
    expect(wayInBbox(way([[48.84, 2.34], [48.845, 2.37]]), box)).toBe(false);
  });

  it("assigns a C-shaped building by its smallest vertex: the same content whatever the batching", async () => {
    // A C wrapping block B on the west, south and north, with its vertex mean
    // inside B but no vertex or segment in B's box: Overpass never returns
    // it for B's own query.
    const B = blockAt(PARIS.lat, PARIS.lon);
    const [x0, y0, x1, y1] = blockBoundsLocal(B, PARIS);
    const W = x1 - x0;
    const H = y1 - y0;
    const poly = [
      [x0 - 20, y0 - 20], [x1 + 50, y0 - 20], [x1 + 50, y0 - 5], [x0 - 5, y0 - 5],
      [x0 - 5, y1 + 5], [x1 + 50, y1 + 5], [x1 + 50, y1 + 20], [x0 - 20, y1 + 20],
    ];
    const meanX = poly.reduce((s, p) => s + p[0], 0) / poly.length;
    const meanY = poly.reduce((s, p) => s + p[1], 0) / poly.length;
    expect(meanX > x0 && meanX < x1 && meanY > y0 && meanY < y1).toBe(true);
    expect(W).toBeGreaterThan(200);
    expect(H).toBeGreaterThan(200);
    const c = wayFromPolygon(42, poly, PARIS.lat, PARIS.lon);
    const fake = fakeOverpass([c]);
    // B and every block around it (rows don't align their columns).
    const bc = { lat: (blockLatLonBounds(B).south + blockLatLonBounds(B).north) / 2, lon: (blockLatLonBounds(B).west + blockLatLonBounds(B).east) / 2 };
    const around = blocksForDisc(bc.lat, bc.lon, 260);
    expect(around).toContain(B);
    for (const p of c.geometry!) expect(around).toContain(blockAt(p.lat, p.lon));
    // B's own query doesn't see the C (real Overpass semantics).
    const bQuery = parseBboxes(blocksQuery([B]))[0];
    expect(wayInBbox(c, bQuery)).toBe(false);
    // Owner: the block of the smallest (lat, lon) vertex, the SW corner, in the row below.
    const owner = rawBuildingOf(c)!.block;
    const sw = c.geometry![0];
    expect(owner).toBe(blockAt(sw.lat, sw.lon));
    expect(blockRowCol(owner)[0]).toBe(blockRowCol(B)[0] - 1);
    expect(owner).not.toBe(B);
    // Rotation / direction of the ring doesn't matter.
    const g = c.geometry!.slice(0, -1);
    const rotated: OsmWay = { ...c, geometry: [...g.slice(3), ...g.slice(0, 3), g[3]] };
    const reversed: OsmWay = { ...c, geometry: [...g].reverse().concat([g[g.length - 1]]) };
    expect(rawBuildingOf(rotated)!.block).toBe(owner);
    expect(rawBuildingOf(reversed)!.block).toBe(owner);

    const content = async (batches: BlockId[][]) => {
      const out = new Map<BlockId, number[]>();
      for (const ids of batches) for (const [id, list] of await fetchBlocks(ids, { fetch: fake.fetch, urls: ["x"] })) out.set(id, list.map((b) => b.id));
      return [...out.entries()].sort((a, b) => a[0] - b[0]);
    };
    const one = await content(around.map((id) => [id]));
    const all = await content([around]);
    // B batched with a neighbour that does see the C (the old vertex-mean rule put it in B then).
    const seer = around.find((id) => id !== B && id !== owner && wayInBbox(c, parseBboxes(blocksQuery([id]))[0]))!;
    expect(seer).toBeDefined();
    const pairs = await content([[B, seer], ...around.filter((id) => id !== B && id !== seer).map((id) => [id])]);
    const sorted = [...around].sort((a, b) => a - b);
    const expected = sorted.map((id) => [id, id === owner ? [42] : []]);
    expect(one).toEqual(expected);
    expect(all).toEqual(expected);
    expect(pairs).toEqual(expected);
  });
});

describe("overpassQuery time limit", () => {
  /** A fetch whose first URL never answers (until aborted), the second answers. */
  const hanging = (): { fetch: FetchFn; seen: string[] } => {
    const seen: string[] = [];
    const fetch: FetchFn = (url, init) => {
      seen.push(url);
      if (url.includes("slow"))
        return new Promise((_, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
      return Promise.resolve(new Response(JSON.stringify({ elements: [] }), { status: 200 }));
    };
    return { fetch, seen };
  };

  it("gives up on an endpoint that holds the request, and tries the next", async () => {
    const h = hanging();
    expect(await overpassQuery("q", { fetch: h.fetch, urls: ["https://slow.test", "https://ok.test"], timeoutMs: 30 })).toEqual([]);
    expect(h.seen).toEqual(["https://slow.test", "https://ok.test"]);
  });

  it("fails with a readable message when every endpoint hangs", async () => {
    const h = hanging();
    await expect(overpassQuery("q", { fetch: h.fetch, urls: ["https://slow.test"], timeoutMs: 30 })).rejects.toThrow(/^Overpass did not answer within 0 s\. Try again in a minute\.$/);
  });

  it("still passes the caller's abort through", async () => {
    const h = hanging();
    const ctl = new AbortController();
    const p = overpassQuery("q", { fetch: h.fetch, urls: ["https://slow.test", "https://ok.test"], signal: ctl.signal, timeoutMs: 60_000 });
    ctl.abort();
    await expect(p).rejects.toThrow(/aborted/);
    expect(h.seen).toEqual(["https://slow.test"]);
  });
});
