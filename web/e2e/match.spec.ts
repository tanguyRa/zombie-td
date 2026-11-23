// A full 8-wave match on Paris Le Marais through the UI, then the run record
// downloaded from the match result panel must verify headless (the native
// `sim-headless verify`) with the browser's per-attempt hashes.
//
// The scenario (scenario.ts) loses wave 1 on purpose (no defence), retries
// it, plays one armament (building clicks), one fence (a drag) and pulls the
// fence down again (a click on it, then Pull down), keeps cards with the
// Keep buttons, mulligans with the button in wave 2, and plays its first
// tactical card mid-wave with a click on the map; a test bot (bot.ts, the
// `sim-headless match` strategy) plays the rest through the test hook. Waves
// run at the hook's test-only "as fast as possible" speed. Seed 2 clears it
// in about 8,500 ticks (`node e2e/bot-check.mts 2` replays it under Node).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import cards from "../../cards.json" with { type: "json" };
import { expect, hook, test } from "./offline";
import { runScenario } from "./scenario";
import { OPEN_LEVEL_MS, openLevel, pageApi } from "./ui";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SEED = 2;
// Budgets. Playing: Chromium and WebKit take about 20-30 s, Firefox's WASM
// (Playwright build) about 70-90 s; the budget is ~6x the slowest. The
// native verifier takes ~5 s, plus a release build of sim-headless if the
// sources changed (cargo runs it; ~1 min from a warm cache).
const PLAY_MS = 10 * 60_000;
const VERIFY_MS = 5 * 60_000;

