import { describe, expect, it } from "vitest";
import { crateLore, rebuildLore, rollCrate } from "../../src/profile/crates";
import { DEFAULT_TABLES } from "../../src/profile/data";
import { CRATE_STREAM, Pcg32 } from "../../src/profile/pcg32";
import { looksLikeAddress, placeLabel } from "../../src/profile/sanitize";
import { ProfileError } from "../../src/profile/store";
import { RARITIES, TIERS } from "../../src/profile/types";
import { STREET_FIXTURES } from "./profile_helpers";

describe("Pcg32", () => {
  it("matches sim-core's reference stream (seed 42, stream 54)", () => {
    const r = new Pcg32(42n, 54n);
    const expected = [0xa15c02b7, 0x7b47f409, 0xba1d3330, 0x83d2f293, 0xbfa4784b, 0xcbed606e];
    for (const e of expected) expect(r.nextU32()).toBe(e);
  });

  it("round-trips its state through JSON", () => {
    const a = new Pcg32(123456789n, CRATE_STREAM);
    for (let i = 0; i < 10; i++) a.nextU32();
    const b = Pcg32.fromState(JSON.parse(JSON.stringify(a.toJSON())));
    for (let i = 0; i < 100; i++) expect(b.nextU32()).toBe(a.nextU32());
  });

  it("below() is in range and float() in [0, 1)", () => {
    const r = new Pcg32(9n, 1n);
    for (let i = 0; i < 2000; i++) {
      const v = r.below(7);
      expect(v >= 0 && v < 7 && Number.isInteger(v)).toBe(true);
      const f = r.float();
      expect(f >= 0 && f < 1).toBe(true);
    }
  });
});

describe("crate odds", () => {
  const { cards, rewards } = DEFAULT_TABLES;
  const N = 40000;

  for (const tier of TIERS) {
    it(`${tier}: rarity and foil frequencies match the table (fixed seed, ${N} cards)`, () => {
      const rng = new Pcg32(20261122n, CRATE_STREAM);
      const rolled = rollCrate(rng, cards, rewards, tier, N);
      const odds = rewards.crates.odds[tier];
      for (const r of RARITIES) {
        const f = rolled.filter((c) => c.rarity === r).length / N;
        const sd = Math.sqrt((odds[r] * (1 - odds[r])) / N);
        expect(Math.abs(f - odds[r]), `${tier} ${r}: ${f} vs ${odds[r]}`).toBeLessThan(5 * sd + 1e-4);
      }
      const foil = rolled.filter((c) => c.foil).length / N;
      expect(Math.abs(foil - odds.foil)).toBeLessThan(5 * Math.sqrt((odds.foil * (1 - odds.foil)) / N) + 1e-4);
      // The rolled card has the rarity rolled.
      for (const c of rolled.slice(0, 500)) expect(cards.cards.find((d) => d.id === c.cardId)!.rarity).toBe(c.rarity);
    });
  }

  it("cards of one rarity come up about equally often", () => {
    const rng = new Pcg32(5n, CRATE_STREAM);
    const rolled = rollCrate(rng, cards, rewards, "recruit", N);
    const commons = cards.cards.filter((c) => c.rarity === "common");
    const total = rolled.filter((c) => c.rarity === "common").length;
    for (const c of commons) {
      const f = rolled.filter((x) => x.cardId === c.id).length / total;
      expect(Math.abs(f - 1 / commons.length)).toBeLessThan(0.02);
    }
  });

  it("harder tiers have better odds and every tier sums to 1", () => {
    for (let i = 0; i < TIERS.length; i++) {
      const o = rewards.crates.odds[TIERS[i]];
      expect(RARITIES.reduce((s, r) => s + o[r], 0)).toBeCloseTo(1, 12);
      if (i > 0) {
        const p = rewards.crates.odds[TIERS[i - 1]];
        expect(o.common).toBeLessThan(p.common);
        expect(o.rare).toBeGreaterThan(p.rare);
        expect(o.legendary).toBeGreaterThan(p.legendary);
        expect(o.foil).toBeGreaterThan(p.foil);
      }
    }
  });

  it("the same seed gives the same crate", () => {
    const a = rollCrate(new Pcg32(77n, CRATE_STREAM), cards, rewards, "elite", 30);
    const b = rollCrate(new Pcg32(77n, CRATE_STREAM), cards, rewards, "elite", 30);
    expect(a).toEqual(b);
  });
});

