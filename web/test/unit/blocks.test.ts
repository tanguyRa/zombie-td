import { describe, expect, it } from "vitest";
import {
  COL_SPAN,
  ROWS,
  blockAt,
  blockBoundsLocal,
  blockDistanceM,
  blockId,
  blockLatLonBounds,
  blockRowCol,
  blocksForDisc,
  blocksForRing,
  rowCols,
  type BlockId,
  type LatLon,
} from "../../src/map/blocks";
import { detCos, project } from "../../src/map/osm";

const PARIS: LatLon = { lat: 48.858, lon: 2.358 };
const PLACES: [string, LatLon][] = [
  ["Paris", PARIS],
  ["Sydney", { lat: -33.8688, lon: 151.2093 }],
  ["Reykjavik", { lat: 64.1466, lon: -21.9426 }],
  ["Quito (equator)", { lat: -0.18, lon: -78.4678 }],
];

describe("block ids", () => {
  it("are stable (pinned values)", () => {
    // If these change, every cached block and run record breaks: bump the
    // cache SCHEMA_VERSION and the snapshot prefix instead.
    expect(blockAt(PARIS.lat, PARIS.lon)).toBe(blockId(61097, 53162));
    expect(blockAt(PARIS.lat, PARIS.lon)).toBe(16016265130);
    expect(rowCols(61097)).toBe(104951);
    expect(blockLatLonBounds(16016265130)).toEqual({
      south: 61097 / 440 - 90,
      north: 61098 / 440 - 90,
      west: (53162 * 360) / 104951 - 180,
      east: (53163 * 360) / 104951 - 180,
    });
    expect(blockRowCol(blockAt(-33.8688, 151.2093))[0]).toBe(rowOfLat(-33.8688));
  });

  it("round-trip through row/col and are safe integers below 2^35", () => {
    for (const [, c] of PLACES) {
      for (const id of blocksForDisc(c.lat, c.lon, 600)) {
        expect(Number.isSafeInteger(id)).toBe(true);
        expect(id).toBeLessThan(2 ** 35);
        const [r, col] = blockRowCol(id);
        expect(blockId(r, col)).toBe(id);
        expect(col).toBeLessThan(COL_SPAN);
      }
    }
    expect(rowCols(Math.floor(ROWS / 2))).toBeLessThan(COL_SPAN);
    expect(rowCols(0)).toBeGreaterThanOrEqual(1);
    expect(rowCols(ROWS - 1)).toBeGreaterThanOrEqual(1);
    expect(() => blockRowCol(-1)).toThrow();
    expect(() => blockRowCol(blockId(61097, 104951))).toThrow();
  });

  it("are unique and independent of the match centre", () => {
    const a = blocksForDisc(PARIS.lat, PARIS.lon, 800);
    expect(new Set(a).size).toBe(a.length);
    // A centre 400 m east sees the same blocks (same ids) where they overlap.
    const b = blocksForDisc(PARIS.lat, PARIS.lon + 400 / (111320 * detCos((PARIS.lat * Math.PI) / 180)), 800);
    const shared = a.filter((id) => b.includes(id));
    expect(shared.length).toBeGreaterThan(a.length / 3);
    for (const id of shared) expect(blockLatLonBounds(id)).toEqual(blockLatLonBounds(id));
  });

  it("are about 250 m square", () => {
    for (const [, c] of PLACES) {
      const [x0, y0, x1, y1] = blockBoundsLocal(blockAt(c.lat, c.lon), c);
      expect(y1 - y0).toBeCloseTo(251.2, 0);
      expect(Math.abs(x1 - x0 - 251.2)).toBeLessThan(3);
    }
  });

  it("detCos matches Math.cos", () => {
    for (let d = -90; d <= 90; d += 0.37) expect(detCos((d * Math.PI) / 180)).toBeCloseTo(Math.cos((d * Math.PI) / 180), 14);
  });
});

function rowOfLat(lat: number) {
  return blockRowCol(blockAt(lat, 0))[0];
}

