import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blockLatLonBounds } from "../../src/map/blocks";
import { cellAreaM2, cellsInDisc } from "../../src/profile/coverage";
import { DEFAULT_TABLES } from "../../src/profile/data";
import { computePayout, localDay } from "../../src/profile/rewards";
import { looksLikeAddress } from "../../src/profile/sanitize";
import { LocalProfileService, memoryProfile } from "../../src/profile/service";
import { IdbProfileBackend, MemoryProfileBackend, ProfileError, SCHEMA_VERSION, migrateBundle } from "../../src/profile/store";
import type { MatchSummary, ProfileExport } from "../../src/profile/types";
import { DAY, FakeClock, HOUR, PARIS, T0, summary } from "./profile_helpers";

afterEach(() => vi.unstubAllGlobals());

const payoutTable = DEFAULT_TABLES.rewards.payout;

async function fresh(clock = new FakeClock(T0)) {
  return { p: await memoryProfile({ clock, seed: 42n, profileId: "test-profile" }), clock };
}

/// Clear a match on each tier up to `tier` so it is unlocked.
async function unlockUpTo(p: LocalProfileService, n: number) {
  const tiers = ["recruit", "veteran", "elite", "nightmare"] as const;
  for (let i = 0; i < n; i++) await p.claimMatch(summary({ tier: tiers[i], center: { lat: -33.9, lon: 18.4 + i * 0.1 }, city: "Cape Town" }), null);
}

describe("payout", () => {
  it("follows the formula", () => {
    const cleared = summary({ savedPerWave: [1000, 3000, 5000, 7000, 9000, 11000, 15000, 18000] });
    const p = computePayout(payoutTable, cleared);
    expect(p).toEqual({ waveTickets: 4, clearedTickets: 2, civilianTickets: 4, noRetryBonus: 2, total: 12 });
    expect(computePayout(payoutTable, { ...cleared, retries: 3 }).noRetryBonus).toBe(0);
    const abandoned = summary({ wavesWon: 3, savedPerWave: [2000, 4500, 8100] });
    expect(computePayout(payoutTable, abandoned)).toEqual({ waveTickets: 2, clearedTickets: 0, civilianTickets: 2, noRetryBonus: 0, total: 4 });
    // Abandoned in wave 1: nothing (no farming by quitting at once).
    expect(computePayout(payoutTable, summary({ wavesWon: 0 })).total).toBe(0);
    // An abandoned run never gets the no-retry bonus.
    expect(computePayout(payoutTable, summary({ wavesWon: 7, retries: 0 })).noRetryBonus).toBe(0);
  });

  it("is paid exactly once per match id", async () => {
    const { p } = await fresh();
    const s = summary();
    const first = await p.claimMatch(s, { log: [1, 2, 3] });
    expect(first.paid).toBe(true);
    expect(first.tickets.length).toBe(first.payout.total);
    const ticketsAfterFirst = (await p.listTickets()).length;
    expect(ticketsAfterFirst).toBe(first.payout.total + first.daily!.granted.length);

    const again = await p.claimMatch(s, { log: [9] });
    expect(again.paid).toBe(false);
    expect(again.tickets).toEqual([]);
    expect(again.payout).toEqual(first.payout);
    // Even with other numbers under the same id.
    const tampered = await p.claimMatch({ ...s, wavesWon: 8, savedPerWave: [99999, 99999, 99999, 99999, 99999, 99999, 99999, 99999] }, null);
    expect(tampered.paid).toBe(false);
    expect((await p.listTickets()).length).toBe(ticketsAfterFirst);
    // Concurrent claims of the same match in one tab.
    const s2 = summary({ wavesWon: 4 });
    const both = await Promise.all([p.claimMatch(s2, null), p.claimMatch(s2, null)]);
    expect(both.filter((c) => c.paid).length).toBe(1);
    // The run record is kept with the first claim.
    expect((await p.getMatch(s.matchId))!.runRecord).toEqual({ log: [1, 2, 3] });
  });

  it("is paid once across two tabs on the same IndexedDB", async () => {
    const idb = new IDBFactory();
    const clock = new FakeClock(T0);
    const a = await LocalProfileService.open({ indexedDB: idb, clock, seed: 1n });
    const b = await LocalProfileService.open({ indexedDB: idb, clock, seed: 2n });
    expect(a.persistent).toBe(true);
    expect((await a.info()).profileId).toBe((await b.info()).profileId);
    const s = summary();
    const claims = await Promise.all([a.claimMatch(s, null), b.claimMatch(s, null)]);
    expect(claims.filter((c) => c.paid).length).toBe(1);
    const paid = claims.find((c) => c.paid)!;
    expect((await a.listTickets()).length).toBe(paid.payout.total + paid.daily!.granted.length);
    a.close();
    b.close();
  });

  it("a stale write is retried on fresh data (the conflict path really runs)", async () => {
    const shared = new MemoryProfileBackend();
    let conflicts = 0;
    const commit = shared.commit.bind(shared);
    shared.commit = async (c) => {
      try {
        await commit(c);
      } catch (e) {
        if (e instanceof ProfileError && e.code === "conflict") conflicts++;
        throw e;
      }
    };
    const a = await LocalProfileService.open({ backend: shared, seed: 1n });
    const b = await LocalProfileService.open({ backend: shared, seed: 1n });
    const s = summary();
    const claims = await Promise.all([a.claimMatch(s, null), b.claimMatch(s, null)]);
    expect(conflicts).toBeGreaterThan(0);
    expect(claims.filter((c) => c.paid).length).toBe(1);
    await expect(a.openCrate("no-such-ticket")).rejects.toMatchObject({ code: "unknown_ticket" });
  });

  it("rejects an inconsistent summary and a locked tier", async () => {
    const { p } = await fresh();
    await expect(p.claimMatch(summary({ wavesWon: 3, furthestWave: 8 }), null)).rejects.toMatchObject({ code: "bad_summary" });
    await expect(p.claimMatch(summary({ savedPerWave: [-1] }), null)).rejects.toMatchObject({ code: "bad_summary" });
    await expect(p.claimMatch(summary({ tier: "elite" }), null)).rejects.toMatchObject({ code: "tier_locked" });
    expect((await p.listTickets()).length).toBe(0);
  });
});

