// T5 review regressions on Paris Le Marais: selections that outlive their
// card, double clicks on phase buttons, stale inspect costs, building picks,
// pause carry-over, seed commits, unsettled requests, quick Keep clicks,
// keyboard activation of hand cards and picks inside a garrisoned building.
import type { Page } from "@playwright/test";
import { expect, hook, hookWith, test } from "./offline";
import { clickCard, clickSim, dragSim, openLevel, runTo, uiAction } from "./ui";

const MARAIS = "Paris — Le Marais";

/** Start the wave with the Start button, paused on its first tick. */
async function startPaused(page: Page) {
  await hook(page, (h) => h.startPaused());
  expect(await uiAction(page, () => page.locator("#start").click())).toBeNull();
  await expect.poll(() => hook(page, (h) => h.phase === "running" && h.perf!.paused)).toBe(true);
}

/** Centre of fence cell `c` in sim meters. */
const cellPoint = (page: Page, c: number) =>
  hookWith(page, (h, k) => [((k % h.level!.gridW) + 0.5) * h.level!.cell, (Math.floor(k / h.level!.gridW) + 0.5) * h.level!.cell] as [number, number], c);

/** A light fence (hand index `i`) placed by the hook across open ground near the centre. */
async function placeFence(page: Page, i: number) {
  const pts = await hook(page, async (h) => {
    const [cx, cy] = h.level!.center;
    for (let dy = 0; dy <= 120; dy += 4)
      for (const y of [cy - dy, cy + dy]) {
        const p: [number, number][] = [
          [cx - 30, y],
          [cx + 30, y],
        ];
        const l = await h.fenceLength(p);
        if (l !== null && l > 20) return p;
      }
    return null;
  });
  expect(pts).not.toBeNull();
  expect(await hookWith(page, (h, a) => h.playCard(a.i, { polyline: a.pts }), { i, pts: pts! })).toBeNull();
  return (await hook(page, (h) => h.structures)).filter((s) => s.kind.type === "fence").pop()!;
}

test("a retry drops the selection: no stray card plays on the next click", async ({ page }) => {
  // Seed 3's first hand holds Paratrooper and Grenades.
  await openLevel(page, MARAIS, 3);
  await startPaused(page);
  const t0 = await hook(page, (h) => h.tick);
  await runTo(page, t0 + 60);
  const para = await hook(page, (h) => h.hand.findIndex((c) => c.card === "paratrooper"));
  expect(para).toBeGreaterThanOrEqual(0);
  const center = (await hook(page, (h) => h.level!.center))!;
  expect(await hookWith(page, (h, a) => h.playCard(a.i, { point: a.p }), { i: para, p: center })).toBeNull();
  // Select Grenades (its position moved after the play), then Retry wave.
  const gi = await hook(page, (h) => h.hand.findIndex((c) => c.card === "grenades"));
  await clickCard(page, gi);
  expect(await hook(page, (h) => h.selection?.card)).toBe("grenades");
  expect(await uiAction(page, () => page.locator("#retry").click())).toBeNull();
  await expect.poll(() => hook(page, (h) => h.phase)).toBe("prep");
  // The selection, its targeting panel, cursor and map-panning lock are gone.
  expect(await hook(page, (h) => h.selection)).toBeNull();
  await expect(page.locator("#targeting")).toBeHidden();
  expect(await hook(page, (h) => h.debug.map.dragPan.isEnabled())).toBe(true);
  expect(await hook(page, (h) => h.debug.map.getCanvas().style.cursor)).toBe("");
  // A drag on the map now pans: no fence is drafted or played.
  const before = await hook(page, (h) => h.uiActions.count);
  await dragSim(page, [center[0] - 20, center[1]], [center[0] + 20, center[1]]);
  await page.waitForTimeout(500);
  expect(await hook(page, (h) => h.uiActions.count)).toBe(before);
  expect(await hook(page, (h) => h.structures.length)).toBe(0);
});

