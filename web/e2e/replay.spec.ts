// The replay viewer (T8): a run record played back in the game view by the
// worker (sim-core's `Replayer`), with the per-attempt hash checks shown as
// they happen. A built-in level run replays offline from a picked file;
// jump to a wave, step, max speed; a tampered record names the attempt and
// what diverged; a streamed run without its map asks for the bundle, then
// replays on it. The viewer is read-only: actions are refused and the
// profile is never written.
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { initSync, WasmMatch } from "../src/wasm/pkg/sim_wasm.js";
import { REPO } from "../test/unit/fixtures";
import { expect, hook, test } from "./offline";
import { LOAD_WAIT_MS } from "./ui";

const GOLDEN_PATH = `${REPO}crates/sim-core/tests/fixtures/run_record_golden.json`;
const GOLDEN = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as {
  attempts: { wave: number; start_tick: number; end_hash: string; result: string }[];
  end: { tick: number; hash: string };
  actions: unknown[];
};
/** Replaying the golden record at max speed (17,577 ticks on the Marais):
 *  seconds in Chromium and WebKit, longer in Firefox under load. */
const REPLAY_MS = 5 * 60_000;

async function openApp(page: Page) {
  await page.goto("/?test=1");
  await page.waitForFunction(() => !!window.__zt?.profile?.ready, null, { timeout: LOAD_WAIT_MS });
}

const replay = (page: Page) => hook(page, (h) => h.replay);
const profileState = (page: Page) => hook(page, async (h) => (await h.profile.settle(), { state: await h.profile.state(), claims: h.profile.claims() }));

/** Pick files in the "Open a replay" picker. */
async function pick(page: Page, files: { name: string; text: string }[]) {
  if (await page.locator("#replay-picker").isHidden()) await page.locator("#open-replay").click();
  await page.locator("#rp-files").setInputFiles(files.map((f) => ({ name: f.name, mimeType: "application/json", buffer: Buffer.from(f.text) })));
}

async function runToEnd(page: Page) {
  await page.locator("#rv-speed-0").click();
  if ((await replay(page)).paused) await page.locator("#rv-pause").click();
  await expect.poll(async () => (await replay(page)).done, { timeout: REPLAY_MS, intervals: [100, 250, 500] }).toBe(true);
}

test("a built-in level run replays offline: jump, step, max speed, every check green, read-only", async ({ page }, info) => {
  test.setTimeout(REPLAY_MS + 2 * LOAD_WAIT_MS);
  await openApp(page);
  const before = await profileState(page);
  await pick(page, [{ name: "run.json", text: readFileSync(GOLDEN_PATH, "utf8") }]);
  await expect.poll(() => hook(page, (h) => h.screen)).toBe("game");
  await expect.poll(async () => (await replay(page)).checks.length, { timeout: LOAD_WAIT_MS }).toBeGreaterThan(0);
  const r0 = await replay(page);
  expect(r0).toMatchObject({ active: true, title: "Paris — Le Marais", mapFrom: "built-in level", endTick: GOLDEN.end.tick, actions: GOLDEN.actions.length });
  // The opening check: attempt 1's prep.
  expect(r0.checks[0]).toMatchObject({ attempt: 0, what: "prep" });
  await expect(page.locator("#replay-panel")).toBeVisible();
  await expect(page.locator("#tools")).toBeHidden();
  // Read-only: an action from the page is refused.
  expect(await hook(page, (h) => h.act({ type: "start_wave" }))).toMatchObject({ error: "read_only" });

  // Jump to wave 3: paused at the start of its first prep.
  await page.locator("#rv-wave").selectOption("3");
  await page.locator("#rv-jump").click();
  await expect.poll(async () => (await replay(page)).jumping === null && (await hook(page, (h) => [h.wave, h.phase, h.perf?.paused]))[0] === 3, { timeout: REPLAY_MS }).toBe(true);
  expect(await hook(page, (h) => [h.phase, h.perf?.paused])).toEqual(["prep", true]);
  let r = await replay(page);
  const firstWave3 = GOLDEN.attempts.findIndex((a) => a.wave === 3);
  for (let i = 0; i < firstWave3; i++) expect(r.rows[i], `attempt ${i + 1}`).toMatchObject({ prep: "ok", end: "ok" });
  expect(r.rows[firstWave3]).toMatchObject({ prep: "ok", end: "pending" });
  // Step: one tick (with the prep's actions due before it), still paused.
  const t0 = r.tick;
  await page.locator("#rv-step").click();
  await expect.poll(async () => (await replay(page)).tick).toBe(t0 + 1);
  expect((await replay(page)).paused).toBe(true);
  // Back in time: jump to wave 2 rebuilds the match from the record.
  await page.locator("#rv-wave").selectOption("2");
  await page.locator("#rv-jump").click();
  await expect.poll(async () => (await replay(page)).jumping === null && (await hook(page, (h) => h.wave)) === 2, { timeout: REPLAY_MS }).toBe(true);

  // Max speed to the end: every attempt's prep and end, and the end, green.
  const t = Date.now();
  await runToEnd(page);
  r = await replay(page);
  console.log(`${info.project.name}: replayed ${r.endTick} ticks to the end in ${((Date.now() - t) / 1000).toFixed(1)} s`);
  expect(r.error).toBeNull();
  expect(r.summary).toMatchObject({ final_hash: GOLDEN.end.hash, waves_won: 8 });
  expect(r.rows).toHaveLength(GOLDEN.attempts.length);
  for (const row of r.rows) expect(row, `attempt ${row.attempt + 1}`).toMatchObject({ prep: "ok", end: "ok" });
  expect(r.final).toBe("ok");
  await expect(page.locator("#rv-verdict")).toHaveText(/^Verified: every hash matches the record/);
  await expect(page.locator(".rv-dot.bad")).toHaveCount(0);
  // No result panel, no payout, and the profile is exactly as before.
  await expect(page.locator("#result")).toBeHidden();
  await page.locator("#back").click();
  expect(await profileState(page)).toEqual(before);
});