describe("daily caps", () => {
  const ev = (matchId: string, wave: number) => ({ kind: "wave_victory" as const, matchId, wave, city: "Paris", district: "Le Marais", tier: "recruit" as const, populationSaved: 500 });

  it("wave victory 5/day, first blood 1/day, reset on the next local day", async () => {
    const { p, clock } = await fresh();
    for (let w = 1; w <= 5; w++) expect((await p.recordDailyEvent(ev("a", w))).granted.length).toBe(1);
    const sixth = await p.recordDailyEvent(ev("a", 6));
    expect(sixth).toMatchObject({ granted: [], reason: "cap_reached", remaining: 0, day: "2026-11-22" });
    // The same wave of the same match never counts twice (retries, restarts).
    clock.advance(DAY);
    expect((await p.recordDailyEvent(ev("a", 1))).reason).toBe("already_counted");
    expect((await p.recordDailyEvent(ev("a", 6))).granted.length).toBe(1);

    const fb = { ...ev("b", 1), kind: "first_blood" as const, populationSaved: 0 };
    expect((await p.recordDailyEvent(fb)).granted.length).toBe(1);
    expect((await p.recordDailyEvent({ ...fb, matchId: "c" })).granted.length).toBe(0);
    expect((await p.dailyStatus()).counts).toEqual({ first_blood: 1, wave_victory: 1, match_victory: 0 });
  });

  it("the boundary is local midnight", async () => {
    // 23:59 local in Paris (UTC+1) = 22:59 UTC.
    const clock = new FakeClock(Date.UTC(2026, 10, 22, 22, 59), 60);
    const { p } = await fresh(clock);
    const fb = (m: string) => ({ kind: "first_blood" as const, matchId: m, wave: 1, city: "Paris", district: "", tier: "recruit" as const, populationSaved: 0 });
    expect((await p.recordDailyEvent(fb("x"))).day).toBe("2026-11-22");
    expect((await p.recordDailyEvent(fb("y"))).granted.length).toBe(0);
    clock.advance(60_000); // 00:00 local
    const r = await p.recordDailyEvent(fb("z"));
    expect(r.day).toBe("2026-11-23");
    expect(r.granted.length).toBe(1);
  });

  it("match victory 5/day, counted by claimMatch", async () => {
    const { p, clock } = await fresh();
    const daily: number[] = [];
    for (let i = 0; i < 6; i++) daily.push((await p.claimMatch(summary(), null)).daily!.granted.length);
    expect(daily).toEqual([2, 2, 2, 2, 2, 0]);
    clock.advance(DAY);
    expect((await p.claimMatch(summary(), null)).daily!.granted.length).toBe(2);
    // An abandoned match has no match victory.
    expect((await p.claimMatch(summary({ wavesWon: 2 }), null)).daily).toBeNull();
  });

  it("a timezone change never reopens a day already used", async () => {
    // 00:30 on the 23rd in Tokyo (UTC+9) = 15:30 UTC on the 22nd.
    const clock = new FakeClock(Date.UTC(2026, 10, 22, 15, 30), 9 * 60);
    const { p } = await fresh(clock);
    const fb = (m: string) => ({ kind: "first_blood" as const, matchId: m, wave: 1, city: "Tokyo", district: "", tier: "recruit" as const, populationSaved: 0 });
    expect((await p.recordDailyEvent(fb("1"))).day).toBe("2026-11-23");
    // Fly to New York (UTC-5): it's the 22nd there. The 22nd doesn't reopen.
    clock.offset = -5 * 60;
    clock.advance(HOUR);
    const ny = await p.recordDailyEvent(fb("2"));
    expect(ny.day).toBe("2026-11-23");
    expect(ny.granted.length).toBe(0);
    // Midnight of the 23rd -> 24th in New York: a new day.
    clock.t = Date.UTC(2026, 10, 24, 5, 0); // 00:00 on the 24th in New York
    const next = await p.recordDailyEvent(fb("3"));
    expect(next.day).toBe("2026-11-24");
    expect(next.granted.length).toBe(1);
    // Flying east starts the next day early (once): Tokyo is already the 25th.
    clock.offset = 9 * 60;
    expect((await p.recordDailyEvent(fb("4"))).day).toBe("2026-11-24"); // 14:00 on the 24th in Tokyo
    clock.t = Date.UTC(2026, 10, 24, 15, 0); // 00:00 on the 25th in Tokyo
    expect((await p.recordDailyEvent(fb("5"))).granted.length).toBe(1);
    expect(localDay(Date.UTC(2026, 10, 24, 15, 0), 9 * 60)).toBe("2026-11-25");
  });
});

describe("difficulty tiers", () => {
  it("unlock one by one by clearing a match on the tier below", async () => {
    const { p } = await fresh();
    expect(await p.tiers()).toEqual({ unlocked: ["recruit"], highestCleared: null });
    // An abandoned match unlocks nothing.
    expect((await p.claimMatch(summary({ wavesWon: 7 }), null)).unlockedTiers).toEqual([]);
    expect((await p.claimMatch(summary(), null)).unlockedTiers).toEqual(["veteran"]);
    expect((await p.tiers()).unlocked).toEqual(["recruit", "veteran"]);
    // Clearing recruit again unlocks nothing new.
    expect((await p.claimMatch(summary(), null)).unlockedTiers).toEqual([]);
    await expect(p.claimMatch(summary({ tier: "elite" }), null)).rejects.toThrow(ProfileError);
    expect((await p.claimMatch(summary({ tier: "veteran" }), null)).unlockedTiers).toEqual(["elite"]);
    expect((await p.claimMatch(summary({ tier: "elite" }), null)).unlockedTiers).toEqual(["nightmare"]);
    expect((await p.claimMatch(summary({ tier: "nightmare" }), null)).unlockedTiers).toEqual([]);
    expect(await p.tiers()).toEqual({ unlocked: ["recruit", "veteran", "elite", "nightmare"], highestCleared: "nightmare" });
  });

  it("reads the multipliers from config.default.json", async () => {
    const { p } = await fresh();
    const r = await p.difficulty("recruit");
    const n = await p.difficulty("nightmare");
    expect(r).toEqual({ population_multiplier: 1, outbreak_scale: 1, fatigue_scale: 1 });
    expect(n.population_multiplier).toBeGreaterThan(r.population_multiplier);
    expect(n.outbreak_scale).toBeGreaterThan(r.outbreak_scale);
    expect(n.fatigue_scale).toBeGreaterThan(r.fatigue_scale);
  });
});

