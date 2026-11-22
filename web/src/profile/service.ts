// ProfileService: everything the future server will own (collection,
// decks, tickets and crates, payouts and daily caps, tiers, coverage and
// achievements, match history) goes through this interface. Every method is
// async and takes and returns plain JSON, so a server client (HTTP/RPC) can
// implement the same interface later. `LocalProfileService` is the v1
// implementation on IndexedDB (memory fallback).
//
// Server notes: a server re-runs the run record before `claimMatch` pays
// (GAMEPLAY.md, "Determinism"), owns the daily counters (UTC or account
// timezone, not the client clock) and the crate RNG.

import { cellIdsForBox, cellsInBox, cellsInDisc, cityFractions, cityKeyOf, mergeCoverage } from "./coverage";
import { crateLore, isTier, rollCrate } from "./crates";
import { DEFAULT_TABLES, STARTER_DECK_ID, checkTables, difficultyOf, mirrorValidateDeck, starterCardIds, tierIndex, type DifficultyParams, type ProfileTables } from "./data";
import { CRATE_STREAM, Pcg32, randomSeed } from "./pcg32";
import { checkSummary, computePayout, effectiveDay, localDay, systemClock, type Clock } from "./rewards";
import { validCityId } from "./place";
import { sanitizePlace } from "./sanitize";
import {
  MemoryProfileBackend,
  ProfileError,
  SCHEMA_VERSION,
  migrateBundle,
  openProfileBackend,
  validateBundle,
  MIGRATIONS,
  type Bundle,
  type Migration,
  type ProfileBackend,
} from "./store";
import {
  TIERS,
  type Achievement,
  type CardInstance,
  type CityProgress,
  type CoverageCell,
  type CrateOpening,
  type CrateRecord,
  type CrateSource,
  type DailyEvent,
  type DailyKind,
  type DailyResult,
  type DailyStatus,
  type Deck,
  type DeckProblem,
  type DeckSaveResult,
  type DeckValidator,
  type LatLonBox,
  type MatchClaim,
  type MatchListItem,
  type MatchRecord,
  type MatchSummary,
  type ProfileExport,
  type ProfileInfo,
  type ProfileState,
  type Ticket,
  type TicketSource,
  type Tier,
  type TierStatus,
} from "./types";

export interface ProfileService {
  info(): Promise<ProfileInfo>;

  // Collection
  listCards(): Promise<CardInstance[]>;
  getCard(instanceId: string): Promise<CardInstance | null>;

  // Decks (named lists of owned instance ids)
  listDecks(): Promise<Deck[]>;
  getDeck(deckId: string): Promise<Deck | null>;
  /// Problems of a would-be deck: the core's rules plus ownership ([] = legal).
  checkDeck(instanceIds: string[]): Promise<DeckProblem[]>;
  /// Create (no id) or replace a deck. Refused with every problem when illegal.
  saveDeck(deck: { id?: string; name: string; instanceIds: string[] }): Promise<DeckSaveResult>;
  deleteDeck(deckId: string): Promise<boolean>;
  /// The card ids of a deck, for `MatchSetup` (re-checked: an illegal deck throws).
  deckCardIds(deckId: string): Promise<string[]>;

  // Rewards
  /// The one payout of a match, when wave 8 is cleared or the match is
  /// abandoned. Idempotent per match id: a second claim pays nothing.
  /// INPUT CONTRACT (privacy): `summary.city` and `summary.district` come only
  /// from the place search's admin fields (`placeFromGeocoder`), never from
  /// `road`, `house_number`, `postcode`, `display_name` or free text;
  /// `summary.cityId` is `osm:relation:<digits>` or it is ignored.
  claimMatch(summary: MatchSummary, runRecord: unknown): Promise<MatchClaim>;
  /// First blood / wave victory, capped per local day. Same input contract
  /// as `claimMatch` for `event.city` and `event.district`.
  recordDailyEvent(event: DailyEvent): Promise<DailyResult>;
  dailyStatus(): Promise<DailyStatus>;

  // Tickets and crates
  listTickets(): Promise<Ticket[]>;
  /// Spend a ticket (the oldest when no id) and open its crate.
  openCrate(ticketId?: string): Promise<CrateOpening>;
  /// The one-off Hometown crate, from a cleared match (once per profile).
  claimHometownCrate(matchId: string): Promise<CrateOpening>;
  listCrates(): Promise<CrateRecord[]>;

