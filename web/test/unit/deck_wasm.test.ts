// sim-core's `validate_deck` through WASM (the validator the game injects
// into the profile, T7b) agrees with the TS mirror (`mirrorValidateDeck`) on
// the t3_cards.rs cases and on random decks.
//
// The cases and their expected errors are a shared fixture,
// crates/sim-wasm/tests/fixtures/deck_cases.json, also read by the WASM test
// (`wasm-pack test --node crates/sim-wasm`, `wasm_validate_deck_matches_the_cases`),
// so the core (native rules compiled to WASM) and the mirror are checked
// against the same expectations. `UPDATE_FIXTURES=1 npx vitest run
// test/unit/deck_wasm.test.ts` rewrites it from the mirror.
//
// Needs the web WASM build (`npm run wasm`, as for the app).
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { initSync, validate_deck } from "../../src/wasm/pkg/sim_wasm.js";
import { DEFAULT_TABLES, mirrorValidateDeck, starterCardIds } from "../../src/profile/data";
import { wasmDeckValidator } from "../../src/ui/deckvalidator";
import type { DeckError } from "../../src/profile/types";
import { Pcg32 } from "../../src/profile/pcg32";
import { REPO } from "./fixtures";

const FIXTURE = `${REPO}crates/sim-wasm/tests/fixtures/deck_cases.json`;
const db = DEFAULT_TABLES.cards;
const ids = (list: [string, number][]) => list.flatMap(([c, n]) => Array<string>(n).fill(c));

initSync({ module: readFileSync(new URL("../../src/wasm/pkg/sim_wasm_bg.wasm", import.meta.url)) });

/** The t3_cards.rs `deck_rules_are_enforced_with_clear_errors` decks (the
 *  "three legendaries" case needs a custom card table, so it stays in the
 *  mirror test only). */
function cases(): { name: string; deck: string[] }[] {
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
  const unknown = [...base];
  unknown[0] = "laser_cannon";
  return [
    { name: "starter", deck: base },
    { name: "19 cards", deck: base.slice(0, 19) },
    { name: "21 cards", deck: [...base, "sniper_nest"] },
    { name: "unknown card", deck: unknown },
    { name: "2 uncommons", deck: [...rest(18), ...ids([["mortar", 2]])] },
    { name: "4 commons", deck: [...ids([["rifles", 4]]), ...rest(19).slice(3)] },
    { name: "3 uncommons", deck: withExtra([["mortar", 3]]) },
    { name: "1 rare each", deck: withExtra([["sniper_nest", 1], ["napalm", 1]]) },
    { name: "2 rares", deck: withExtra([["sniper_nest", 2]]) },
    { name: "2 legendaries", deck: withExtra([["airstrike", 1], ["armored_convoy", 1]]) },
    { name: "2 copies of a legendary", deck: withExtra([["airstrike", 2]]) },
    { name: "every problem", deck: [...withExtra([["airstrike", 2], ["sniper_nest", 2]]), "rifles"] },
    { name: "empty", deck: [] },
  ];
}

describe("validate_deck through WASM = the TS mirror", () => {
  it("the shared fixture holds the mirror's answers", () => {
    const now = cases().map((c) => ({ ...c, errors: mirrorValidateDeck(db, c.deck) }));
    if (process.env.UPDATE_FIXTURES) writeFileSync(FIXTURE, JSON.stringify(now, null, 1) + "\n");
    const stored = JSON.parse(readFileSync(FIXTURE, "utf8")) as { name: string; deck: string[]; errors: DeckError[] }[];
    expect(stored).toEqual(now);
    // The cases cover every error kind the embedded cards can produce.
    const kinds = new Set(now.flatMap((c) => c.errors.map((e) => e.error)));
    expect([...kinds].sort()).toEqual(["too_many_copies", "unknown_card", "wrong_size"]);
  });

  it("WASM gives the same errors, in the same order, on every case", async () => {
    const v = wasmDeckValidator(validate_deck);
    for (const c of cases()) {
      expect(await v(c.deck), c.name).toEqual(mirrorValidateDeck(db, c.deck));
    }
  });

  it("and on 2,000 random decks", async () => {
    const v = wasmDeckValidator(validate_deck);
    const rng = new Pcg32(7n, 1n);
    const pool = [...db.cards.map((c) => c.id), "laser_cannon"];
    for (let i = 0; i < 2000; i++) {
      const n = 17 + rng.below(6);
      const deck = Array.from({ length: n }, () => pool[rng.below(pool.length)]);
      expect(await v(deck)).toEqual(mirrorValidateDeck(db, deck));
    }
  });

  it("refuses what is not a list of card ids", () => {
    expect(() => validate_deck("{}")).toThrow(/bad_deck/);
    expect(() => validate_deck("[1, 2]")).toThrow(/bad_deck/);
  });
});
