// Smaller match tests on Paris Le Marais: the HUD, the hand, invalid plays
// and their messages, phase rules, keep marks, fog, and that pause and speed
// never change the simulation.
import { expect, hook, hookWith, test } from "./offline";
import { centreOn, clickCard, clickSim, openLevel, uiAction } from "./ui";

const MARAIS = "Paris — Le Marais";

/** Run the current wave until match tick `tick` (test-only fast mode), paused there. */
async function runTo(page: import("@playwright/test").Page, tick: number) {
  await hookWith(
    page,
    (h, t) => {
      h.pauseAt(t);
      h.speed(0);
      h.pause(false);
    },
    tick,
  );
  await expect.poll(() => hookWith(page, (h, t) => h.phase !== "running" || (h.perf!.paused && h.tick >= t), tick), { timeout: 120_000 }).toBe(true);
}

test("HUD and hand show the match state", async ({ page }) => {
  await openLevel(page, MARAIS, 1);
  const st = (await hook(page, (h) => h.status))!;
  // Wave 1's prep: 8 + 6 supply, 20 cards - 5 drawn, nobody lost yet.
  expect(st).toMatchObject({ wave: 1, waves: 8, phase: "prep", supply: 14, deck_count: 15, discard_count: 0, retries: 0, mulligan_available: true });
  await expect(page.locator("#phase")).toHaveText("Prep");
  await expect(page.locator("#h-wave")).toHaveText("1/8");
  await expect(page.locator("#h-supply")).toHaveText("14");
  await expect(page.locator("#h-deck")).toHaveText("15 / 0");
  await expect(page.locator("#h-retries")).toHaveText("0");
  await expect(page.locator("#h-civ")).toHaveText(st.stats.civilians.toLocaleString("en-US"));
  await expect(page.locator("#h-saved")).toHaveText(`100.0% · ${st.stats.civilians}/${st.stats.civilians}`);
  await expect(page.locator("#h-fatigue")).toHaveText("100% speed");
  await expect(page.locator("#mulligan")).toHaveText("Mulligan (1 supply)");
  await expect(page.locator("#start")).toHaveText("Start wave");
  await expect(page.locator("#pause")).toBeDisabled();

  // The hand: name, cost, kind and rarity of each card, as the core says.
  const hand = await hook(page, (h) => h.hand);
  expect(hand.map((c) => c.card)).toEqual(["hunting_rifles", "light_fence", "rifles", "rifles", "mortar"]);
  const cards = page.locator("#hand .hcard");
  await expect(cards).toHaveCount(5);
  for (const c of hand) {
    const el = page.locator(`#hand .hcard[data-index="${c.hand_index}"]`);
    await expect(el.locator(".c-name")).toHaveText(c.name);
    await expect(el.locator(".c-cost")).toHaveText(String(c.cost));
    await expect(el.locator(".c-kind")).toContainText(c.kind);
    await expect(el.locator(".c-rarity")).toHaveText(c.rarity);
    await expect(el).toHaveClass(new RegExp(`rarity-${c.rarity}`));
  }

  // Start (through the button) and run 200 ticks: the HUD follows.
  await hook(page, (h) => h.pause(true));
  expect(await uiAction(page, () => page.locator("#start").click())).toBeNull();
  const t0 = await hook(page, (h) => h.tick);
  await runTo(page, t0 + 200);
  const run = (await hook(page, (h) => h.status))!;
  expect(run.phase).toBe("running");
  expect(run.wave_tick).toBe(200);
  await expect(page.locator("#phase")).toHaveText("Paused");
  await expect(page.locator("#pause")).toHaveText("Resume");
  await expect(page.locator("#h-time")).toHaveText("0:10");
  await expect(page.locator("#h-zom")).toHaveText(run.stats.zombies.toLocaleString("en-US"));
  await expect(page.locator("#h-civ")).toHaveText(run.stats.civilians.toLocaleString("en-US"));
  const pct = ((100 * run.stats.civilians) / run.wave_start_civilians).toFixed(1);
  await expect(page.locator("#h-saved")).toHaveText(`${pct}% · ${run.stats.civilians.toLocaleString("en-US")}/${run.wave_start_civilians.toLocaleString("en-US")}`);
  // The 15% line sits at the defeat threshold.
  const line = await page.locator("#h-line").evaluate((e) => parseFloat((e as HTMLElement).style.left));
  expect(line).toBeCloseTo((100 * run.defeat_threshold) / run.wave_start_civilians, 3);
  await expect(page.locator("#h-line-label")).toHaveText(`lost below ${run.defeat_threshold} civilians (15%)`);

  // Speed buttons only change the clock.
  await page.locator("#speed-2").click();
  await expect.poll(() => hook(page, (h) => h.perf!.speed)).toBe(2);
  await expect(page.locator("#speed-2")).toHaveClass(/\bon\b/);
  expect(await hook(page, (h) => h.tick)).toBe(t0 + 200);
  await page.locator("#pause").click();
  await expect.poll(() => hook(page, (h) => h.tick)).toBeGreaterThan(t0 + 200);
});

