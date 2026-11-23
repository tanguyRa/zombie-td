// The first session (T8), end to end and offline: a new profile searches a
// place (fixture Nominatim), marks it as hometown, starts the streamed match
// there (fixture Overpass blocks), plays all 8 waves to a clear (the test
// bot through the hook, plus one real card play through the UI), gets the
// payout, opens the Hometown crate, then opens that match's replay from the
// match history with its map bundle and lets it run to the end at max speed
// with every hash check green. The record and the bundle also verify
// headless (`sim-headless verify --chunks`).
//
// The map: a village, the Marais buildings within 150 m of its centre and
// nothing else (`villageLevel`), served per block by the fixture Overpass of
// stream.spec.ts. On the whole Marais the test bot can't clear 8 streamed
// waves (the dense rings 2–3 are lost on most seeds, and by wave 8 too few
// civilians are left for its outbreak); on the village every civilian and
// every garrison is in wave 1's ring and the outer rings' outbreaks have to
// come to them. The 1.3 km grid, the 109 blocks and the streaming are the
// same as for any picked place.
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import cardsJson from "../../cards.json" with { type: "json" };
import { loadLevel, villageLevel, waysFromLevel } from "../test/unit/fixtures";
import { pickTowers, playPrep, type CardInfo } from "./bot";
import { expect, hook, hookWith, test } from "./offline";
import { fixtureOverpass, verifyChunks } from "./streamfixture";
import { LOAD_WAIT_MS, pageApi } from "./ui";

const level = loadLevel("paris-marais");
const VILLAGE = villageLevel(level, 150);
const WAYS = waysFromLevel(VILLAGE);
/** The match seed (the default): the bot clears the 8 waves of the village
 *  on it at the first try (the same plays under Node: 5,106 ticks). */
const SEED = 1;
const CARDS: Record<string, CardInfo> = Object.fromEntries((cardsJson as unknown as { cards: ({ id: string } & CardInfo)[] }).cards.map((c) => [c.id, c]));
const CORS = { "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin" };
/** One wave on the 1.3 km grid: seconds in Chromium and WebKit, minutes in
 *  Firefox when three browsers share the CPU. */
const WAVE_MS = 12 * 60_000;

async function runWave(page: Page) {
  await hook(page, (h) => {
    h.pauseAt(null);
    h.speed(0);
    h.pause(false);
  });
  await expect.poll(() => hook(page, (h) => h.phase), { timeout: WAVE_MS, intervals: [100, 250, 500] }).not.toBe("running");
}

const state = (page: Page) => hook(page, async (h) => (await h.profile.settle(), h.profile.state()));