describe("collection and crates", () => {
  it("a new profile has the starter deck, once, account-bound and not tradeable", async () => {
    const backend = new MemoryProfileBackend();
    const p = await LocalProfileService.open({ backend, seed: 1n });
    const cards = await p.listCards();
    expect(cards.length).toBe(20);
    for (const c of cards) {
      expect(c).toMatchObject({ source: "starter", stamp: null, accountBound: true, tradeable: false, salvageable: false, foil: false });
    }
    const decks = await p.listDecks();
    expect(decks).toHaveLength(1);
    expect(decks[0].name).toBe("Civil Defence Issue");
    expect(decks[0].instanceIds).toEqual(cards.map((c) => c.instanceId));
    // Opening the profile again does not grant it again.
    const again = await LocalProfileService.open({ backend, seed: 9n });
    expect((await again.listCards()).length).toBe(20);
    expect((await again.listDecks()).length).toBe(1);
  });

  it("a ticket opens a crate of stamped, tradeable cards with lore", async () => {
    const { p } = await fresh();
    const s = summary({ district: "12 Rue des Rosiers, Le Marais", city: "75004 Paris", tier: "recruit" });
    const claim = await p.claimMatch(s, null);
    const before = (await p.listTickets()).length;
    const t = claim.tickets[0];
    const { crate, cards } = await p.openCrate(t.id);
    expect((await p.listTickets()).length).toBe(before - 1);
    expect(cards).toHaveLength(DEFAULT_TABLES.rewards.crates.cards_per_crate);
    expect(crate.ticketId).toBe(t.id);
    expect(crate.lore).toContain("Le Marais, Paris");
    expect(looksLikeAddress(crate.lore)).toBe(false);
    for (const c of cards) {
      expect(c).toMatchObject({ source: "crate", accountBound: false, tradeable: true, salvageable: true, crateId: crate.id });
      expect(c.stamp).toEqual({ district: "Le Marais", city: "Paris", wave: 8, tier: "recruit", populationSaved: 8000, mvpCard: "rifles", date: "2026-11-22" });
      expect(looksLikeAddress(`${c.stamp!.district}, ${c.stamp!.city}`)).toBe(false);
    }
    expect((await p.listCards()).length).toBe(20 + cards.length);
    // Stored history never shows the street either.
    expect((await p.getMatch(s.matchId))!.summary.district).toBe("Le Marais");
    // Spend every ticket, then none left.
    while ((await p.listTickets()).length) await p.openCrate();
    await expect(p.openCrate()).rejects.toMatchObject({ code: "no_ticket" });
    await expect(p.openCrate("nope")).rejects.toMatchObject({ code: "no_ticket" });
  });

  it("crate contents follow the profile seed, not the match", async () => {
    const roll = async (seed: bigint) => {
      const p = await memoryProfile({ clock: new FakeClock(T0), seed, profileId: "same" });
      await p.claimMatch(summary({ matchId: "fixed" }), null);
      return (await p.openCrate()).cards.map((c) => [c.cardId, c.foil]);
    };
    expect(await roll(5n)).toEqual(await roll(5n));
    const others = await Promise.all([6n, 7n, 8n, 9n].map(roll));
    expect(others.some((o) => JSON.stringify(o) !== JSON.stringify(others[0]))).toBe(true);
  });

  it("the Hometown crate is granted once, from a cleared match", async () => {
    const { p } = await fresh();
    const lost = summary({ wavesWon: 3 });
    await p.claimMatch(lost, null);
    await expect(p.claimHometownCrate(lost.matchId)).rejects.toMatchObject({ code: "not_cleared" });
    await expect(p.claimHometownCrate("nope")).rejects.toMatchObject({ code: "unknown_match" });
    const home = summary({ district: "Belleville", city: "Paris" });
    await p.claimMatch(home, null);
    const { crate, cards } = await p.claimHometownCrate(home.matchId);
    expect(crate.source).toBe("hometown");
    expect(crate.ticketId).toBeNull();
    expect(crate.lore).toContain("Belleville, Paris");
    expect(cards).toHaveLength(DEFAULT_TABLES.rewards.crates.hometown_cards);
    expect((await p.info()).hometownCrateClaimed).toBe(true);
    await expect(p.claimHometownCrate(home.matchId)).rejects.toMatchObject({ code: "hometown_claimed" });
  });
});

describe("coverage", () => {
  it("covers the cells inside the defended radius, keeping the highest tier", async () => {
    const { p } = await fresh();
    const cells = cellsInDisc(PARIS, 1300);
    // About the disc's area (cells are ~251 m square).
    const area = cells.reduce((s, c) => s + cellAreaM2(c), 0);
    expect(Math.abs(area - Math.PI * 1300 * 1300) / (Math.PI * 1300 * 1300)).toBeLessThan(0.15);

    const box = { south: 48.8, west: 2.25, north: 48.92, east: 2.45 };
    expect(await p.coverageInBox(box)).toEqual([]);
    const c1 = await p.claimMatch(summary({ tier: "recruit" }), null);
    expect(c1.coverageCells).toBe(cells.length);
    let got = await p.coverageInBox(box);
    expect(got.map((c) => c.cell)).toEqual(cells);
    expect(new Set(got.map((c) => c.tier))).toEqual(new Set(["recruit"]));
    // An abandoned match adds no coverage.
    expect((await p.claimMatch(summary({ wavesWon: 7, tier: "recruit", center: { lat: 48.87, lon: 2.3 }, defendedRadiusM: 1125 }), null)).coverageCells).toBe(0);

    // Veteran, 600 m east: the overlap goes up to veteran.
    const east = { lat: PARIS.lat, lon: PARIS.lon + 600 / (111320 * Math.cos((PARIS.lat * Math.PI) / 180)) };
    await p.claimMatch(summary({ tier: "veteran", center: east }), null);
    const eastCells = new Set(cellsInDisc(east, 1300));
    // Recruit again at the first spot: nothing goes down.
    const c3 = await p.claimMatch(summary({ tier: "recruit" }), null);
    expect(c3.coverageCells).toBe(0);
    got = await p.coverageInBox(box);
    for (const c of got) expect(c.tier).toBe(eastCells.has(c.cell) ? "veteran" : "recruit");
    expect(got.length).toBe(new Set([...cells, ...eastCells]).size);
  });

  it("the bounding-box query returns only intersecting cells", async () => {
    const { p } = await fresh();
    await p.claimMatch(summary(), null);
    const all = await p.coverageInBox({ south: -90, west: -180, north: 90, east: 180 });
    expect(all.length).toBe(cellsInDisc(PARIS, 1300).length);
    const small = { south: PARIS.lat - 0.001, west: PARIS.lon - 0.001, north: PARIS.lat + 0.001, east: PARIS.lon + 0.001 };
    const some = await p.coverageInBox(small);
    expect(some.length).toBeGreaterThan(0);
    expect(some.length).toBeLessThanOrEqual(4);
    for (const c of some) {
      const b = blockLatLonBounds(c.cell);
      expect(c.bounds).toEqual(b);
      expect(b.west < small.east && small.west < b.east && b.south < small.north && small.south < b.north).toBe(true);
    }
    expect(await p.coverageInBox({ south: 10, west: 10, north: 11, east: 11 })).toEqual([]);
  });
});

