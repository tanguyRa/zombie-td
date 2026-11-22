// Projecting cached blocks into sim-core `BuildingChunk`s for a match centre,
// and the canonical map snapshot hash over a set of chunks.

import { blockBoundsLocal, type BlockId, type LatLon } from "./blocks";
import { fnv1a64Hex } from "./hash";
import { MIN_AREA_M2, area, clipConvex, project, roundCm, type BuildingKind, type Pt } from "./osm";
import type { RawBuilding } from "./overpass";

/// Mirrors sim-core `level::Building` (level-local meters).
export interface ChunkBuilding {
  id: number;
  kind: BuildingKind;
  floors: number;
  polygon: [number, number][];
}

/// Mirrors sim-core `match_::BuildingChunk`.
export interface BuildingChunk {
  block_id: BlockId;
  bounds: [number, number, number, number];
  buildings: ChunkBuilding[];
}

/// `match.block_margin_m` in config.default.json: how far a building may
/// stick out of its block in sim-core.
export const BLOCK_MARGIN_M = 50;
/// Buildings are clipped to the block grown by this much: 0.1 m inside the
/// sim-core limit, so cm rounding and f32 parsing can never trip its check.
export const CLIP_MARGIN_M = BLOCK_MARGIN_M - 0.1;

/// Project one cached block for a match centred on `center`.
///
/// Rules (all deterministic, + - * / and Math.round only):
/// - each ring is projected with the level projection (`osm.project`);
/// - a ring with a vertex outside the block grown by `CLIP_MARGIN_M` is
///   clipped to that rectangle (Sutherland–Hodgman); if fewer than 3 vertices
///   remain the building is dropped;
/// - a building whose (clipped, unrounded) area is below 15 m² is dropped,
///   like `levelgen.ts`;
/// - coordinates are rounded to cm (`Math.round(v * 100) / 100`);
/// - buildings are sorted by OSM id.
export function projectBlock(block: { id: BlockId; buildings: RawBuilding[] }, center: LatLon): BuildingChunk {
  const bounds = blockBoundsLocal(block.id, center);
  const m = CLIP_MARGIN_M;
  const [x0, y0, x1, y1] = [bounds[0] - m, bounds[1] - m, bounds[2] + m, bounds[3] + m];
  const clipRect: Pt[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const out: ChunkBuilding[] = [];
  const sorted = [...block.buildings].sort((a, b) => a.id - b.id);
  for (const b of sorted) {
    let ring: Pt[] = [];
    for (let i = 0; i + 1 < b.ring.length; i += 2) ring.push(project(b.ring[i], b.ring[i + 1], center.lat, center.lon));
    if (ring.some(([x, y]) => x < x0 || y < y0 || x > x1 || y > y1)) {
      ring = clipConvex(ring, clipRect);
    }
    if (ring.length < 3) continue;
    if (area(ring) < MIN_AREA_M2) continue;
    out.push({ id: b.id, kind: b.kind, floors: b.floors, polygon: ring.map(([x, y]) => [roundCm(x), roundCm(y)]) });
  }
  return { block_id: block.id, bounds, buildings: out };
}

/// Prefix of the snapshot hash input; bump the version if the format changes.
export const SNAPSHOT_PREFIX = "zt-map-v1\n";

const cm = (v: number) => Math.round(v * 100);

/// One chunk's canonical line (no trailing newline): the compact JSON
/// `[block_id,[x0,y0,x1,y1],[[id,"kind",floors_dm,[x,y,x,y,...]],...]]`
/// where coordinates are integer centimetres (`round(v × 100)`), floors are
/// integer tenths (`round(floors × 10)`), and buildings are in id order.
export function canonicalChunk(c: BuildingChunk): string {
  const bs = [...c.buildings].sort((a, b) => a.id - b.id);
  return JSON.stringify([
    c.block_id,
    c.bounds.map(cm),
    bs.map((b) => [b.id, b.kind, Math.round(b.floors * 10), b.polygon.flatMap(([x, y]) => [cm(x), cm(y)])]),
  ]);
}

/// The map snapshot hash of a set of chunks: FNV-1a 64 over the UTF-8 bytes
/// of `SNAPSHOT_PREFIX` followed by `canonicalChunk(c) + "\n"` for every
/// chunk in ascending block id order. 16 lowercase hex digits. Independent
/// of the order chunks are given in; duplicate block ids are an error.
export function snapshotHash(chunks: BuildingChunk[]): string {
  const sorted = [...chunks].sort((a, b) => a.block_id - b.block_id);
  let s = SNAPSHOT_PREFIX;
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i].block_id === sorted[i - 1].block_id) throw new Error(`duplicate block ${sorted[i].block_id}`);
    s += canonicalChunk(sorted[i]) + "\n";
  }
  return fnv1a64Hex(s);
}
