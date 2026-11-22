// Browser port of tools/levelgen/levelgen.py: one Overpass query for the
// building ways around a point, then the playable radius grows in 50 m steps
// until the building count is in range. Produces the same level pack JSON
// that sim-core reads.
//
// Differences from the Python tool (no shapely here): footprints are clipped
// to the circle with Sutherland–Hodgman against a 64-gon, so a building cut
// into several pieces stays one polygon joined along the circle edge (those
// cells are walls anyway), and invalid rings are not repaired.

const OVERPASS_URLS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"];

const RESIDENTIAL = new Set([
  "yes", "residential", "house", "apartments", "detached", "semidetached_house",
  "terrace", "bungalow", "dormitory", "farm", "cabin", "houseboat", "static_caravan",
]);
const COMMERCIAL = new Set([
  "commercial", "retail", "office", "supermarket", "hotel", "kiosk", "shop",
  "mall", "restaurant", "bank", "warehouse", "industrial",
]);

export const QUERY_RADIUS_M = 600;
export const MIN_BUILDINGS = 600;
export const MAX_BUILDINGS = 1200;
/// Below this many buildings even at the full query radius, the place is too empty to play.
export const PLAYABLE_MIN_BUILDINGS = 40;
const START_RADIUS_M = 100;
const RADIUS_STEP_M = 50;
const MIN_AREA_M2 = 15;

interface OsmWay {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

export interface LevelPackJson {
  name: string;
  center_lat: number;
  center_lon: number;
  radius_m: number;
  source: string;
  generated_at: string;
  buildings: { id: number; kind: string; floors: number; polygon: number[][] }[];
}

type Pt = [number, number];

function project(lat: number, lon: number, lat0: number, lon0: number): Pt {
  return [(lon - lon0) * Math.cos((lat0 * Math.PI) / 180) * 111320, (lat - lat0) * 110540];
}

function floorsOf(tags: Record<string, string>): number {
  for (const [key, div] of [["building:levels", 1], ["height", 3]] as const) {
    const v = tags[key];
    if (v === undefined) continue;
    const f = parseFloat(String(v).split(";")[0].replace("m", "").trim()) / div;
    if (Number.isFinite(f) && f > 0) return Math.max(1, Math.round(f * 10) / 10);
  }
  return 2;
}

function kindOf(tags: Record<string, string>): string {
  const b = tags.building ?? "yes";
  if (COMMERCIAL.has(b)) return "commercial";
  if (RESIDENTIAL.has(b)) return "residential";
  return "other";
}

function area(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i];
    const [x1, y1] = p[(i + 1) % p.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

/// Sutherland–Hodgman clip of `subject` against a convex, counter-clockwise polygon.
function clipConvex(subject: Pt[], clip: Pt[]): Pt[] {
  let out = subject;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    const inside = (p: Pt) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
    const cross = (p: Pt, q: Pt): Pt => {
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const ex = b[0] - a[0];
      const ey = b[1] - a[1];
      const t = (ex * (p[1] - a[1]) - ey * (p[0] - a[0])) / (ey * dx - ex * dy);
      return [p[0] + t * dx, p[1] + t * dy];
    };
    const input = out;
    out = [];
    for (let k = 0; k < input.length; k++) {
      const p = input[k];
      const q = input[(k + 1) % input.length];
      const pin = inside(p);
      const qin = inside(q);
      if (pin && qin) out.push(q);
      else if (pin && !qin) out.push(cross(p, q));
      else if (!pin && qin) out.push(cross(p, q), q);
    }
  }
  return out;
}

function circle(r: number): Pt[] {
  const c: Pt[] = [];
  for (let i = 0; i < 64; i++) {
    const t = (i / 64) * 2 * Math.PI;
    c.push([r * Math.cos(t), r * Math.sin(t)]);
  }
  return c;
}

interface Projected {
  id: number;
  tags: Record<string, string>;
  ring: Pt[];
  maxDist: number;
  minDist: number;
}

function projectAll(ways: OsmWay[], lat0: number, lon0: number): Projected[] {
  const out: Projected[] = [];
  for (const w of ways) {
    const g = w.geometry;
    if (w.type !== "way" || !g || g.length < 4) continue;
    const ring = g.map((p) => project(p.lat, p.lon, lat0, lon0));
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) ring.pop();
    if (ring.length < 3) continue;
    let maxDist = 0;
    let minDist = Infinity;
    for (const [x, y] of ring) {
      const d = Math.hypot(x, y);
      maxDist = Math.max(maxDist, d);
      minDist = Math.min(minDist, d);
    }
    out.push({ id: w.id, tags: w.tags ?? {}, ring, maxDist, minDist });
  }
  return out;
}