describe("city achievements", () => {
  /// Match centres on a 2.2 km grid around Paris.
  const grid = (n: number) => {
    const out: { lat: number; lon: number }[] = [];
    const dLat = 2200 / 110540;
    const dLon = 2200 / (111320 * Math.cos((PARIS.lat * Math.PI) / 180));
    for (let i = 0; out.length < n; i++) {
      const r = Math.floor(i / 5);
      const c = i % 5;
      out.push({ lat: PARIS.lat + (r - 2) * dLat, lon: PARIS.lon + (c - 2) * dLon });
    }
    return out;
  };

  it("city cleared at >= 75% of the city's area, in tiers", async () => {
    const clock = new FakeClock(T0);
    // A small city (30 km²) so a few matches clear it.
    const p = await memoryProfile({ clock, seed: 1n, cityArea: ({ cityKey }) => (cityKey === "name:paris" ? 30 : null) });
    await unlockUpTo(p, 1); // veteran unlocked (Cape Town match)
    let last = null;
    const centres = grid(25);
    let i = 0;
    for (; i < centres.length; i++) {
      const claim = await p.claimMatch(summary({ center: centres[i], tier: "veteran" }), null);
      last = claim.city!;
      expect(last.provisional).toBe(false);
      if (last.fractionByTier.recruit >= 0.75) break;
    }
    expect(last!.clearedTiers).toEqual(["recruit", "veteran"]);
    expect(last!.fractionByTier.elite).toBe(0);
    const ach = await p.achievements();
    expect(ach.map((a) => a.id).sort()).toEqual(["city_cleared:name:paris:recruit", "city_cleared:name:paris:veteran"]);
    expect(ach.every((a) => !a.provisional && a.city === "Paris")).toBe(true);
    // Defended area of a recruit match elsewhere in the city doesn't count at veteran.
    const progress = await p.cityProgress(" PARIS ");
    expect(progress.fractionByTier.veteran).toBeGreaterThanOrEqual(0.75);
    // Another city: nothing cleared.
    expect((await p.cityProgress("Lyon")).clearedTiers).toEqual([]);
  });

  it("an unknown area uses the placeholder and marks the achievement provisional", async () => {
    let known: number | null = null;
    const p = await memoryProfile({ clock: new FakeClock(T0), seed: 1n, cityArea: () => known });
    const placeholder = DEFAULT_TABLES.rewards.coverage.placeholder_city_area_km2;
    let claim = await p.claimMatch(summary({ city: "Smallville", cityId: "osm:relation:1" }), null);
    expect(claim.city).toMatchObject({ cityKey: "id:osm:relation:1", areaKm2: placeholder, provisional: true, clearedTiers: [] });
    // Pretend the city is tiny: a provisional achievement first...
    const tiny = await memoryProfile({ clock: new FakeClock(T0), seed: 1n, tables: { ...DEFAULT_TABLES, rewards: { ...DEFAULT_TABLES.rewards, coverage: { city_cleared_fraction: 0.75, placeholder_city_area_km2: 3 } } }, cityArea: () => known });
    claim = await tiny.claimMatch(summary({ city: "Smallville" }), null);
    expect(claim.newAchievements).toHaveLength(1);
    expect(claim.newAchievements[0]).toMatchObject({ id: "city_cleared:name:smallville:recruit", provisional: true });
    // ...dropped when the real area shows the city isn't cleared.
    known = 50;
    claim = await tiny.claimMatch(summary({ city: "Smallville", center: { lat: 48.9, lon: 2.4 } }), null);
    expect(claim.city!.provisional).toBe(false);
    expect(await tiny.achievements()).toEqual([]);
  });

  it("a provisional achievement becomes final when the real area confirms it", async () => {
    let known: number | null = null;
    const tables = { ...DEFAULT_TABLES, rewards: { ...DEFAULT_TABLES.rewards, coverage: { city_cleared_fraction: 0.75, placeholder_city_area_km2: 3 } } };
    const p = await memoryProfile({ clock: new FakeClock(T0), seed: 1n, tables, cityArea: () => known });
    await p.claimMatch(summary({ city: "Smallville" }), null);
    expect((await p.achievements())[0].provisional).toBe(true);
    known = 4;
    await p.claimMatch(summary({ city: "Smallville" }), null);
    expect(await p.achievements()).toMatchObject([{ id: "city_cleared:name:smallville:recruit", provisional: false }]);
  });
});

describe("match history", () => {
  it("lists summaries newest first and gets one with its run record", async () => {
    const { p, clock } = await fresh();
    const a = summary({ wavesWon: 3 });
    await p.claimMatch(a, { seed: 1, actions: [] });
    clock.advance(HOUR);
    const b = summary();
    await p.claimMatch(b, { seed: 2, actions: [[10, "Start"]] });
    const list = await p.listMatches();
    expect(list.map((m) => m.summary.matchId)).toEqual([b.matchId, a.matchId]);
    expect(list[0]).not.toHaveProperty("runRecord");
    expect(list[1].cleared).toBe(false);
    const got = await p.getMatch(b.matchId);
    expect(got!.runRecord).toEqual({ seed: 2, actions: [[10, "Start"]] });
    expect(got!.summary.runRecordId).toBe(b.runRecordId);
    expect(await p.getMatch("nope")).toBeNull();
  });
});

describe("storage", () => {
  it("falls back to memory when IndexedDB is missing or broken", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const p = await LocalProfileService.open({ seed: 1n });
    expect(p.persistent).toBe(false);
    expect((await p.listCards()).length).toBe(20);
    const throwing = { open: () => { throw new DOMException("denied", "SecurityError"); } } as unknown as IDBFactory;
    const q = await LocalProfileService.open({ indexedDB: throwing, seed: 1n });
    expect(q.persistent).toBe(false);
  });

  it("persists across reopen on IndexedDB", async () => {
    const idb = new IDBFactory();
    const a = await LocalProfileService.open({ indexedDB: idb, clock: new FakeClock(T0), seed: 1n });
    await a.claimMatch(summary(), { r: 1 });
    const id = (await a.info()).profileId;
    a.close();
    const b = await LocalProfileService.open({ indexedDB: idb, clock: new FakeClock(T0), seed: 2n });
    expect((await b.info()).profileId).toBe(id);
    expect((await b.listMatches()).length).toBe(1);
    expect((await b.coverageInBox({ south: -90, west: -180, north: 90, east: 180 })).length).toBeGreaterThan(0);
    b.close();
  });

  it("migrates an older schema on open, refuses a newer one, never wipes", async () => {
    const idb = new IDBFactory();
    const v1 = await LocalProfileService.open({ indexedDB: idb, clock: new FakeClock(T0), seed: 1n });
    await v1.claimMatch(summary({ matchId: "old-match" }), null);
    const tickets = (await v1.listTickets()).length;
    v1.close();
    // A future schema 2 that renames decks and tags coverage cells.
    const migrations = {
      1: (b: { state: { decks: { name: string }[] }; coverage: { areaM2: number }[] }) => {
        for (const d of b.state.decks) d.name = d.name.toUpperCase();
        for (const c of b.coverage) c.areaM2 = Math.round(c.areaM2);
      },
    };
    const v2 = await LocalProfileService.open({ indexedDB: idb, clock: new FakeClock(T0), schema: 2, migrations: migrations as never });
    expect((await v2.info()).schema).toBe(2);
    expect((await v2.listDecks())[0].name).toBe("CIVIL DEFENCE ISSUE");
    expect((await v2.listTickets()).length).toBe(tickets);
    expect((await v2.claimMatch(summary({ matchId: "old-match" }), null)).paid).toBe(false);
    const cells = await v2.coverageInBox({ south: -90, west: -180, north: 90, east: 180 });
    expect(cells.every((c) => Number.isInteger(c.areaM2))).toBe(true);
    v2.close();
    // The old code can't read schema 2: it refuses instead of resetting.
    await expect(LocalProfileService.open({ indexedDB: idb, clock: new FakeClock(T0) })).rejects.toMatchObject({ code: "schema_too_new" });
    // The data is still there.
    const again = await LocalProfileService.open({ indexedDB: idb, clock: new FakeClock(T0), schema: 2, migrations: migrations as never });
    expect((await again.listTickets()).length).toBe(tickets);
    again.close();
  });

  it("migrateBundle checks its steps", () => {
    const b = { state: { schema: 1 } as never, matches: [], coverage: [] };
    expect(() => migrateBundle(b, 3, { 1: () => {} })).toThrow(/no migration from profile schema 2/);
    expect(() => migrateBundle({ ...b, state: { schema: 4 } as never }, SCHEMA_VERSION)).toThrow(ProfileError);
    expect(migrateBundle(b, 1)).toEqual(b);
  });

  it("an IndexedDB opened with a newer store layout is refused, not wiped", async () => {
    const idb = new IDBFactory();
    await new Promise<void>((res) => {
      const r = idb.open("zt-profile", 99);
      r.onsuccess = () => {
        r.result.close();
        res();
      };
    });
    await expect(IdbProfileBackend.open({ indexedDB: idb })).rejects.toMatchObject({ code: "schema_too_new" });
    await expect(LocalProfileService.open({ indexedDB: idb })).rejects.toMatchObject({ code: "schema_too_new" });
  });
});

