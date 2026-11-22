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

export function loadConfig(): { wave8_radius_m: number; match: { ring_radius_m: number[]; block_margin_m: number } } {
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

function wayTouches(w: OsmWay, [s, wl, n, e]: Bbox): boolean {
  const g = w.geometry ?? [];
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const p of g) {
    a = Math.min(a, p.lat);
    b = Math.min(b, p.lon);
    c = Math.max(c, p.lat);
    d = Math.max(d, p.lon);
  }
  return a <= n && c >= s && b <= e && d >= wl;
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
  /// Hold every call whose bboxes match `pred` until `release()`.
  hold(pred: (c: FakeCall) => boolean): { release(): void };
}

/// An Overpass endpoint answering `way["building"](bbox)` unions from `ways`
/// (a way is returned when its bounding box touches a query box).
export function fakeOverpass(ways: OsmWay[]): FakeOverpass {
  const calls: FakeCall[] = [];
  let failing = 0;
  let failStatus = 504;
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
    // levelgen.ts's `around:` query gets every way (the fixture is one area).
    const elements = query.includes("(around:") ? ways : ways.filter((w) => call.bboxes.some((b) => wayTouches(w, b)));
    return new Response(JSON.stringify({ elements }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return {
    fetch,
    calls,
    failNext(n, status = 504) {
      failing = n;
      failStatus = status;
    },
    hold(pred) {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      holds.push({ pred, gate });
      return { release };
    },
  };
}
