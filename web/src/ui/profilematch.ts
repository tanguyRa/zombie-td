// Match ↔ profile wiring (T7b): a match id per match, the daily events
// (first blood, wave victory) as they happen, and one `claimMatch` per match
// when wave 8 is cleared or the match is abandoned (leaving, a new match, a
// new seed after progress). The summary is built from what the worker
// reported (status, wave results, shooters, structures); the run record
// comes from the worker too. Nothing here touches the sim.
//
// Local verification: the record is NOT replayed before the claim. The
// profile is the player's own data on their own machine (they can edit
// IndexedDB anyway), and a local replay costs what playing cost (seconds on
// the Marais, minutes at 1.3 km). The server re-runs every record before it
// pays (DECISIONS "Profile UI (T7b)").
import type { MatchStatus, Structure, WaveResult } from "../protocol";
import { placeFromGeocoder } from "../profile/place";
import type { ProfileService } from "../profile/service";
import type { LatLon, MatchClaim, MatchSummary, Tier } from "../profile/types";

/** City and district of a place, as the profile stores them. */
export interface PlaceAdmin {
  city: string;
  district: string;
  cityId?: string;
}

/** A Nominatim result's admin names, through the privacy contract
 *  (`placeFromGeocoder` reads only city/town/village/municipality and
 *  suburb/city_district/borough/quarter/neighbourhood; never `road`,
 *  `house_number`, `postcode` or `display_name`). The result itself is the
 *  city-level result: a city relation (the player searched the city) also
 *  gives the `cityId`; an address result gives none (fail-closed). */
export function adminOf(result: { address?: Record<string, string>; osm_type?: unknown; osm_id?: unknown; addresstype?: unknown }): PlaceAdmin {
  return placeFromGeocoder(result?.address ?? {}, result);
}

/** Where a match is played. `city`/`district` come from the place search's
 *  admin fields only (`placeFromGeocoder`) or the built-in level's fixed
 *  names, never from a street or the display name. */
export interface MatchPlace {
  center: LatLon;
  city: string;
  district: string;
  cityId?: string;
}

/** One match as the profile sees it. */
export interface MatchContext {
  matchId: string;
  place: MatchPlace;
  tier: Tier;
  deckId: string;
  /** Card ids of the deck, as sent in the setup. */
  deck: string[];
  populationMultiplier: number;
  /** The player said this is their hometown (offers the Hometown crate on a clear). */
  hometown: boolean;
  seed: string;
  /** A picked place (streamed map) rather than a built-in level. */
  streamed: boolean;
  /** Set once the claim was sent (a second one would pay nothing anyway). */
  claimed: boolean;
  firstBloodSent: boolean;
  /** Waves whose wave victory was reported. */
  waveVictories: Set<number>;
  /** The worker's `ready` for this match arrived. */
  ready: boolean;
  /** A status arrived after this match's `ready`: only then is what the
   *  page shows this match's (not the previous match's, still queued). No
   *  daily event, no claim before. */
  live: boolean;
}

/** What the worker last reported about the match on screen. */
export interface MatchSnapshot {
  status: MatchStatus;
  results: WaveResult[];
  /** Shooters: [building or -1, x, y, range, kills] × n. */
  towers: ArrayLike<number>;
  structures: Structure[];
  /** Ring radius of every wave (m), index 0 = wave 1. */
  rings: number[];
}

export type ClaimReason = "cleared" | "abandoned";

export interface ClaimNotice {
  ctx: MatchContext;
  reason: ClaimReason;
  claim: MatchClaim;
  summary: MatchSummary;
}

/** Any progress worth a claim: a wave was started, won or lost, or retried. */
export function hasProgress(s: MatchStatus | null | undefined): boolean {
  return !!s && (s.wave > 1 || s.phase !== "prep" || s.retries > 0 || s.restarts > 0);
}

/** The MVP card: the armament whose garrisons (still on the map) have the
 *  most kills; ties go to the card id first in alphabetical order. null with
 *  no kill. Tactical cards and pulled-down garrisons are not counted (the
 *  core keeps no per-card kill count). */
export function mvpCard(towers: ArrayLike<number>, structures: Structure[]): string | null {
  const cardOf = new Map<number, string>();
  for (const s of structures) if (s.kind.type === "garrison") for (const b of s.kind.buildings) cardOf.set(b, s.card);
  const kills = new Map<string, number>();
  for (let i = 0; i + 4 < towers.length; i += 5) {
    const card = towers[i] >= 0 ? cardOf.get(towers[i]) : undefined;
    if (card) kills.set(card, (kills.get(card) ?? 0) + towers[i + 4]);
  }
  let best: string | null = null;
  let most = 0;
  for (const [card, k] of [...kills].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (k > most) {
      most = k;
      best = card;
    }
  }
  return best;
}

/** The `MatchSummary` of the match on screen. Waves won are the distinct
 *  waves with a won result (a retry drops the retried attempt's result, a
 *  restart drops them all); civilians saved per wave are the end civilians
 *  of each won wave; retries count wave retries and match restarts. */
export function buildSummary(ctx: MatchContext, snap: MatchSnapshot, maxRadiusM: number): MatchSummary {
  const won = new Map<number, number>();
  for (const r of snap.results) if (r.won) won.set(r.wave, r.end_civilians);
  let wavesWon = 0;
  while (wavesWon < 8 && won.has(wavesWon + 1)) wavesWon++;
  const savedPerWave = Array.from({ length: wavesWon }, (_, i) => Math.max(0, Math.floor(won.get(i + 1)!)));
  const radius = wavesWon > 0 ? (snap.rings[wavesWon - 1] ?? 0) : 0;
  const s: MatchSummary = {
    matchId: ctx.matchId,
    center: { lat: ctx.place.center.lat, lon: ctx.place.center.lon },
    city: ctx.place.city,
    district: ctx.place.district,
    tier: ctx.tier,
    wavesWon,
    furthestWave: Math.min(8, wavesWon + 1),
    savedPerWave,
    retries: snap.status.retries + snap.status.restarts,
    mvpCard: mvpCard(snap.towers, snap.structures),
    defendedRadiusM: Math.min(maxRadiusM, Math.max(0, radius)),
    runRecordId: ctx.matchId,
  };
  if (ctx.place.cityId) s.cityId = ctx.place.cityId;
  return s;
}