test("invalid plays are refused with the core's reason", async ({ page }) => {
  // Seed 2's first hand: Heavy stockade (100 m), Barbed wire, Rifles x3.
  await openLevel(page, MARAIS, 2);
  const hand = await hook(page, (h) => h.hand);
  expect(hand.map((c) => c.card)).toEqual(["heavy_stockade", "barbed_wire", "rifles", "rifles", "rifles"]);
  const [cx, cy] = (await hook(page, (h) => h.level!.center))!;

  // A 160 m line with the 100 m Heavy stockade: the hint shows the length
  // against the limit and the cost while dragging, then the core refuses it.
  await clickCard(page, 0);
  await expect(page.locator("#hint")).toHaveText("Drag a line on open ground (up to 100 m)");
  // A straight line across the core whose placed part (clipped at
  // buildings) is well over 100 m.
  const y = await hookWith(
    page,
    async (h, c) => {
      for (let dy = 0; dy <= 120; dy += 6)
        for (const yy of [c[1] - dy, c[1] + dy]) {
          const l = await h.fenceLength([[c[0] - 110, yy], [c[0] + 110, yy]]);
          if (l !== null && l > 130) return yy;
        }
      return null;
    },
    [cx, cy],
  );
  expect(y).not.toBeNull();
  const a: [number, number] = [cx - 110, y!];
  const b: [number, number] = [cx + 110, y!];
  {
    await centreOn(page, cx, y!);
    const [sa, sb] = await hookWith(page, (h, p) => [h.toScreen(p[0][0], p[0][1])!, h.toScreen(p[1][0], p[1][1])!], [a, b]);
    await page.mouse.move(sa.x, sa.y);
    await page.mouse.down();
    await page.mouse.move(sb.x, sb.y, { steps: 25 });
    // Mid-drag: "<n> m placed / 100 m · cost 3", marked over the limit.
    await expect(page.locator("#hint")).toHaveText(/^\d+ m placed \/ 100 m · cost 3$/);
    await expect(page.locator("#hint")).toHaveClass(/\bover\b/);
    const err = await uiAction(page, () => page.mouse.up());
    expect(err).toMatch(/^fence is \d+ m, Heavy stockade allows 100 m$/);
  }
  await expect(page.locator("#toast")).toHaveText(/Heavy stockade allows 100 m/);
  expect(await hook(page, (h) => h.structures.length)).toBe(0);

  // A garrison on a building of the next ring (not revealed yet), sent like
  // the UI would: the core refuses it.
  const outer = (await hook(page, (h) => h.buildings.find((x) => x.cells > 0 && x.wave === 2)?.index))!;
  expect(outer).toBeGreaterThanOrEqual(0);
  const e1 = await hookWith(page, (h, k) => h.playCard(2, { buildings: [k] }), outer);
  expect(e1).toMatchObject({ error: "not_revealed", message: `building ${outer} is not in the revealed area` });

  // Rifles on 4 buildings: at most 3.
  const inner = await hook(page, (h) => h.buildings.filter((x) => x.cells > 0 && x.wave === 1 && x.area > 50).slice(0, 4).map((x) => x.index));
  const e2 = await hookWith(page, (h, k) => h.playCard(2, { buildings: k }), inner);
  expect(e2).toMatchObject({ error: "too_many_buildings", message: "rifles equips at most 3 buildings" }); // the hook gets the raw core message (card ids)

  // Click-play one Rifles on 3 valid buildings, then the same building again.
  const err = await uiAction(page, async () => {
    await clickCard(page, 2);
    await expect(page.locator("#hint")).toHaveText("Click up to 3 highlighted buildings (0/3)");
    expect(await hook(page, (h) => h.drawn.layers)).toContain("valid");
    for (const k of inner.slice(0, 3)) {
      const p = (await hookWith(page, (h, i) => h.buildingPoint(i), k))!;
      await clickSim(page, p[0], p[1]);
    }
  });
  expect(err).toBeNull();
  expect(await hook(page, (h) => h.towers.map((t) => t.building).sort((x, y) => x - y))).toEqual([...inner.slice(0, 3)].sort((x, y) => x - y));
  await expect(page.locator("#h-supply")).toHaveText("11");
  const e3 = await hookWith(page, (h, k) => h.playCard(2, { buildings: [k] }), inner[0]);
  expect(e3).toMatchObject({ error: "already_garrisoned" });

  // Mulligan after a play: the button is disabled and the core says why.
  await expect(page.locator("#mulligan")).toBeDisabled();
  expect(await hook(page, (h) => h.mulligan())).toMatchObject({ error: "mulligan_after_play", message: "mulligan only before playing a card" });

});

