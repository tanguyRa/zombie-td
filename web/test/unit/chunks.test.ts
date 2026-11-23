import { afterEach, describe, expect, it, vi } from "vitest";
import { blockAt, blockBoundsLocal, blockId, blockRowCol, blocksForDisc } from "../../src/map/blocks";
import { BLOCK_MARGIN_M, canonicalChunk, projectBlock, snapshotHash, type BuildingChunk } from "../../src/map/chunks";
import { fnv1a64Hex, fnv1a64HexBigInt } from "../../src/map/hash";
import { assignToBlocks } from "../../src/map/overpass";
import { roundCm, roundHalfUp } from "../../src/map/osm";
import { loadLevel, waysFromLevel, wayFromPolygon } from "./fixtures";

const level = loadLevel("paris-marais");
const CENTER = { lat: level.center_lat, lon: level.center_lon };
const ways = waysFromLevel(level);
const ids = blocksForDisc(CENTER.lat, CENTER.lon, 450);
const raw = assignToBlocks(ways, ids);
const chunksAt = (c = CENTER) => ids.map((id) => projectBlock({ id, buildings: raw.get(id)! }, c));

afterEach(() => vi.unstubAllGlobals());

describe("projection", () => {
  it("reproduces the committed level within a centimetre (lat/lon round trip)", () => {
    const byId = new Map(chunksAt().flatMap((c) => c.buildings).map((b) => [b.id, b]));
    for (const b of level.buildings) {
      const mine = byId.get(b.id);
      if (!mine) continue; // < 15 m² or outside the 450 m disc
      expect(mine.polygon.length).toBe(b.polygon.length);
      mine.polygon.forEach(([x, y], i) => {
        expect(Math.abs(x - b.polygon[i][0])).toBeLessThan(0.011);
        expect(Math.abs(y - b.polygon[i][1])).toBeLessThan(0.011);
      });
    }
  });

  it("is deterministic and sorts buildings by id", () => {
    const id = blockAt(CENTER.lat, CENTER.lon);
    const list = raw.get(id)!;
    expect(list.length).toBeGreaterThan(20);
    const a = projectBlock({ id, buildings: list }, CENTER);
    const shuffled = [...list].reverse();
    const b = projectBlock({ id, buildings: shuffled }, CENTER);
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    const order = a.buildings.map((x) => x.id);
    expect(order).toEqual([...order].sort((x, y) => x - y));
    for (const bd of a.buildings) for (const [x, y] of bd.polygon) {
      expect(Math.round(x * 100) / 100).toBe(x);
      expect(Math.round(y * 100) / 100).toBe(y);
    }
  });

  it("gives bounds containing the block, shared exactly with neighbours", () => {
    for (const c of chunksAt()) {
      expect(c.bounds).toEqual(blockBoundsLocal(c.block_id, CENTER));
      const [x0, y0, x1, y1] = c.bounds;
      expect(x1 - x0).toBeGreaterThan(200);
      expect(y1 - y0).toBeGreaterThan(200);
    }
    const [r, col] = blockRowCol(blockAt(CENTER.lat, CENTER.lon));
    expect(blockBoundsLocal(blockId(r, col), CENTER)[2]).toBe(blockBoundsLocal(blockId(r, col + 1), CENTER)[0]);
  });

  it("keeps every building within the sim-core margin (clipping big ones)", () => {
    const id = blockAt(CENTER.lat, CENTER.lon);
    const [x0, y0, x1, y1] = blockBoundsLocal(id, CENTER);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    // 600 m long building centred in the block (a flat diamond, anchored by
    // its southern vertex in this block): sticks out ~175 m each side.
    const big = wayFromPolygon(1, [[cx, cy - 5], [cx + 300, cy], [cx, cy + 5], [cx - 300, cy]], CENTER.lat, CENTER.lon);
    const tiny = wayFromPolygon(2, [[cx, cy], [cx + 3, cy], [cx + 3, cy + 3], [cx, cy + 3]], CENTER.lat, CENTER.lon);
    const got = assignToBlocks([big, tiny], [id]).get(id)!;
    const chunk = projectBlock({ id, buildings: got }, CENTER);
    expect(chunk.buildings.map((b) => b.id)).toEqual([1]); // tiny (9 m²) dropped
    const xs = chunk.buildings[0].polygon.map((p) => p[0]);
    expect(Math.min(...xs)).toBeCloseTo(x0 - 49.9, 1);
    expect(Math.max(...xs)).toBeCloseTo(x1 + 49.9, 1);
    for (const c of chunksAt())
      for (const b of c.buildings)
        for (const [x, y] of b.polygon) {
          // The sim-core check, in f32.
          const f = Math.fround;
          const m = BLOCK_MARGIN_M;
          expect(f(x) >= f(c.bounds[0]) - m && f(x) <= f(c.bounds[2]) + m && f(y) >= f(c.bounds[1]) - m && f(y) <= f(c.bounds[3]) + m).toBe(true);
        }
  });
});

