// Global city grid blocks (see DECISIONS.md, "Map blocks (T6a)").
//
// The grid is a lat/lon grid: rows of 1/440 degree of latitude (about 251 m),
// and in each row a whole number of equal columns around the globe, chosen so
// the blocks are about square in the level projection. Every block is a
// lat/lon rectangle, so in the level projection (linear in lat and in lon) it
// is an exact axis-aligned rectangle, and neighbours share their edges bit
// for bit. The grid is fixed: the same block id means the same area for any
// match centre.
//
// Block id: `row * 2^18 + col`, a plain safe integer below 2^35 (fits a JS
// number, JSON and Rust's u64 exactly). Row 0 starts at the south pole.

import { METERS_PER_DEG_LAT, detCos, metersPerDegLon, project, rad, roundCm } from "./osm";

export type BlockId = number;

export interface LatLon {
  lat: number;
  lon: number;
}

export interface LatLonBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/// Rows per degree of latitude: blocks are 110540 / 440 = 251.2 m tall.
export const ROWS_PER_DEG = 440;
export const ROWS = 180 * ROWS_PER_DEG;
/// Column multiplier in the id. Columns per row are at most ~163 000 < 2^18.
export const COL_SPAN = 2 ** 18;
/// Distance slack (meters) for disc/block intersection, so a block exactly
/// tangent to a disc (or a few f32 ulps away) counts as touching it.
export const TOUCH_EPS_M = 0.05;

/// Latitude of the southern edge of row `r` (r = ROWS gives the north pole).
export function rowEdgeLat(r: number): number {
  return r / ROWS_PER_DEG - 90;
}

const colsCache = new Map<number, number>();

/// Number of columns in row `r`: round(360° × cos(mid-lat) × 111320 / 110540
/// × ROWS_PER_DEG), at least 1. Uses `detCos` so every engine agrees.
export function rowCols(r: number): number {
  let n = colsCache.get(r);
  if (n === undefined) {
    const mid = (rowEdgeLat(r) + rowEdgeLat(r + 1)) / 2;
    n = Math.max(1, Math.floor(((360 * ROWS_PER_DEG * detCos(rad(mid)) * 111320) / METERS_PER_DEG_LAT) + 0.5));
    colsCache.set(r, n);
  }
  return n;
}

/// Longitude of the western edge of column `c` in row `r` (c = cols gives +180).
export function colEdgeLon(r: number, c: number): number {
  return (c * 360) / rowCols(r) - 180;
}

/// The row containing `lat` (south edge inclusive, north edge exclusive).
export function rowOf(lat: number): number {
  let r = Math.floor((lat + 90) * ROWS_PER_DEG);
  r = Math.min(ROWS - 1, Math.max(0, r));
  // Make the result agree exactly with `rowEdgeLat` (float rounding).
  while (r > 0 && lat < rowEdgeLat(r)) r--;
  while (r < ROWS - 1 && lat >= rowEdgeLat(r + 1)) r++;
  return r;
}

/// The column of row `r` containing `lon` (west edge inclusive).
export function colOf(r: number, lon: number): number {
  const n = rowCols(r);
  let c = Math.floor(((lon + 180) * n) / 360);
  c = Math.min(n - 1, Math.max(0, c));
  while (c > 0 && lon < colEdgeLon(r, c)) c--;
  while (c < n - 1 && lon >= colEdgeLon(r, c + 1)) c++;
  return c;
}

export function blockId(row: number, col: number): BlockId {
  return row * COL_SPAN + col;
}

export function blockRowCol(id: BlockId): [number, number] {
  if (!Number.isSafeInteger(id) || id < 0) throw new Error(`bad block id ${id}`);
  const row = Math.floor(id / COL_SPAN);
  const col = id - row * COL_SPAN;
  if (row >= ROWS || col >= rowCols(row)) throw new Error(`bad block id ${id}`);
  return [row, col];
}

/// The block containing a point.
export function blockAt(lat: number, lon: number): BlockId {
  const r = rowOf(lat);
  return blockId(r, colOf(r, lon));
}

export function blockLatLonBounds(id: BlockId): LatLonBox {
  const [r, c] = blockRowCol(id);
  return { south: rowEdgeLat(r), west: colEdgeLon(r, c), north: rowEdgeLat(r + 1), east: colEdgeLon(r, c + 1) };
}

/// The block in level-local meters for a match centred on `center`:
/// `[min_x, min_y, max_x, max_y]`, the projected corners rounded to cm (the
/// same rounding on a shared edge, so blocks still tile exactly).
export function blockBoundsLocal(id: BlockId, center: LatLon): [number, number, number, number] {
  const b = blockLatLonBounds(id);
  const [x0, y0] = project(b.south, b.west, center.lat, center.lon);
  const [x1, y1] = project(b.north, b.east, center.lat, center.lon);
  return [roundCm(x0), roundCm(y0), roundCm(x1), roundCm(y1)];
}

/// Distance (meters, level projection) from the centre to the nearest point of the block.
export function blockDistanceM(id: BlockId, center: LatLon): number {
  const [x0, y0, x1, y1] = blockBoundsLocal(id, center);
  const dx = Math.max(x0, 0, -x1);
  const dy = Math.max(y0, 0, -y1);
  return Math.hypot(dx, dy);
}

/// Whether the block touches the disc of `radiusM` around the centre.
function touches(dist: number, radiusM: number): boolean {
  return dist <= radiusM + TOUCH_EPS_M;
}

/// Sort block ids closest first (distance from the centre to the block, then id).
export function sortClosestFirst(ids: BlockId[], center: LatLon): BlockId[] {
  const d = new Map(ids.map((id) => [id, blockDistanceM(id, center)]));
  return [...ids].sort((a, b) => d.get(a)! - d.get(b)! || a - b);
}

/// Every block touching the disc of `radiusM` around (centerLat, centerLon),
/// closest first. Their union covers the disc.
export function blocksForDisc(centerLat: number, centerLon: number, radiusM: number): BlockId[] {
  const center = { lat: centerLat, lon: centerLon };
  const span = radiusM + 1;
  const dLat = span / METERS_PER_DEG_LAT;
  const dLon = span / metersPerDegLon(centerLat);
  const out: BlockId[] = [];
  for (let r = rowOf(centerLat - dLat); r <= rowOf(centerLat + dLat); r++) {
    for (let c = colOf(r, centerLon - dLon); c <= colOf(r, centerLon + dLon); c++) {
      const id = blockId(r, c);
      if (touches(blockDistanceM(id, center), radiusM)) out.push(id);
    }
  }
  return sortClosestFirst(out, center);
}

/// Blocks touching the disc of `rOuter` but not the disc of `rInner`, closest
/// first: with successive radii, the rings partition the blocks of the largest disc.
export function blocksForRing(center: LatLon, rInner: number, rOuter: number): BlockId[] {
  return blocksForDisc(center.lat, center.lon, rOuter).filter((id) => !touches(blockDistanceM(id, center), rInner));
}