test("phase buttons: a double click sends one action; Retry is off in prep; prep starts unpaused", async ({ page }) => {
  await openLevel(page, MARAIS, 1);
  await expect(page.locator("#retry")).toBeDisabled();
  // Double-click Start: one start_wave, no refusal toast for a second one.
  const n0 = await hook(page, (h) => h.uiActions.count);
  await page.locator("#start").dblclick();
  await expect.poll(() => hook(page, (h) => h.phase)).toBe("running");
  await page.waitForTimeout(500);
  expect(await hook(page, (h) => h.uiActions.count)).toBe(n0 + 1);
  expect(await hook(page, (h) => h.toast)).toBe("");
  // The statuses of the running wave leave the Pause label's text node in
  // place: WebKit drops a click whose mousedown text node is replaced
  // before the mouseup, so a rewrite on every status lost presses.
  await page.evaluate(() => ((window as unknown as { pauseText: Node | null }).pauseText = document.getElementById("pause")!.firstChild));
  const t0 = await hook(page, (h) => h.tick);
  await expect.poll(() => hook(page, (h) => h.tick)).toBeGreaterThan(t0 + 5);
  expect(await page.evaluate(() => (window as unknown as { pauseText: Node | null }).pauseText === document.getElementById("pause")!.firstChild)).toBe(true);
  // Pause the wave with the button, then double-click Retry: one retry,
  // and the new prep is not paused.
  await page.locator("#pause").click();
  await expect.poll(() => hook(page, (h) => h.perf!.paused)).toBe(true);
  await page.locator("#retry").dblclick();
  await expect.poll(() => hook(page, (h) => h.phase)).toBe("prep");
  await page.waitForTimeout(500);
  expect(await hook(page, (h) => h.status!.retries)).toBe(1);
  expect(await hook(page, (h) => h.perf!.paused)).toBe(false);
  await expect(page.locator("#retry")).toBeDisabled();
  await expect(page.locator("#phase")).toHaveText("Prep");
  // Start again: the wave runs (the earlier pause did not carry over).
  const t1 = await hook(page, (h) => h.tick);
  await hook(page, (h) => h.speed(16));
  expect(await uiAction(page, () => page.locator("#start").click())).toBeNull();
  await expect.poll(() => hook(page, (h) => h.tick)).toBeGreaterThan(t1 + 20);
  expect(await hook(page, (h) => h.perf!.paused)).toBe(false);
  // Double-click Restart: one restart.
  await page.locator("#restart").dblclick();
  await expect.poll(() => hook(page, (h) => h.phase === "prep" && h.wave === 1)).toBe(true);
  await page.waitForTimeout(500);
  expect(await hook(page, (h) => h.status!.restarts)).toBe(1);
  expect(await hook(page, (h) => h.status!.retries)).toBe(2);
  expect(await hook(page, (h) => h.toast)).toBe("");
});

test("the inspect panel follows the structure's costs and closes on restart", async ({ page }) => {
  // Seed 1's hand: Hunting rifles, Light fence (cost 2), ...
  await openLevel(page, MARAIS, 1);
  const fence = await placeFence(page, 1);
  expect(fence.cost).toBe(2);
  if (fence.kind.type !== "fence") throw new Error("not a fence");
  const p = await cellPoint(page, fence.kind.cells[Math.floor(fence.kind.cells.length / 2)]);
  await clickSim(page, p[0], p[1]);
  await expect(page.locator("#inspect")).toBeVisible();
  await expect(page.locator("#inspect")).toHaveAttribute("data-structure", String(fence.id));
  // Same prep: full refund.
  await expect(page.locator("#i-pull")).toHaveText("Pull down (+2 supply)");
  await expect(page.locator("#i-repair")).toHaveText("Repair (intact)");
  // The wave starts: the refund drops to half (the core's number), without
  // clicking the fence again.
  await startPaused(page);
  const refund = (await hookWith(page, (h, q) => h.pick(q[0], q[1]), p)).refund;
  expect(refund).toBe(1);
  await expect(page.locator("#i-pull")).toHaveText(`Pull down (+${refund} supply)`);
  await expect(page.locator("#i-pull")).toBeDisabled();
  // Restart: the panel closes (structure ids start again from 0).
  expect(await uiAction(page, () => page.locator("#restart").click())).toBeNull();
  await expect.poll(() => hook(page, (h) => h.phase)).toBe("prep");
  await expect(page.locator("#inspect")).toBeHidden();
  expect(await hook(page, (h) => h.inspected)).toBeNull();
});