test("tactical cards: refused in prep with a message, played mid-wave with a click", async ({ page }) => {
  // Seed 3's first hand holds Paratrooper and Grenades.
  await openLevel(page, MARAIS, 3);
  const hand = await hook(page, (h) => h.hand);
  const gi = hand.findIndex((c) => c.card === "grenades");
  expect(gi).toBeGreaterThanOrEqual(0);
  const [cx, cy] = (await hook(page, (h) => h.level!.center))!;

  // In prep: select Grenades, click the map: refused, the reason shown.
  const err = await uiAction(page, async () => {
    await clickCard(page, gi);
    await expect(page.locator("#hint")).toHaveText("Click a point in the revealed area (during the wave)");
    await clickSim(page, cx, cy);
  });
  expect(err).toBe("Grenades is a Tactical card: it can only be played during a wave, not during Prep");
  await expect(page.locator("#toast")).toHaveText(err!);
  expect(await hook(page, (h) => h.supply)).toBe(14);

  // Keep both tactical cards with the Keep buttons; a third is refused.
  const tac = hand.filter((c) => c.kind === "tactical").map((c) => c.hand_index);
  for (const i of tac) expect(await uiAction(page, () => page.locator(`#hand .hcard[data-index="${i}"] .c-keep`).click())).toBeNull();
  for (const i of tac) await expect(page.locator(`#hand .hcard[data-index="${i}"] .c-keep`)).toHaveText("Kept for next wave");
  const other = hand.find((c) => c.kind !== "tactical")!.hand_index;
  expect(await uiAction(page, () => page.locator(`#hand .hcard[data-index="${other}"] .c-keep`).click())).toBe("keep at most 2 cards");
  expect(await hook(page, (h) => h.hand.filter((c) => c.keep).map((c) => c.hand_index))).toEqual(tac);

  // Mid-wave: Grenades on the zombies, through the UI.
  await hook(page, (h) => h.pause(true));
  expect(await uiAction(page, () => page.locator("#start").click())).toBeNull();
  const t0 = await hook(page, (h) => h.tick);
  await runTo(page, t0 + 60);
  expect(await hook(page, (h) => h.phase)).toBe("running");
  const z = await hook(page, (h) => h.zombies());
  expect(z.length).toBeGreaterThan(0);
  const supply = await hook(page, (h) => h.supply);
  const err2 = await uiAction(page, async () => {
    await clickCard(page, gi);
    await clickSim(page, z[0][0], z[0][1]);
  });
  expect(err2).toBeNull();
  expect(await hook(page, (h) => h.supply)).toBe(supply - 1);
  expect(await hook(page, (h) => h.hand.some((c) => c.card === "grenades"))).toBe(false);
  // Fortifications are refused while the wave runs.
  const fi = await hook(page, (h) => h.hand.findIndex((c) => c.kind === "fortification"));
  const e = await hookWith(page, (h, i) => h.playCard(i, { polyline: [[0, 0], [10, 0]] }), fi);
  expect(e).toMatchObject({ error: "card_wrong_phase" });
  expect(e!.message).toMatch(/can only be played during prep, not during Running$/);
  // Repair and pull-down are prep only.
  expect(await hook(page, (h) => h.pullDown(0))).toMatchObject({ error: "wrong_phase" });
});

