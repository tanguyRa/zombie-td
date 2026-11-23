// The local profile in the browser (T7b), on the built-in Marais level with
// no network (Nominatim answers come from fixtures): the starter deck of a
// new profile, deck validation, one payout per match, crates and their
// stamps, a custom deck used in a match, tier unlocks, coverage on the map,
// match history with a record that verifies headless, and the place names
// taken from the geocoder's admin fields only.
//
// A full 8-wave clear is the T5 full-match test (match.spec.ts), which also
// checks its claim, the Veteran unlock and coverage; here a clear is
// fast-forwarded through the test hook (`profile.fastForwardClear`: the same
// claim path and payout panel with a synthetic 8-wave summary).
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import cards from "../../cards.json" with { type: "json" };
import { looksLikeAddress } from "../src/profile/sanitize";
import { type CardInfo, keepTactical, playPrep, zombieHotspot } from "./bot";
import { expect, hook, hookWith, test } from "./offline";
import { LOAD_WAIT_MS, OPEN_LEVEL_MS, pageApi, waitMapIdle } from "./ui";
import { VERIFY_MS, verifyNative } from "./verify";

const MARAIS = "Paris — Le Marais";
const STARTER = "deck-civil_defence_issue";
const CARDS: Record<string, CardInfo & { rarity: string }> = Object.fromEntries((cards.cards as unknown as ({ id: string; rarity: string } & CardInfo)[]).map((c) => [c.id, c]));
const MAX_COPIES = cards.deck_rules.max_copies as Record<string, number>;

async function openApp(page: Page) {
  await page.goto("/?test=1");
  await page.waitForFunction(() => !!window.__zt?.profile?.ready, null, { timeout: LOAD_WAIT_MS });
}

/** Click a built-in level on the map screen and wait for wave 1's prep (or the setup's refusal). */
async function startPreset(page: Page) {
  await page.getByRole("button", { name: MARAIS }).click();
}

async function waitPrep(page: Page) {
  await expect.poll(() => hook(page, (h) => (h.phase === "prep" && h.profile.match ? h.hand.length : 0)), { timeout: LOAD_WAIT_MS }).toBe(5);
}

const state = (page: Page) => hook(page, async (h) => (await h.profile.settle(), h.profile.state()));

test("a new profile has the starter deck; an illegal deck is refused", async ({ page }) => {
  await openApp(page);
  const s = await state(page);
  expect(s.decks.map((d) => d.name)).toEqual(["Civil Defence Issue"]);
  expect(s.activeDeckId).toBe(STARTER);
  expect(s.cards).toHaveLength(20);
  expect(s.cards.every((c) => c.accountBound && c.stamp === null && !c.tradeable)).toBe(true);
  expect(s.tickets).toBe(0);
  expect(s.unlocked).toEqual(["recruit"]);
  expect(s.history).toBe(0);
  // Only unlocked tiers are offered.
  await expect(page.locator("#p-tier option")).toHaveText(["Recruit"]);
  await expect(page.locator("#p-deck option")).toHaveText(["Civil Defence Issue"]);
  await expect(page.locator("#p-tier-note")).toContainText("coming soon");

  // The collection: 20 account-bound starter cards.
  await page.locator("#p-open-collection").click();
  await expect(page.locator("#collection .coll-card")).toHaveCount(20);
  await expect(page.locator("#collection .coll-card .bound")).toHaveCount(20);
  await expect(page.locator("#collection .coll-card").first().locator(".stamp")).toContainText("Account-bound");

  // The deck builder: the starter deck is legal; a copy with a card removed
  // is not, and the profile refuses to save it.
  await page.locator('#profile-screen [data-screen="deck"]').click();
  await expect(page.locator("#db-errors")).toHaveText("Legal deck.");
  await expect(page.locator("#db-save")).toBeDisabled(); // the starter deck can't be changed
  await page.locator("#db-new").click();
  await page.locator("#deck-builder .db-entry .db-remove").first().click();
  await expect(page.locator("#db-count")).toHaveText("19 / 20 cards");
  await expect(page.locator("#db-errors")).toContainText("a deck has exactly 20 cards, this one has 19");
  await expect(page.locator("#db-use")).toBeDisabled();
  await page.locator("#db-saveas").click();
  await expect(page.locator("#db-status")).toContainText("Not saved: a deck has exactly 20 cards, this one has 19");
  expect((await state(page)).decks).toHaveLength(1);
  await page.locator("#ps-close").click();

  // A deck made illegal outside the builder (an imported profile) is
  // refused when a match starts: no match is built.
  await hook(page, async (h) => {
    const x = await h.profile.exportProfile();
    const starter = x.state.decks[0];
    x.state.decks.push({ id: "deck-bad", name: "Short deck", instanceIds: starter.instanceIds.slice(0, 19), updatedAt: starter.updatedAt });
    await h.profile.importProfile(x);
    await h.profile.refresh();
    h.profile.setDeck("deck-bad");
  });
  await startPreset(page);
  await expect(page.locator("#prep-msg")).toContainText('The deck "Short deck" is not legal: a deck has exactly 20 cards, this one has 19', { timeout: LOAD_WAIT_MS });
  await expect(page.locator("#prep-actions")).toBeVisible();
  expect(await hook(page, (h) => ({ phase: h.phase, match: h.profile.match }))).toEqual({ phase: "loading", match: null });
  await page.locator("#prep-back").click();
  expect((await state(page)).history).toBe(0);
});