  // Difficulty
  tiers(): Promise<TierStatus>;
  difficulty(tier: Tier): Promise<DifficultyParams>;

  // Coverage and achievements. PRIVATE: a player's own cells never leave
  // the profile. A server would serve them only to their owner and publish
  // aggregates only (the combined liberation map, per-city percentages over
  // all players), never one player's cells or match centres.
  coverageInBox(box: LatLonBox): Promise<CoverageCell[]>;
  /// `city`: the admin city name (`placeFromGeocoder`); `cityId`:
  /// `osm:relation:<digits>` or ignored (then keyed on the sanitised name).
  cityProgress(city: string, cityId?: string): Promise<CityProgress>;
  achievements(): Promise<Achievement[]>;

  // Match history
  listMatches(): Promise<MatchListItem[]>;
  getMatch(matchId: string): Promise<MatchRecord | null>;

  // Debugging
  exportProfile(): Promise<ProfileExport>;
  importProfile(data: ProfileExport): Promise<void>;
}

/// City area in km² (OSM admin boundary later), or null/undefined when unknown.
export type CityAreaLookup = (q: { city: string; cityId?: string; cityKey: string }) => Promise<number | null | undefined> | number | null | undefined;

export interface LocalProfileOptions {
  /// Use this backend (tests); otherwise IndexedDB with a memory fallback.
  backend?: ProfileBackend;
  indexedDB?: IDBFactory;
  dbName?: string;
  clock?: Clock;
  /// Seed of the crate RNG for a new profile (random by default).
  seed?: bigint;
  /// Profile id for a new profile (random UUID by default).
  profileId?: string;
  /// The core's deck rules. Default: the TS mirror of cards.json `deck_rules`
  /// (T5 passes sim-core's `validate_deck` through WASM).
  validateDeck?: DeckValidator;
  tables?: ProfileTables;
  /// City areas; unknown => the placeholder, achievement marked provisional.
  cityArea?: CityAreaLookup;
  /// Tests: pretend the data schema is newer, with these migrations.
  schema?: number;
  migrations?: Record<number, Migration>;
}

const MAX_RETRIES = 8;

function randomId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return "p" + Math.floor(Math.random() * 2 ** 52).toString(36) + Date.now().toString(36);
}

interface Tx {
  state: ProfileState;
  matches: MatchRecord[];
  cells: CoverageCell[];
}

export class LocalProfileService implements ProfileService {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly clock: Clock;
  private readonly tables: ProfileTables;
  private readonly validator: DeckValidator;
  private readonly schema: number;
  private readonly migrations: Record<number, Migration>;

  private constructor(
    private readonly backend: ProfileBackend,
    private readonly opts: LocalProfileOptions,
  ) {
    this.clock = opts.clock ?? systemClock;
    this.tables = opts.tables ?? DEFAULT_TABLES;
    checkTables(this.tables);
    this.validator = opts.validateDeck ?? ((ids) => mirrorValidateDeck(this.tables.cards, ids));
    this.schema = opts.schema ?? SCHEMA_VERSION;
    this.migrations = opts.migrations ?? MIGRATIONS;
    const cardIds = new Set(this.tables.cards.cards.map((c) => c.id));
    this.isCard = (id) => cardIds.has(id);
  }

  /// Known card ids (`mvpCard` must be one, or null).
  private readonly isCard: (id: string) => boolean;

  /// Open (or create) the local profile. A new profile gets the starter deck.
  static async open(opts: LocalProfileOptions = {}): Promise<LocalProfileService> {
    const backend = opts.backend ?? (await openProfileBackend({ name: opts.dbName, indexedDB: opts.indexedDB }));
    const s = new LocalProfileService(backend, opts);
    await s.ensure();
    return s;
  }

  /// Whether the profile survives a reload (false on the memory fallback: the UI should warn).
  get persistent(): boolean {
    return this.backend.persistent;
  }

  close(): void {
    this.backend.close();
  }

  // ---- plumbing -------------------------------------------------------

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private today(): string {
    const now = this.clock.now();
    return localDay(now, this.clock.utcOffsetMinutes(now));
  }

  /// Serialise operations in this tab.
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<ProfileState> {
    return this.checked(await this.backend.loadState());
  }

