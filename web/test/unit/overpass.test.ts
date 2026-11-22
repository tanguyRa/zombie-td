import { describe, expect, it } from "vitest";
import { blockAt, blockLatLonBounds, blockRowCol, blockId, blocksForDisc, type BlockId } from "../../src/map/blocks";
import { assignToBlocks, blocksQuery, fetchBlocks, rawBuildingOf } from "../../src/map/overpass";
import { project, type OsmWay } from "../../src/map/osm";
import { fakeOverpass, loadLevel, parseBboxes, waysFromLevel, wayFromPolygon } from "./fixtures";

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
    const ways = [rect(1, edgeX - 10, midY), rect(2, edgeX + 10, midY), rect(3, edgeX - 0.5, midY)];
    const fake = fakeOverpass(ways);
    // Fetched one block at a time, or both in one batch: same assignment.
    const a = await fetchBlocks([home], { fetch: fake.fetch, urls: ["x"] });
    const e = await fetchBlocks([east], { fetch: fake.fetch, urls: ["x"] });
    const both = await fetchBlocks([east, home], { fetch: fake.fetch, urls: ["x"] });
    expect(a.get(home)!.map((x) => x.id)).toEqual([1, 3]);
    expect(e.get(east)!.map((x) => x.id)).toEqual([2]);
    expect(both.get(home)).toEqual(a.get(home));
    expect(both.get(east)).toEqual(e.get(east));
    // Every way of the queries was returned to both blocks by the server (they touch both boxes).
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
});