test("abandoning after a won wave pays once; the history's record verifies headless", async ({ page }, info) => {
  test.setTimeout(OPEN_LEVEL_MS + 10 * 60_000 + VERIFY_MS);
  await openApp(page);
  await startPreset(page);
  await waitPrep(page);
  await waitMapIdle(page);
  const matchId = (await hook(page, (h) => h.profile.match!.matchId))!;
  // Win wave 1 with the test bot (bot.ts), retrying with another variant if lost.
  const api = pageApi(page, { deadline: Date.now() + 10 * 60_000 });
  for (let variant = 0; ; variant++) {
    expect(variant, "wave 1 lost three times").toBeLessThan(3);
    await playPrep(api, CARDS, variant, { a: 0.37 * variant });
    await keepTactical(api, 2);
    expect(await api.apply({ type: "start_wave" })).toBeNull();
    await api.runWave(async () => {
      const v = await api.view();
      const c = v.hand.find((h) => h.kind === "tactical" && h.playable && h.target === "point");
      const p = c && zombieHotspot(await api.zombies());
      if (c && p) await api.apply({ type: "play_card", hand_index: c.hand_index, target: { point: p } });
    });
    const st = await api.status();
    if (st.phase === "wave_won") break;
    expect(st.phase).toBe("wave_lost");
    expect(await api.apply({ type: "retry_wave" })).toBeNull();
  }
  // The daily events: first blood (a zombie was killed) and the wave victory.
  const during = await state(page);
  expect(during.tickets).toBe(2);
  expect(during.history).toBe(0);
  const saved = (await hook(page, (h) => h.results.filter((r) => r.won).pop()!.end_civilians))!;

  // ← Map abandons the match: one payout, shown on the map screen.
  await page.locator("#r-close").click();
  await page.locator("#back").click();
  await expect(page.locator("#payout")).toBeVisible();
  await expect(page.locator("#payout h3")).toHaveText("Match abandoned: resupply");
  const want = 1 + Math.min(4, Math.floor(saved / 4000)); // furthest wave 2, civilians saved
  await expect(page.locator("#payout .po-total")).toHaveText(`+${want} resupply ticket${want === 1 ? "" : "s"}`);
  let claims = await hook(page, async (h) => (await h.profile.settle(), h.profile.claims()));
  expect(claims).toEqual([{ matchId, reason: "abandoned", paid: true, total: want, noRetryBonus: 0, unlocked: [], cleared: false }]);
  const after = await state(page);
  expect(after.tickets).toBe(2 + want);
  expect(after.history).toBe(1);
  await expect(page.locator("#p-open-crates")).toHaveText(`Crates · ${2 + want} tickets`);

  // A second claim of the same match pays nothing.
  const again = await hookWith(page, (h, id) => h.profile.claimAgain(id), matchId);
  expect(again.paid).toBe(false);
  expect(again.payout.total).toBe(want);
  expect((await state(page)).tickets).toBe(2 + want);
  // A match left before anything happened is not claimed.
  await page.locator("#payout-close").click();
  await startPreset(page);
  await waitPrep(page);
  await page.locator("#back").click();
  claims = await hook(page, async (h) => (await h.profile.settle(), h.profile.claims()));
  expect(claims).toHaveLength(1);
  expect((await state(page)).history).toBe(1);

  // Match history: the match, and its run record verifies headless.
  await page.locator("#p-open-history").click();
  const item = page.locator(`#history .hist-item[data-match="${matchId}"]`);
  await expect(item).toContainText("Le Marais, Paris · Recruit");
  await expect(item).toContainText("Abandoned in wave 2");
  const [download] = await Promise.all([page.waitForEvent("download"), item.locator(".hist-dl").click()]);
  const path = info.outputPath("abandoned-run.json");
  await download.saveAs(path);
  const record = JSON.parse(readFileSync(path, "utf8"));
  expect(record.end.abandoned).toBe(true);
  const v = verifyNative(path);
  expect(v.phase).toBe("wave_won");
  expect(v.waves_won).toBe(1);
  console.log(`${info.project.name}: abandoned match paid ${want} ticket(s), record verified (${v.attempts} attempts, final ${v.final_hash})`);
});