  private checked(s: ProfileState | undefined): ProfileState {
    if (!s) throw new ProfileError("storage", "no profile");
    if (s.schema !== this.schema) throw new ProfileError("schema_too_new", `profile schema ${s.schema}, expected ${this.schema}`);
    return s;
  }

  /// Read-modify-write with optimistic concurrency: `fn` mutates a fresh
  /// copy; the commit fails if another tab wrote meanwhile, and `fn` reruns.
  private mutate<T>(fn: (tx: Tx) => Promise<T> | T): Promise<T> {
    return this.serial(async () => {
      for (let attempt = 0; ; attempt++) {
        const state = await this.load();
        const rev = state.revision;
        const tx: Tx = { state, matches: [], cells: [] };
        const out = await fn(tx);
        tx.state.revision = rev + 1;
        try {
          await this.backend.commit({ expectedRevision: rev, state: tx.state, matches: tx.matches, cells: tx.cells });
          return out;
        } catch (e) {
          if (e instanceof ProfileError && e.code === "conflict" && attempt < MAX_RETRIES) continue;
          throw e;
        }
      }
    });
  }

  private read<T>(fn: (s: ProfileState) => T): Promise<T> {
    return this.serial(async () => fn(await this.load()));
  }

  private nextId(s: ProfileState, kind: string): string {
    s.nextSeq += 1;
    return `${s.profileId.slice(0, 8)}-${kind}${s.nextSeq.toString().padStart(6, "0")}`;
  }

  /// Create the profile if missing (with the starter deck), migrate an older one.
  private ensure(): Promise<void> {
    return this.serial(async () => {
      for (let attempt = 0; ; attempt++) {
        const s = await this.backend.loadState();
        try {
          if (!s) {
            await this.backend.commit({ expectedRevision: null, state: this.newState(), replaceAll: true });
          } else if (s.schema !== this.schema) {
            const b = migrateBundle({ state: s, matches: await this.backend.allMatches(), coverage: await this.backend.allCells() }, this.schema, this.migrations);
            b.state.revision = s.revision + 1;
            await this.backend.commit({ expectedRevision: s.revision, state: b.state, matches: b.matches, cells: b.coverage, replaceAll: true });
          }
          return;
        } catch (e) {
          if (e instanceof ProfileError && e.code === "conflict" && attempt < MAX_RETRIES) continue;
          throw e;
        }
      }
    });
  }

  private newState(): ProfileState {
    const now = this.nowIso();
    const rng = new Pcg32(this.opts.seed ?? randomSeed(), CRATE_STREAM);
    const s: ProfileState = {
      schema: this.schema,
      profileId: this.opts.profileId ?? randomId(),
      createdAt: now,
      revision: 0,
      nextSeq: 0,
      instances: [],
      decks: [],
      tickets: [],
      crates: [],
      claimedMatches: [],
      highestClearedTier: -1,
      daily: { day: "", counts: { first_blood: 0, wave_victory: 0, match_victory: 0 } },
      dailyKeys: [],
      hometownCrateClaimed: false,
      achievements: [],
      rng: rng.toJSON(),
    };
    // The starter deck "Civil Defence Issue": account-bound, no stamp.
    const ids: string[] = [];
    for (const cardId of starterCardIds(this.tables.cards)) {
      const instanceId = this.nextId(s, "s");
      ids.push(instanceId);
      s.instances.push({ instanceId, cardId, source: "starter", stamp: null, foil: false, accountBound: true, tradeable: false, salvageable: false, acquiredAt: now });
    }
    const name = this.tables.cards.starter_decks.find((d) => d.id === STARTER_DECK_ID)!.name;
    s.decks.push({ id: `deck-${STARTER_DECK_ID}`, name, instanceIds: ids, updatedAt: now });
    return s;
  }

  // ---- info and collection ---------------------------------------------

  info(): Promise<ProfileInfo> {
    return this.read((s) => ({
      profileId: s.profileId,
      schema: s.schema,
      createdAt: s.createdAt,
      tickets: s.tickets.length,
      cards: s.instances.length,
      hometownCrateClaimed: s.hometownCrateClaimed,
    }));
  }

  listCards(): Promise<CardInstance[]> {
    return this.read((s) => s.instances);
  }

  getCard(instanceId: string): Promise<CardInstance | null> {
    return this.read((s) => s.instances.find((i) => i.instanceId === instanceId) ?? null);
  }

  // ---- decks -------------------------------------------------------------