describe("export and import", () => {
  it("round-trips a whole profile", async () => {
    const { p } = await fresh();
    const s: MatchSummary = summary({ tier: "recruit" });
    await p.claimMatch(s, { r: 1 });
    await p.openCrate();
    await p.recordDailyEvent({ kind: "first_blood", matchId: s.matchId, wave: 1, city: "Paris", district: "", tier: "recruit", populationSaved: 0 });
    const dump: ProfileExport = JSON.parse(JSON.stringify(await p.exportProfile()));
    expect(dump.format).toBe("zt-profile-export");
    expect(dump.matches).toHaveLength(1);

    const q = await memoryProfile({ clock: new FakeClock(T0), seed: 999n });
    await q.importProfile(dump);
    expect(await q.listCards()).toEqual(await p.listCards());
    expect(await q.listTickets()).toEqual(await p.listTickets());
    expect(await q.listMatches()).toEqual(await p.listMatches());
    expect(await q.achievements()).toEqual(await p.achievements());
    const world = { south: -90, west: -180, north: 90, east: 180 };
    expect(await q.coverageInBox(world)).toEqual(await p.coverageInBox(world));
    expect((await q.info()).profileId).toBe("test-profile");
    // Same RNG state: the next crate is the same in both.
    expect((await q.openCrate()).cards.map((c) => c.cardId)).toEqual((await p.openCrate()).cards.map((c) => c.cardId));
    // Idempotency survives the import.
    expect((await q.claimMatch(s, null)).paid).toBe(false);
  });

  it("refuses garbage and newer exports", async () => {
    const { p } = await fresh();
    await expect(p.importProfile({} as never)).rejects.toMatchObject({ code: "bad_import" });
    const dump = await p.exportProfile();
    await expect(p.importProfile({ ...dump, schema: SCHEMA_VERSION + 1, state: { ...dump.state, schema: SCHEMA_VERSION + 1 } })).rejects.toMatchObject({ code: "schema_too_new" });
    expect((await p.listCards()).length).toBe(20);
  });

  it("a malformed export is refused and the profile is left untouched", async () => {
    const { p } = await fresh();
    await p.claimMatch(summary(), { r: 1 });
    const good = JSON.parse(JSON.stringify(await p.exportProfile())) as ProfileExport;
    const before = JSON.stringify(await p.exportProfile());
    const st = good.state as unknown as Record<string, unknown>;
    const withState = (patch: Record<string, unknown>) => ({ ...good, state: { ...st, ...patch } as never });
    const bad: unknown[] = [
      { format: "zt-profile-export", schema: 1, state: { schema: 1 }, matches: [], coverage: [] },
      withState({ instances: undefined }),
      withState({ decks: {} }),
      withState({ tickets: "x" }),
      withState({ crates: null }),
      withState({ claimedMatches: [1] }),
      withState({ dailyKeys: undefined }),
      withState({ achievements: undefined }),
      withState({ instances: [null] }),
      withState({ revision: "3" }),
      withState({ nextSeq: NaN }),
      withState({ rng: { state: "zz", inc: "1" } }),
      withState({ rng: undefined }),
      withState({ daily: { day: 3, counts: {} } }),
      withState({ daily: { day: "2026-11-22", counts: { first_blood: 0 } } }),
      withState({ highestClearedTier: 9 }),
      withState({ profileId: "" }),
      { ...good, matches: [{ summary: {} }] },
      { ...good, matches: [null] },
      { ...good, coverage: [{ cell: "12" }] },
      { ...good, coverage: [{}] },
    ];
    for (const b of bad) {
      await expect(p.importProfile(b as ProfileExport), JSON.stringify(b).slice(0, 120)).rejects.toMatchObject({ code: "bad_import" });
    }
    expect(JSON.stringify(await p.exportProfile())).toBe(before);
    expect((await p.listCards()).length).toBe(20);
    expect((await p.claimMatch(summary(), null)).paid).toBe(true);
    // The good export still imports.
    await p.importProfile(good);
    expect((await p.listMatches()).length).toBe(1);
  });

  it("an import applies the place contract (hand-edited export)", async () => {
    const { p } = await fresh();
    await p.claimMatch(summary({ cityId: "osm:relation:7444" }), { r: 1 });
    const good = JSON.parse(JSON.stringify(await p.exportProfile())) as ProfileExport;
    expect(good.matches[0].summary.cityId).toBe("osm:relation:7444");
    expect(Object.keys(good.coverage[0].cities)).toEqual(["id:osm:relation:7444"]);
    const edited = JSON.parse(JSON.stringify(good)) as ProfileExport;
    edited.matches[0].summary.cityId = "osm:way:12345";
    edited.matches[0].summary.city = "Rue de Rivoli 12, Paris";
    edited.matches[0].summary.district = "12 Rue de Rivoli";
    const q = await memoryProfile({ clock: new FakeClock(T0), seed: 1n });
    await q.importProfile(edited);
    const [{ summary: m }] = await q.listMatches();
    expect(m.cityId).toBeUndefined();
    expect("cityId" in m).toBe(false);
    expect(m.city).toBe("Paris");
    expect(m.district).toBe("");
    // A coverage city key that is neither an accepted id nor a name is refused.
    for (const key of ["id:osm:way:12345", "osm:relation:7444", "name:", "12 Rue de Rivoli", "id:osm:relation:1234567890123"]) {
      const bad = JSON.parse(JSON.stringify(good)) as ProfileExport;
      bad.coverage[0].cities = { [key]: "recruit" };
      await expect(q.importProfile(bad), key).rejects.toMatchObject({ code: "bad_import" });
    }
    // The valid export still round-trips unchanged.
    await q.importProfile(good);
    expect(await q.listMatches()).toEqual(await p.listMatches());
    const world = { south: -90, west: -180, north: 90, east: 180 };
    expect(await q.coverageInBox(world)).toEqual(await p.coverageInBox(world));
  });

  it("exports state, matches and coverage from one transaction", async () => {
    const idb = new IDBFactory();
    const a = await LocalProfileService.open({ indexedDB: idb, clock: new FakeClock(T0), seed: 1n });
    const other = await LocalProfileService.open({ indexedDB: idb, clock: new FakeClock(T0), seed: 1n });
    // Another tab claims a match while the export is between two reads.
    const backend = (a as unknown as { backend: IdbProfileBackend }).backend;
    let armed = true;
    const realLoad = backend.loadState.bind(backend);
    backend.loadState = async () => {
      const s = await realLoad();
      if (armed) {
        armed = false;
        await other.claimMatch(summary({ matchId: "racing" }), null);
      }
      return s;
    };
    const realAll = backend.allMatches.bind(backend);
    backend.allMatches = async () => {
      if (armed) {
        armed = false;
        await other.claimMatch(summary({ matchId: "racing" }), null);
      }
      return realAll();
    };
    const dump = await a.exportProfile();
    expect(dump.matches.map((m) => m.summary.matchId).sort()).toEqual([...dump.state.claimedMatches].sort());
    a.close();
    other.close();
  });
});

