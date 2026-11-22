// Crate rolls and lore. Rolled with the profile's own PCG32 (pcg32.ts),
// never the match seed: crates are not part of a match or its replay.

import type { CardsTable, RewardsTable } from "./data";
import type { Rng } from "./pcg32";
import { placeLabel } from "./sanitize";
import { ProfileError } from "./store";
import { RARITIES, TIERS, type CrateSource, type Rarity, type Tier } from "./types";

export function isTier(t: unknown): t is Tier {
  return typeof t === "string" && (TIERS as readonly string[]).includes(t);
}

export interface RolledCard {
  cardId: string;
  rarity: Rarity;
  foil: boolean;
}

/// One card: rarity from the tier's odds (cumulative over common, uncommon,
/// rare, legendary against one 24-bit float), then a card of that rarity
/// uniformly (cards.json order), then foil against a second float.
export function rollCard(rng: Rng, cards: CardsTable, odds: RewardsTable["crates"]["odds"][Tier]): RolledCard {
  const u = rng.float();
  let acc = 0;
  let rarity: Rarity = RARITIES[RARITIES.length - 1];
  for (const r of RARITIES) {
    acc += odds[r];
    if (u < acc) {
      rarity = r;
      break;
    }
  }
  // A rarity with no card (custom tables): fall back to the nearest lower one.
  let pool = cards.cards.filter((c) => c.rarity === rarity);
  for (let i = RARITIES.indexOf(rarity); pool.length === 0 && i > 0; i--) {
    rarity = RARITIES[i - 1];
    pool = cards.cards.filter((c) => c.rarity === rarity);
  }
  const card = pool[rng.below(pool.length)];
  const foil = rng.float() < odds.foil;
  return { cardId: card.id, rarity, foil };
}

/// Throws ProfileError("bad_ticket") on a tier with no odds (a ticket from
/// a corrupt or foreign profile), before the RNG moves.
export function rollCrate(rng: Rng, cards: CardsTable, rewards: RewardsTable, tier: Tier, count: number): RolledCard[] {
  if (!isTier(tier) || !Object.hasOwn(rewards.crates.odds, tier)) throw new ProfileError("bad_ticket", `no crate odds for tier ${String(tier)}`);
  const odds = rewards.crates.odds[tier];
  return Array.from({ length: count }, () => rollCard(rng, cards, odds));
}

const WAVE_WORDS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];
const TIER_NAMES: Record<Tier, string> = { recruit: "Recruit", veteran: "Veteran", elite: "Elite", nightmare: "Nightmare" };

export function tierName(t: Tier): string {
  return TIER_NAMES[t];
}

/// "Where and how it was recovered", from a lore template of the crate's
/// source. `{place}` is the sanitised "District, City"; `{wave}` is a word
/// ("eighth"), so a lore line has no digit; `{tier}` the tier name.
export function crateLore(rng: Rng, rewards: RewardsTable, source: CrateSource, district: string, city: string, wave: number, tier: Tier): string {
  if (!isTier(tier)) throw new ProfileError("bad_ticket", `unknown tier ${String(tier)}`);
  const templates = Object.hasOwn(rewards.crates.lore, source) ? rewards.crates.lore[source] : undefined;
  if (!Array.isArray(templates) || templates.length === 0) throw new ProfileError("bad_ticket", `no lore for crate source ${String(source)}`);
  const t = templates[rng.below(templates.length)];
  const w = WAVE_WORDS[Math.min(8, Math.max(1, wave)) - 1];
  return t.replace(/\{place\}/g, placeLabel(district, city)).replace(/\{wave\}/g, w).replace(/\{tier\}/g, TIER_NAMES[tier]);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/// Rebuild a stored lore line (import): when `lore` reads as one of the
/// source's templates, the same line with `{place}` made again from the
/// sanitised `district` and `city`. The wave word and the tier name are
/// kept: they can only be one of the fixed words. null when no template
/// matches (unknown source, or a line from other tables): the caller decides.
export function rebuildLore(rewards: RewardsTable, source: string, lore: string, district: string, city: string): string | null {
  const templates = Object.hasOwn(rewards.crates.lore, source) ? rewards.crates.lore[source as CrateSource] : undefined;
  if (!Array.isArray(templates) || typeof lore !== "string") return null;
  const word = (ws: string[]) => `(${ws.map(escapeRe).join("|")})`;
  for (const t of templates) {
    const parts = t.split(/(\{place\}|\{wave\}|\{tier\})/);
    const pattern = parts.map((p) => (p === "{place}" ? "([\\s\\S]*?)" : p === "{wave}" ? word(WAVE_WORDS) : p === "{tier}" ? word(Object.values(TIER_NAMES)) : escapeRe(p)));
    const m = new RegExp(`^${pattern.join("")}$`).exec(lore);
    if (!m) continue;
    const place = placeLabel(district, city);
    let g = 0;
    return parts
      .map((p) => {
        if (p !== "{place}" && p !== "{wave}" && p !== "{tier}") return p;
        g += 1;
        return p === "{place}" ? place : m[g];
      })
      .join("");
  }
  return null;
}
