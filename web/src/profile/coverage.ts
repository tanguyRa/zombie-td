// Coverage map: the cells of the global block grid (map/blocks.ts, about
// 251 m square) a cleared match defended, with the highest tier per cell,
// and the "city cleared" achievement.
//
// PRIVACY: coverage is the player's own map of places they defended, so it
// says where they play (often their home). It stays in this profile and is
// never sent anywhere by the local implementation. When a server takes over,
// it publishes only aggregates (the combined liberation map, per-city
// percentages summed over many players) and never one player's cells; see
// `ProfileService.coverageInBox`.

import { blockId, blockLatLonBounds, blocksForDisc, colOf, rowOf } from "../map/blocks";
import { METERS_PER_DEG_LAT, metersPerDegLon, project } from "../map/osm";
import { tierIndex } from "./data";
import { isCityId } from "./place";
import { TIERS, type CoverageCell, type LatLon, type LatLonBox, type Tier } from "./types";

/// Area (m²) of a grid cell, in the same equirectangular metres as the
/// level projection at the cell's mid-latitude.
export function cellAreaM2(cell: number): number {
  const b = blockLatLonBounds(cell);
  const h = (b.north - b.south) * METERS_PER_DEG_LAT;
  const w = (b.east - b.west) * metersPerDegLon((b.north + b.south) / 2);
  return h * w;
}

/// The cells whose centre lies within `radiusM` of `center` (level
/// projection). Centre-inside, not "touching", so the defended area isn't
/// overstated: on average the cells cover the disc's area.
export function cellsInDisc(center: LatLon, radiusM: number): number[] {
  if (!(radiusM > 0)) return [];
  return blocksForDisc(center.lat, center.lon, radiusM)
    .filter((id) => {
      const b = blockLatLonBounds(id);
      const [x, y] = project((b.south + b.north) / 2, (b.west + b.east) / 2, center.lat, center.lon);
      return x * x + y * y <= radiusM * radiusM;
    })
    .sort((a, b) => a - b);
}

/// Merge a match into existing cells: each cell keeps its highest tier, and
/// its highest tier per city key (`null`: no city, e.g. a name that
/// sanitised to nothing). Returns the cells that changed.
export function mergeCoverage(existing: Map<number, CoverageCell>, cells: number[], tier: Tier, cityKey: string | null): CoverageCell[] {
  const changed: CoverageCell[] = [];
  const ti = tierIndex(tier);
  for (const id of cells) {
    const old = existing.get(id);
    if (!old) {
      const c: CoverageCell = { cell: id, tier, cities: cityKey === null ? {} : { [cityKey]: tier }, areaM2: cellAreaM2(id), bounds: blockLatLonBounds(id) };
      existing.set(id, c);
      changed.push(c);
      continue;
    }
    let dirty = false;
    const next: CoverageCell = { ...old, cities: { ...old.cities } };
    if (ti > tierIndex(old.tier)) {
      next.tier = tier;
      dirty = true;
    }
    const prevCity = cityKey === null ? undefined : old.cities[cityKey];
    if (cityKey !== null && (prevCity === undefined || ti > tierIndex(prevCity))) {
      next.cities[cityKey] = tier;
      dirty = true;
    }
    if (dirty) {
      existing.set(id, next);
      changed.push(next);
    }
  }
  return changed;
}

export function boxesIntersect(a: LatLonBox, b: LatLonBox): boolean {
  return a.west < b.east && b.west < a.east && a.south < b.north && b.south < a.north;
}

/// Cells of `all` intersecting the box, sorted by id.
export function cellsInBox(all: Iterable<CoverageCell>, box: LatLonBox): CoverageCell[] {
  const out: CoverageCell[] = [];
  for (const c of all) if (boxesIntersect(c.bounds, box)) out.push(c);
  return out.sort((a, b) => a.cell - b.cell);
}

/// Candidate cell ids for a box (to read only those from storage), or null
/// when the box spans too many cells to enumerate (then scan everything).
export function cellIdsForBox(box: LatLonBox, max = 20000): number[] | null {
  const r0 = rowOf(box.south);
  const r1 = rowOf(box.north);
  if (r1 - r0 + 1 > max) return null;
  const ids: number[] = [];
  for (let r = r0; r <= r1; r++) {
    const c0 = colOf(r, box.west);
    const c1 = colOf(r, box.east);
    if (ids.length + (c1 - c0 + 1) > max) return null;
    for (let c = c0; c <= c1; c++) ids.push(blockId(r, c));
  }
  return ids;
}

/// The achievement key of a city: its stable id when the place search gave
/// an accepted one (`osm:relation:<digits>`, see place.ts; any other id is
/// ignored), else its folded name ("Paris" = "paris" = " PARIS "). Callers
/// pass the sanitised name (`sanitizePlace(city, "city")`), never a raw
/// geocoder field: the key is stored in cells and achievement ids.
export function cityKeyOf(city: string, cityId?: string): string {
  if (isCityId(cityId)) return `id:${cityId}`;
  return "name:" + city.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ");
}

/// Defended fraction of a city at each tier: area of the cells counted for
/// that city at that tier or harder, over the city's area (capped at 1).
export function cityFractions(cells: Iterable<CoverageCell>, cityKey: string, cityAreaM2: number): Record<Tier, number> {
  const area = [0, 0, 0, 0];
  for (const c of cells) {
    const t = c.cities[cityKey];
    if (t === undefined) continue;
    const ti = tierIndex(t);
    for (let i = 0; i <= ti; i++) area[i] += c.areaM2;
  }
  const out = {} as Record<Tier, number>;
  TIERS.forEach((t, i) => (out[t] = cityAreaM2 > 0 ? Math.min(1, area[i] / cityAreaM2) : 0));
  return out;
}
