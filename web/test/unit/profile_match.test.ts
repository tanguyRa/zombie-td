// The match ↔ profile wiring (ui/profilematch.ts): the summary built from
// the worker's reports, the MVP card, the place names from the geocoder,
// and one claim per match.
import { describe, expect, it } from "vitest";
import { memoryProfile } from "../../src/profile/service";
import { looksLikeAddress } from "../../src/profile/sanitize";
import type { MatchStatus, Structure, WaveResult } from "../../src/protocol";
import { MatchTracker, adminOf, buildSummary, hasProgress, mvpCard, type MatchContext, type MatchSnapshot } from "../../src/ui/profilematch";

const status = (over: Partial<MatchStatus> = {}): MatchStatus =>
  ({
    tick: 0,
    wave: 1,
    waves: 8,
    phase: "prep",
    wave_tick: 0,
    radius_m: 100,
    next_radius_m: 150,
    next_ring_ready: true,
    supply: 14,
    income: { base: 6, civilians: 0 },
    deck_count: 15,
    discard_count: 0,
    reshuffles: 0,
    retries: 0,
    restarts: 0,
    fatigue: 1,
    defeat_threshold: 0,
    wave_start_civilians: 0,
    newcomers: 0,
    mulligan_available: true,
    mulligan_cost: 1,
    stats: { civilians: 5000, infected: 0, zombies: 0, dead: 0, zombies_killed: 0, bites: 0, fence_cells_broken: 0 },
    ...over,
  }) as MatchStatus;

const result = (wave: number, won: boolean, end: number): WaveResult => ({
  wave,
  won,
  ticks: 100,
  radius_m: 100,
  newcomers: 0,
  start_civilians: end + 100,
  end_civilians: end,
  zombies_killed: 3,
  bites: 0,
  fence_cells_broken: 0,
  outbreak_clusters: 1,
  supply_earned: 5,
  cards_played: 2,
});

const RINGS = [120, 200, 300, 420, 560, 720, 900, 1100];

function ctx(over: Partial<MatchContext> = {}): MatchContext {
  return {
    matchId: "m1",
    place: { center: { lat: 48.858, lon: 2.358 }, city: "Paris", district: "Le Marais" },
    tier: "recruit",
    deckId: "deck-civil_defence_issue",
    deck: [],
    populationMultiplier: 0.3,
    hometown: false,
    seed: "2",
    streamed: false,
    claimed: false,
    firstBloodSent: false,
    waveVictories: new Set(),
    ...over,
  };
}

const garrison = (id: number, card: string, buildings: number[]): Structure => ({ id, card, cost: 3, wave: 1, kind: { type: "garrison", buildings } });

describe("summary", () => {
  it("counts the won waves, the civilians of each and the retries; abandoned in wave 3", () => {
    const snap: MatchSnapshot = {
      status: status({ wave: 3, phase: "running", retries: 1, restarts: 1 }),
      results: [result(1, true, 4000), result(2, true, 7000)],
      towers: [],
      structures: [],
      rings: RINGS,
    };
    const s = buildSummary(ctx(), snap, 1950);
    expect(s).toMatchObject({ wavesWon: 2, furthestWave: 3, savedPerWave: [4000, 7000], retries: 2, defendedRadiusM: 200, mvpCard: null, city: "Paris", district: "Le Marais", runRecordId: "m1" });
    expect(s.cityId).toBeUndefined();
  });

  it("a cleared match: 8 waves, the wave-8 radius (capped by the profile's bound)", () => {
    const results = RINGS.map((_, i) => result(i + 1, true, 1000 * (i + 1)));
    const s = buildSummary(ctx({ place: { center: { lat: 1, lon: 2 }, city: "X", district: "", cityId: "osm:relation:7444" } }), { status: status({ phase: "match_won", wave: 8 }), results, towers: [], structures: [], rings: RINGS }, 1000);
    expect(s).toMatchObject({ wavesWon: 8, furthestWave: 8, defendedRadiusM: 1000, cityId: "osm:relation:7444" });
    expect(s.savedPerWave).toHaveLength(8);
  });

  it("a lost wave on the result screen is not a won wave", () => {
    const s = buildSummary(ctx(), { status: status({ wave: 2, phase: "wave_lost" }), results: [result(1, true, 3000), result(2, false, 10)], towers: [], structures: [], rings: RINGS }, 1950);
    expect(s).toMatchObject({ wavesWon: 1, furthestWave: 2, savedPerWave: [3000] });
  });

  it("progress: a pristine wave-1 prep is not worth a claim", () => {
    expect(hasProgress(null)).toBe(false);
    expect(hasProgress(status())).toBe(false);
    expect(hasProgress(status({ phase: "running" }))).toBe(true);
    expect(hasProgress(status({ retries: 1 }))).toBe(true);
    expect(hasProgress(status({ restarts: 1 }))).toBe(true);
    expect(hasProgress(status({ wave: 2 }))).toBe(true);
  });
});

