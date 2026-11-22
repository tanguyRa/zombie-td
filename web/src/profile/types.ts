// Profile data types (T7a). Every type here is plain JSON (no Date, Map,
// bigint or class instance), so it can cross a worker, a network RPC or
// IndexedDB unchanged: the future server speaks the same shapes.

import type { BlockId, LatLon, LatLonBox } from "../map/blocks";

export type { BlockId, LatLon, LatLonBox };

/// Difficulty tiers, easiest first (GAMEPLAY.md, "Difficulty").
export const TIERS = ["recruit", "veteran", "elite", "nightmare"] as const;
export type Tier = (typeof TIERS)[number];

export const RARITIES = ["common", "uncommon", "rare", "legendary"] as const;
export type Rarity = (typeof RARITIES)[number];

/// What a finished (cleared or abandoned) match reports to the profile.
/// T4/T5 build it from the match and its run record. Keep it minimal: the
/// server will re-derive every number from the run record before paying.
export interface MatchSummary {
  /// Unique id of this match (a UUID made when the match starts). The
  /// idempotency key of the payout: a second claim with the same id pays nothing.
  matchId: string;
  /// Match centre (the searched address). Private: used for the coverage
  /// map only, never put in a stamp, a lore line or anything shared.
  center: LatLon;
  /// City name from the place search (sanitised before any display).
  city: string;
  /// District / suburb / neighbourhood name from the place search ("" if none).
  district: string;
  /// Stable city id from the place search (e.g. "osm:relation:7444"), when
  /// known. City achievements key on it, else on the normalised city name.
  cityId?: string;
  tier: Tier;
  /// Waves won (0..8). 8 means the match was cleared.
  wavesWon: number;
  /// Furthest wave reached (1..8): wavesWon + 1 for an abandoned match, 8 when cleared.
  furthestWave: number;
  /// Civilians alive at the end of each wave won, index = wave - 1 (last attempt of each wave).
  savedPerWave: number[];
  /// Wave retries plus match restarts. 0 earns the no-retry bonus when cleared.
  retries: number;
  /// Card id of the match's MVP card (most kills), or null.
  mvpCard: string | null;
  /// Radius (m) of the area defended: the outer radius of the last wave won
  /// (the wave-8 radius for a cleared match).
  defendedRadiusM: number;
  /// Id of the run record stored with the match (T4).
  runRecordId: string;
}

/// Where and how a card was recovered. Never a street, house number or
/// postcode: `district` and `city` go through `sanitizePlace`.
export interface ProvenanceStamp {
  district: string;
  city: string;
  wave: number;
  tier: Tier;
  populationSaved: number;
  mvpCard: string | null;
  /// Local day of recovery, "YYYY-MM-DD" (no time of day).
  date: string;
}

export type InstanceSource = "starter" | "crate";

/// One unique card owned by the player.
export interface CardInstance {
  instanceId: string;
  cardId: string;
  source: InstanceSource;
  /// null for account-bound starter cards.
  stamp: ProvenanceStamp | null;
  foil: boolean;
  /// Starter cards: bound to the account, never traded or salvaged.
  accountBound: boolean;
  tradeable: boolean;
  salvageable: boolean;
  /// When it entered the collection (ISO 8601).
  acquiredAt: string;
  /// The crate it came from (crate cards only).
  crateId?: string;
}

export interface Deck {
  id: string;
  name: string;
  instanceIds: string[];
  updatedAt: string;
}

/// Serialised `DeckError` of sim-core (`#[serde(tag = "error", rename_all = "snake_case")]`).
export type DeckError =
  | { error: "wrong_size"; size: number; expected: number }
  | { error: "unknown_card"; card: string }
  | { error: "too_many_copies"; card: string; rarity: Rarity; copies: number; max: number }
  | { error: "too_many_legendaries"; count: number; max: number };

/// Profile-side deck problems (ownership), on top of the core's rules.
export type OwnershipError =
  | { error: "not_owned"; instanceId: string }
  | { error: "duplicate_instance"; instanceId: string };

export type DeckProblem = DeckError | OwnershipError;

/// The core's deck rules, injected: `validate_deck` through WASM in the
/// game, `mirrorValidateDeck` in tests. Returns every problem ([] = legal).
export type DeckValidator = (cardIds: string[]) => DeckError[] | Promise<DeckError[]>;

export type DeckSaveResult = { ok: true; deck: Deck } | { ok: false; errors: DeckProblem[] };

export type TicketSource = "payout" | "first_blood" | "wave_victory" | "match_victory";

/// A resupply ticket. It remembers the match it was earned in, so the crate
/// it opens can name where it was recovered.
export interface Ticket {
  id: string;
  source: TicketSource;
  matchId: string;
  /// Already sanitised.
  district: string;
  city: string;
  tier: Tier;
  wave: number;
  populationSaved: number;
  mvpCard: string | null;
  earnedAt: string;
  /// Local day it was earned ("YYYY-MM-DD"): the stamp date of its cards.
  day: string;
}

export type CrateSource = TicketSource | "hometown";

