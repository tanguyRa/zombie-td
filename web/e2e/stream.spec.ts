// Streaming maps (T6b): a picked place loads its blocks from Overpass (routed
// to fixture responses built from the committed Marais level, per block)
// into the IndexedDB block cache. Waves 1–2 first, the rest in the
// background; a slow block holds Next wave on "Loading the next district…";
// when it then fails, the error and Retry loading stay up while other rings
// keep arriving, and Retry loading recovers; retry and restart never
// re-fetch; a second visit is served from the cache; and the run record plus
// the map bundle verify headless in chunks mode with the browser's hashes.
import { writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import cardsJson from "../../cards.json" with { type: "json" };
import { blocksForDisc } from "../src/map/blocks";
import { loadConfig, loadLevel } from "../test/unit/fixtures";
import { playPrep, type CardInfo } from "./bot";
import { expect, hook, test } from "./offline";
import { fixtureOverpass, verifyChunks } from "./streamfixture";
import { LOAD_WAIT_MS, pageApi } from "./ui";

const cfg = loadConfig();
const level = loadLevel("paris-marais");
const PLACE = { lat: level.center_lat, lon: level.center_lon, name: "Marais (fixture)" };
/** The loader's disc for wave w: ring radius + block margin + one cell diagonal. */
const disc = (w: number) => cfg.match.ring_radius_m[w - 1] + cfg.match.block_margin_m + cfg.cell_size_m * Math.SQRT2;
/** Waves 1–2's blocks, computed here from the block grid alone. */
const FIRST = new Set(blocksForDisc(PLACE.lat, PLACE.lon, disc(2)));
const CARDS: Record<string, CardInfo> = Object.fromEntries((cardsJson as unknown as { cards: ({ id: string } & CardInfo)[] }).cards.map((c) => [c.id, c]));
/** One wave on the 1.3 km grid: seconds in Chromium and WebKit, minutes in
 *  Firefox when three browsers share the CPU. */
const WAVE_MS = 12 * 60_000;
/** The match seed: the default (1), on which the bot wins waves 1 and 2 of
 *  the fixture on the first try (seeds 2–8 lose one of them). */
const SEED = 1;

/** The map screen with the pin on the fixture place (the last place, as
 *  "Start here" saves it), then "Start here": wave 1's prep. */
async function openPicked(page: Page, opts: { reload?: boolean } = {}) {
  if (!opts.reload) {
    await page.goto("/?test=1");
    await page.evaluate((p) => localStorage.setItem("ztd.lastPlace", JSON.stringify(p)), PLACE);
  }
  await page.goto("/?test=1");
  await page.waitForFunction(() => !!window.__zt);
  await expect(page.locator("#pick-name")).toHaveText(PLACE.name);
  await page.locator("#go").click();
  await expect.poll(() => hook(page, (h) => h.phase), { timeout: LOAD_WAIT_MS }).toBe("prep");
}

/** Play the current wave with the bot until it is won (retrying a lost
 *  one); the number of lost attempts. */
async function winWave(page: Page): Promise<number> {
  const api = pageApi(page);
  for (let attempt = 0; attempt < 5; attempt++) {
    expect(await hook(page, (h) => h.phase)).toBe("prep");
    await playPrep(api, CARDS, attempt, { a: 0 });
    expect(await api.apply({ type: "start_wave" })).toBeNull();
    await runWave(page);
    const p = await hook(page, (h) => h.phase);
    if (p === "wave_won" || p === "match_won") return attempt;
    expect(p).toBe("wave_lost");
    expect(await api.apply({ type: "retry_wave" })).toBeNull();
  }
  throw new Error("the bot could not win the wave");
}

async function runWave(page: Page) {
  await hook(page, (h) => {
    h.pauseAt(null);
    h.speed(0);
    h.pause(false);
  });
  await expect.poll(() => hook(page, (h) => h.phase), { timeout: WAVE_MS, intervals: [100, 250, 500] }).not.toBe("running");
}

const mapInfo = (page: Page) => hook(page, (h) => h.map!);

test("a picked place streams its map: first blocks, background rings, a slow then failing block, Retry loading, no re-fetch, headless verify, cached revisit", async ({ page, routeExternal }, info) => {
  // Alone: about 1 min in Chromium and WebKit, Firefox's WASM about 3x
  // that; with the whole suite on three workers, up to ~3x more.
  test.setTimeout(30 * 60_000);
  const say = (s: string) => console.log(`${info.project.name}: ${s}`);
  const ov = fixtureOverpass();
  await ov.install(routeExternal);
  // Every background query waits until the first load is checked; the
  // batch of one wave-3 block stays slow until the test lets it through,
  // and so does the batch of the last wave-8 block (to arrive after the
  // slow one has failed).
  const background = ov.hold((b) => b.some((id) => !FIRST.has(id)));
  let slowBlock = -1;
  let lateBlock = -1;
  const slow = ov.hold((b) => b.includes(slowBlock));
  const late = ov.hold((b) => b.includes(lateBlock));

  const t0 = Date.now();
  await openPicked(page);
  const firstMs = Date.now() - t0;
  const m0 = await mapInfo(page);
  slowBlock = m0.waveBlocks[2][m0.waveBlocks[2].length - 1];
  lateBlock = m0.waveBlocks[7][m0.waveBlocks[7].length - 1];
  // The first load asked for exactly waves 1–2's blocks (the background
  // queries are all held, so prep could not wait for any of them).
  expect(new Set([...m0.waveBlocks[0], ...m0.waveBlocks[1]])).toEqual(FIRST);
  const firstCalls = ov.calls.filter((c) => c.status === 200);
  expect(new Set(firstCalls.flatMap((c) => c.blocks))).toEqual(FIRST);
  for (const c of ov.calls) expect(c.blocks.every((id) => FIRST.has(id)) || c.blocks.every((id) => !FIRST.has(id))).toBe(true);
  expect(m0.ready.slice(0, 2)).toEqual([true, true]);
  expect(m0.ready[2]).toBe(false);
  expect(m0.stats).toMatchObject({ cacheHits: 0, fetched: FIRST.size });
  await expect.poll(async () => (await mapInfo(page)).worker.stored).toBe(FIRST.size);
  const total = m0.waveBlocks.flat().length;
  say(`first load: ${FIRST.size} blocks in ${firstCalls.length} queries, ${firstMs} ms to prep (${m0.firstLoadMs.toFixed(0)} ms loading); ${total} blocks in all`);
  const lvl = await hook(page, (h) => h.level!);
  expect(lvl.rings).toEqual(cfg.match.ring_radius_m);
  expect(lvl.buildings).toBeGreaterThan(100);
  expect(await page.locator("#seed").inputValue()).toBe(String(SEED));

  // Background blocks arriving mid-wave wait in the worker for the wave's end.
  const api = pageApi(page);
  await playPrep(api, CARDS, 0, { a: 0 });
  await hook(page, (h) => h.startPaused());
  expect(await hook(page, (h) => h.startWave())).toBeNull();
  await expect.poll(() => hook(page, (h) => h.perf?.paused && h.phase === "running")).toBe(true);
  background.release();
  // Every block but the slow and the late batches arrives, closest ring first.
  await expect.poll(async () => (await mapInfo(page)).stats.fetched, { timeout: 60_000 }).toBeGreaterThan(total - 13);
  const mid = await mapInfo(page);
  expect(mid.ready[2]).toBe(false); // the slow block is in ring 3
  expect(mid.ready[7]).toBe(false); // and the late one in ring 8
  expect(mid.worker.queued).toBeGreaterThan(0);
  expect(mid.worker.stored).toBe(FIRST.size);
  await runWave(page);
  expect(await hook(page, (h) => h.phase)).toBe("wave_won");
  await expect.poll(async () => (await mapInfo(page)).worker.queued).toBe(0);
  expect((await mapInfo(page)).worker.stored).toBe((await mapInfo(page)).stats.fetched);
  say("wave 1 won; background blocks added after it");

  // Wave 2: its ring came with the first load, no banner.
  await page.locator("#r-next").click();
  await expect.poll(() => hook(page, (h) => `${h.phase} ${h.wave}`)).toBe("prep 2");
  expect((await hook(page, (h) => h.district)).visible).toBe(false);
  const wave2Buildings = (await hook(page, (h) => h.level!)).buildings;
  expect(await winWave(page)).toBe(0);
  expect(await hook(page, (h) => h.phase)).toBe("wave_won");

  // Wave 3's ring waits for the slow block: Next wave shows the banner.
  expect((await mapInfo(page)).ready[2]).toBe(false);
  await page.locator("#r-next").click();
  await expect(page.locator("#district")).toBeVisible();
  await expect(page.locator("#district")).toHaveAttribute("data-state", "loading");
  await expect(page.locator("#d-msg")).toHaveText(/^Loading the next district… \d+ \/ \d+ blocks$/);
  await expect(page.locator("#d-retry")).toBeHidden();
  await expect(page.locator("#r-next")).toBeDisabled();
  await expect(page.locator("#start")).toBeDisabled();
  expect((await mapInfo(page)).district).toBe(3);
  await page.waitForTimeout(500);
  expect(await hook(page, (h) => `${h.phase} ${h.wave}`)).toBe("wave_won 2");

  // The slow batch now fails (504, every attempt, both endpoints): the
  // banner turns into the error with Retry loading.
  ov.setFail((b) => b.includes(slowBlock));
  slow.release();
  await expect(page.locator("#district")).toHaveAttribute("data-state", "failed", { timeout: 30_000 });
  const failedText = /^Could not load the next district\. map ring 3 can't be loaded: \d+ blocks? failed \(Overpass is busy \(504\)\. Try again in a minute\.\)$/;
  await expect(page.locator("#d-msg")).toHaveText(failedText);
  await expect(page.locator("#d-retry")).toBeVisible();
  // A later ring's batch arriving after the failure keeps the error and
  // Retry loading up (it used to turn the banner back to "Loading…").
  const fetchedAtFailure = (await mapInfo(page)).stats.fetched;
  late.release();
  await expect.poll(async () => (await mapInfo(page)).stats.fetched).toBeGreaterThan(fetchedAtFailure);
  await expect.poll(async () => (await mapInfo(page)).worker.stored).toBe((await mapInfo(page)).stats.fetched);
  expect((await mapInfo(page)).ready[7]).toBe(false); // ring 8 needs ring 3's blocks too
  await expect(page.locator("#district")).toHaveAttribute("data-state", "failed");
  await expect(page.locator("#d-msg")).toHaveText(failedText);
  await expect(page.locator("#d-retry")).toBeVisible();
  expect(await hook(page, (h) => `${h.phase} ${h.wave}`)).toBe("wave_won 2");
  const failedCalls = ov.calls.length;
  const failures = ov.calls.filter((c) => c.status === 504).length;
  expect(failures).toBeGreaterThan(0);

  // Fixed server: Retry loading opens wave 3.
  ov.setFail(null);
  const g0 = Date.now();
  await page.locator("#d-retry").click();
  await expect.poll(() => hook(page, (h) => `${h.phase} ${h.wave}`)).toBe("prep 3");
  say(`${failures} failed queries; wave 3 opened ${Date.now() - g0} ms after Retry loading`);
  await expect(page.locator("#district")).toBeHidden();
  expect(ov.calls.length).toBeGreaterThan(failedCalls);
  expect(ov.calls.slice(failedCalls).every((c) => c.status === 200)).toBe(true);
  const m3 = await mapInfo(page);
  expect(m3.ready.every(Boolean)).toBe(true);
  expect(m3.stats.fetched).toBe(total);
  expect(m3.worker).toEqual({ stored: total, queued: 0 });
  // Wave 3 is the first that reveals streamed blocks.
  await expect.poll(async () => (await hook(page, (h) => h.level!)).buildings).toBeGreaterThan(wave2Buildings);

  // Retry and restart never re-fetch (the match keeps its chunks).
  const calls = ov.calls.length;
  expect(await hook(page, (h) => h.retryWave())).toBeNull();
  await expect.poll(() => hook(page, (h) => `${h.phase} ${h.wave}`)).toBe("prep 3");
  await page.locator("#restart").click();
  await expect.poll(() => hook(page, (h) => `${h.phase} ${h.wave} ${h.status!.restarts}`)).toBe("prep 1 1");
  expect(ov.calls.length).toBe(calls);
  expect((await mapInfo(page)).stats).toEqual(m3.stats);
  expect((await mapInfo(page)).refused).toEqual([]);
  // The record plus the map bundle verify headless in chunks mode.
  const record = await hook(page, (h) => h.record());
  const bundle = await hook(page, (h) => h.mapBundle());
  const rec = JSON.parse(record);
  const map = JSON.parse(bundle);
  expect(rec.map.source).toBe("chunks");
  expect(map.chunks.map((c: { block_id: number }) => c.block_id)).toEqual(rec.map.blocks);
  expect(rec.map.blocks).toHaveLength(total);
  expect({ lat: map.center_lat, lon: map.center_lon, r: map.radius_m, b: map.buildings, f: map.fences }).toEqual({ lat: PLACE.lat, lon: PLACE.lon, r: cfg.wave8_radius_m, b: [], f: [] });
  const runPath = info.outputPath("run.json");
  const mapPath = info.outputPath("map.json");
  writeFileSync(runPath, record);
  writeFileSync(mapPath, bundle);
  const attempts = await hook(page, (h) => h.attempts);
  const summary = verifyChunks(runPath, mapPath);
  expect(summary.map_source).toBe("chunks");
  expect(summary.snapshot_hash).toBe(rec.map.snapshot_hash);
  expect(summary.attempt_hashes).toEqual(attempts.map((a) => a.end_hash));
  // Waves 1–2 (won on the first try), then wave 3's prep ended by Retry
  // wave, then by Restart.
  expect(summary.attempt_hashes.length).toBe(4);
  const { hash } = await hook(page, (h) => h.stateHash());
  expect(summary.final_hash).toBe(hash);
  say(`verified headless: ${attempts.length} attempts, snapshot ${rec.map.snapshot_hash}, final hash ${hash}`);

  // Leaving aborts the loader; a second visit (after a reload: the
  // IndexedDB cache) makes no request at all.
  if (await page.locator("#result").isVisible()) await page.locator("#r-close").click();
  await page.locator("#back").click();
  await expect.poll(() => hook(page, (h) => h.screen)).toBe("explore");
  expect(await hook(page, (h) => h.map)).toBeNull();
  const before = ov.calls.length;
  const t1 = Date.now();
  await openPicked(page, { reload: true });
  const m2 = await mapInfo(page);
  expect(m2.ready.every(Boolean)).toBe(true);
  await expect.poll(async () => (await mapInfo(page)).stats.cacheHits).toBe(total);
  expect((await mapInfo(page)).stats).toEqual({ queries: 0, cacheHits: total, fetched: 0 });
  expect(ov.calls.length).toBe(before);
  say(`second visit from the cache: prep in ${Date.now() - t1} ms, 0 requests`);
});
