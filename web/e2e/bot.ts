// A scripted player for the browser match tests: the same strategy as
// `sim-headless match` (crates/sim-headless/src/matchcmd.rs), in TypeScript.
// It only computes action inputs (trig is fine here: a replay reads the
// actions back, it never re-runs the script). The tests drive it through
// the page's test hook; `bot-check.mts` drives it on WasmMatch under Node to
// pick a scenario quickly.

export interface HandCard {
  hand_index: number;
  card: string;
  name: string;
  kind: "fortification" | "armament" | "tactical";
  rarity: string;
  cost: number;
  target: "buildings" | "polyline" | "point";
  keep: boolean;
  playable: boolean;
}

export interface Building {
  index: number;
  x: number;
  y: number;
  area: number;
  floors: number;
  cells: number;
  wave: number;
}

export interface BotView {
  wave: number;
  center: [number, number];
  radius: number;
  /** Ring radius of every wave, index 0 = wave 1. */
  rings: number[];
  hand: HandCard[];
  buildings: Building[];
  /** Shooters as [building or -1, x, y] (units have building -1). */
  towers: { building: number; x: number; y: number }[];
  mulliganAvailable: boolean;
}

/** Revealed, garrisonable buildings (at least 10 m², not taken), picked
 *  greedily for coverage: each pick is the building farthest from every
 *  shooter so far, the play-area edge counting as covered. Ties by index. */
export function pickSpread(v: BotView, want: number, exclude: number[] = []): number[] {
  const taken = new Set(v.towers.map((t) => t.building));
  for (const e of exclude) taken.add(e);
  const pts = v.towers.filter((t) => t.building >= 0).map((t) => [t.x, t.y]);
  const [cx, cy] = v.center;
  const cands = v.buildings.filter((b) => b.cells > 0 && b.area >= 10 && !taken.has(b.index) && b.wave <= v.wave);
  const out: number[] = [];
  while (out.length < want) {
    let best: { s: number; b: Building } | null = null;
    for (const b of cands) {
      if (out.includes(b.index)) continue;
      const edge = Math.max(0, v.radius - Math.hypot(b.x - cx, b.y - cy)) + 25;
      let s = edge;
      for (const q of pts) s = Math.min(s, Math.hypot(q[0] - b.x, q[1] - b.y));
      if (!best || s > best.s || (s === best.s && b.index < best.b.index)) best = { s, b };
    }
    if (!best) break;
    out.push(best.b.index);
    pts.push([best.b.x, best.b.y]);
  }
  return out;
}

/** Largest buildings anywhere in the revealed area (the retry variant). */
export function pickLargest(v: BotView, want: number, exclude: number[] = []): number[] {
  const taken = new Set(v.towers.map((t) => t.building));
  for (const e of exclude) taken.add(e);
  return v.buildings
    .filter((b) => b.cells > 0 && b.area >= 10 && !taken.has(b.index) && b.wave <= v.wave)
    .sort((a, b) => b.area * b.floors - a.area * a.floors || a.index - b.index)
    .slice(0, want)
    .map((b) => b.index);
}

export function pickTowers(v: BotView, variant: number, want: number, exclude: number[] = []): number[] {
  return variant % 2 === 0 ? pickSpread(v, want, exclude) : pickLargest(v, want, exclude);
}

/** Where the fences of this wave go: a circle 4 m inside the previous ring
 *  (wave 1: 60% of the core). */
export function fenceRadius(v: BotView): number {
  return v.wave === 1 ? 0.6 * v.rings[0] : v.rings[v.wave - 2] - 4;
}

/** An arc of the circle from angle a0 grown in 2° steps while its placed
 *  length (`length`, the core's `fence_length_m`) stays within `limit`. */