export interface CrateRecord {
  id: string;
  source: CrateSource;
  /// The ticket spent (none for the hometown crate).
  ticketId: string | null;
  matchId: string;
  tier: Tier;
  /// "Where and how it was recovered": district/city only.
  lore: string;
  instanceIds: string[];
  openedAt: string;
}

export interface CrateOpening {
  crate: CrateRecord;
  cards: CardInstance[];
}

export type DailyKind = "first_blood" | "wave_victory" | "match_victory";

/// A daily-capped event reported during a match (match victory is counted
/// by `claimMatch` itself).
export interface DailyEvent {
  kind: "first_blood" | "wave_victory";
  matchId: string;
  /// The wave it happened in (1..8).
  wave: number;
  city: string;
  district: string;
  tier: Tier;
  /// Civilians alive at the end of that wave (0 for first blood).
  populationSaved: number;
}

export interface DailyResult {
  granted: Ticket[];
  /// Why nothing was granted, if so.
  reason?: "cap_reached" | "already_counted";
  day: string;
  remaining: number;
}

export interface DailyStatus {
  day: string;
  counts: Record<DailyKind, number>;
  caps: Record<DailyKind, number>;
}

/// The breakdown of one match payout (see `computePayout`).
export interface Payout {
  waveTickets: number;
  clearedTickets: number;
  civilianTickets: number;
  noRetryBonus: number;
  total: number;
}

export interface CityProgress {
  /// The achievement key: `cityId` or the normalised city name.
  cityKey: string;
  city: string;
  /// City area (km²) from the lookup, or the placeholder.
  areaKm2: number;
  /// True when the area is the placeholder (no real area known).
  provisional: boolean;
  /// Defended fraction (0..1) of the city at each tier or harder.
  fractionByTier: Record<Tier, number>;
  /// Tiers whose fraction reaches the "city cleared" threshold.
  clearedTiers: Tier[];
}

export interface Achievement {
  /// "city_cleared:<cityKey>:<tier>".
  id: string;
  kind: "city_cleared";
  cityKey: string;
  city: string;
  tier: Tier;
  provisional: boolean;
  at: string;
}

export interface MatchClaim {
  /// false when this match id was already claimed (nothing paid again).
  paid: boolean;
  payout: Payout;
  tickets: Ticket[];
  /// Match victory daily reward, when cleared and under the cap.
  daily: DailyResult | null;
  /// Tiers newly unlocked by this match.
  unlockedTiers: Tier[];
  /// Coverage cells added or raised to this match's tier.
  coverageCells: number;
  /// City progress after this match (cleared matches only).
  city: CityProgress | null;
  newAchievements: Achievement[];
}

/// One coverage cell: a block of the global grid (map/blocks.ts, ~251 m).
export interface CoverageCell {
  cell: BlockId;
  /// Highest tier this cell was defended at.
  tier: Tier;
  /// Highest tier per city key (a border cell can count for two cities).
  cities: Record<string, Tier>;
  /// Cell area (m²).
  areaM2: number;
  bounds: LatLonBox;
}

/// A stored match: its summary, the run record (opaque JSON until T4) and
/// what it paid.
export interface MatchRecord {
  summary: MatchSummary;
  runRecord: unknown;
  claimedAt: string;
  payout: Payout;
  cleared: boolean;
}

/// List view of a match (no run record).
export interface MatchListItem {
  summary: MatchSummary;
  claimedAt: string;
  payout: Payout;
  cleared: boolean;
}

export interface TierStatus {
  unlocked: Tier[];
  /// Highest tier with a cleared match, or null.
  highestCleared: Tier | null;
}

export interface ProfileInfo {
  profileId: string;
  schema: number;
  createdAt: string;
  tickets: number;
  cards: number;
  hometownCrateClaimed: boolean;
}

/// `exportProfile()` output: everything, for debugging and support.
export interface ProfileExport {
  format: "zt-profile-export";
  schema: number;
  exportedAt: string;
  state: ProfileState;
  matches: MatchRecord[];
  coverage: CoverageCell[];
}

/// The core profile document (one IndexedDB record). Match history and
/// coverage cells live in their own stores (they grow).
export interface ProfileState {
  schema: number;
  profileId: string;
  createdAt: string;
  /// Bumped on every write; commits check it (optimistic concurrency between tabs).
  revision: number;
  /// Counter for instance/ticket/crate/deck ids.
  nextSeq: number;
  instances: CardInstance[];
  decks: Deck[];
  tickets: Ticket[];
  crates: CrateRecord[];
  /// Match ids already paid.
  claimedMatches: string[];
  /// Highest tier index (0..3) with a cleared match, -1 if none.
  highestClearedTier: number;
  /// Current local day ("YYYY-MM-DD", never goes backwards) and its counts.
  daily: { day: string; counts: Record<DailyKind, number> };
  /// Daily event keys already counted (all time): "wave_victory:<match>:<wave>".
  dailyKeys: string[];
  hometownCrateClaimed: boolean;
  achievements: Achievement[];
  /// Crate RNG (PCG32) state and increment as hex u64 strings.
  rng: { state: string; inc: string };
}