test("an unavailable building click keeps the picks", async ({ page }) => {
  // Seed 2's first hand: Heavy stockade, Barbed wire, Rifles x3.
  await openLevel(page, MARAIS, 2);
  const inner = await hook(page, (h) => h.buildings.filter((x) => x.cells > 0 && x.wave === 1 && x.area > 50).slice(0, 2).map((x) => x.index));
  const point = async (b: number) => (await hookWith(page, (h, k) => h.buildingPoint(k), b))!;
  await clickCard(page, 2);
  const a = await point(inner[0]);
  await clickSim(page, a[0], a[1]);
  await expect.poll(() => hook(page, (h) => h.selection)).toEqual({ handIndex: 2, card: "rifles", picked: [inner[0]] });
  // Another Rifles garrisons inner[1] (the selected one stays: still Rifles at position 2).
  expect(await hookWith(page, (h, k) => h.playCard(3, { buildings: [k] }), inner[1])).toBeNull();
  expect(await hook(page, (h) => h.selection)).toEqual({ handIndex: 2, card: "rifles", picked: [inner[0]] });
  const b = await point(inner[1]);
  await clickSim(page, b[0], b[1]);
  await expect(page.locator("#hint")).toHaveText("Not available: already garrisoned. 1/3 picked.");
  expect(await hook(page, (h) => h.selection)).toEqual({ handIndex: 2, card: "rifles", picked: [inner[0]] });
  // A building of the next ring: refused the same way, picks kept.
  const outer = (await hook(page, (h) => h.buildings.find((x) => x.cells > 0 && x.wave === 2 && x.area > 50)?.index))!;
  const o = await point(outer);
  await clickSim(page, o[0], o[1]);
  await expect(page.locator("#hint")).toHaveText(/^(Not available: outside the revealed area\. 1\/3 picked\.|Click a building \(inside the revealed area\))$/);
  expect(await hook(page, (h) => h.selection)).toEqual({ handIndex: 2, card: "rifles", picked: [inner[0]] });
  // Place plays the one valid pick.
  expect(await uiAction(page, () => page.locator("#sel-place").click())).toBeNull();
  expect(await hook(page, (h) => h.towers.map((t) => t.building).sort((x, y) => x - y))).toEqual([...inner].sort((x, y) => x - y));
});

test("the seed commits on Enter or New match only, asks during a wave, and stays exact above 2^53", async ({ page }) => {
  await openLevel(page, MARAIS, 1);
  const seedOf = () => hook(page, async (h) => JSON.parse(await h.record()).setup.seed as string);
  // While a committed seed's match is being built (the old one stopped, the
  // setup waiting for the profile) there is no match: a record rejects with
  // "aborted" (the hook's contract). The polls below read that as "no seed
  // yet" (null); any other error still fails the test.
  const newSeed = () =>
    hook(page, (h) =>
      h.record().then(
        (json) => JSON.parse(json).setup.seed as string,
        (e: Error) => {
          if (e.message === "aborted") return null;
          throw e;
        },
      ),
    );
  expect(await seedOf()).toBe("1");
  const big = "9007199254740993"; // 2^53 + 1: not a JS number
  await page.locator("#seed").fill(big);
  await page.locator("#seed").blur();
  await page.waitForTimeout(700);
  expect(await hook(page, (h) => h.phase)).toBe("prep");
  expect(await seedOf()).toBe("1");
  await page.locator("#seed").press("Enter");
  await expect.poll(newSeed, { timeout: 60_000 }).toBe(big);
  await expect.poll(() => hook(page, (h) => (h.phase === "prep" ? h.hand.length : 0)), { timeout: 60_000 }).toBe(5);
  // While a wave runs, a new match asks first: dismissed, nothing happens.
  await startPaused(page);
  await page.locator("#seed").fill("5");
  page.once("dialog", (d) => void d.dismiss());
  await page.locator("#new-match").click();
  await page.waitForTimeout(700);
  expect(await hook(page, (h) => h.phase)).toBe("running");
  expect(await seedOf()).toBe(big);
  // Accepted: the new match starts.
  page.once("dialog", (d) => void d.accept());
  await page.locator("#seed").press("Enter");
  await expect.poll(newSeed, { timeout: 60_000 }).toBe("5");
  await expect.poll(() => hook(page, (h) => h.phase), { timeout: 60_000 }).toBe("prep");
  // Not a u64: refused with a message, the match stays.
  await page.locator("#seed").fill("18446744073709551616");
  await page.locator("#seed").press("Enter");
  await expect(page.locator("#toast")).toHaveText("The seed must be a whole number from 0 to 18446744073709551615");
  expect(await seedOf()).toBe("5");
});