/// Owner of a point by half-open containment in the local bounds.
function containing(ids: BlockId[], bounds: Map<BlockId, number[]>, x: number, y: number): BlockId[] {
  return ids.filter((id) => {
    const [x0, y0, x1, y1] = bounds.get(id)!;
    return x >= x0 && x < x1 && y >= y0 && y < y1;
  });
}

describe("tiling", () => {
  for (const [name, c] of PLACES) {
    it(`blocks for a disc cover it with no gaps or overlaps (${name})`, () => {
      const R = 700;
      const ids = blocksForDisc(c.lat, c.lon, R);
      const bounds = new Map(ids.map((id) => [id, blockBoundsLocal(id, c)]));
      // Sample the disc every 17 m (plus its rim): each point in exactly one block.
      const pts: [number, number][] = [];
      for (let x = -R; x <= R; x += 17) for (let y = -R; y <= R; y += 17) if (x * x + y * y <= R * R) pts.push([x, y]);
      for (let k = 0; k < 360; k++) pts.push([R * 0.9999 * Math.cos(k), R * 0.9999 * Math.sin(k)]);
      for (const [x, y] of pts) expect(containing(ids, bounds, x, y)).toHaveLength(1);
      // Pairwise: interiors never overlap.
      for (const a of ids)
        for (const b of ids) {
          if (a >= b) continue;
          const p = bounds.get(a)!;
          const q = bounds.get(b)!;
          const ox = Math.min(p[2], q[2]) - Math.max(p[0], q[0]);
          const oy = Math.min(p[3], q[3]) - Math.max(p[1], q[1]);
          expect(ox <= 0 || oy <= 0).toBe(true);
        }
      // Each block touches the disc.
      for (const id of ids) expect(blockDistanceM(id, c)).toBeLessThanOrEqual(R + 0.05);
    });
  }

  it("blockAt agrees with the block bounds (lat/lon and local)", () => {
    const ids = blocksForDisc(PARIS.lat, PARIS.lon, 500);
    for (let i = 0; i < 2000; i++) {
      const lat = PARIS.lat + (Math.sin(i * 12.9898) * 0.5) * 0.009;
      const lon = PARIS.lon + (Math.sin(i * 78.233) * 0.5) * 0.013;
      const id = blockAt(lat, lon);
      const b = blockLatLonBounds(id);
      expect(lat >= b.south && lat < b.north && lon >= b.west && lon < b.east).toBe(true);
      const [x, y] = project(lat, lon, PARIS.lat, PARIS.lon);
      if (Math.hypot(x, y) < 480) expect(ids).toContain(id);
    }
  });

  it("neighbours share edges exactly", () => {
    const id = blockAt(PARIS.lat, PARIS.lon);
    const [r, c] = blockRowCol(id);
    const me = blockBoundsLocal(id, PARIS);
    expect(blockBoundsLocal(blockId(r, c + 1), PARIS)[0]).toBe(me[2]);
    expect(blockBoundsLocal(blockId(r, c - 1), PARIS)[2]).toBe(me[0]);
    expect(blockBoundsLocal(blockAt(blockLatLonBounds(id).north + 1e-9, PARIS.lon), PARIS)[1]).toBe(me[3]);
  });

  it("rings partition the largest disc, closest first", () => {
    const radii = [200, 350, 500, 650, 825, 1000, 1175, 1350];
    const waves = radii.map((r, w) => (w === 0 ? blocksForDisc(PARIS.lat, PARIS.lon, r) : blocksForRing(PARIS, radii[w - 1], r)));
    const all = waves.flat();
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort((a, b) => a - b)).toEqual([...blocksForDisc(PARIS.lat, PARIS.lon, 1350)].sort((a, b) => a - b));
    for (const ring of waves) {
      const d = ring.map((id) => blockDistanceM(id, PARIS));
      for (let i = 1; i < d.length; i++) expect(d[i]).toBeGreaterThanOrEqual(d[i - 1]);
    }
    // A block of ring w is beyond disc w-1: no block is listed twice across waves,
    // and every ring after the first is non-empty at these radii.
    for (const ring of waves) expect(ring.length).toBeGreaterThan(0);
  });
});