export interface TrackerDeps {
  profile: () => ProfileService | null;
  /** The match on screen as the worker last reported it (null before `ready`). */
  snapshot: () => MatchSnapshot | null;
  /** Ask the worker for the run record of the match on screen. Must post
   *  its request synchronously, so it is answered before a following
   *  `stop` or `init`. */
  record: () => Promise<string>;
  maxRadiusM: number;
  onClaim: (n: ClaimNotice) => void;
  onDaily: () => void;
  onError: (message: string) => void;
}

export function newMatchId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `m-${Date.now().toString(36)}-${Math.floor(Math.random() * 2 ** 40).toString(36)}`;
}

export class MatchTracker {
  current: MatchContext | null = null;
  private pending = new Set<Promise<unknown>>();
  /** Every claim made in this page (the test hook reads them). */
  readonly claims: ClaimNotice[] = [];

  constructor(private readonly d: TrackerDeps) {}

  /** A new match was sent to the worker. */
  start(ctx: Omit<MatchContext, "matchId" | "claimed" | "firstBloodSent" | "waveVictories" | "ready" | "live">): MatchContext {
    this.current = { ...ctx, matchId: newMatchId(), claimed: false, firstBloodSent: false, waveVictories: new Set(), ready: false, live: false };
    return this.current;
  }

  /** The worker built the match last `start`ed (its `ready`). */
  onReady(): void {
    if (this.current) this.current.ready = true;
  }

  /** Wait for every profile call made so far (tests, and before reading the profile). */
  async settle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private track<T>(p: Promise<T>): Promise<T | undefined> {
    const q = p.catch((e: unknown) => {
      const msg = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
      console.error("profile:", e);
      this.d.onError(`Profile: ${msg}`);
      return undefined;
    });
    this.pending.add(q);
    void q.finally(() => this.pending.delete(q));
    return q;
  }

  /** First blood: the first zombie killed in this match (the profile counts it once a day). */
  onStatus(s: MatchStatus): void {
    const ctx = this.current;
    if (!ctx?.ready) return; // a status from before this match's ready: not this match's
    ctx.live = true;
    const p = this.d.profile();
    if (!p || ctx.firstBloodSent || s.stats.zombies_killed <= 0) return;
    ctx.firstBloodSent = true;
    void this.track(
      p.recordDailyEvent({ kind: "first_blood", matchId: ctx.matchId, wave: s.wave, city: ctx.place.city, district: ctx.place.district, tier: ctx.tier, populationSaved: 0 }).then((r) => {
        if (r.granted.length) this.d.onDaily();
        return r;
      }),
    );
  }

  /** A phase change: a won wave reports a wave victory; wave 8 won claims the match. */
  onPhase(s: MatchStatus, results: WaveResult[]): void {
    const ctx = this.current;
    const p = this.d.profile();
    if (!ctx?.live || !p) return;
    if ((s.phase === "wave_won" || s.phase === "match_won") && !ctx.waveVictories.has(s.wave)) {
      ctx.waveVictories.add(s.wave);
      const r = [...results].reverse().find((x) => x.wave === s.wave && x.won);
      void this.track(
        p
          .recordDailyEvent({ kind: "wave_victory", matchId: ctx.matchId, wave: s.wave, city: ctx.place.city, district: ctx.place.district, tier: ctx.tier, populationSaved: r ? r.end_civilians : 0 })
          .then((res) => {
            if (res.granted.length) this.d.onDaily();
            return res;
          }),
      );
    }
    if (s.phase === "match_won") void this.claim("cleared");
  }

  /** The match on screen is being left (← Map, a new match, a new seed,
   *  another level): claim it if it made progress. Call it before the
   *  worker's `stop` or `init` (the record request must reach the worker
   *  first). The match is forgotten either way. */
  abandon(): Promise<ClaimNotice | undefined> | null {
    const ctx = this.current;
    const snap = this.d.snapshot();
    const out = ctx?.live && !ctx.claimed && hasProgress(snap?.status) ? this.claim("abandoned") : null;
    this.current = null;
    return out;
  }

  /** Claim the current match once. The snapshot and the record request are
   *  taken now (synchronously), the profile call follows. */
  claim(reason: ClaimReason, snapshot?: MatchSnapshot): Promise<ClaimNotice | undefined> | null {
    const ctx = this.current;
    const p = this.d.profile();
    // `snapshot`: the test hook's fast-forward (a synthetic cleared match).
    const snap = snapshot ?? this.d.snapshot();
    // Not live: the snapshot may still be the previous match's.
    if (!ctx?.live || !p || !snap || ctx.claimed) return null;
    ctx.claimed = true;
    const summary = buildSummary(ctx, snap, this.d.maxRadiusM);
    const record = this.d.record();
    return this.track(
      (async () => {
        let runRecord: unknown = null;
        try {
          runRecord = JSON.parse(await record);
        } catch (e) {
          console.error("profile: no run record for the claim", e);
        }
        const claim = await p.claimMatch(summary, runRecord);
        const n: ClaimNotice = { ctx, reason, claim, summary };
        this.claims.push(n);
        this.d.onClaim(n);
        return n;
      })(),
    );
  }
}
