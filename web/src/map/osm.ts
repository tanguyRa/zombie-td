// Shared OpenStreetMap helpers: Overpass endpoints, the building-kind and
// floors mapping, and the local projection. Used by the block loader
// (`overpass.ts`, `chunks.ts`); `tools/levelgen/levelgen.py` has the same
// mapping for the committed levels.

export const OVERPASS_URLS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"];

const RESIDENTIAL = new Set([
  "yes", "residential", "house", "apartments", "detached", "semidetached_house",
  "terrace", "bungalow", "dormitory", "farm", "cabin", "houseboat", "static_caravan",
]);
const COMMERCIAL = new Set([
  "commercial", "retail", "office", "supermarket", "hotel", "kiosk", "shop",
  "mall", "restaurant", "bank", "warehouse", "industrial",
]);

/// Buildings smaller than this (after clipping) are dropped.
export const MIN_AREA_M2 = 15;

export type BuildingKind = "residential" | "commercial" | "other";

export interface OsmWay {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

export type Pt = [number, number];

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/// cos(x) for |x| <= pi/2 from +, -, *, / only (Taylor series to x^24), so
/// every JS engine (and a Rust port in f64) gets the same bits. `Math.cos`
/// is implementation-defined and may differ in the last ulp between browsers.
export function detCos(x: number): number {
  const x2 = x * x;
  let term = 1;
  let sum = 1;
  for (let k = 1; k <= 12; k++) {
    term = (-term * x2) / ((2 * k - 1) * (2 * k));
    sum += term;
  }
  return sum;
}

/// Degrees to radians with the same constant everywhere.
export function rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/// Meters per degree of longitude at `lat0` (equirectangular, as levelgen.py).
export function metersPerDegLon(lat0: number): number {
  return detCos(rad(lat0)) * 111320;
}
export const METERS_PER_DEG_LAT = 110540;

/// The local projection of every level: equirectangular around (lat0, lon0),
/// x east and y north in meters. Linear in lon and in lat separately, so a
/// lat/lon rectangle projects to an axis-aligned rectangle.
export function project(lat: number, lon: number, lat0: number, lon0: number): Pt {
  return [(lon - lon0) * metersPerDegLon(lat0), (lat - lat0) * METERS_PER_DEG_LAT];
}

/// Round half up: `floor(v + 0.5)`, the rule every port must use (Rust's
/// `f64::round` rounds negative halves away from zero, so it differs).
export function roundHalfUp(v: number): number {
  return Math.floor(v + 0.5);
}

/// Round to centimetres (the precision of level packs): `floor(v*100 + 0.5) / 100`.
export function roundCm(v: number): number {
  return roundHalfUp(v * 100) / 100;
}

export function floorsOf(tags: Record<string, string>): number {
  for (const [key, div] of [["building:levels", 1], ["height", 3]] as const) {
    const v = tags[key];
    if (v === undefined) continue;
    const f = parseFloat(String(v).split(";")[0].replace("m", "").trim()) / div;
    if (Number.isFinite(f) && f > 0) return Math.max(1, roundHalfUp(f * 10) / 10);
  }
  return 2;
}

export function kindOf(tags: Record<string, string>): BuildingKind {
  const b = tags.building ?? "yes";
  if (COMMERCIAL.has(b)) return "commercial";
  if (RESIDENTIAL.has(b)) return "residential";
  return "other";
}

export function area(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i];
    const [x1, y1] = p[(i + 1) % p.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

/// Sutherland–Hodgman clip of `subject` against a convex, counter-clockwise polygon.
export function clipConvex(subject: Pt[], clip: Pt[]): Pt[] {
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

/// Why an Overpass response body is unusable, or null when it is fine.
/// Overpass answers a timeout or out-of-memory with HTTP 200, a `remark`
/// like "runtime error: Query timed out ..." and partial or empty
/// `elements`: that is a failure, never an empty area.
export function overpassBodyError(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return "Overpass sent a malformed answer";
  const b = body as { elements?: unknown; remark?: unknown };
  if (typeof b.remark === "string" && /error/i.test(b.remark)) return `Overpass failed (${b.remark.slice(0, 120)})`;
  if (!Array.isArray(b.elements)) return "Overpass sent a malformed answer";
  return null;
}

/// How long one endpoint may take to answer (the queries ask Overpass for at
/// most 90 s). A public instance can hold a request for minutes; without a
/// limit it never fails, so neither the retry nor the player's Retry
/// loading would ever come.
export const OVERPASS_REQUEST_TIMEOUT_MS = 120_000;

/// POST one Overpass QL query, trying each endpoint in turn. An HTTP error,
/// an unparsable body, a body without an `elements` array, one with an
/// error `remark` (timeout, out of memory) or no answer within `timeoutMs`
/// is a failure of that endpoint. Throws with a player-readable message
/// when all fail.
export async function overpassQuery(query: string, opts: { fetch?: FetchFn; signal?: AbortSignal; urls?: string[]; timeoutMs?: number } = {}): Promise<OsmWay[]> {
  const f: FetchFn = opts.fetch ?? ((i, init) => fetch(i, init));
  const limit = opts.timeoutMs ?? OVERPASS_REQUEST_TIMEOUT_MS;
  let lastErr = "";
  for (const url of opts.urls ?? OVERPASS_URLS) {
    // This request's own signal: the caller's abort, or the time limit.
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) ctl.abort();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, limit);
    try {
      const r = await f(url, { method: "POST", body: new URLSearchParams({ data: query }), signal: ctl.signal });
      if (r.ok) {
        const body: unknown = await r.json();
        const bad = overpassBodyError(body);
        if (bad === null) return (body as { elements: OsmWay[] }).elements;
        lastErr = bad;
        continue;
      }
      lastErr = r.status === 429 || r.status === 504 ? `Overpass is busy (${r.status})` : `Overpass error ${r.status}`;
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      lastErr = timedOut ? `Overpass did not answer within ${Math.round(limit / 1000)} s` : `Could not reach Overpass (${String(e)})`;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
  throw new Error(`${lastErr}. Try again in a minute.`);
}
