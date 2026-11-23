// Test fixtures: Overpass ways rebuilt from a committed level pack (inverse
// of the level projection), and a fake Overpass server that answers the
// block queries from them. No network.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { METERS_PER_DEG_LAT, metersPerDegLon, type FetchFn, type OsmWay } from "../../src/map/osm";

export const REPO = fileURLToPath(new URL("../../../", import.meta.url));

export interface LevelJson {
  name: string;
  center_lat: number;
  center_lon: number;
  radius_m: number;
  buildings: { id: number; kind: string; floors: number; polygon: number[][] }[];
}

export function loadLevel(name: string): LevelJson {
  return JSON.parse(readFileSync(`${REPO}levels/${name}.json`, "utf8"));
}

export function loadConfig(): { cell_size_m: number; wave8_radius_m: number; match: { ring_radius_m: number[]; block_margin_m: number } } {
  return JSON.parse(readFileSync(`${REPO}config.default.json`, "utf8"));
}

const TAG_OF_KIND: Record<string, string> = { residential: "apartments", commercial: "retail", other: "church" };

/// A closed way from a local-meters polygon around (lat0, lon0).
export function wayFromPolygon(id: number, polygon: number[][], lat0: number, lon0: number, tags: Record<string, string> = {}): OsmWay {
  const kx = metersPerDegLon(lat0);
  const geometry = polygon.map(([x, y]) => ({ lat: +(lat0 + y / METERS_PER_DEG_LAT).toFixed(7), lon: +(lon0 + x / kx).toFixed(7) }));
  geometry.push({ ...geometry[0] });
  return { type: "way", id, tags: { building: "yes", ...tags }, geometry };
}

/// The level's buildings as Overpass ways (7-decimal lat/lon like OSM).
export function waysFromLevel(level: LevelJson): OsmWay[] {
  return level.buildings.map((b) =>
    wayFromPolygon(b.id, b.polygon, level.center_lat, level.center_lon, { building: TAG_OF_KIND[b.kind], "building:levels": String(b.floors) }),
  );
}

export type Bbox = [number, number, number, number]; // s, w, n, e

export function parseBboxes(query: string): Bbox[] {
  return [...query.matchAll(/way\["building"\]\(([-\d.e]+),([-\d.e]+),([-\d.e]+),([-\d.e]+)\)/g)].map((m) => [+m[1], +m[2], +m[3], +m[4]] as Bbox);
}

/// Whether the segment p–q (lat, lon) meets the closed box (Liang–Barsky).
function segmentMeetsBox(p: { lat: number; lon: number }, q: { lat: number; lon: number }, [s, w, n, e]: Bbox): boolean {
  let t0 = 0;
  let t1 = 1;
  const d = [q.lat - p.lat, q.lon - p.lon];
  const checks: [number, number][] = [
    [-d[0], p.lat - s],
    [d[0], n - p.lat],
    [-d[1], p.lon - w],
    [d[1], e - p.lon],
  ];
  for (const [pp, qq] of checks) {
    if (pp === 0) {
      if (qq < 0) return false;
    } else {
      const r = qq / pp;
      if (pp < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
      if (t0 > t1) return false;
    }
  }
  return true;
}

/// Like Overpass `way(bbox)`: a vertex of the way lies in the box or one of
/// its segments crosses it. A way merely surrounding the box (its bounding
/// box overlaps, nothing inside) is not returned.
export function wayInBbox(w: OsmWay, box: Bbox): boolean {
  const g = w.geometry ?? [];
  const [s, wl, n, e] = box;
  if (g.some((p) => p.lat >= s && p.lat <= n && p.lon >= wl && p.lon <= e)) return true;
  for (let i = 0; i + 1 < g.length; i++) if (segmentMeetsBox(g[i], g[i + 1], box)) return true;
  return false;
}

export interface FakeCall {
  url: string;
  query: string;
  bboxes: Bbox[];
}

export interface FakeOverpass {
  fetch: FetchFn;
  calls: FakeCall[];
  /// Make the next `n` calls fail with this HTTP status.
  failNext(n: number, status?: number): void;
  /// Make the next `n` calls answer HTTP 200 with this JSON body (an
  /// Overpass runtime-error remark, a malformed body, ...).
  bodyNext(n: number, body: unknown): void;
  /// Hold every call whose bboxes match `pred` until `release()`.
  hold(pred: (c: FakeCall) => boolean): { release(): void };
}

/// An Overpass runtime error as Overpass sends it: HTTP 200, partial elements.
export function timeoutBody(elements: OsmWay[] = []): unknown {
  return {
    version: 0.6,
    generator: "Overpass API",
    elements,
    remark: 'runtime error: Query timed out in "query" at line 1 after 91 seconds.',
  };
}

/// An Overpass endpoint answering `way["building"](bbox)` unions from `ways`
/// (a way is returned when a vertex or a segment lies in a query box).
export function fakeOverpass(ways: OsmWay[]): FakeOverpass {
  const calls: FakeCall[] = [];
  let failing = 0;
  let failStatus = 504;
  let bodies = 0;
  let body200: unknown = null;
  const holds: { pred: (c: FakeCall) => boolean; gate: Promise<void> }[] = [];
  const fetch: FetchFn = async (url, init) => {
    const body = init?.body as URLSearchParams;
    const query = body.get("data") ?? "";
    const call = { url, query, bboxes: parseBboxes(query) };
    calls.push(call);
    for (const h of holds) if (h.pred(call)) await h.gate;
    if (failing > 0) {
      failing--;
      return new Response("busy", { status: failStatus });
    }
    if (bodies > 0) {
      bodies--;
      return new Response(JSON.stringify(body200), { status: 200, headers: { "content-type": "application/json" } });
    }
    const elements = ways.filter((w) => call.bboxes.some((b) => wayInBbox(w, b)));
    return new Response(JSON.stringify({ elements }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return {
    fetch,
    calls,
    failNext(n, status = 504) {
      failing = n;
      failStatus = status;
    },
    bodyNext(n, b) {
      bodies = n;
      body200 = b;
    },
    hold(pred) {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      holds.push({ pred, gate });
      return { release };
    },
  };
}

/// A village: the level's buildings whose centroid is within `radius`
/// metres of its centre, nothing else. On a streamed 1.3 km match every
/// civilian lives in wave 1's ring and every garrison stands among them,
/// while the outer rings' outbreaks have to come to them: the test bot
/// clears 8 waves on it (first-session.spec.ts). The plain Marais leaves too
/// few civilians for wave 8 (DECISIONS, "Replay viewer and first session").
export function villageLevel(level: LevelJson, radius: number): LevelJson {
  const centroid = (p: number[][]) => [p.reduce((a, q) => a + q[0], 0) / p.length, p.reduce((a, q) => a + q[1], 0) / p.length];
  return { ...level, name: `${level.name}-village`, radius_m: radius, buildings: level.buildings.filter((b) => Math.hypot(...(centroid(b.polygon) as [number, number])) <= radius) };
}