test("a cleared match: tier unlock, coverage, crates with stamped cards, a custom deck in a match", async ({ page }) => {
  test.setTimeout(OPEN_LEVEL_MS * 3 + 60_000);
  await openApp(page);
  await page.locator("#p-home").check(); // this is my hometown
  await startPreset(page);
  await waitPrep(page);
  expect(await hook(page, (h) => h.profile.match)).toMatchObject({ tier: "recruit", deckId: STARTER, hometown: true, city: "Paris", district: "Le Marais", populationMultiplier: Math.fround(0.3) });
  // Some progress, then a fast-forwarded clear (same claim path as a real one).
  expect(await hook(page, (h) => h.startWave())).toBeNull();
  const ff = await hook(page, (h) => h.profile.fastForwardClear());
  expect(ff).toMatchObject({ paid: true, unlocked: ["veteran"] });
  expect(ff!.total).toBeGreaterThanOrEqual(8);
  await expect(page.locator("#payout")).toBeVisible();
  await expect(page.locator("#payout h3")).toHaveText("Match cleared: resupply");
  await expect(page.locator("#payout .po-unlock")).toHaveText("Unlocked: Veteran");
  await expect(page.locator("#payout .po-bonus")).toContainText("no-retry bonus: +2");
  // The hometown crate, once.
  await page.locator("#hometown-open").click();
  await expect(page.locator("#payout .crate-open .lore")).toBeVisible();
  await expect(page.locator("#payout .crate-open .coll-card")).toHaveCount(5);
  await page.locator("#payout-close").click();
  await page.locator("#back").click(); // already claimed: nothing more
  const s1 = await state(page);
  expect(s1.hometownCrateClaimed).toBe(true);
  expect(s1.unlocked).toEqual(["recruit", "veteran"]);
  expect(s1.cards).toHaveLength(25);
  expect(await hook(page, (h) => h.profile.claims().length)).toBe(1);
  await expect(page.locator("#p-tier option")).toHaveText(["Recruit", "Veteran"]);

  // Coverage of the cleared match, drawn on the map screen.
  await expect.poll(() => hook(page, (h) => h.profile.coverageDrawn)).toBe(0);
  await page.locator("#p-coverage").check();
  await expect.poll(() => hook(page, (h) => h.profile.coverageDrawn), { timeout: 15_000 }).toBeGreaterThan(0);
  expect(await hook(page, (h) => h.debug.map.getLayoutProperty("coverage-fill", "visibility"))).toBe("visible");

  // Open a crate: three new stamped cards, and no street anywhere.
  await page.locator("#p-open-crates").click();
  await expect(page.locator("#cr-tickets")).toHaveText(`${s1.tickets} resupply tickets`);
  await page.locator("#cr-open").click();
  await expect(page.locator("#cr-result .lore")).toBeVisible();
  await expect(page.locator("#cr-result .coll-card .stamp")).toHaveCount(3);
  await expect(page.locator("#cr-tickets")).toHaveText(`${s1.tickets - 1} resupply ticket${s1.tickets - 1 === 1 ? "" : "s"}`);
  const s2 = await state(page);
  expect(s2.cards).toHaveLength(28);
  const crateCards = s2.cards.filter((c) => c.stamp);
  expect(crateCards).toHaveLength(8);
  for (const c of crateCards) {
    // The wave is the ticket's: 8 for the payout and the hometown crate, the
    // event's wave for a daily ticket (first blood).
    expect(c.stamp).toMatchObject({ district: "Le Marais", city: "Paris", tier: "recruit" });
    expect(c.stamp!.wave).toBeGreaterThanOrEqual(1);
    expect(looksLikeAddress(c.stamp!.district) || looksLikeAddress(c.stamp!.city)).toBe(false);
    expect(c.tradeable && !c.accountBound).toBe(true);
  }
  const lore = await hook(page, async (h) => (await h.profile.exportProfile()).state.crates.map((c) => c.lore));
  expect(lore).toHaveLength(2);
  for (const l of lore) {
    expect(l).toContain("Le Marais");
    expect(looksLikeAddress(l), l).toBe(false);
  }
  const shown = await page.locator("#ps-body").innerText();
  expect(shown).not.toMatch(/\brue\b|\bstreet\b|\d{5}/i);

  // Build a deck with a crate card in the deck builder and use it.
  await page.locator('#profile-screen [data-screen="deck"]').click();
  const starterCounts = new Map<string, number>();
  for (const c of s2.cards.filter((x) => x.accountBound)) starterCounts.set(c.cardId, (starterCounts.get(c.cardId) ?? 0) + 1);
  // A crate card the starter deck has room for replaces another card; else
  // it replaces a starter copy of itself (Add prefers the stamped copy).
  const extra = crateCards.find((c) => (starterCounts.get(c.cardId) ?? 0) < MAX_COPIES[CARDS[c.cardId].rarity]) ?? crateCards[0];
  const room = (starterCounts.get(extra.cardId) ?? 0) < MAX_COPIES[CARDS[extra.cardId].rarity];
  const out = room ? [...starterCounts.keys()].find((id) => id !== extra.cardId)! : extra.cardId;
  await page.locator("#db-new").click();
  await page.locator(`#deck-builder .db-entry[data-card="${out}"] .db-remove`).click();
  await page.locator(`#deck-builder .db-card[data-card="${extra.cardId}"] .db-add`).click();
  await expect(page.locator("#db-count")).toHaveText("20 / 20 cards");
  await expect(page.locator("#db-errors")).toHaveText("Legal deck.");
  await page.locator("#db-name").fill("Recovered");
  await page.locator("#db-saveas").click();
  await expect(page.locator("#db-status")).toHaveText('Saved "Recovered".');
  await page.locator("#db-use").click();
  await expect(page.locator("#db-use")).toHaveText("Used for matches");
  await page.locator("#ps-close").click();
  const s3 = await state(page);
  const deck = s3.decks.find((d) => d.name === "Recovered")!;
  expect(s3.activeDeckId).toBe(deck.id);
  // A stamped copy of that card is in (Add picks the newest stamped copy).
  const stampedCopies = crateCards.filter((c) => c.cardId === extra.cardId).map((c) => c.instanceId);
  expect(deck.instanceIds.filter((i) => stampedCopies.includes(i))).toHaveLength(1);
  const byInstance = new Map(s3.cards.map((c) => [c.instanceId, c.cardId]));
  const deckCards = deck.instanceIds.map((i) => byInstance.get(i));

  // A Veteran match with that deck: the record's setup is the deck and the tier's multiplier.
  await page.locator("#p-tier").selectOption("veteran");
  await startPreset(page);
  await waitPrep(page);
  const m = (await hook(page, (h) => h.profile.match))!;
  expect(m).toMatchObject({ tier: "veteran", deckId: deck.id, deck: deckCards, populationMultiplier: Math.fround(0.3 * 1.25) });
  const record = JSON.parse(await hook(page, (h) => h.record()));
  expect(record.setup.deck).toEqual(deckCards);
  // The record writes the f32 in its shortest form ("0.375").
  expect(Math.fround(record.setup.population_multiplier)).toBe(Math.fround(0.3 * 1.25));
  // Clearing on Veteran unlocks Elite (not Nightmare).
  expect(await hook(page, (h) => h.startWave())).toBeNull();
  expect(await hook(page, (h) => h.profile.fastForwardClear())).toMatchObject({ paid: true, unlocked: ["elite"] });
  await page.locator("#back").click();
  await expect(page.locator("#p-tier option")).toHaveText(["Recruit", "Veteran", "Elite"]);
  await expect(page.locator("#p-tier")).toHaveValue("veteran");

  // Progress: tiers, and the city of the cleared matches, provisional (placeholder area).
  await page.locator("#p-open-progress").click();
  await expect(page.locator('#pr-tiers li[data-tier="elite"]')).toContainText("unlocked");
  await expect(page.locator('#pr-tiers li[data-tier="nightmare"]')).toContainText("locked");
  await expect(page.locator("#pr-cities .city-item")).toHaveCount(1);
  await expect(page.locator("#pr-cities .city-item")).toContainText("Paris");
  await expect(page.locator("#pr-cities .city-item .provisional")).toHaveText("provisional");
});