describe("rounding", () => {
  it("is floor(v * 100 + 0.5) exactly (half up, also for negative halves)", () => {
    expect(roundHalfUp(12.5)).toBe(13);
    expect(roundHalfUp(-12.5)).toBe(-12); // Rust's f64::round gives -13
    expect(roundHalfUp(-12.51)).toBe(-13);
    // floor(v + 0.5), not "nearest": 0.49999999999999994 + 0.5 rounds to 1 in f64.
    expect(roundHalfUp(0.49999999999999994)).toBe(1);
    expect(roundCm(-0.125)).toBe(-0.12);
    expect(roundCm(0.125)).toBe(0.13);
    const chunk: BuildingChunk = { block_id: 1, bounds: [-0.125, 0.125, 1, 2], buildings: [{ id: 1, kind: "other", floors: 2.25, polygon: [[-0.125, 0], [1, 0], [1, 1]] }] };
    expect(canonicalChunk(chunk)).toBe('[1,[-12,13,100,200],[[1,"other",23,[-12,0,100,0,100,100]]]]');
  });
});

describe("snapshot hash", () => {
  it("FNV-1a 64 matches the reference and known vectors", () => {
    expect(fnv1a64Hex("")).toBe("cbf29ce484222325");
    expect(fnv1a64Hex("a")).toBe("af63dc4c8601ec8c");
    expect(fnv1a64Hex("foobar")).toBe("85944171f73967e8");
    let s = "";
    for (let i = 0; i < 300; i++) {
      s += String.fromCharCode(32 + ((i * 7919) % 95)) + (i % 17 === 0 ? "é€" : "");
      expect(fnv1a64Hex(s)).toBe(fnv1a64HexBigInt(s));
    }
  });

  it("uses the documented canonical form", () => {
    const c: BuildingChunk = {
      block_id: 42,
      bounds: [-1.5, 2, 250.25, 251.2],
      buildings: [
        { id: 9, kind: "other", floors: 2.5, polygon: [[0, 0], [10, 0], [10, 10.01]] },
        { id: 3, kind: "residential", floors: 1, polygon: [[-1, -2], [3, 4], [5, -6.07]] },
      ],
    };
    expect(canonicalChunk(c)).toBe('[42,[-150,200,25025,25120],[[3,"residential",10,[-100,-200,300,400,500,-607]],[9,"other",25,[0,0,1000,0,1000,1001]]]]');
    expect(snapshotHash([c])).toBe(fnv1a64Hex("zt-map-v1\n" + canonicalChunk(c) + "\n"));
    expect(snapshotHash([])).toBe(fnv1a64Hex("zt-map-v1\n"));
  });

  it("is independent of chunk and building order", () => {
    const chunks = chunksAt();
    const h = snapshotHash(chunks);
    expect(snapshotHash([...chunks].reverse())).toBe(h);
    const shuffled = chunks.map((c, i) => ({ ...c, buildings: i % 2 ? [...c.buildings].reverse() : c.buildings }));
    expect(snapshotHash([...shuffled.slice(5), ...shuffled.slice(0, 5)])).toBe(h);
    expect(() => snapshotHash([...chunks, chunks[0]])).toThrow(/duplicate/);
  });

  it("changes when any building changes", () => {
    const chunks = chunksAt();
    const h = snapshotHash(chunks);
    const k = chunks.findIndex((c) => c.buildings.length > 3);
    const edit = (f: (c: BuildingChunk) => void) => {
      const copy = structuredClone(chunks);
      f(copy[k]);
      return snapshotHash(copy);
    };
    const variants = [
      edit((c) => (c.buildings[2].polygon[1][0] += 0.01)),
      edit((c) => (c.buildings[2].polygon[0][1] -= 0.01)),
      edit((c) => (c.buildings[1].floors += 0.1)),
      edit((c) => (c.buildings[0].kind = c.buildings[0].kind === "other" ? "commercial" : "other")),
      edit((c) => (c.buildings[3].id += 1)),
      edit((c) => c.buildings.splice(1, 1)),
      edit((c) => c.buildings[0].polygon.pop()),
      edit((c) => (c.bounds[2] += 0.01)),
      edit((c) => (c.block_id = 12345)),
      snapshotHash(chunks.slice(1)),
    ];
    for (const v of variants) expect(v).not.toBe(h);
    expect(new Set(variants).size).toBe(variants.length);
  });

  it("differs between match centres (it hashes the projected chunks)", () => {
    expect(snapshotHash(chunksAt({ lat: CENTER.lat + 0.001, lon: CENTER.lon }))).not.toBe(snapshotHash(chunksAt()));
  });
});