  private async problems(s: ProfileState, instanceIds: string[]): Promise<DeckProblem[]> {
    const owned = new Map(s.instances.map((i) => [i.instanceId, i]));
    const out: DeckProblem[] = [];
    const seen = new Set<string>();
    const cardIds: string[] = [];
    for (const id of instanceIds) {
      const inst = owned.get(id);
      if (!inst) {
        out.push({ error: "not_owned", instanceId: id });
        continue;
      }
      if (seen.has(id)) {
        out.push({ error: "duplicate_instance", instanceId: id });
        continue;
      }
      seen.add(id);
      cardIds.push(inst.cardId);
    }
    // Core rules on the cards the deck would really hold (each owned instance once).
    out.push(...(await this.validator(cardIds)));
    return out;
  }

  listDecks(): Promise<Deck[]> {
    return this.read((s) => s.decks);
  }

  getDeck(deckId: string): Promise<Deck | null> {
    return this.read((s) => s.decks.find((d) => d.id === deckId) ?? null);
  }

  checkDeck(instanceIds: string[]): Promise<DeckProblem[]> {
    return this.serial(async () => this.problems(await this.load(), instanceIds));
  }

  saveDeck(input: { id?: string; name: string; instanceIds: string[] }): Promise<DeckSaveResult> {
    return this.mutate(async (tx) => {
      const s = tx.state;
      const errors = await this.problems(s, input.instanceIds);
      if (errors.length) return { ok: false as const, errors };
      if (input.id !== undefined && !s.decks.some((d) => d.id === input.id)) throw new ProfileError("unknown_deck", `no deck ${input.id}`);
      const deck: Deck = {
        id: input.id ?? this.nextId(s, "d"),
        name: input.name.trim().slice(0, 40) || "Deck",
        instanceIds: [...input.instanceIds],
        updatedAt: this.nowIso(),
      };
      const i = s.decks.findIndex((d) => d.id === deck.id);
      if (i >= 0) s.decks[i] = deck;
      else s.decks.push(deck);
      return { ok: true as const, deck };
    });
  }

  deleteDeck(deckId: string): Promise<boolean> {
    return this.mutate((tx) => {
      const before = tx.state.decks.length;
      tx.state.decks = tx.state.decks.filter((d) => d.id !== deckId);
      return tx.state.decks.length !== before;
    });
  }

  deckCardIds(deckId: string): Promise<string[]> {
    return this.serial(async () => {
      const s = await this.load();
      const d = s.decks.find((x) => x.id === deckId);
      if (!d) throw new ProfileError("unknown_deck", `no deck ${deckId}`);
      const errors = await this.problems(s, d.instanceIds);
      if (errors.length) throw new ProfileError("illegal_deck", `deck ${deckId} is not legal: ${JSON.stringify(errors)}`);
      const byId = new Map(s.instances.map((i) => [i.instanceId, i.cardId]));
      return d.instanceIds.map((id) => byId.get(id)!);
    });
  }

  // ---- rewards -----------------------------------------------------------

  private rollDay(s: ProfileState): string {
    const day = effectiveDay(this.clock, s.daily.day);
    if (day !== s.daily.day) s.daily = { day, counts: { first_blood: 0, wave_victory: 0, match_victory: 0 } };
    return day;
  }

  private ticket(s: ProfileState, source: TicketSource, p: { matchId: string; district: string; city: string; tier: Tier; wave: number; populationSaved: number; mvpCard: string | null }): Ticket {
    return {
      id: this.nextId(s, "t"),
      source,
      matchId: p.matchId,
      district: sanitizePlace(p.district),
      city: sanitizePlace(p.city, "city"),
      tier: p.tier,
      wave: p.wave,
      populationSaved: Math.max(0, Math.floor(p.populationSaved)),
      mvpCard: p.mvpCard,
      earnedAt: this.nowIso(),
      day: this.today(),
    };
  }

  /// Count one daily event under its cap. `key` makes it idempotent.
  private daily(s: ProfileState, kind: DailyKind, key: string, mk: () => Ticket[]): DailyResult {
    const day = this.rollDay(s);
    const cap = this.tables.rewards.daily[kind].cap;
    const remaining = () => Math.max(0, cap - s.daily.counts[kind]);
    if (s.dailyKeys.includes(key)) return { granted: [], reason: "already_counted", day, remaining: remaining() };
    if (s.daily.counts[kind] >= cap) return { granted: [], reason: "cap_reached", day, remaining: 0 };
    s.daily.counts[kind] += 1;
    s.dailyKeys.push(key);
    const granted = mk();
    s.tickets.push(...granted);
    return { granted, day, remaining: remaining() };
  }