test("requests settle after the match stops or is rebuilt", async ({ page }) => {
  await openLevel(page, MARAIS, 1);
  // Re-init with an action queued: it settles (applied or aborted).
  const r0 = await hook(page, async (h) => {
    const t = (p: Promise<unknown>) => Promise.race([p.then((v) => `ok:${JSON.stringify(v)}`, (e: Error) => `rejected:${e.message}`), new Promise((r) => setTimeout(() => r("timeout"), 5000))]);
    const p = h.act({ type: "mulligan" });
    h.newMatch(1);
    return t(p);
  });
  expect(r0).not.toBe("timeout");
  await expect.poll(() => hook(page, (h) => (h.phase === "prep" ? h.hand.length : 0)), { timeout: 60_000 }).toBe(5);
  // After "← Map": every kind of request is answered.
  await page.locator("#back").click();
  await expect.poll(() => hook(page, (h) => h.screen)).toBe("explore");
  const r = await hook(page, async (h) => {
    const t = (p: Promise<unknown>) => Promise.race([p.then((v) => `ok:${JSON.stringify(v)}`, (e: Error) => `rejected:${e.message}`), new Promise((r) => setTimeout(() => r("timeout"), 5000))]);
    return { act: await t(h.startWave()), pick: await t(h.pick(1, 1)), record: await t(h.record()), hash: await t(h.stateHash()) };
  });
  expect(r).toEqual({ act: 'ok:{"error":"aborted","message":"the match was stopped"}', pick: "rejected:aborted", record: "rejected:aborted", hash: "rejected:aborted" });
  expect(await hook(page, (h) => h.toast)).toBe("");
});

test("two quick Keep clicks keep both cards", async ({ page }) => {
  await openLevel(page, MARAIS, 3);
  const tac = await hook(page, (h) => h.hand.filter((c) => c.kind === "tactical").map((c) => c.hand_index));
  expect(tac.length).toBe(2);
  // Both clicks before the first answer arrives.
  await page.evaluate((idx) => {
    for (const i of idx) (document.querySelector(`#hand .hcard[data-index="${i}"] .c-keep`) as HTMLElement).click();
  }, tac);
  await expect.poll(() => hook(page, (h) => h.hand.filter((c) => c.keep).map((c) => c.hand_index))).toEqual(tac);
  for (const i of tac) await expect(page.locator(`#hand .hcard[data-index="${i}"] .c-keep`)).toHaveText("Kept for next wave");
  // Unkeep both quickly: none left.
  await page.evaluate((idx) => {
    for (const i of idx) (document.querySelector(`#hand .hcard[data-index="${i}"] .c-keep`) as HTMLElement).click();
  }, tac);
  await expect.poll(() => hook(page, (h) => h.hand.filter((c) => c.keep).length)).toBe(0);
});