describe("crate lore", () => {
  it("names the district and city, never a street, a number or a postcode", () => {
    const rng = new Pcg32(1n, CRATE_STREAM);
    const places: [string, string][] = [
      ["Le Marais", "Paris"],
      ["12 Rue des Rosiers", "75004 Paris"],
      ["Baker Street 221B", "London NW1 6XE"],
      ["Hauptstraße 5", "10115 Berlin"],
      ["", ""],
    ];
    for (const source of ["payout", "match_victory", "wave_victory", "first_blood", "hometown"] as const) {
      for (const [district, city] of places) {
        for (let wave = 1; wave <= 8; wave++) {
          for (const tier of TIERS) {
            const lore = crateLore(rng, DEFAULT_TABLES.rewards, source, district, city, wave, tier);
            expect(looksLikeAddress(lore), lore).toBe(false);
            expect(lore).not.toMatch(/\d/);
            expect(lore).not.toMatch(/Rue|Street|stra(ß|ss)e/i);
            expect(lore).not.toMatch(/\{|\}/);
          }
        }
      }
    }
    const l = crateLore(new Pcg32(3n, CRATE_STREAM), DEFAULT_TABLES.rewards, "payout", "12 Rue des Rosiers, Le Marais", "Paris", 8, "veteran");
    expect(l).toContain("Le Marais, Paris");
    expect(l).toContain("eighth");
    expect(l).toContain("Veteran");
  });

  it("on a fixed list of real streets, lore shows the expected place and no street", () => {
    const rng = new Pcg32(5n, CRATE_STREAM);
    for (const { input, want, banned } of STREET_FIXTURES) {
      const label = want ? `${want}, Kyoto` : "Kyoto";
      for (const source of ["payout", "match_victory", "wave_victory", "first_blood", "hometown"] as const) {
        const lore = crateLore(rng, DEFAULT_TABLES.rewards, source, input, "Kyoto", 3, "elite");
        expect(lore, input).toContain(label);
        expect(lore.toLowerCase(), input).not.toContain(banned.toLowerCase());
        expect(lore, input).not.toMatch(/\d/);
      }
      // The street as the city field. The city mode is lenient (the field is
      // an admin name by contract, and "Plaza Huincul" is a town), but a
      // house number, a postcode, a second segment, an abbreviation or a
      // hyphenated suffix still sends the lore to the city or a generic name.
      const asCity = crateLore(rng, DEFAULT_TABLES.rewards, "payout", "", input, 3, "elite");
      expect(asCity, input).not.toMatch(/\d/);
      const strong = want !== "" || /\d|,|\.|º|-(ro|gil|daero|dori|dōri)\b/i.test(input);
      if (strong) {
        expect(asCity, input).toContain(want || "an unnamed district");
        expect(asCity.toLowerCase(), input).not.toContain(banned.toLowerCase());
      }
    }
  });

  it("an unknown tier or source fails with a ProfileError, not a TypeError", () => {
    const rng = new Pcg32(5n, CRATE_STREAM);
    const { cards, rewards } = DEFAULT_TABLES;
    expect(() => rollCrate(rng, cards, rewards, "impossible" as never, 3)).toThrow(ProfileError);
    expect(() => crateLore(rng, rewards, "payout", "", "Paris", 3, "impossible" as never)).toThrow(ProfileError);
    expect(() => crateLore(rng, rewards, "nowhere" as never, "", "Paris", 3, "recruit")).toThrow(ProfileError);
  });

  it("every lore template is free of street words", () => {
    for (const templates of Object.values(DEFAULT_TABLES.rewards.crates.lore)) {
      for (const t of templates) expect(looksLikeAddress(t.replace(/\{\w+\}/g, "X")), t).toBe(false);
    }
  });
});

describe("rebuildLore", () => {
  const rewards = DEFAULT_TABLES.rewards;
  it("gives back every lore line as it was, and re-makes only the place", () => {
    for (const source of Object.keys(rewards.crates.lore)) {
      for (let seed = 0n; seed < 12n; seed++) {
        for (const tier of TIERS) {
          for (const wave of [1, 3, 8]) {
            const line = crateLore(new Pcg32(seed, CRATE_STREAM), rewards, source as never, "Le Marais", "Paris", wave, tier);
            expect(rebuildLore(rewards, source, line, "Le Marais", "Paris")).toBe(line);
            const edited = line.replace("Le Marais, Paris", "12 Rue de Rivoli, 75004 Paris");
            expect(rebuildLore(rewards, source, edited, "", "Paris")).toBe(line.replace("Le Marais, Paris", "Paris"));
          }
        }
      }
    }
  });
  it("returns null for a line that reads as no template, or an unknown source", () => {
    expect(rebuildLore(rewards, "payout", "Found at 12 Rue de Rivoli.", "", "Paris")).toBeNull();
    expect(rebuildLore(rewards, "toString", "x", "", "Paris")).toBeNull();
    expect(rebuildLore(rewards, "nope", "x", "", "Paris")).toBeNull();
  });
});

describe("crateLore replacements (T7a review)", () => {
  it("never expands $&, $`, $' or $$ in the place, wave or tier", () => {
    const rewards = structuredClone(DEFAULT_TABLES.rewards);
    for (const k of Object.keys(rewards.crates.lore) as (keyof typeof rewards.crates.lore)[]) rewards.crates.lore[k] = ["Before {place} middle {wave} and {tier} after."];
    const kept: string[] = [];
    for (const name of ["Saint-$&-Ville", "Bourg$`Haut", "Bourg $` Haut", "Mont$'Bas", "Mont $' Bas", "Val$$Doré", "Val $$ Doré", "Les $1 Prés"]) {
      const label = placeLabel(name, "");
      if (label.includes("$")) kept.push(label);
      const lore = crateLore(new Pcg32(5n, CRATE_STREAM), rewards, "payout", name, "", 3, "elite");
      expect(lore).toBe(`Before ${label} middle third and Elite after.`);
    }
    // The sanitiser keeps at least these, so the test sees every pattern.
    for (const p of ["$&", "$`", "$'", "$$"]) expect(kept.some((l) => l.includes(p)), `${p} in ${kept.join(" | ")}`).toBe(true);
  });
});