describe("review fixes", () => {
  it("recordDailyEvent checks tier, wave, match id and population", async () => {
    const { p } = await fresh();
    const ok = { kind: "wave_victory" as const, matchId: "a", wave: 1, city: "Paris", district: "", tier: "recruit" as const, populationSaved: 10 };
    await expect(p.recordDailyEvent({ ...ok, tier: "nightmare" })).rejects.toMatchObject({ code: "tier_locked" });
    await expect(p.recordDailyEvent({ ...ok, kind: "first_blood", tier: "elite" })).rejects.toMatchObject({ code: "tier_locked" });
    for (const bad of [
      { tier: "bogus" },
      { wave: 0 },
      { wave: 9 },
      { wave: 2.5 },
      { wave: NaN },
      { matchId: "" },
      { matchId: 7 },
      { populationSaved: -1 },
      { populationSaved: NaN },
      { populationSaved: Infinity },
    ]) {
      await expect(p.recordDailyEvent({ ...ok, ...bad } as never), JSON.stringify(bad)).rejects.toMatchObject({ code: "bad_summary" });
    }
    expect(await p.listTickets()).toEqual([]);
    expect((await p.dailyStatus()).counts).toEqual({ first_blood: 0, wave_victory: 0, match_victory: 0 });
    // Veteran unlocks after a recruit clear.
    await p.claimMatch(summary(), null);
    expect((await p.recordDailyEvent({ ...ok, tier: "veteran" })).granted).toHaveLength(1);
  });

  it("an unusable ticket doesn't wedge openCrate", async () => {
    const backend = new MemoryProfileBackend();
    const p = await LocalProfileService.open({ backend, clock: new FakeClock(T0), seed: 1n });
    await p.recordDailyEvent({ kind: "first_blood", matchId: "a", wave: 1, city: "Paris", district: "", tier: "recruit", populationSaved: 0 });
    const s = (await backend.loadState())!;
    const good = s.tickets[0];
    s.tickets.unshift({ ...good, id: "bad-ticket", tier: "bogus" as never });
    await backend.commit({ expectedRevision: s.revision, state: { ...s, revision: s.revision + 1 } });
    await expect(p.openCrate("bad-ticket")).rejects.toMatchObject({ code: "bad_ticket" });
    const opened = await p.openCrate();
    expect(opened.crate.ticketId).toBe(good.id);
    // Only the unusable ticket is left: reported, not a TypeError.
    await expect(p.openCrate()).rejects.toMatchObject({ code: "bad_ticket" });
    expect((await p.listTickets()).map((t) => t.id)).toEqual(["bad-ticket"]);
  });

  it("a clock set a year ahead then corrected doesn't freeze the daily caps", async () => {
    const clock = new FakeClock(T0 + 365 * DAY);
    const { p } = await fresh(clock);
    const fb = (m: string) => ({ kind: "first_blood" as const, matchId: m, wave: 1, city: "Paris", district: "", tier: "recruit" as const, populationSaved: 0 });
    expect((await p.recordDailyEvent(fb("1"))).day).toBe("2027-11-22");
    clock.t = T0; // corrected
    const r = await p.recordDailyEvent(fb("2"));
    expect(r.day).toBe("2026-11-22");
    expect(r.granted).toHaveLength(1);
    expect((await p.dailyStatus()).day).toBe("2026-11-22");
    // One day ahead still holds (flying east, then back west).
    clock.t = T0 + DAY;
    expect((await p.recordDailyEvent(fb("3"))).day).toBe("2026-11-23");
    clock.t = T0 + 2 * HOUR;
    const back = await p.recordDailyEvent(fb("4"));
    expect(back.day).toBe("2026-11-23");
    expect(back.granted).toHaveLength(0);
  });

  it("an address in the city never reaches the city key, achievements, cells or progress", async () => {
    const tables = { ...DEFAULT_TABLES, rewards: { ...DEFAULT_TABLES.rewards, coverage: { city_cleared_fraction: 0.75, placeholder_city_area_km2: 3 } } };
    const seen: string[] = [];
    const p = await memoryProfile({ clock: new FakeClock(T0), seed: 1n, tables, cityArea: ({ city, cityKey }) => (seen.push(city, cityKey), null) });
    const raw = "12 Rue de Rivoli, 75004 Paris";
    const claim = await p.claimMatch(summary({ city: raw, district: "12 Rue de Rivoli" }), null);
    expect(claim.city).toMatchObject({ city: "Paris", cityKey: "name:paris" });
    expect(claim.newAchievements.map((a) => a.id)).toEqual(["city_cleared:name:paris:recruit"]);
    const progress = await p.cityProgress(raw);
    expect(progress).toMatchObject({ city: "Paris", cityKey: "name:paris" });
    expect(progress.fractionByTier.recruit).toBeGreaterThan(0);
    const dump = await p.exportProfile();
    const placeStrings = [
      claim.city!.city,
      claim.city!.cityKey,
      progress.city,
      progress.cityKey,
      ...seen,
      ...dump.state.achievements.flatMap((a) => [a.id, a.cityKey, a.city]),
      ...dump.coverage.flatMap((c) => Object.keys(c.cities)),
      ...dump.matches.flatMap((m) => [m.summary.city, m.summary.district]),
      ...dump.state.tickets.flatMap((t) => [t.city, t.district]),
    ];
    for (const s of placeStrings) {
      expect(s, s).not.toMatch(/\d/);
      expect(s.toLowerCase(), s).not.toMatch(/rivoli|rue/);
    }
    expect(JSON.stringify(dump)).not.toMatch(/Rivoli|75004/);
    // Same key as plain "Paris": the coverage counts for one city.
    expect((await p.cityProgress("Paris")).fractionByTier).toEqual(progress.fractionByTier);
  });

  it("a city that sanitises to nothing adds coverage but no city key", async () => {
    const { p } = await fresh();
    const claim = await p.claimMatch(summary({ city: "12 Rue de Rivoli" }), null);
    expect(claim.coverageCells).toBeGreaterThan(0);
    expect(claim.city).toBeNull();
    const dump = await p.exportProfile();
    expect(dump.coverage.every((c) => Object.keys(c.cities).length === 0)).toBe(true);
    expect((await p.cityProgress("12 Rue de Rivoli")).fractionByTier.recruit).toBe(0);
  });

  it("the defended radius is bounded and finite", async () => {
    const { p } = await fresh();
    const max = DEFAULT_TABLES.maxDefendedRadiusM;
    expect(max).toBe(1300 * 1.5);
    for (const r of [60000, max + 1, Infinity, NaN, -1]) {
      await expect(p.claimMatch(summary({ defendedRadiusM: r }), null), String(r)).rejects.toMatchObject({ code: "bad_summary" });
    }
    expect((await p.claimMatch(summary({ defendedRadiusM: max }), null)).coverageCells).toBe(cellsInDisc(PARIS, max).length);
  });

  it("an unknown tier in claimMatch is a bad_summary", async () => {
    const { p } = await fresh();
    await expect(p.claimMatch(summary({ tier: "bogus" as never }), null)).rejects.toMatchObject({ code: "bad_summary" });
  });

  it("a blocked open is reported, not replaced by an empty memory profile", async () => {
    const fakeReq = (fire: (r: Record<string, unknown>) => void) => {
      const r: Record<string, unknown> = {};
      setTimeout(() => fire(r), 0);
      return r;
    };
    const blocked = { open: () => fakeReq((r) => (r.onblocked as () => void)()) } as unknown as IDBFactory;
    await expect(LocalProfileService.open({ indexedDB: blocked })).rejects.toMatchObject({ code: "storage" });
  });

  it("a transient open error is retried, then reported", async () => {
    const real = new IDBFactory();
    let calls = 0;
    const failing = (r: Record<string, unknown>) => {
      r.error = new DOMException("disk hiccup", "UnknownError");
      (r.onerror as () => void)();
    };
    const flaky = {
      open: (name: string, v: number) => {
        calls++;
        if (calls === 1) {
          const r: Record<string, unknown> = {};
          setTimeout(() => failing(r), 0);
          return r;
        }
        return real.open(name, v);
      },
    } as unknown as IDBFactory;
    const p = await LocalProfileService.open({ indexedDB: flaky, seed: 1n });
    expect(p.persistent).toBe(true);
    expect(calls).toBe(2);
    p.close();
    const broken = {
      open: () => {
        const r: Record<string, unknown> = {};
        setTimeout(() => failing(r), 0);
        return r;
      },
    } as unknown as IDBFactory;
    await expect(LocalProfileService.open({ indexedDB: broken })).rejects.toMatchObject({ code: "storage" });
  });
});