/** Play at Max until the replay is past `tick`. */
async function maxPast(page: Page, tick: number) {
  await page.locator("#rv-speed-0").click();
  if ((await replay(page)).paused) await page.locator("#rv-pause").click();
  await expect.poll(async () => (await replay(page)).tick, { timeout: REPLAY_MS, intervals: [50, 100, 250] }).toBeGreaterThan(tick);
}

/** Jump to wave `w` from the panel and wait until the jump is over. */
async function jump(page: Page, w: number) {
  await page.locator("#rv-wave").selectOption(String(w));
  await page.locator("#rv-jump").click();
  await expect.poll(async () => {
    const r = await replay(page);
    return r.jumping === null && r.paused && (await hook(page, (h) => h.wave)) === w;
  }, { timeout: REPLAY_MS }).toBe(true);
}

test("a jump at Max lands on its wave: back to wave 1 at tick 0, forward and back to a wave's prep", async ({ page }) => {
  test.setTimeout(REPLAY_MS + 2 * LOAD_WAIT_MS);
  await openApp(page);
  await pick(page, [{ name: "run.json", text: readFileSync(GOLDEN_PATH, "utf8") }]);
  await expect.poll(async () => (await replay(page)).checks.length, { timeout: LOAD_WAIT_MS }).toBeGreaterThan(0);
  const firstOf = (w: number) => GOLDEN.attempts.find((a) => a.wave === w)!.start_tick;
  // Running at Max, then back to wave 1: the very start, nothing replayed.
  await maxPast(page, 3000);
  await jump(page, 1);
  // Held there (a slice at Max right after the rebuild would move it on).
  await page.waitForTimeout(500);
  expect(await replay(page)).toMatchObject({ tick: 0, nextAction: 0, paused: true, jumping: null, speed: 0 });
  expect(await hook(page, (h) => [h.wave, h.phase, h.perf?.paused])).toEqual([1, "prep", true]);
  // Forward to wave 3, at Max on past it, then back to wave 2: each stops at
  // the start of that wave's first prep.
  await jump(page, 3);
  expect((await replay(page)).tick).toBe(firstOf(3));
  await maxPast(page, firstOf(3) + 500);
  await jump(page, 2);
  await page.waitForTimeout(500);
  expect(await replay(page)).toMatchObject({ tick: firstOf(2), paused: true, jumping: null, speed: 0 });
  expect(await hook(page, (h) => [h.wave, h.phase, h.perf?.paused])).toEqual([2, "prep", true]);
});

test("a replay's Max speed doesn't carry into a played match", async ({ page }) => {
  test.setTimeout(REPLAY_MS + 4 * LOAD_WAIT_MS);
  await openApp(page);
  // A played match at 2x.
  await page.getByRole("button", { name: "Paris — Le Marais" }).click();
  await expect.poll(() => hook(page, (h) => h.phase), { timeout: LOAD_WAIT_MS }).toBe("prep");
  await page.locator("#speed-2").click();
  await expect.poll(() => hook(page, (h) => h.perf?.speed)).toBe(2);
  await page.locator("#back").click();
  // A replay at Max.
  await pick(page, [{ name: "run.json", text: readFileSync(GOLDEN_PATH, "utf8") }]);
  await expect.poll(async () => (await replay(page)).checks.length, { timeout: LOAD_WAIT_MS }).toBeGreaterThan(0);
  await maxPast(page, 1000);
  expect((await replay(page)).speed).toBe(0);
  await page.locator("#back").click();
  // The next played match is back at its own 2x, and the page shows it.
  await page.getByRole("button", { name: "Paris — Le Marais" }).click();
  await expect.poll(() => hook(page, (h) => h.phase), { timeout: LOAD_WAIT_MS }).toBe("prep");
  expect(await hook(page, (h) => h.perf?.speed)).toBe(2);
  await expect(page.locator("#speed-2")).toHaveClass(/\bon\b/);
  await expect(page.locator("#speed-1")).not.toHaveClass(/\bon\b/);
  await expect(page.locator("#speed-4")).not.toHaveClass(/\bon\b/);
  // And it runs at 2x (40 ticks a second), not flat out.
  expect(await hook(page, (h) => h.act({ type: "start_wave" }))).toBeNull();
  await expect.poll(() => hook(page, (h) => h.phase)).toBe("running");
  const t0 = await hook(page, (h) => h.tick);
  await page.waitForTimeout(1000);
  const ran = (await hook(page, (h) => h.tick)) - t0;
  expect(ran).toBeGreaterThan(0);
  expect(ran).toBeLessThan(120);
});