describe("MVP card", () => {
  it("the armament whose garrisons killed the most; ties by card id; none without kills", () => {
    const s = [garrison(1, "rifles", [10, 11]), garrison(2, "mortar", [12]), garrison(3, "hunting_rifles", [13])];
    // [building, x, y, range, kills]; a unit (-1) is not counted.
    const towers = [10, 0, 0, 30, 4, 11, 0, 0, 30, 3, 12, 0, 0, 30, 6, 13, 0, 0, 30, 1, -1, 0, 0, 30, 50];
    expect(mvpCard(towers, s)).toBe("rifles");
    expect(mvpCard([10, 0, 0, 30, 6, 12, 0, 0, 30, 6], s)).toBe("mortar");
    expect(mvpCard([10, 0, 0, 30, 0], s)).toBeNull();
    expect(mvpCard([], [])).toBeNull();
  });
});

describe("place names from the geocoder", () => {
  it("only admin fields: no road, house number or postcode reaches the profile", () => {
    const r = {
      osm_type: "node",
      osm_id: 123,
      addresstype: "building",
      address: { house_number: "12", road: "Rue des Rosiers", suburb: "Le Marais", city_district: "4e Arrondissement", city: "Paris", postcode: "75004", country: "France" },
      display_name: "12, Rue des Rosiers, Le Marais, Paris, 75004, France",
    };
    const a = adminOf(r);
    expect(a).toEqual({ city: "Paris", district: "Le Marais" });
    for (const v of Object.values(a)) expect(looksLikeAddress(v)).toBe(false);
  });

  it("a city result gives its relation id; an address result none", () => {
    expect(adminOf({ osm_type: "relation", osm_id: 7444, addresstype: "city", address: { city: "Paris", country: "France" } })).toEqual({ city: "Paris", district: "", cityId: "osm:relation:7444" });
    expect(adminOf({ osm_type: "relation", osm_id: 99, addresstype: "building", address: { city: "Paris" } }).cityId).toBeUndefined();
    expect(adminOf({})).toEqual({ city: "", district: "" });
  });
});

describe("tracker", () => {
  it("claims once: a clear then leaving pays once, a pristine match never", async () => {
    const p = await memoryProfile({ seed: 1n });
    let snap: MatchSnapshot | null = { status: status({ phase: "running" }), results: [], towers: [], structures: [], rings: RINGS };
    const claims: string[] = [];
    const t = new MatchTracker({
      profile: () => p,
      snapshot: () => snap,
      record: async () => JSON.stringify({ format: 1, setup: { seed: "2" } }),
      maxRadiusM: 1950,
      onClaim: (n) => claims.push(`${n.reason}:${n.claim.paid}:${n.claim.payout.total}`),
      onDaily: () => {},
      onError: (m) => {
        throw new Error(m);
      },
    });
    const base = { place: ctx().place, tier: "recruit" as const, deckId: "d", deck: [], populationMultiplier: 0.3, hometown: false, seed: "2", streamed: false };

    // First blood once per match; wave victories once per wave.
    const m = t.start(base);
    t.onStatus(status({ phase: "running", stats: { ...status().stats, zombies_killed: 2 } }));
    t.onStatus(status({ phase: "running", stats: { ...status().stats, zombies_killed: 5 } }));
    const results = RINGS.map((_, i) => result(i + 1, true, 16000));
    for (let w = 1; w <= 7; w++) t.onPhase(status({ wave: w, phase: "wave_won" }), results.slice(0, w));
    t.onPhase(status({ wave: 7, phase: "wave_won" }), results.slice(0, 7)); // a repeat
    snap = { status: status({ wave: 8, phase: "match_won" }), results, towers: [], structures: [], rings: RINGS };
    t.onPhase(snap.status, results);
    await t.settle();
    // 12 (perfect clear) + 2 match victory + 5 wave victories (cap) + 1 first blood.
    expect((await p.listTickets()).length).toBe(20);
    expect(claims).toEqual(["cleared:true:12"]);
    expect(t.abandon()).toBeNull(); // already claimed
    expect((await p.getMatch(m.matchId))?.runRecord).toEqual({ format: 1, setup: { seed: "2" } });

    // A pristine match left at once: no claim, no history entry.
    t.start(base);
    snap = { status: status(), results: [], towers: [], structures: [], rings: RINGS };
    expect(t.abandon()).toBeNull();
    expect(t.current).toBeNull();

    // A match abandoned in wave 2 pays once, and claiming it again pays nothing.
    const m3 = t.start(base);
    snap = { status: status({ wave: 2, phase: "prep" }), results: [result(1, true, 8000)], towers: [], structures: [], rings: RINGS };
    await t.abandon();
    expect(claims[1]).toBe("abandoned:true:3"); // wave 2: 1, civilians 8000/4000: 2
    const again = await p.claimMatch((await p.getMatch(m3.matchId))!.summary, null);
    expect(again.paid).toBe(false);
    expect((await p.listMatches()).length).toBe(2);
  });
});
