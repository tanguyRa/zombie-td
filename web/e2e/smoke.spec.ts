// Smoke test: built-in level, a tower and a fence placed through the UI,
// Start, 4×, run to the end, check the result panel.
import { expect, hook, test } from "./offline";

// Central screen area not covered by the top bar, the tools panel or the HUD.
const SAFE = { left: 240, right: 1280 - 280, top: 90, bottom: 800 - 30 };
const inSafe = (p: { x: number; y: number } | null) => !!p && p.x > SAFE.left && p.x < SAFE.right && p.y > SAFE.top && p.y < SAFE.bottom;

test("built-in level: tower + fence, start, 4x, result panel", async ({ page, blocked }) => {
  await page.goto("/?test=1");
  await page.waitForFunction(() => !!window.__zt);
  expect(await hook(page, (h) => h.screen)).toBe("explore");

  // Le Vésinet is the smaller built-in level; it starts without a download.
  await page.getByRole("button", { name: "Le Vésinet (suburb)" }).click();
  // Level load + spawning can take a while when three browsers share the CPU.
  await expect.poll(() => hook(page, (h) => h.phase), { timeout: 60_000 }).toBe("setup");
  expect(await hook(page, (h) => h.screen)).toBe("game");

  // Smallest population through the slider, so the game ends quickly.
  await page.locator("#pop").fill("5000");
  await expect.poll(() => hook(page, (h) => (h.phase === "setup" ? h.level?.agents : 0)), { timeout: 60_000 }).toBe(5000);
  await expect.poll(() => hook(page, (h) => h.mapIdle)).toBe(true);

  // Tower: click the Tower tool, then a building near the centre of the view.
  const target = await hook(page, (h) => {
    const l = h.level!;
    let best: { x: number; y: number; d: number } | null = null;
    for (let i = 0; i < l.buildings; i++) {
      const p = h.buildingPoint(i);
      if (!p) continue;
      const d = Math.hypot(p[0] - l.center[0], p[1] - l.center[1]);
      if (d > 30 && (!best || d < best.d)) {
        const s = h.toScreen(p[0], p[1])!;
        best = { x: s.x, y: s.y, d };
      }
    }
    return best;
  });
  expect(inSafe(target)).toBe(true);
  const towersBefore = await hook(page, (h) => h.stats!.towersLeft);
  await page.locator("#tool-tower").click();
  await page.mouse.click(target!.x, target!.y);
  await expect.poll(() => hook(page, (h) => h.stats!.towersLeft)).toBe(towersBefore - 1);
  await expect(page.locator("#towers-left")).toHaveText(String(towersBefore - 1));

  // Fence: drag across the level centre with the Fence tool.
  const [a, b] = await hook(page, (h) => {
    const [cx, cy] = h.level!.center;
    return [h.toScreen(cx - 50, cy + 20)!, h.toScreen(cx + 50, cy + 20)!];
  });
  expect(inSafe(a) && inSafe(b)).toBe(true);
  await page.locator("#tool-fence").click();
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 20 });
  await page.mouse.up();
  await expect.poll(() => hook(page, (h) => h.placements.map((p) => p.type))).toEqual(["tower", "fence"]);
  expect(await hook(page, (h) => h.stats!.fenceLeft)).toBeLessThan(400);

  // Start, 4×, run to the end.
  await page.locator("#start").click();
  await expect.poll(() => hook(page, (h) => h.phase)).toBe("running");
  await page.locator("#speed-4").click();
  const t0 = Date.now();
  await expect.poll(() => hook(page, (h) => h.stats!.speed)).toBe(4);
  await expect(page.locator("#speed-4")).toHaveClass(/\bon\b/);

  await expect(page.locator("#result")).toBeVisible({ timeout: 170_000 });
  const end = await hook(page, (h) => ({ phase: h.phase, stats: h.stats! }));
  const wall = (Date.now() - t0) / 1000;
  const { hash } = await hook(page, (h) => h.stateHash());
  expect(hash).toMatch(/^[0-9a-f]{16}$/);
  console.log(
    `${test.info().project.name}: ${end.phase} at tick ${end.stats.tick} after ${wall.toFixed(0)} s ` +
      `(${(end.stats.tick / wall).toFixed(0)} ticks/s, 80 = 4x), ${end.stats.civilians}/${end.stats.initial} civilians, ` +
      `${end.stats.killed} killed, sim p95 ${end.stats.simMsP95.toFixed(1)} ms, hash ${hash}`,
  );
  expect(["win", "loss", "timeout"]).toContain(end.phase);
  const outcome = { win: "Win", loss: "Loss", timeout: "Timeout" }[end.phase as "win" | "loss" | "timeout"];
  await expect(page.locator("#r-outcome")).toHaveText(outcome);
  await expect(page.locator("#r-time")).toHaveText(/^\d+:\d\d$/);
  await expect(page.locator("#r-killed")).toHaveText(end.stats.killed.toLocaleString("en-US"));
  await expect(page.locator("#r-surv")).toHaveText(/%$/);
  expect(end.stats.tick).toBeGreaterThan(0);

  // Nothing outside the local server was let through (blocked requests are fine).
  expect(blocked.every((u) => !u.startsWith("http://localhost"))).toBe(true);
});