  private async cityArea(city: string, cityId: string | undefined, cityKey: string): Promise<{ areaKm2: number; provisional: boolean }> {
    let a: number | null | undefined;
    try {
      a = await this.opts.cityArea?.({ city, cityId, cityKey });
    } catch {
      a = undefined;
    }
    if (typeof a === "number" && Number.isFinite(a) && a > 0) return { areaKm2: a, provisional: false };
    return { areaKm2: this.tables.rewards.coverage.placeholder_city_area_km2, provisional: true };
  }

  /// `city` is already sanitised.
  private async progress(cells: CoverageCell[], city: string, cityId: string | undefined): Promise<CityProgress> {
    const cityKey = cityKeyOf(city, cityId);
    const { areaKm2, provisional } = await this.cityArea(city, cityId, cityKey);
    const fractionByTier = cityFractions(cells, cityKey, areaKm2 * 1e6);
    const threshold = this.tables.rewards.coverage.city_cleared_fraction;
    return { cityKey, city, areaKm2, provisional, fractionByTier, clearedTiers: TIERS.filter((t) => fractionByTier[t] >= threshold) };
  }

  /// Bring the stored city achievements in line with `p`: add newly cleared
  /// tiers; a provisional one becomes final when the real area confirms it,
  /// and is dropped when the real area shows the city isn't cleared. Final
  /// achievements are never taken away.
  private applyAchievements(s: ProfileState, p: CityProgress): Achievement[] {
    const added: Achievement[] = [];
    for (const tier of TIERS) {
      const id = `city_cleared:${p.cityKey}:${tier}`;
      const i = s.achievements.findIndex((a) => a.id === id);
      const cleared = p.clearedTiers.includes(tier);
      if (i < 0) {
        if (!cleared) continue;
        const a: Achievement = { id, kind: "city_cleared", cityKey: p.cityKey, city: sanitizePlace(p.city, "city"), tier, provisional: p.provisional, at: this.nowIso() };
        s.achievements.push(a);
        added.push(a);
      } else if (s.achievements[i].provisional && !p.provisional) {
        if (cleared) s.achievements[i] = { ...s.achievements[i], provisional: false };
        else s.achievements.splice(i, 1);
      }
    }
    return added;
  }