function buildingsWithin(all: Projected[], radius: number): LevelPackJson["buildings"] {
  const clip = circle(radius);
  const out: LevelPackJson["buildings"] = [];
  for (const b of all) {
    if (b.minDist >= radius) continue;
    let ring = b.ring;
    if (b.maxDist > radius) {
      // Clip expects a consistent winding; SH works for either subject orientation.
      ring = clipConvex(ring, clip);
      if (ring.length < 3) continue;
    }
    if (area(ring) < MIN_AREA_M2) continue;
    out.push({
      id: b.id,
      kind: kindOf(b.tags),
      floors: floorsOf(b.tags),
      polygon: ring.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]),
    });
  }
  return out;
}

async function overpass(lat: number, lon: number, radius: number, signal?: AbortSignal): Promise<OsmWay[]> {
  const q = `[out:json][timeout:60];way["building"](around:${radius.toFixed(0)},${lat},${lon});out tags geom;`;
  let lastErr = "";
  for (const url of OVERPASS_URLS) {
    try {
      const r = await fetch(url, { method: "POST", body: new URLSearchParams({ data: q }), signal });
      if (r.ok) return ((await r.json()) as { elements: OsmWay[] }).elements;
      lastErr = r.status === 429 || r.status === 504 ? `Overpass is busy (${r.status})` : `Overpass error ${r.status}`;
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = `Could not reach Overpass (${String(e)})`;
    }
  }
  throw new Error(`${lastErr}. Try again in a minute.`);
}

export interface GenProgress {
  (msg: string): void;
}

/// Download buildings around (lat, lon) and build a level pack.
export async function generateLevel(name: string, lat: number, lon: number, progress: GenProgress, signal?: AbortSignal): Promise<LevelPackJson> {
  progress("Downloading buildings from OpenStreetMap…");
  const ways = await overpass(lat, lon, QUERY_RADIUS_M, signal);
  progress(`Building the level from ${ways.length.toLocaleString()} footprints…`);
  await new Promise((r) => setTimeout(r, 0));
  const all = projectAll(ways, lat, lon);
  type Choice = { radius: number; buildings: LevelPackJson["buildings"] } | null;
  let chosen: Choice = null;
  let prev: Choice = null;
  for (let radius = START_RADIUS_M; radius <= QUERY_RADIUS_M; radius += RADIUS_STEP_M) {
    const b = buildingsWithin(all, radius);
    if (b.length > MAX_BUILDINGS) {
      chosen = prev ?? { radius, buildings: b };
      break;
    }
    prev = { radius, buildings: b };
    if (b.length >= MIN_BUILDINGS) {
      chosen = prev;
      break;
    }
  }
  chosen ??= prev; // sparse area: use the full query radius
  if (!chosen || chosen.buildings.length < PLAYABLE_MIN_BUILDINGS) {
    throw new Error(`Only ${chosen?.buildings.length ?? 0} buildings within ${QUERY_RADIUS_M} m. Pick a more built-up spot.`);
  }
  return {
    name,
    center_lat: lat,
    center_lon: lon,
    radius_m: chosen.radius,
    source: "OpenStreetMap contributors (ODbL), via Overpass API",
    generated_at: new Date().toISOString().slice(0, 10),
    buildings: chosen.buildings,
  };
}