test("fog: the next ring is darkened and holds no agents", async ({ page }) => {
  await openLevel(page, MARAIS, 1);
  const st = (await hook(page, (h) => h.status))!;
  await expect.poll(() => hook(page, (h) => h.drawn.layers)).toContain("fog");
  const d = await hook(page, (h) => h.drawn);
  expect(d.layers).toEqual(expect.arrayContaining(["outside", "fog", "buildings", "agents"]));
  expect(d.fogRadius.revealed).toBeCloseTo(st.radius_m, 3);
  expect(d.fogRadius.next).toBeCloseTo(st.next_radius_m, 3);
  expect(st.next_radius_m).toBeGreaterThan(st.radius_m);
  // Buildings of the next ring are drawn (they are visible through the fog).
  const ring2 = await hook(page, (h) => h.buildings.filter((b) => b.wave === 2).length);
  expect(ring2).toBeGreaterThan(0);
  // No agent beyond the revealed disc, in prep and while the wave runs.
  const outside = (r: number) =>
    hookWith(
      page,
      async (h, rr) => {
        const [cx, cy] = h.level!.center;
        return (await h.agents()).filter((a) => a.state !== 4 && Math.hypot(a.x - cx, a.y - cy) > rr).length;
      },
      r,
    );
  expect(await outside(st.radius_m + 2)).toBe(0);
  await hook(page, (h) => h.pause(true));
  await hook(page, (h) => h.startWave());
  await runTo(page, st.tick + 400);
  expect(await outside(st.radius_m + 2)).toBe(0);
  expect(await hook(page, (h) => h.drawn.agents)).toBe(await hook(page, (h) => h.status!.stats.civilians + h.status!.stats.infected + h.status!.stats.zombies + h.status!.stats.dead));
});

test("pause and speed never change the simulation", async ({ page }) => {
  await openLevel(page, MARAIS, 1);
  const plays = async () => {
    const b = await hook(page, (h) => h.buildings.filter((x) => x.cells > 0 && x.wave === 1 && x.area > 80).slice(0, 5).map((x) => x.index));
    expect(await hookWith(page, (h, k) => h.playCard(0, { buildings: k.slice(0, 2) }), b)).toBeNull();
    expect(await hookWith(page, (h, k) => h.playCard(1, { buildings: k.slice(2, 5) }), b)).toBeNull();
    await hook(page, (h) => h.pause(true));
    expect(await hook(page, (h) => h.startWave())).toBeNull();
    return hook(page, (h) => h.tick);
  };
  const t0 = await plays();
  // Run A: 1x, 4x and pauses, through the buttons, to wave tick 300.
  await hook(page, (h) => h.pauseAt(h.tick + 300));
  await page.locator("#speed-1").click();
  await page.locator("#pause").click(); // resume
  await page.waitForTimeout(700);
  await page.locator("#pause").click(); // pause
  await page.waitForTimeout(300);
  await page.locator("#speed-4").click();
  await page.locator("#pause").click(); // resume
  await expect.poll(() => hook(page, (h) => h.perf!.paused && h.tick === h.status!.tick), { timeout: 120_000 }).toBe(true);
  await expect.poll(() => hook(page, (h) => h.tick), { timeout: 120_000 }).toBe(t0 + 300);
  const a = await hook(page, (h) => h.stateHash());
  // Run B: a new match with the same seed and actions, as fast as possible.
  await hook(page, (h) => h.newMatch(1));
  await expect.poll(() => hook(page, (h) => (h.phase === "prep" ? h.hand.length : 0)), { timeout: 60_000 }).toBe(5);
  const t1 = await plays();
  expect(t1).toBe(t0);
  await runTo(page, t0 + 300);
  const b = await hook(page, (h) => h.stateHash());
  expect(b).toEqual(a);
});
