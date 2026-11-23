// Fetching the buildings of map blocks from Overpass.
//
// Geometry is kept in lat/lon (as Overpass returns it), so a cached block is
// reusable for any match centre. Each building belongs to exactly one block:
// the block containing its anchor vertex, the lexicographically smallest
// (lat, then lon) vertex of its ring. The anchor is a vertex, so it lies in
// its block's (padded) query box and Overpass `way(bbox)` always returns the
// way for that block's own query, whatever the batching; it does not depend
// on the ring's starting vertex or direction. A query returns every way
// touching any of its boxes; ways anchored in another block are dropped
// (that block's own query returns them). A vertex mean or centroid would
// not do: it can lie in a block that no vertex or segment of the way enters.

import { blockAt, blockLatLonBounds, type BlockId } from "./blocks";
import { floorsOf, kindOf, overpassQuery, type BuildingKind, type FetchFn, type OsmWay } from "./osm";

/// One building as cached: OSM way id, derived kind and floors, and the outer
/// ring as flat `[lat0, lon0, lat1, lon1, ...]`, not closed.
export interface RawBuilding {
  id: number;
  kind: BuildingKind;
  floors: number;
  ring: number[];
}

/// Padding (degrees, ~0.1 m) added to each block box in the query, so a way
/// lying exactly on an edge is never missed by float formatting.
const BBOX_PAD_DEG = 1e-6;

export interface OverpassOptions {
  fetch?: FetchFn;
  signal?: AbortSignal;
  /// Once aborted, no further endpoint is tried (see `overpassQuery`).
  stop?: AbortSignal;
  urls?: string[];
  /// Per-endpoint limit (default `OVERPASS_REQUEST_TIMEOUT_MS`).
  timeoutMs?: number;
}

/// The Overpass QL query for the buildings of these blocks (a union of boxes).
export function blocksQuery(ids: BlockId[]): string {
  const parts = ids.map((id) => {
    const b = blockLatLonBounds(id);
    return `way["building"](${b.south - BBOX_PAD_DEG},${b.west - BBOX_PAD_DEG},${b.north + BBOX_PAD_DEG},${b.east + BBOX_PAD_DEG});`;
  });
  return `[out:json][timeout:80];(${parts.join("")});out tags geom;`;
}

/// A way as a cached building plus the block that owns it, or null when it
/// has no usable ring (fewer than 3 distinct vertices).
export function rawBuildingOf(w: OsmWay): { block: BlockId; building: RawBuilding } | null {
  const g = w.geometry;
  if (w.type !== "way" || !g || g.length < 4) return null;
  const pts = g.slice();
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first.lat === last.lat && first.lon === last.lon) pts.pop();
  if (pts.length < 3) return null;
  let anchor = pts[0];
  const ring: number[] = [];
  for (const p of pts) {
    if (p.lat < anchor.lat || (p.lat === anchor.lat && p.lon < anchor.lon)) anchor = p;
    ring.push(p.lat, p.lon);
  }
  const tags = w.tags ?? {};
  return {
    block: blockAt(anchor.lat, anchor.lon),
    building: { id: w.id, kind: kindOf(tags), floors: floorsOf(tags), ring },
  };
}

/// Split Overpass elements into the given blocks (each sorted by building
/// id, duplicates removed). Blocks with no buildings map to `[]`; elements
/// owned by other blocks are dropped.
export function assignToBlocks(elements: OsmWay[], ids: BlockId[]): Map<BlockId, RawBuilding[]> {
  const out = new Map<BlockId, RawBuilding[]>(ids.map((id) => [id, []]));
  const seen = new Set<number>();
  for (const el of elements) {
    if (seen.has(el.id)) continue;
    const r = rawBuildingOf(el);
    if (!r) continue;
    const list = out.get(r.block);
    if (!list) continue;
    seen.add(el.id);
    list.push(r.building);
  }
  for (const list of out.values()) list.sort((a, b) => a.id - b.id);
  return out;
}

/// Fetch the buildings of a batch of blocks in one Overpass query.
export async function fetchBlocks(ids: BlockId[], opts: OverpassOptions = {}): Promise<Map<BlockId, RawBuilding[]>> {
  const elements = await overpassQuery(blocksQuery(ids), opts);
  return assignToBlocks(elements, ids);
}