  claimMatch(summary: MatchSummary, runRecord: unknown): Promise<MatchClaim> {
    return this.mutate(async (tx) => {
      const s = tx.state;
      const none = { waveTickets: 0, clearedTickets: 0, civilianTickets: 0, noRetryBonus: 0, total: 0 };
      if (typeof summary?.matchId === "string" && s.claimedMatches.includes(summary.matchId)) {
        const old = await this.backend.getMatch(summary.matchId);
        return { paid: false, payout: old?.payout ?? none, tickets: [], daily: null, unlockedTiers: [], coverageCells: 0, city: null, newAchievements: [] };
      }
      const problems = checkSummary(summary, this.tables.maxDefendedRadiusM, this.isCard);
      if (problems.length) throw new ProfileError("bad_summary", problems.join("; "));
      const ti = tierIndex(summary.tier);
      if (ti > s.highestClearedTier + 1) throw new ProfileError("tier_locked", `${summary.tier} is locked`);

      const cleared = summary.wavesWon >= 8;
      const cityId = validCityId(summary.cityId);
      const saved = summary.savedPerWave.length ? Math.max(...summary.savedPerWave) : 0;
      const place = { matchId: summary.matchId, district: summary.district, city: summary.city, tier: summary.tier, populationSaved: saved, mvpCard: summary.mvpCard };
      const payout = computePayout(this.tables.rewards.payout, summary);
      const tickets = Array.from({ length: payout.total }, () => this.ticket(s, "payout", { ...place, wave: summary.furthestWave }));
      s.tickets.push(...tickets);
      s.claimedMatches.push(summary.matchId);

      let daily: DailyResult | null = null;
      const unlockedTiers: Tier[] = [];
      let coverageCells = 0;
      let city: CityProgress | null = null;
      let newAchievements: Achievement[] = [];
      if (cleared) {
        const n = this.tables.rewards.daily.match_victory.tickets;
        daily = this.daily(s, "match_victory", `match_victory:${summary.matchId}`, () => Array.from({ length: n }, () => this.ticket(s, "match_victory", { ...place, wave: 8 })));
        if (ti > s.highestClearedTier) {
          const before = this.unlocked(s.highestClearedTier);
          s.highestClearedTier = ti;
          unlockedTiers.push(...this.unlocked(ti).filter((t) => !before.includes(t)));
        }
        // Coverage: cells inside the defended (wave-8) radius, highest tier per cell.
        // The city key is built from the sanitised name (it is stored in cells
        // and achievement ids); a name that sanitises to nothing, with no id,
        // tags no city and counts for no city achievement.
        // An id that isn't `osm:relation:<digits>` is ignored (place.ts).
        const cityName = sanitizePlace(summary.city, "city");
        const cityKey = cityName || cityId ? cityKeyOf(cityName, cityId) : null;
        const ids = cellsInDisc(summary.center, summary.defendedRadiusM);
        const existing = new Map((await this.backend.getCells(ids)).map((c) => [c.cell, c]));
        const changed = mergeCoverage(existing, ids, summary.tier, cityKey);
        for (const c of changed) tx.cells.push(c); // a loop: spreading many cells overflows the stack
        coverageCells = changed.length;
        if (cityKey !== null) {
          // City progress over every cell (including this match's).
          const all = new Map((await this.backend.allCells()).map((c) => [c.cell, c]));
          for (const c of changed) all.set(c.cell, c);
          city = await this.progress([...all.values()], cityName, cityId);
          newAchievements = this.applyAchievements(s, city);
        }
      }

      // History keeps the sanitised names (a UI listing it can't show a street).
      // An unaccepted cityId is not stored either.
      const stored: MatchSummary = { ...summary, city: sanitizePlace(summary.city, "city"), district: sanitizePlace(summary.district), savedPerWave: [...summary.savedPerWave] };
      if (cityId === undefined) delete stored.cityId;
      tx.matches.push({ summary: stored, runRecord: runRecord ?? null, claimedAt: this.nowIso(), payout, cleared });
      return { paid: true, payout, tickets, daily, unlockedTiers, coverageCells, city, newAchievements };
    });
  }

  recordDailyEvent(e: DailyEvent): Promise<DailyResult> {
    return this.mutate((tx) => {
      const s = tx.state;
      if (!e || typeof e !== "object") throw new ProfileError("bad_summary", "not a daily event");
      if (e.kind !== "first_blood" && e.kind !== "wave_victory") throw new ProfileError("bad_summary", `unknown daily event ${String(e.kind)}`);
      if (typeof e.matchId !== "string" || !e.matchId) throw new ProfileError("bad_summary", "matchId is empty");
      if (!(Number.isInteger(e.wave) && e.wave >= 1 && e.wave <= 8)) throw new ProfileError("bad_summary", `wave must be 1..8, not ${String(e.wave)}`);
      if (!(typeof e.populationSaved === "number" && Number.isFinite(e.populationSaved) && e.populationSaved >= 0)) {
        throw new ProfileError("bad_summary", `populationSaved must be a finite number >= 0, not ${String(e.populationSaved)}`);
      }
      if (!isTier(e.tier)) throw new ProfileError("bad_summary", `unknown tier ${String(e.tier)}`);
      if (typeof e.city !== "string" || typeof e.district !== "string") throw new ProfileError("bad_summary", "city and district must be strings");
      if (tierIndex(e.tier) > s.highestClearedTier + 1) throw new ProfileError("tier_locked", `${e.tier} is locked`);
      const day = this.rollDay(s);
      const key = e.kind === "first_blood" ? `first_blood:${day}` : `wave_victory:${e.matchId}:${e.wave}`;
      const n = this.tables.rewards.daily[e.kind].tickets;
      return this.daily(s, e.kind, key, () =>
        Array.from({ length: n }, () => this.ticket(s, e.kind, { matchId: e.matchId, district: e.district, city: e.city, tier: e.tier, wave: e.wave, populationSaved: e.populationSaved, mvpCard: null })),
      );
    });
  }