test("first session: new profile, hometown search, a streamed 8-wave clear, payout, Hometown crate, replay from history, headless verify", async ({ page, routeExternal }, info) => {
  test.setTimeout(60 * 60_000);
  const say = (s: string) => console.log(`${info.project.name}: ${s}`);
  const t0 = Date.now();
  const lap = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;

  // ---- 1. a new profile
  await page.goto("/?test=1");
  await page.waitForFunction(() => !!window.__zt?.profile?.ready, null, { timeout: LOAD_WAIT_MS });
  const s0 = await state(page);
  expect(s0).toMatchObject({ tickets: 0, history: 0, unlocked: ["recruit"], hometownCrateClaimed: false });
  expect(s0.cards).toHaveLength(20);

  // ---- 2. search a place (fixture Nominatim), pick it, mark it as hometown
  await routeExternal(/^https:\/\/nominatim\.openstreetmap\.org\//, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: CORS,
      body: JSON.stringify([
        {
          lat: String(level.center_lat),
          lon: String(level.center_lon),
          display_name: "Le Marais, Paris 4e Arrondissement, Paris, Île-de-France, France",
          osm_type: "relation",
          osm_id: 2192616,
          addresstype: "suburb",
          address: { suburb: "Le Marais", city_district: "Paris 4e Arrondissement", city: "Paris", country: "France" },
        },
      ]),
    }),
  );
  const ov = fixtureOverpass(WAYS);
  await ov.install(routeExternal);
  await page.locator("#search-q").fill("Le Marais, Paris");
  await page.locator("#search-q").press("Enter");
  await expect.poll(() => hook(page, (h) => h.picked?.admin ?? null)).toMatchObject({ city: "Paris", district: "Le Marais" });
  await page.locator("#p-home").check();

  // ---- 3. the streamed match on the fixture blocks
  await page.locator("#go").click();
  await expect.poll(() => hook(page, (h) => (h.phase === "prep" && h.profile.match ? h.hand.length : 0)), { timeout: LOAD_WAIT_MS }).toBe(5);
  expect(await hook(page, (h) => h.map !== null)).toBe(true);
  expect(await hook(page, (h) => h.profile.match)).toMatchObject({ hometown: true, tier: "recruit", city: "Paris", district: "Le Marais" });
  expect(await page.locator("#seed").inputValue()).toBe(String(SEED));
  say(`prep 1 after ${lap()}, ${(await hook(page, (h) => h.map!)).stats.fetched} blocks fetched`);

  // ---- 4. 8 waves: one real UI card play (wave 1's first armament, on the
  // buildings the bot would pick), the bot for the rest.
  const api = pageApi(page);
  let uiPlays = 0;
  let lost = 0;
  const waveTimes: string[] = [];
  for (let wave = 1; wave <= 8; wave++) {
    const tw = Date.now();
    let won = false;
    for (let attempt = 0; attempt < 5 && !won; attempt++) {
      expect(await hook(page, (h) => [h.wave, h.phase])).toEqual([wave, "prep"]);
      if (wave === 1 && attempt === 0) {
        const v = await api.view();
        const arm = v.hand.find((h) => h.kind === "armament" && h.playable)!;
        expect(arm, "wave 1's hand has an armament").toBeTruthy();
        const targets = pickTowers(v, 0, CARDS[arm.card].effect.buildings!);
        expect(await api.ui!.playArmament!(arm.hand_index, targets)).toBeNull();
        expect((await hook(page, (h) => h.structures)).some((s) => s.card === arm.card)).toBe(true);
        uiPlays++;
      }
      await playPrep(api, CARDS, attempt, { a: 0 });
      expect(await api.apply({ type: "start_wave" })).toBeNull();
      await runWave(page);
      const p = await hook(page, (h) => h.phase);
      if (p === "wave_won" || p === "match_won") won = true;
      else {
        expect(p).toBe("wave_lost");
        lost++;
        await page.locator("#r-retry").click();
        await expect.poll(() => hook(page, (h) => h.phase)).toBe("prep");
      }
    }
    expect(won, `wave ${wave} won within 5 attempts`).toBe(true);
    waveTimes.push(`${((Date.now() - tw) / 1000).toFixed(0)}s`);
    if (wave < 8) {
      await expect(page.locator("#r-next")).toBeVisible();
      await page.locator("#r-next").click();
      await expect.poll(() => hook(page, (h) => [h.wave, h.phase]), { timeout: LOAD_WAIT_MS }).toEqual([wave + 1, "prep"]);
    }
  }
  expect(uiPlays).toBe(1);
  expect(await hook(page, (h) => h.result)).toBe("match_won");
  expect(await hook(page, (h) => h.map!.refused)).toEqual([]);
  const attempts = await hook(page, (h) => h.attempts);
  const finalHash = (await hook(page, (h) => h.stateHash())).hash;
  say(`8 waves cleared after ${lap()} (per wave ${waveTimes.join(", ")}; ${lost} lost attempts, ${attempts.length} attempts, tick ${await hook(page, (h) => h.tick)})`);

  // ---- 5. the payout, once
  await expect.poll(() => hook(page, (h) => h.profile.claims().length), { timeout: 30_000 }).toBe(1);
  const [claim] = await hook(page, (h) => h.profile.claims());
  const matchId = (await hook(page, (h) => h.profile.match!.matchId))!;
  expect(claim).toMatchObject({ matchId, reason: "cleared", paid: true, cleared: true, unlocked: ["veteran"] });
  expect(claim.total).toBeGreaterThanOrEqual(8);
  expect(claim.noRetryBonus > 0).toBe(lost === 0);
  await expect(page.locator("#result .po-unlock")).toHaveText("Unlocked: Veteran");
  const s1 = await state(page);
  expect(s1.tickets).toBeGreaterThanOrEqual(claim.total);
  expect(s1.history).toBe(1);

  // ---- 6. the Hometown crate
  await page.locator("#hometown-open").click();
  await expect(page.locator(".crate-open .coll-card")).toHaveCount(5);
  await expect(page.locator(".crate-open .lore")).toBeVisible();
  const s2 = await state(page);
  expect(s2.hometownCrateClaimed).toBe(true);
  expect(s2.cards).toHaveLength(25);
  const stamped = s2.cards.filter((c) => c.stamp);
  expect(stamped).toHaveLength(5);
  for (const c of stamped) expect(c.stamp).toMatchObject({ city: "Paris", district: "Le Marais", wave: 8 });

  // The run record and the map bundle, from the match panel.
  const dir = info.outputPath();
  const save = async (button: string, name: string) => {
    const dl = page.waitForEvent("download");
    await page.locator(button).click();
    const path = `${dir}/${name}`;
    await (await dl).saveAs(path);
    return path;
  };
  const runPath = await save("#r-download", "run.json");
  const mapPath = await save("#r-download-map", "map.json");
  const record = JSON.parse(readFileSync(runPath, "utf8")) as { map: { source: string; blocks: number[] }; end: { hash: string; phase: string }; attempts: { end_hash: string }[] };
  expect(record.map.source).toBe("chunks");
  expect(record.end).toMatchObject({ phase: "match_won", hash: finalHash });
  const stored = await hookWith(page, (h, id) => h.profile.getMatch(id), matchId);
  expect(JSON.stringify(stored!.runRecord)).toBe(JSON.stringify(record));

  // ---- 7. the replay from the match history, with its map bundle. The
  // block cache is emptied first, so the viewer can't take the blocks from
  // it: it asks for the bundle, which is then given.
  await page.locator("#r-map").click();
  expect(await hook(page, (h) => h.screen)).toBe("explore");
  await hook(page, (h) => h.clearMapCache());
  await page.locator("#p-open-history").click();
  const item = page.locator(`#history .hist-item[data-match="${matchId}"]`);
  await expect(item).toContainText("Le Marais, Paris");
  await item.locator(".hist-replay").click();
  await expect(page.locator("#replay-picker")).toBeVisible();
  await expect(page.locator("#rp-msg")).toContainText(`streamed map (${record.map.blocks.length} blocks)`);
  await page.locator("#rp-files").setInputFiles(mapPath);
  await expect.poll(() => hook(page, (h) => h.screen)).toBe("game");
  expect(await hook(page, (h) => h.replay.mapFrom)).toBe("map bundle");
  const tr = Date.now();
  await page.locator("#rv-speed-0").click();
  await expect.poll(() => hook(page, (h) => h.replay.done), { timeout: 30 * 60_000, intervals: [250, 500, 1000] }).toBe(true);
  const r = await hook(page, (h) => h.replay);
  expect(r.error).toBeNull();
  expect(r.summary).toMatchObject({ final_hash: record.end.hash, waves_won: 8, map_source: "chunks" });
  expect(r.rows).toHaveLength(record.attempts.length);
  for (const row of r.rows) expect(row, `attempt ${row.attempt + 1}`).toMatchObject({ prep: "ok", end: "ok" });
  expect(r.final).toBe("ok");
  await expect(page.locator(".rv-dot.ok")).toHaveCount(2 * record.attempts.length + 1);
  await expect(page.locator(".rv-dot.bad")).toHaveCount(0);
  say(`replay of ${r.endTick} ticks at max speed: ${((Date.now() - tr) / 1000).toFixed(0)} s, all ${r.checks.length} checks green`);
  // The replay touched nothing in the profile.
  await page.locator("#back").click();
  const s3 = await state(page);
  expect(s3).toEqual(s2);
  expect(await hook(page, (h) => h.profile.claims().length)).toBe(1);

  // ---- 8. the record verifies headless too, with the browser's hashes
  const v = verifyChunks(runPath, mapPath);
  expect(v.phase).toBe("match_won");
  expect(v.attempt_hashes).toEqual(attempts.map((a) => a.end_hash));
  expect(v.final_hash).toBe(record.end.hash);
  say(`first session done in ${lap()}`);
});