/** `sim-headless verify` (native, release): the summary, or throws with its output. */
function verifyNative(recordPath: string): { phase: string; waves_won: number; retries: number; attempts: number; attempt_hashes: string[]; final_hash: string } {
  let out: string;
  try {
    out = execFileSync("cargo", ["run", "--release", "-q", "-p", "sim-headless", "--", "verify", recordPath, "--level", "levels/paris-marais.json", "--quiet"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 << 20,
      timeout: VERIFY_MS,
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    throw new Error(`sim-headless verify rejected the record:\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
  }
  const at = out.lastIndexOf("\nverified:");
  expect(at, out).toBeGreaterThan(0);
  console.log(out.slice(at + 1).trim());
  return JSON.parse(out.slice(0, at));
}

test("full 8-wave match through the UI verifies headless", async ({ page }, info) => {
  test.setTimeout(OPEN_LEVEL_MS + PLAY_MS + VERIFY_MS);
  const t0 = Date.now();
  await openLevel(page, "Paris — Le Marais", SEED);
  await expect(page.locator("#h-wave")).toHaveText("1/8");

  const log = await runScenario(pageApi(page, { deadline: t0 + OPEN_LEVEL_MS + PLAY_MS }), cards as never, (s) => console.log(`${info.project.name}: ${s}`));
  const playMs = Date.now() - t0;

  // Every kind of play the test must show happened, the UI ones with the UI.
  expect(log.counts.lost).toBeGreaterThanOrEqual(1);
  expect(log.counts.mulligans).toBeGreaterThanOrEqual(1);
  expect(log.counts.pullDowns).toBeGreaterThanOrEqual(1);
  expect(log.counts.tactical).toBeGreaterThanOrEqual(1);
  expect(log.counts.keeps).toBeGreaterThanOrEqual(8);
  expect(log.counts.uiPlays).toBe(3); // armament clicks, fence drag, tactical click
  expect(log.counts.uiRepairs).toBe(1); // a damaged fence clicked, then Repair

  // The match result panel.
  await expect(page.locator("#result")).toBeVisible();
  await expect(page.locator("#r-title")).toHaveText("Match won: 8 waves cleared");
  const end = await hook(page, (h) => ({ status: h.status!, attempts: h.attempts, results: h.results }));
  expect(end.status.phase).toBe("match_won");
  expect(end.status.retries).toBe(log.counts.lost);
  await expect(page.locator("#r-stats")).toContainText(`Retries${end.status.retries}`);
  const last = end.results[end.results.length - 1];
  await expect(page.locator("#r-stats")).toContainText(`Civilians saved${last.end_civilians.toLocaleString("en-US")}`);
  await expect(page.locator("#r-waves tr")).toHaveCount(9);

  // Download the run record with the button.
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#r-download").click()]);
  expect(download.suggestedFilename()).toMatch(/^zombie-td-run-.*-seed2\.json$/);
  const path = info.outputPath("run.json");
  await download.saveAs(path);
  const record = JSON.parse(readFileSync(path, "utf8"));
  expect(record.end.abandoned).toBe(false);
  expect(record.setup.seed).toBe(String(SEED));
  // Prep is never stepped: every attempt's prep is zero ticks long, so its
  // start tick is the previous attempt's end tick.
  for (let i = 1; i < record.attempts.length; i++) expect(record.attempts[i].start_tick).toBe(record.attempts[i - 1].end_tick);

  // Verify headless and compare every attempt's end hash with the browser's.
  const v0 = Date.now();
  const summary = verifyNative(path);
  const verifyMs = Date.now() - v0;
  expect(summary.phase).toBe("match_won");
  expect(summary.waves_won).toBe(8);
  expect(summary.retries).toBe(end.status.retries);
  expect(summary.attempt_hashes).toEqual(end.attempts.map((a) => a.end_hash));
  expect(summary.attempt_hashes).toEqual(record.attempts.map((a: { end_hash: string }) => a.end_hash));
  const { hash } = await hook(page, (h) => h.stateHash());
  expect(summary.final_hash).toBe(hash);
  console.log(
    `${info.project.name}: match won at tick ${end.status.tick}, ${end.attempts.length} attempts, ${end.status.retries} retries, ` +
      `${record.actions.length} actions; played in ${(playMs / 1000).toFixed(0)} s, verified natively in ${(verifyMs / 1000).toFixed(1)} s, final hash ${hash}`,
  );

  // The profile (T7b): the starter deck on Recruit, and the clear claimed
  // once, with its payout in the match panel (no no-retry bonus: wave 1 was
  // retried), Veteran unlocked, coverage on the map and the match in the history.
  expect(record.setup.deck).toEqual(await hook(page, (h) => h.profile.match!.deck));
  // The record writes the f32 in its shortest form ("0.3").
  expect(Math.fround(record.setup.population_multiplier)).toBe(Math.fround(0.3));
  const claims = await hook(page, async (h) => (await h.profile.settle(), h.profile.claims()));
  expect(claims).toHaveLength(1);
  expect(claims[0]).toMatchObject({ reason: "cleared", paid: true, noRetryBonus: 0, unlocked: ["veteran"], cleared: true });
  await expect(page.locator("#r-payout")).toBeVisible();
  await expect(page.locator("#r-payout .po-total")).toHaveText(`+${claims[0].total} resupply tickets`);
  await expect(page.locator("#r-payout .po-nobonus")).toHaveText("no-retry bonus: none (retried)");
  await expect(page.locator("#r-payout .po-unlock")).toHaveText("Unlocked: Veteran");
  await page.locator("#r-map").click(); // New location: already claimed, nothing more
  const prof = await hook(page, async (h) => (await h.profile.settle(), { claims: h.profile.claims().length, state: await h.profile.state() }));
  expect(prof.claims).toBe(1);
  expect(prof.state.unlocked).toEqual(["recruit", "veteran"]);
  expect(prof.state.history).toBe(1);
  await expect(page.locator("#p-tier option")).toHaveText(["Recruit", "Veteran"]);
  await page.locator("#p-coverage").check();
  await expect.poll(() => hook(page, (h) => h.profile.coverageDrawn), { timeout: 15_000 }).toBeGreaterThan(0);
  await page.locator("#p-open-history").click();
  const item = page.locator(`#history .hist-item[data-match="${claims[0].matchId}"]`);
  await expect(item).toContainText("Le Marais, Paris · Recruit");
  await expect(item).toContainText("Cleared");
  const [histDownload] = await Promise.all([page.waitForEvent("download"), item.locator(".hist-dl").click()]);
  const histPath = info.outputPath("history-run.json");
  await histDownload.saveAs(histPath);
  // The stored record is the record the panel saved (so it verifies the same).
  expect(JSON.parse(readFileSync(histPath, "utf8"))).toEqual(record);
});