  dailyStatus(): Promise<DailyStatus> {
    return this.read((s) => {
      const day = effectiveDay(this.clock, s.daily.day);
      const counts = day === s.daily.day ? { ...s.daily.counts } : { first_blood: 0, wave_victory: 0, match_victory: 0 };
      const d = this.tables.rewards.daily;
      return { day, counts, caps: { first_blood: d.first_blood.cap, wave_victory: d.wave_victory.cap, match_victory: d.match_victory.cap } };
    });
  }

  // ---- tickets and crates --------------------------------------------------

  listTickets(): Promise<Ticket[]> {
    return this.read((s) => s.tickets);
  }

  listCrates(): Promise<CrateRecord[]> {
    return this.read((s) => s.crates);
  }

  private open(s: ProfileState, source: CrateSource, t: Omit<Ticket, "id" | "source" | "earnedAt">, ticketId: string | null, count: number): CrateOpening {
    const rng = Pcg32.fromState(s.rng);
    const rolled = rollCrate(rng, this.tables.cards, this.tables.rewards, t.tier, count);
    const lore = crateLore(rng, this.tables.rewards, source, t.district, t.city, t.wave, t.tier);
    s.rng = rng.toJSON();
    const crateId = this.nextId(s, "k");
    const now = this.nowIso();
    const cards: CardInstance[] = rolled.map((r) => ({
      instanceId: this.nextId(s, "c"),
      cardId: r.cardId,
      source: "crate",
      stamp: {
        district: sanitizePlace(t.district),
        city: sanitizePlace(t.city, "city"),
        wave: t.wave,
        tier: t.tier,
        populationSaved: t.populationSaved,
        mvpCard: t.mvpCard,
        date: t.day,
      },
      foil: r.foil,
      accountBound: false,
      tradeable: true,
      salvageable: true,
      acquiredAt: now,
      crateId,
    }));
    s.instances.push(...cards);
    const crate: CrateRecord = { id: crateId, source, ticketId, matchId: t.matchId, tier: t.tier, lore, instanceIds: cards.map((c) => c.instanceId), openedAt: now };
    s.crates.push(crate);
    return { crate, cards };
  }

  openCrate(ticketId?: string): Promise<CrateOpening> {
    return this.mutate((tx) => {
      const s = tx.state;
      if (s.tickets.length === 0) throw new ProfileError("no_ticket", "no resupply ticket left");
      let i: number;
      if (ticketId === undefined) {
        // The oldest ticket that can open a crate: an unusable one (unknown
        // tier or source, from a corrupt profile) is skipped, not fatal.
        i = s.tickets.findIndex((t) => this.usableTicket(t));
        if (i < 0) throw new ProfileError("bad_ticket", `${s.tickets.length} ticket(s) left, none can open a crate (unknown tier or source)`);
      } else {
        i = s.tickets.findIndex((t) => t.id === ticketId);
        if (i < 0) throw new ProfileError("unknown_ticket", `no ticket ${ticketId}`);
        if (!this.usableTicket(s.tickets[i])) throw new ProfileError("bad_ticket", `ticket ${ticketId} can't open a crate (unknown tier or source)`);
      }
      const [t] = s.tickets.splice(i, 1);
      return this.open(s, t.source, t, t.id, this.tables.rewards.crates.cards_per_crate);
    });
  }

  private usableTicket(t: Ticket): boolean {
    const c = this.tables.rewards.crates;
    return isTier(t?.tier) && Object.hasOwn(c.odds, t.tier) && typeof t.source === "string" && Object.hasOwn(c.lore, t.source);
  }

  claimHometownCrate(matchId: string): Promise<CrateOpening> {
    return this.mutate(async (tx) => {
      const s = tx.state;
      if (s.hometownCrateClaimed) throw new ProfileError("hometown_claimed", "the Hometown crate was already claimed");
      const m = await this.backend.getMatch(matchId);
      if (!m) throw new ProfileError("unknown_match", `no match ${matchId}`);
      if (!m.cleared) throw new ProfileError("not_cleared", "the Hometown crate needs a cleared match");
      s.hometownCrateClaimed = true;
      const sm = m.summary;
      const saved = sm.savedPerWave.length ? Math.max(...sm.savedPerWave) : 0;
      const day = localDay(Date.parse(m.claimedAt), this.clock.utcOffsetMinutes(Date.parse(m.claimedAt)));
      return this.open(s, "hometown", { matchId, district: sm.district, city: sm.city, tier: sm.tier, wave: 8, populationSaved: saved, mvpCard: sm.mvpCard, day }, null, this.tables.rewards.crates.hometown_cards);
    });
  }