test("hand cards: Enter and Space select the focused card, Space does not pause", async ({ page }) => {
  await openLevel(page, MARAIS, 1);
  const card = (i: number) => page.locator(`#hand .hcard[data-index="${i}"]`);
  await card(1).focus();
  await page.keyboard.press("Enter");
  expect(await hook(page, (h) => h.selection?.card)).toBe("light_fence");
  await expect(card(1)).toBeFocused();
  await page.keyboard.press("Enter");
  expect(await hook(page, (h) => h.selection)).toBeNull();
  // Mid-wave (paused): Space on a focused card selects it and leaves the clock alone.
  await startPaused(page);
  await card(0).focus();
  await page.keyboard.press(" ");
  expect(await hook(page, (h) => h.selection?.card)).toBe("hunting_rifles");
  await page.waitForTimeout(300);
  expect(await hook(page, (h) => h.perf!.paused)).toBe(true);
  // Space elsewhere still toggles the pause.
  await page.locator("#hand").evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press(" ");
  await expect.poll(() => hook(page, (h) => h.perf!.paused)).toBe(false);
});

test("Space pauses after a click on a speed button, without clicking it again", async ({ page }) => {
  await openLevel(page, MARAIS, 1);
  await startPaused(page);
  await page.locator("#pause").click(); // resume
  await expect.poll(() => hook(page, (h) => h.perf!.paused)).toBe(false);
  // The clicked toolbar button keeps focus (Chromium, Firefox): Space must
  // pause, not activate #speed-2 again.
  await page.locator("#speed-2").click();
  await expect.poll(() => hook(page, (h) => h.perf!.speed)).toBe(2);
  await page.keyboard.press(" ");
  await expect.poll(() => hook(page, (h) => h.perf!.paused)).toBe(true);
  await page.waitForTimeout(300);
  expect(await hook(page, (h) => h.perf!.paused)).toBe(true);
  expect(await hook(page, (h) => h.perf!.speed)).toBe(2);
  // A focused #speed-4: Space resumes and the speed stays at 2.
  await page.locator("#speed-4").focus();
  await page.keyboard.press(" ");
  await expect.poll(() => hook(page, (h) => h.perf!.paused)).toBe(false);
  await page.waitForTimeout(300);
  expect(await hook(page, (h) => h.perf!.paused)).toBe(false);
  expect(await hook(page, (h) => h.perf!.speed)).toBe(2);
});

test("two quick pause presses before any status both count", async ({ page }) => {
  await openLevel(page, MARAIS, 1);
  await startPaused(page);
  await page.locator("#pause").click(); // resume
  await expect.poll(() => hook(page, (h) => h.perf!.paused)).toBe(false);
  const advances = async () => {
    await expect.poll(() => hook(page, (h) => h.perf!.paused)).toBe(false);
    const t = await hook(page, (h) => h.status!.tick);
    await expect.poll(() => hook(page, (h) => h.status!.tick), { timeout: 30_000 }).toBeGreaterThanOrEqual(t + 20);
    expect(await hook(page, (h) => h.perf!.paused)).toBe(false);
  };
  // Two clicks in one task: no status can arrive between them, so a handler
  // reading the last status would ask for "paused" twice and stay paused.
  await page.evaluate(() => {
    const b = document.getElementById("pause") as HTMLButtonElement;
    b.click();
    b.click();
  });
  await advances();
  // The same with two Space presses (on the body, not a hand card).
  await page.evaluate(() => {
    for (let i = 0; i < 2; i++) document.body.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
  });
  await advances();
  // An odd number of presses in one task leaves it paused.
  await page.evaluate(() => {
    const b = document.getElementById("pause") as HTMLButtonElement;
    for (let i = 0; i < 3; i++) b.click();
  });
  await expect.poll(() => hook(page, (h) => h.perf!.paused)).toBe(true);
});