test("a tampered record: the viewer names the attempt and what diverged", async ({ page }) => {
  test.setTimeout(REPLAY_MS + 2 * LOAD_WAIT_MS);
  await openApp(page);
  const bad = structuredClone(GOLDEN) as typeof GOLDEN;
  const k = 3;
  const flip = (h: string) => h.slice(0, -1) + (h.endsWith("0") ? "1" : "0");
  bad.attempts[k].end_hash = flip(bad.attempts[k].end_hash);
  await pick(page, [{ name: "tampered.json", text: JSON.stringify(bad) }]);
  await expect.poll(async () => (await replay(page)).active, { timeout: LOAD_WAIT_MS }).toBe(true);
  await runToEnd(page);
  const r = await replay(page);
  expect(r.error).toMatchObject({ error: "diverged", attempt: k, what: "end_hash", record: bad.attempts[k].end_hash, replay: GOLDEN.attempts[k].end_hash });
  expect(r.rows[k]).toMatchObject({ prep: "ok", end: "bad" });
  for (let i = 0; i < k; i++) expect(r.rows[i]).toMatchObject({ prep: "ok", end: "ok" });
  expect(r.final).toBe("pending");
  await expect(page.locator("#rv-verdict")).toHaveText(
    `Diverged at attempt ${k + 1} (wave ${GOLDEN.attempts[k].wave}), tick ${r.error!.tick}: the end hash is ${GOLDEN.attempts[k].end_hash} in the replay, ${bad.attempts[k].end_hash} in the record.`,
  );
  await expect(page.locator(`#rv-checks li[data-attempt="${k}"] .rv-dot.bad`)).toHaveCount(1);
});

test("a streamed run without its map asks for the bundle, then replays on it", async ({ page }) => {
  test.setTimeout(REPLAY_MS + 2 * LOAD_WAIT_MS);
  // A short streamed run made here with the Node build of the same WASM on
  // the T6a map blocks (crates/sim-core/tests/fixtures/map_chunks.json, a
  // 500 m shell at the Marais centre): wave 1 started and played for 200
  // ticks, abandoned. Its map bundle is that shell plus the record's blocks.
  initSync({ module: readFileSync(new URL("../src/wasm/pkg/sim_wasm_bg.wasm", import.meta.url)) });
  const fx = `${REPO}crates/sim-core/tests/fixtures`;
  const meta = JSON.parse(readFileSync(`${fx}/map_chunks.meta.json`, "utf8")) as { center_lat: number; center_lon: number; level_radius_m: number };
  const chunks = JSON.parse(readFileSync(`${fx}/map_chunks.json`, "utf8")) as { block_id: number }[];
  const shell = { name: "streamed", center_lat: meta.center_lat, center_lon: meta.center_lon, radius_m: meta.level_radius_m, buildings: [], fences: [] };
  const m = WasmMatch.new_streaming(JSON.stringify(shell), JSON.stringify({ seed: "4" }), JSON.stringify(chunks));
  m.apply(JSON.stringify({ type: "start_wave" }));
  m.step(200);
  const record = m.record();
  m.free();
  const blocks = (JSON.parse(record) as { map: { blocks: number[] } }).map.blocks;
  const bundle = JSON.stringify({ ...shell, chunks: blocks.map((id) => chunks.find((c) => c.block_id === id)) });

  await openApp(page);
  await hook(page, (h) => h.clearMapCache());
  await pick(page, [{ name: "run.json", text: record }]);
  await expect.poll(async () => (await replay(page)).picker.message).toMatch(new RegExp(`streamed map \\(${blocks.length} blocks\\) and none of them are in this browser's map cache`));
  await expect(page.locator("#rp-msg")).toContainText('"Download map"');
  await expect(page.locator("#replay-picker")).toHaveAttribute("data-need", "bundle");
  expect(await hook(page, (h) => h.screen)).toBe("explore");
  // The bundle: the replay starts on it.
  await pick(page, [{ name: "map.json", text: bundle }]);
  await expect.poll(() => hook(page, (h) => h.screen)).toBe("game");
  expect((await replay(page)).mapFrom).toBe("map bundle");
  await runToEnd(page);
  const r = await replay(page);
  expect(r.error).toBeNull();
  expect(r.summary).toMatchObject({ map_source: "chunks", abandoned: true });
  expect(r.rows).toEqual([{ attempt: 0, wave: 1, prep: "ok", end: "pending", result: "open at the end" }]);
  expect(r.final).toBe("ok");
});