export async function fenceArc(
  center: [number, number],
  r: number,
  a0: number,
  limit: number,
  length: (pts: [number, number][]) => Promise<number | null>,
): Promise<{ pts: [number, number][]; end: number }> {
  const at = (a: number): [number, number] => [center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)];
  const step = (2 * Math.PI) / 180;
  // Grow in chunks of 8 steps, then back off one step at a time: far fewer
  // length queries than one per step, same arc.
  let n = 1;
  const ok = async (k: number) => {
    const pts: [number, number][] = [];
    for (let i = 0; i <= k; i++) pts.push(at(a0 + i * step));
    const l = await length(pts);
    return l !== null && l <= limit;
  };
  while (n + 8 < 180 && (await ok(n + 8))) n += 8;
  while (n + 1 < 180 && (await ok(n + 1))) n += 1;
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) pts.push(at(a0 + i * step));
  return { pts, end: a0 + n * step };
}

/** The densest group of zombies: the 20 m square holding the most, at the
 *  mean position of its zombies. */
export function zombieHotspot(zombies: [number, number][]): [number, number] | null {
  const cells = new Map<string, { n: number; x: number; y: number; k: [number, number] }>();
  for (const [x, y] of zombies) {
    const k: [number, number] = [Math.floor(x / 20), Math.floor(y / 20)];
    const key = `${k[0]},${k[1]}`;
    const e = cells.get(key) ?? { n: 0, x: 0, y: 0, k };
    e.n++;
    e.x += x;
    e.y += y;
    cells.set(key, e);
  }
  let best: { n: number; x: number; y: number; k: [number, number] } | null = null;
  for (const e of cells.values()) {
    if (!best || e.n > best.n || (e.n === best.n && (e.k[0] < best.k[0] || (e.k[0] === best.k[0] && e.k[1] < best.k[1])))) best = e;
  }
  return best ? [best.x / best.n, best.y / best.n] : null;
}

/** Card limits the script needs (from cards.json). */
export interface CardInfo {
  kind: string;
  effect: { type: string; buildings?: number; length_m?: number };
}

export type Action =
  | { type: "play_card"; hand_index: number; target: { buildings: number[] } | { polyline: [number, number][] } | { point: [number, number] } }
  | { type: "mulligan" }
  | { type: "keep_cards"; hand_indices: number[] }
  | { type: "repair"; fence_id: number }
  | { type: "pull_down"; placement_id: number }
  | { type: "start_wave" }
  | { type: "next_wave" }
  | { type: "retry_wave" }
  | { type: "restart_match" };

/** What the script plays through: the page's test hook in the browser,
 *  WasmMatch under Node. */
export interface BotApi {
  view(): Promise<BotView>;
  apply(a: Action): Promise<string | null>;
  fenceLength(pts: [number, number][]): Promise<number | null>;
}

/** The prep part of the script: armaments on spread-out buildings, then
 *  fences as arcs. Returns the cards played. */
export async function playPrep(api: BotApi, cards: Record<string, CardInfo>, variant: number, arc: { a: number }): Promise<number> {
  let played = 0;
  for (const kind of ["armament", "fortification"] as const) {
    for (let guard = 0; guard < 10; guard++) {
      const v = await api.view();
      const c = v.hand.find((h) => h.kind === kind && h.playable);
      if (!c) break;
      const info = cards[c.card];
      let a: Action;
      if (info.effect.type === "garrison") {
        a = { type: "play_card", hand_index: c.hand_index, target: { buildings: pickTowers(v, variant, info.effect.buildings!) } };
      } else if (info.effect.type === "fence") {
        const { pts, end } = await fenceArc(v.center, fenceRadius(v), arc.a, info.effect.length_m!, (p) => api.fenceLength(p));
        arc.a = end;
        a = { type: "play_card", hand_index: c.hand_index, target: { polyline: pts } };
      } else break;
      if ((await api.apply(a)) !== null) break;
      played++;
    }
  }
  return played;
}

/** Keep the tactical cards (at most `max`) for later waves. */
export async function keepTactical(api: BotApi, max: number): Promise<number[]> {
  const v = await api.view();
  const keep = v.hand.filter((h) => h.kind === "tactical").map((h) => h.hand_index).slice(0, max);
  await api.apply({ type: "keep_cards", hand_indices: keep });
  return keep;
}
