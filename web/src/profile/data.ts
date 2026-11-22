// The data tables the profile reads: cards.json (cards, deck rules, starter
// deck), rewards.json (payout, daily caps, crate odds and lore, coverage)
// and the `difficulty` section of config.default.json. All three are bundled
// (Vite JSON imports); tests can pass other tables to `LocalProfileService`.

import cardsJson from "../../../cards.json";
import config from "../../../config.default.json";
import rewardsJson from "../../../rewards.json";
import { RARITIES, TIERS, type DeckError, type Rarity, type Tier } from "./types";

export interface CardDef {
  id: string;
  name: string;
  rarity: Rarity;
  kind: string;
  cost: number;
}

export interface CardsTable {
  deck_rules: { deck_size: number; max_copies: Record<Rarity, number>; max_legendaries: number };
  starter_decks: { id: string; name: string; cards: { card: string; copies: number }[] }[];
  cards: CardDef[];
}

export type RarityOdds = Record<Rarity, number> & { foil: number };

export interface RewardsTable {
  payout: {
    /// Tickets by furthest wave reached, index = wave - 1.
    furthest_wave_tickets: number[];
    cleared_tickets: number;
    civilians_per_ticket: number;
    max_civilian_tickets: number;
    no_retry_bonus_tickets: number;
  };
  daily: Record<"first_blood" | "wave_victory" | "match_victory", { cap: number; tickets: number }>;
  crates: {
    cards_per_crate: number;
    hometown_cards: number;
    odds: Record<Tier, RarityOdds>;
    lore: Record<"payout" | "match_victory" | "wave_victory" | "first_blood" | "hometown", string[]>;
  };
  coverage: { city_cleared_fraction: number; placeholder_city_area_km2: number };
}

/// Per-tier multipliers (config.default.json `difficulty`). Factors on top of
/// the `match` section: population = buildings × match.population_multiplier
/// × population_multiplier; outbreak_scale scales the number and size of
/// outbreak clusters; fatigue_scale scales how much civilians slow down.
/// The sim consumes them later (T5 wiring); the profile only reads them.
export interface DifficultyParams {
  population_multiplier: number;
  outbreak_scale: number;
  fatigue_scale: number;
}

export interface ProfileTables {
  cards: CardsTable;
  rewards: RewardsTable;
  difficulty: Record<Tier, DifficultyParams>;
}

export const DEFAULT_TABLES: ProfileTables = {
  cards: cardsJson as CardsTable,
  rewards: rewardsJson as RewardsTable,
  difficulty: (config as unknown as { difficulty: Record<Tier, DifficultyParams> }).difficulty,
};

/// Throws on a table that would break the profile (missing tier, odds not
/// summing to 1, empty lore, ...). Run once when a service is created.
export function checkTables(t: ProfileTables): void {
  const fail = (m: string) => {
    throw new Error(`profile tables: ${m}`);
  };
  for (const tier of TIERS) {
    const d = t.difficulty?.[tier];
    if (!d) fail(`difficulty.${tier} missing`);
    for (const k of ["population_multiplier", "outbreak_scale", "fatigue_scale"] as const) {
      if (!(typeof d[k] === "number" && d[k] > 0)) fail(`difficulty.${tier}.${k} must be > 0`);
    }
    const o = t.rewards.crates.odds[tier];
    if (!o) fail(`crates.odds.${tier} missing`);
    const sum = RARITIES.reduce((s, r) => s + (o[r] ?? 0), 0);
    if (Math.abs(sum - 1) > 1e-9) fail(`crates.odds.${tier} sums to ${sum}, not 1`);
    if (!(o.foil >= 0 && o.foil <= 1)) fail(`crates.odds.${tier}.foil out of [0, 1]`);
    for (const r of RARITIES) if (o[r] > 0 && !t.cards.cards.some((c) => c.rarity === r)) fail(`no ${r} card to roll`);
  }
  if (t.rewards.payout.furthest_wave_tickets.length !== 8) fail("payout.furthest_wave_tickets needs 8 entries");
  for (const [k, v] of Object.entries(t.rewards.crates.lore)) if (!v.length) fail(`crates.lore.${k} is empty`);
  if (!t.cards.starter_decks.some((d) => d.id === STARTER_DECK_ID)) fail(`starter deck ${STARTER_DECK_ID} missing`);
}

/// The starter deck every new profile gets ("Civil Defence Issue").
export const STARTER_DECK_ID = "civil_defence_issue";

export function starterCardIds(t: CardsTable): string[] {
  const d = t.starter_decks.find((s) => s.id === STARTER_DECK_ID)!;
  return d.cards.flatMap((e) => Array<string>(e.copies).fill(e.card));
}

export function tierIndex(t: Tier): number {
  const i = TIERS.indexOf(t);
  if (i < 0) throw new Error(`unknown tier ${t}`);
  return i;
}

export function difficultyOf(tables: ProfileTables, tier: Tier): DifficultyParams {
  return tables.difficulty[tier];
}

const RUST_RARITY: Record<Rarity, string> = { common: "Common", uncommon: "Uncommon", rare: "Rare", legendary: "Legendary" };

/// The message sim-core's `Display for DeckError` prints, for the UI.
export function deckErrorMessage(e: DeckError): string {
  switch (e.error) {
    case "wrong_size":
      return `a deck has exactly ${e.expected} cards, this one has ${e.size}`;
    case "unknown_card":
      return `unknown card "${e.card}"`;
    case "too_many_copies":
      return `${e.copies} copies of "${e.card}": at most ${e.max} of a ${RUST_RARITY[e.rarity]} card`;
    case "too_many_legendaries":
      return `${e.count} legendary cards: at most ${e.max} per deck`;
  }
}

/// A TS mirror of sim-core's `CardDb::validate_deck` (same checks, same
/// error order: size, then per distinct card in first-seen order unknown /
/// too many copies, then the legendary count). For tests and as a fallback
/// before the WASM module loads; the game uses the core's (T5).
export function mirrorValidateDeck(cards: CardsTable, deck: string[]): DeckError[] {
  const r = cards.deck_rules;
  const errors: DeckError[] = [];
  if (deck.length !== r.deck_size) errors.push({ error: "wrong_size", size: deck.length, expected: r.deck_size });
  const seen = new Map<string, number>();
  for (const id of deck) seen.set(id, (seen.get(id) ?? 0) + 1);
  let legendaries = 0;
  for (const [id, copies] of seen) {
    const c = cards.cards.find((x) => x.id === id);
    if (!c) {
      errors.push({ error: "unknown_card", card: id });
      continue;
    }
    const max = r.max_copies[c.rarity];
    if (copies > max) errors.push({ error: "too_many_copies", card: id, rarity: c.rarity, copies, max });
    if (c.rarity === "legendary") legendaries += copies;
  }
  if (legendaries > r.max_legendaries) errors.push({ error: "too_many_legendaries", count: legendaries, max: r.max_legendaries });
  return errors;
}