  // ---- tiers -----------------------------------------------------------------

  private unlocked(highestCleared: number): Tier[] {
    return TIERS.slice(0, Math.min(TIERS.length, highestCleared + 2));
  }

  tiers(): Promise<TierStatus> {
    return this.read((s) => ({ unlocked: this.unlocked(s.highestClearedTier), highestCleared: s.highestClearedTier >= 0 ? TIERS[s.highestClearedTier] : null }));
  }

  async difficulty(tier: Tier): Promise<DifficultyParams> {
    return { ...difficultyOf(this.tables, tier) };
  }

  // ---- coverage and achievements ----------------------------------------------

  coverageInBox(box: LatLonBox): Promise<CoverageCell[]> {
    return this.serial(async () => {
      const ids = cellIdsForBox(box);
      const cells = ids ? await this.backend.getCells(ids) : await this.backend.allCells();
      return cellsInBox(cells, box);
    });
  }

  /// `city` is sanitised and `cityId` checked as in `claimMatch` (same key;
  /// the name returned is the sanitised one).
  cityProgress(city: string, cityId?: string): Promise<CityProgress> {
    return this.serial(async () => this.progress(await this.backend.allCells(), sanitizePlace(typeof city === "string" ? city : "", "city"), validCityId(cityId)));
  }

  achievements(): Promise<Achievement[]> {
    return this.read((s) => s.achievements);
  }

  // ---- history -------------------------------------------------------------------

  listMatches(): Promise<MatchListItem[]> {
    return this.serial(async () =>
      (await this.backend.allMatches())
        .map(({ summary, claimedAt, payout, cleared }) => ({ summary, claimedAt, payout, cleared }))
        .sort((a, b) => (a.claimedAt < b.claimedAt ? 1 : a.claimedAt > b.claimedAt ? -1 : a.summary.matchId < b.summary.matchId ? 1 : -1)),
    );
  }

  getMatch(matchId: string): Promise<MatchRecord | null> {
    return this.serial(async () => (await this.backend.getMatch(matchId)) ?? null);
  }

  // ---- export / import ---------------------------------------------------------------

  exportProfile(): Promise<ProfileExport> {
    return this.serial(async () => {
      // One read transaction: another tab's commit can't land between the
      // state and the matches.
      const snap = await this.backend.snapshot();
      return {
        format: "zt-profile-export" as const,
        schema: this.schema,
        exportedAt: this.nowIso(),
        state: this.checked(snap.state),
        matches: snap.matches,
        coverage: snap.coverage,
      };
    });
  }

  /// Replace the whole profile with an export (older schemas are migrated).
  /// The migrated bundle is validated in full before anything is written: a
  /// malformed export throws `bad_import` and the profile stays as it was.
  importProfile(data: ProfileExport): Promise<void> {
    return this.serial(async () => {
      if (!data || data.format !== "zt-profile-export" || !data.state || !Array.isArray(data.matches) || !Array.isArray(data.coverage)) {
        throw new ProfileError("bad_import", "not a profile export");
      }
      if (data.schema !== (data.state as { schema?: unknown }).schema) {
        throw new ProfileError("bad_import", `export schema ${String(data.schema)} doesn't match its state schema ${String((data.state as { schema?: unknown }).schema)}`);
      }
      let b: Bundle;
      try {
        b = migrateBundle({ state: data.state, matches: data.matches, coverage: data.coverage }, this.schema, this.migrations);
      } catch (e) {
        if (e instanceof ProfileError) throw e;
        throw new ProfileError("bad_import", `the export could not be migrated: ${String((e as Error)?.message ?? e)}`);
      }
      validateBundle(b, { maxRadiusM: this.tables.maxDefendedRadiusM, isCard: this.isCard });
      const cur = await this.backend.loadState();
      b.state.revision = (cur?.revision ?? 0) + 1;
      await this.backend.commit({ expectedRevision: cur?.revision ?? null, state: b.state, matches: b.matches, cells: b.coverage, replaceAll: true });
    });
  }
}

/// A profile kept in memory only (tests, or explicitly non-persistent play).
export function memoryProfile(opts: Omit<LocalProfileOptions, "backend"> = {}): Promise<LocalProfileService> {
  return LocalProfileService.open({ ...opts, backend: new MemoryProfileBackend() });
}