describe("review fixes 2", () => {
  const world = { south: -90, west: -180, north: 90, east: 180 };

  it("an unaccepted cityId never reaches a stored key; an osm relation does", async () => {
    const tables = { ...DEFAULT_TABLES, rewards: { ...DEFAULT_TABLES.rewards, coverage: { city_cleared_fraction: 0.75, placeholder_city_area_km2: 3 } } };
    const seen: (string | undefined)[] = [];
    const p = await memoryProfile({ clock: new FakeClock(T0), seed: 1n, tables, cityArea: ({ cityId, cityKey }) => (seen.push(cityId, cityKey), null) });
    const bad = ["12 Rue de Rivoli, 75004 Paris", "osm:way:4372", "osm:node:17807753", " osm:relation:7444", "id:../x"];
    for (const [i, cityId] of bad.entries()) {
      const claim = await p.claimMatch(summary({ cityId, center: { lat: PARIS.lat, lon: PARIS.lon + i * 0.05 } }), null);
      expect(claim.city?.cityKey, cityId).toBe("name:paris");
    }
    expect((await p.cityProgress("Paris", "12 Rue de Rivoli")).cityKey).toBe("name:paris");
    const good = await p.claimMatch(summary({ cityId: "osm:relation:7444", center: { lat: 45.76, lon: 4.83 }, city: "Lyon" }), null);
    expect(good.city?.cityKey).toBe("id:osm:relation:7444");
    expect((await p.cityProgress("Lyon", "osm:relation:7444")).cityKey).toBe("id:osm:relation:7444");
    const dump = JSON.stringify(await p.exportProfile());
    // No stored string equals an unaccepted id (quoted: " osm:relation:7444" with its space).
    for (const b of bad) expect(dump.includes(JSON.stringify(b)), b).toBe(false);
    for (const b of ["Rivoli", "75004", "osm:way", "osm:node", "id:../x"]) expect(dump.includes(b), b).toBe(false);
    expect(seen.filter((s) => s !== undefined && !/^(name:paris|name:lyon|osm:relation:7444|id:osm:relation:7444)$/.test(s))).toEqual([]);
    // History drops the unaccepted id, keeps the accepted one.
    const matches = await p.listMatches();
    expect(matches.filter((m) => m.summary.cityId !== undefined).map((m) => m.summary.cityId)).toEqual(["osm:relation:7444"]);
  });

  it("Halle (Saale) and Halle (Westf.) are two cities; Praha 1 stamps as Praha", async () => {
    const { p } = await fresh();
    const a = await p.claimMatch(summary({ city: "Halle (Saale)", district: "", center: { lat: 51.48, lon: 11.97 } }), null);
    const b = await p.claimMatch(summary({ city: "Halle (Westf.)", district: "", center: { lat: 52.06, lon: 8.36 } }), null);
    expect(a.city!.cityKey).not.toBe(b.city!.cityKey);
    const c = await p.claimMatch(summary({ city: "Praha", district: "Praha 1", center: { lat: 50.08, lon: 14.42 } }), null);
    const { cards } = await p.openCrate(c.tickets[0].id);
    expect(cards[0].stamp).toMatchObject({ district: "Praha", city: "Praha" });
  });

  it("savedPerWave must be finite integers >= 0", async () => {
    const { p } = await fresh();
    for (const v of [Infinity, NaN, 1.5, -1]) {
      await expect(p.claimMatch(summary({ savedPerWave: [1000, 2000, 3000, 4000, 5000, 6000, 7000, v] }), null), String(v)).rejects.toMatchObject({ code: "bad_summary" });
    }
    expect((await p.listTickets()).length).toBe(0);
  });

  it("city and district must be strings, mvpCard a known card id or null", async () => {
    const { p } = await fresh();
    for (const over of [{ city: 12 }, { district: null }, { district: { road: "x" } }, { mvpCard: "not_a_card" }, { mvpCard: 3 }, { mvpCard: "" }]) {
      await expect(p.claimMatch(summary(over as never), null), JSON.stringify(over)).rejects.toMatchObject({ code: "bad_summary" });
    }
    expect((await p.claimMatch(summary({ mvpCard: null }), null)).paid).toBe(true);
    expect((await p.claimMatch(summary({ mvpCard: "mortar" }), null)).paid).toBe(true);
    const e = { kind: "wave_victory" as const, matchId: "m", wave: 1, city: "Paris", district: "", tier: "recruit" as const, populationSaved: 0 };
    await expect(p.recordDailyEvent({ ...e, city: 3 as never })).rejects.toMatchObject({ code: "bad_summary" });
    await expect(p.recordDailyEvent({ ...e, district: undefined as never })).rejects.toMatchObject({ code: "bad_summary" });
    expect((await p.recordDailyEvent(e)).granted).toHaveLength(1);
  });

  /// A profile after claims (cleared and abandoned), crates, the Hometown
  /// crate, a daily event and a saved deck.
  async function played(p: LocalProfileService) {
    const home = summary({ district: "Belleville", city: "Paris", cityId: "osm:relation:7444" });
    await p.claimMatch(home, { r: 1 });
    await p.claimMatch(summary({ wavesWon: 3, center: { lat: 45.76, lon: 4.83 }, city: "Lyon", mvpCard: null }), { r: 2 });
    await p.openCrate();
    await p.openCrate();
    await p.claimHometownCrate(home.matchId);
    await p.recordDailyEvent({ kind: "first_blood", matchId: home.matchId, wave: 1, city: "Paris", district: "", tier: "recruit", populationSaved: 0 });
    const ids = (await p.listCards()).map((c) => c.instanceId).slice(0, 20);
    expect((await p.saveDeck({ name: "Mine", instanceIds: ids })).ok).toBe(true);
  }

  async function sameProfile(q: LocalProfileService, p: LocalProfileService) {
    expect(await q.listCards()).toEqual(await p.listCards());
    expect(await q.listDecks()).toEqual(await p.listDecks());
    expect(await q.listTickets()).toEqual(await p.listTickets());
    expect(await q.listCrates()).toEqual(await p.listCrates());
    expect(await q.listMatches()).toEqual(await p.listMatches());
    expect(await q.achievements()).toEqual(await p.achievements());
    expect(await q.coverageInBox(world)).toEqual(await p.coverageInBox(world));
    expect(await q.info()).toEqual(await p.info());
  }

  for (const where of ["memory", "IndexedDB"] as const) {
    for (const state of ["fresh", "played"] as const) {
      it(`a valid export round-trips (${state}, ${where})`, async () => {
        const mk = (seed: bigint) =>
          where === "memory"
            ? memoryProfile({ clock: new FakeClock(T0), seed, profileId: "rt" })
            : LocalProfileService.open({ indexedDB: new IDBFactory(), clock: new FakeClock(T0), seed, profileId: "rt" });
        const p = await mk(42n);
        if (state === "played") await played(p);
        const dump: ProfileExport = JSON.parse(JSON.stringify(await p.exportProfile()));
        const q = await mk(7n);
        await q.importProfile(dump);
        await sameProfile(q, p);
        // And again from the imported profile.
        const again: ProfileExport = JSON.parse(JSON.stringify(await q.exportProfile()));
        expect({ ...again, exportedAt: "", state: { ...again.state, revision: 0 } }).toEqual({ ...dump, exportedAt: "", state: { ...dump.state, revision: 0 } });
        p.close();
        q.close();
      });
    }
  }

  it("import checks every match in full, unique ids and the schema", async () => {
    const { p } = await fresh();
    await played(p);
    const good = JSON.parse(JSON.stringify(await p.exportProfile())) as ProfileExport;
    const before = JSON.stringify(await p.exportProfile());
    const copy = () => JSON.parse(JSON.stringify(good)) as ProfileExport;
    const edit = (f: (d: ProfileExport) => void) => {
      const d = copy();
      f(d);
      return d;
    };
    const bad: [string, ProfileExport][] = [
      ["savedPerWave not an array", edit((d) => ((d.matches[0].summary as unknown as Record<string, unknown>).savedPerWave = "x"))],
      ["savedPerWave Infinity", edit((d) => (d.matches[0].summary.savedPerWave[0] = Infinity))],
      ["wavesWon 9", edit((d) => (d.matches[0].summary.wavesWon = 9))],
      ["bad tier", edit((d) => (d.matches[0].summary.tier = "godmode" as never))],
      ["radius too big", edit((d) => (d.matches[0].summary.defendedRadiusM = 1e9))],
      ["no center", edit((d) => (d.matches[0].summary.center = null as never))],
      ["city not a string", edit((d) => (d.matches[0].summary.city = 1 as never))],
      ["unknown mvpCard", edit((d) => (d.matches[0].summary.mvpCard = "nuke"))],
      ["cleared not a boolean", edit((d) => (d.matches[0].cleared = "yes" as never))],
      ["claimedAt not ISO", edit((d) => (d.matches[0].claimedAt = "yesterday"))],
      ["claimedAt missing", edit((d) => (d.matches[0].claimedAt = undefined as never))],
      ["payout null", edit((d) => (d.matches[0].payout = null as never))],
      ["payout fields", edit((d) => (d.matches[0].payout = { total: "12" } as never))],
      ["deck instanceIds not strings", edit((d) => (d.state.decks[0].instanceIds = [1, 2] as never))],
      ["duplicate instance id", edit((d) => d.state.instances.push({ ...d.state.instances[0] }))],
      ["duplicate ticket id", edit((d) => d.state.tickets.push({ ...d.state.tickets[0] }))],
      ["duplicate match id", edit((d) => d.matches.push(JSON.parse(JSON.stringify(d.matches[0]))))],
      ["duplicate deck id", edit((d) => d.state.decks.push({ ...d.state.decks[0] }))],
      ["schema mismatch", edit((d) => (d.schema = SCHEMA_VERSION + 1))],
      ["state schema mismatch", edit((d) => (d.state.schema = 0))],
    ];
    expect(good.state.tickets.length).toBeGreaterThan(0);
    for (const [name, b] of bad) {
      await expect(p.importProfile(b), name).rejects.toMatchObject({ code: "bad_import" });
    }
    expect(JSON.stringify(await p.exportProfile())).toBe(before);
    // The crash path of the review: a summary without savedPerWave can no
    // longer be imported and then reach claimHometownCrate.
    const q = await memoryProfile({ clock: new FakeClock(T0), seed: 1n });
    const noHome = edit((d) => {
      d.state.hometownCrateClaimed = false;
      delete (d.matches[0].summary as Partial<MatchSummary>).savedPerWave;
    });
    await expect(q.importProfile(noHome)).rejects.toMatchObject({ code: "bad_import" });
    await q.importProfile(good);
    expect((await q.listMatches()).length).toBe(2);
  });
});