test("a seed commit after a lost wave and a retry asks first", async ({ page }) => {
  test.setTimeout(240_000);
  await openLevel(page, MARAIS, 1);
  const seedOf = () => hook(page, async (h) => JSON.parse(await h.record()).setup.seed as string);
  // Lose wave 1 (no defence), as fast as the clock goes, then Retry.
  await startPaused(page);
  await hook(page, (h) => h.speed(16));
  await page.locator("#pause").click(); // resume
  await expect.poll(() => hook(page, (h) => h.phase), { timeout: 180_000, intervals: [250, 500, 1000] }).toBe("wave_lost");
  expect(await uiAction(page, () => page.locator("#r-retry").click())).toBeNull();
  await expect.poll(() => hook(page, (h) => h.phase === "prep" && h.status!.retries === 1)).toBe(true);
  // Back in a wave-1 prep, but not a pristine one: a new seed asks.
  let asked = "";
  page.once("dialog", (d) => {
    asked = d.message();
    void d.dismiss();
  });
  await page.locator("#seed").fill("7");
  await page.locator("#seed").press("Enter");
  await expect.poll(() => asked).toMatch(/^Start a new match with seed 7\?/);
  await page.waitForTimeout(700);
  expect(await seedOf()).toBe("1");
  expect(await hook(page, (h) => h.status!.retries)).toBe(1);
});

test("a click inside a garrisoned building inspects its garrison, not a fence next to it", async ({ page }) => {
  await openLevel(page, MARAIS, 1);
  // A building and a fence that leaves it from inside (the fence is
  // clipped at the wall, so its first cells touch the building).
  const found = await hook(page, async (h) => {
    const dirs: [number, number][] = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    for (const b of h.buildings.filter((x) => x.cells > 0 && x.wave === 1 && x.area > 80).slice(0, 40)) {
      const p = h.buildingPoint(b.index);
      if (!p) continue;
      for (const [dx, dy] of dirs) {
        const pts: [number, number][] = [p, [p[0] + 40 * dx, p[1] + 40 * dy]];
        const l = await h.fenceLength(pts);
        if (l !== null && l > 10) return { b: b.index, pts, dir: [dx, dy] };
      }
    }
    return null;
  });
  expect(found).not.toBeNull();
  const { b, pts, dir } = found!;
  expect(await hookWith(page, (h, k) => h.playCard(0, { buildings: [k] }), b)).toBeNull(); // Hunting rifles
  const garrison = (await hook(page, (h) => h.structures)).find((s) => s.kind.type === "garrison")!;
  expect(await hookWith(page, (h, p) => h.playCard(0, { polyline: p }), pts)).toBeNull(); // Light fence (now first)
  const fence = (await hook(page, (h) => h.structures)).find((s) => s.kind.type === "fence")!;
  if (fence.kind.type !== "fence") throw new Error("not a fence");
  // The last point inside the building along the line, within 2.5 m of a fence cell.
  const q = await hookWith(
    page,
    async (h, a) => {
      const l = h.level!;
      const cells = a.cells.map((c) => [((c % l.gridW) + 0.5) * l.cell, (Math.floor(c / l.gridW) + 0.5) * l.cell]);
      let last: [number, number] | null = null;
      for (let s = 0; s <= 40; s += 0.25) {
        const p: [number, number] = [a.from[0] + s * a.dir[0], a.from[1] + s * a.dir[1]];
        const k = await h.pick(p[0], p[1]);
        if (k.building !== a.b) continue;
        if (cells.some((c) => Math.hypot(c[0] - p[0], c[1] - p[1]) <= 2.5)) last = p;
      }
      return last;
    },
    { cells: fence.kind.cells, from: pts[0], dir, b },
  );
  expect(q).not.toBeNull();
  await clickSim(page, q![0], q![1]);
  await expect(page.locator("#inspect")).toBeVisible();
  await expect(page.locator("#inspect")).toHaveAttribute("data-structure", String(garrison.id));
  // Outside the building, the fence is still picked within 3 m.
  const c = await cellPoint(page, fence.kind.cells[Math.floor(fence.kind.cells.length / 2)]);
  await clickSim(page, c[0], c[1]);
  await expect(page.locator("#inspect")).toHaveAttribute("data-structure", String(fence.id));
});
