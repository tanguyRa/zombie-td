// The TS mirror of sim-core's deck rules agrees with the Rust tests
// (crates/sim-core/tests/t3_cards.rs, `deck_rules_are_enforced_with_clear_errors`),
// and the profile adds ownership checks.

import { describe, expect, it } from "vitest";
import { DEFAULT_TABLES, deckErrorMessage, mirrorValidateDeck, starterCardIds, type CardsTable } from "../../src/profile/data";
import { memoryProfile } from "../../src/profile/service";
import type { DeckError } from "../../src/profile/types";

const db = DEFAULT_TABLES.cards;
const v = (deck: string[], t: CardsTable = db) => mirrorValidateDeck(t, deck);
const ids = (list: [string, number][]) => list.flatMap(([c, n]) => Array<string>(n).fill(c));

describe("mirrorValidateDeck = sim-core validate_deck (t3_cards.rs cases)", () => {
  const base = starterCardIds(db);
  const rest = (n: number) =>
    ids([
      ["rifles", 3],
      ["hunting_rifles", 3],
      ["militia", 3],
      ["light_fence", 3],
      ["barbed_wire", 3],
      ["grenades", 3],
      ["machine_gun_nest", 2],
    ]).slice(0, n);
  const withExtra = (extra: [string, number][]) => {
    const e = ids(extra);
    return [...rest(20 - e.length), ...e];
  };

  it("the starter deck is legal and 20 commons/uncommons", () => {
    expect(base.length).toBe(20);
    expect(base.every((c) => ["common", "uncommon"].includes(db.cards.find((d) => d.id === c)!.rarity))).toBe(true);
    expect(v(base)).toEqual([]);
  });

  it("size", () => {
    expect(v(base.slice(0, 19))).toEqual([{ error: "wrong_size", size: 19, expected: 20 }]);
    expect(v([...base, "sniper_nest"])).toEqual([{ error: "wrong_size", size: 21, expected: 20 }]);
  });

  it("unknown card", () => {
    const u = [...base];
    u[0] = "laser_cannon";
    expect(v(u)).toContainEqual({ error: "unknown_card", card: "laser_cannon" });
  });

  it("copies by rarity", () => {
    expect(v([...rest(18), ...ids([["mortar", 2]])])).toEqual([]);
    const fourRifles = [...ids([["rifles", 4]]), ...rest(19).slice(3)];
    expect(fourRifles.length).toBe(20);
    expect(v(fourRifles)).toEqual([{ error: "too_many_copies", card: "rifles", rarity: "common", copies: 4, max: 3 }]);
    expect(v(withExtra([["mortar", 3]]))).toEqual([{ error: "too_many_copies", card: "mortar", rarity: "uncommon", copies: 3, max: 2 }]);
    expect(v(withExtra([["sniper_nest", 1], ["napalm", 1]]))).toEqual([]);
    expect(v(withExtra([["sniper_nest", 2]]))).toEqual([{ error: "too_many_copies", card: "sniper_nest", rarity: "rare", copies: 2, max: 1 }]);
  });

  it("legendaries: 1 copy each, at most 2 per deck", () => {
    expect(v(withExtra([["airstrike", 1], ["armored_convoy", 1]]))).toEqual([]);
    expect(v(withExtra([["airstrike", 2]]))).toEqual([{ error: "too_many_copies", card: "airstrike", rarity: "legendary", copies: 2, max: 1 }]);
    const three: CardsTable = { ...db, cards: [...db.cards, { ...db.cards.find((c) => c.id === "airstrike")!, id: "orbital", name: "Orbital" }] };
    expect(v(withExtra([["airstrike", 1], ["armored_convoy", 1], ["orbital", 1]]), three)).toEqual([{ error: "too_many_legendaries", count: 3, max: 2 }]);
  });

  it("every problem is reported, in Rust's order, with Rust's messages", () => {
    const many = [...withExtra([["airstrike", 2], ["sniper_nest", 2]]), "rifles"];
    const errs = v(many);
    expect(errs.length).toBe(4);
    expect(errs).toContainEqual({ error: "too_many_copies", card: "rifles", rarity: "common", copies: 4, max: 3 });
    expect(errs.map(deckErrorMessage).some((m) => m.includes("at most 1 of a legendary card"))).toBe(true);
    expect(deckErrorMessage(errs[0])).toContain("exactly 20 cards");
    expect(deckErrorMessage({ error: "too_many_legendaries", count: 3, max: 2 })).toBe("3 legendary cards: at most 2 per deck");
    expect(deckErrorMessage({ error: "unknown_card", card: "x" })).toBe('unknown card "x"');
  });
});

describe("decks in the profile", () => {
  it("saves, loads and lists decks of owned instances", async () => {
    const p = await memoryProfile({ seed: 1n });
    const cards = await p.listCards();
    const ids20 = cards.map((c) => c.instanceId);
    const r = await p.saveDeck({ name: "My deck", instanceIds: ids20 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((await p.getDeck(r.deck.id))!.instanceIds).toEqual(ids20);
    const names = (await p.listDecks()).map((d) => d.name);
    expect(names).toEqual(["Civil Defence Issue", "My deck"]);
    expect(await p.deckCardIds(r.deck.id)).toEqual(starterCardIds(db));
    // Rename in place.
    const r2 = await p.saveDeck({ id: r.deck.id, name: "Renamed", instanceIds: ids20 });
    expect(r2.ok).toBe(true);
    expect((await p.listDecks()).length).toBe(2);
    expect(await p.deleteDeck(r.deck.id)).toBe(true);
    expect(await p.deleteDeck(r.deck.id)).toBe(false);
  });

  it("refuses instances not owned and an instance twice", async () => {
    const p = await memoryProfile({ seed: 1n });
    const ids20 = (await p.listCards()).map((c) => c.instanceId);
    const stolen = [...ids20.slice(0, 19), "someone-elses-card"];
    const r = await p.saveDeck({ name: "x", instanceIds: stolen });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toContainEqual({ error: "not_owned", instanceId: "someone-elses-card" });
    // The core then sees only the 19 owned cards.
    expect(r.errors).toContainEqual({ error: "wrong_size", size: 19, expected: 20 });

    const twice = [...ids20.slice(0, 19), ids20[0]];
    const r2 = await p.saveDeck({ name: "x", instanceIds: twice });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.errors).toContainEqual({ error: "duplicate_instance", instanceId: ids20[0] });
    expect((await p.listDecks()).length).toBe(1);
  });

  it("uses the injected validator (the core's, through WASM, in the game)", async () => {
    const calls: string[][] = [];
    const veto: DeckError = { error: "wrong_size", size: 0, expected: 99 };
    const p = await memoryProfile({
      seed: 1n,
      validateDeck: async (cardIds) => {
        calls.push(cardIds);
        return [veto];
      },
    });
    const ids20 = (await p.listCards()).map((c) => c.instanceId);
    const r = await p.saveDeck({ name: "x", instanceIds: ids20 });
    expect(r).toEqual({ ok: false, errors: [veto] });
    expect(calls[0]).toEqual(starterCardIds(db));
    expect(await p.checkDeck(ids20)).toEqual([veto]);
  });
});