test("place names come from the geocoder's admin fields only", async ({ page, routeExternal }) => {
  const asked: string[] = [];
  await routeExternal(/^https:\/\/nominatim\.openstreetmap\.org\//, (route) => {
    const url = route.request().url();
    asked.push(url);
    const search = url.includes("/search?");
    const body = search
      ? [
          {
            lat: "48.8576",
            lon: "2.3590",
            display_name: "12, Rue des Rosiers, Le Marais, Paris 4e Arrondissement, Paris, Île-de-France, 75004, France",
            osm_type: "node",
            osm_id: 4242,
            addresstype: "building",
            address: { house_number: "12", road: "Rue des Rosiers", suburb: "Le Marais", city_district: "Paris 4e Arrondissement", city: "Paris", postcode: "75004", country: "France" },
          },
        ]
      : { display_name: "Gràcia, Barcelona, Catalunya, España", address: { suburb: "Gràcia", city: "Barcelona", postcode: "08012", country: "España" } };
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) });
  });
  await openApp(page);
  await page.locator("#search-q").fill("12 rue des Rosiers");
  await page.locator("#search-q").press("Enter");
  await expect.poll(() => hook(page, (h) => h.picked?.admin ?? null)).toEqual({ city: "Paris", district: "Le Marais" });
  expect(asked[0]).toContain("addressdetails=1");
  // A dropped pin: one reverse geocode at an admin zoom level.
  await waitMapIdle(page);
  const box = (await page.locator("#map canvas.maplibregl-canvas").boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.3);
  await expect.poll(() => hook(page, (h) => h.picked?.admin ?? null)).toEqual({ city: "Barcelona", district: "Gràcia" });
  expect(asked[1]).toMatch(/\/reverse\?.*zoom=14.*addressdetails=1/);
});
