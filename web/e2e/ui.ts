// Helpers for the match tests: open a level, play through the real UI
// (clicks on cards, buildings and map points, line drags), and the bot's
// view of the page through the test hook.
import { expect, type Page } from "@playwright/test";
import { hook, hookWith } from "./offline";
import type { Action, BotView } from "./bot";
import type { Status, Structure, ScenarioApi } from "./scenario";

/** Level load and match creation can take a while when three browsers
 *  share the CPU. */
export const LOAD_WAIT_MS = 60_000;
export const MAP_IDLE_WAIT_MS = 15_000;
/** The most `openLevel` can wait: two loads (preset, then the seed's new match) and the map. */
export const OPEN_LEVEL_MS = 2 * LOAD_WAIT_MS + MAP_IDLE_WAIT_MS;

/** Open a built-in level with `?test=1` and wait for wave 1's prep. */
export async function openLevel(page: Page, preset: string, seed: number) {
  await page.goto("/?test=1");
  await page.waitForFunction(() => !!window.__zt);
  await page.getByRole("button", { name: preset }).click();
  await expect.poll(() => hook(page, (h) => h.phase), { timeout: LOAD_WAIT_MS }).toBe("prep");
  if (seed !== 1) {
    // Enter commits the seed (in prep, no confirmation): one new match (the
    // page drops the old status at once, so the poll below waits for the new).
    await page.locator("#seed").fill(String(seed));
    await page.locator("#seed").press("Enter");
    await expect.poll(() => hook(page, (h) => (h.phase === "prep" ? h.hand.length : 0)), { timeout: LOAD_WAIT_MS }).toBe(5);
  }
  await waitMapIdle(page);
}

/** Run the current wave until match tick `tick` (test-only fast mode), paused there. */
export async function runTo(page: Page, tick: number) {
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

export async function waitMapIdle(page: Page) {
  await expect.poll(() => hook(page, (h) => h.mapIdle), { timeout: MAP_IDLE_WAIT_MS }).toBe(true);
}

/** Centre the map on a sim point (a view change only) and return its
 *  screen position, so it is never under a panel. */
export async function centreOn(page: Page, x: number, y: number) {
  await hookWith(
    page,
    (h, p) => {
      const c = h.toScreen(p[0], p[1])!;
      const r = h.debug.map.getCanvas().getBoundingClientRect();
      h.debug.map.panBy([c.x - (r.left + r.width / 2), c.y - (r.top + r.height / 2)], { duration: 0 });
    },
    [x, y],
  );
  await waitMapIdle(page);
  return (await hookWith(page, (h, p) => h.toScreen(p[0], p[1]), [x, y]))!;
}

/** Click a sim point on the map. */
export async function clickSim(page: Page, x: number, y: number) {
  const s = await centreOn(page, x, y);
  await page.mouse.click(s.x, s.y);
}

/** Click a hand card (on its name, not on its Keep button). */
export async function clickCard(page: Page, handIndex: number) {
  await page.locator(`#hand .hcard[data-index="${handIndex}"] .c-name`).click();
}

/** Do something in the UI that sends one action, and return its refusal
 *  message (or null): waits for the UI's action counter to move. */
export async function uiAction(page: Page, doIt: () => Promise<void>): Promise<string | null> {
  const before = await hook(page, (h) => h.uiActions.count);
  await doIt();
  await expect.poll(() => hook(page, (h) => h.uiActions.count), { timeout: 15_000 }).toBeGreaterThan(before);
  return hook(page, (h) => h.uiActions.error?.message ?? null);
}

export async function view(page: Page): Promise<BotView> {
  return hook(page, (h) => ({
    wave: h.wave,
    center: h.level!.center,
    radius: h.status!.radius_m,
    rings: h.level!.rings,
    hand: h.hand,
    buildings: h.buildings,
    towers: h.towers,
    mulliganAvailable: h.status!.mulligan_available,
  })) as Promise<BotView>;
}

/** The scenario's API on the page: the bot through the hook, and the UI
 *  plays the test wants made with real clicks and drags. */
export function pageApi(page: Page, opts: { onWave?: (s: Status) => void; deadline?: number } = {}): ScenarioApi {
  const apply = (a: Action) => hookWith(page, (h, act) => h.act(act as never).then((e) => (e ? e.message : null)), a);
  const status = () => hook(page, (h) => h.status!) as Promise<Status>;
  return {
    view: () => view(page),
    apply,
    fenceLength: (pts) => hookWith(page, (h, p) => h.fenceLength(p), pts),
    status,
    structures: () => hook(page, (h) => h.structures) as Promise<Structure[]>,
    // The repair cost of a fence, from the worker's pick at one of its cells.
    repairCost: (id) =>
      hookWith(
        page,
        async (h, i) => {
          const s = h.structures.find((x) => x.id === i);
          if (!s || s.kind.type !== "fence" || s.kind.cells.length === 0) return -1;
          const l = h.level!;
          const c = s.kind.cells[0];
          const p = await h.pick(((c % l.gridW) + 0.5) * l.cell, (Math.floor(c / l.gridW) + 0.5) * l.cell);
          return p.structure === i ? p.repairCost : -1;
        },
        id,
      ),
    zombies: () => hook(page, (h) => h.zombies()),
    // Run the wave at full speed, pausing on each 40th wave tick (like the
    // Node check's `every`) only while a tactical card could be played.
    runWave: async (every) => {
      const deadline = opts.deadline ?? Date.now() + 10 * 60_000;
      const left = () => Math.max(1_000, deadline - Date.now());
      for (;;) {
        const st = await status();
        if (st.phase !== "running") break;
        opts.onWave?.(st);
        if (Date.now() > deadline) throw new Error(`wave ${st.wave} still running at tick ${st.tick}`);
        const tactical = await hook(page, (h) => h.hand.some((c) => c.kind === "tactical" && c.target === "point" && c.playable));
        if (tactical) {
          let delta = (39 - (st.wave_tick % 40) + 40) % 40;
          if (delta === 0) delta = 40;
          const target = st.tick + delta;
          await hookWith(
            page,
            (h, t) => {
              h.pauseAt(t);
              h.speed(0);
              h.pause(false);
            },
            target,
          );
          await expect
            .poll(() => hookWith(page, (h, t) => h.status!.phase !== "running" || (h.perf!.paused && h.tick >= t), target), { timeout: left(), intervals: [50, 100, 250] })
            .toBe(true);
          const now = await status();
          if (now.phase !== "running") break;
          expect(now.tick).toBe(target);
          await every();
        } else {
          await hook(page, (h) => {
            h.pauseAt(null);
            h.speed(0);
            h.pause(false);
          });
          await expect.poll(() => hook(page, (h) => h.phase), { timeout: left(), intervals: [100, 250, 500] }).not.toBe("running");
        }
      }
    },
    ui: {
      playArmament: (i, buildings) =>
        uiAction(page, async () => {
          await clickCard(page, i);
          for (const b of buildings) {
            const p = (await hookWith(page, (h, k) => h.buildingPoint(k), b))!;
            await clickSim(page, p[0], p[1]);
          }
        }),
      playFence: (i, pts) =>
        uiAction(page, async () => {
          await clickCard(page, i);
          await dragSim(page, pts[0], pts[pts.length - 1]);
        }),
      pullDown: (id) =>
        uiAction(page, async () => {
          const s = (await hook(page, (h) => h.structures)).find((x) => x.id === id)!;
          if (s.kind.type !== "fence") throw new Error("pullDown: fences only");
          const c = s.kind.cells[Math.floor(s.kind.cells.length / 2)];
          const [x, y] = await hookWith(page, (h, k) => [((k % h.level!.gridW) + 0.5) * h.level!.cell, (Math.floor(k / h.level!.gridW) + 0.5) * h.level!.cell], c);
          await clickSim(page, x, y);
          await expect(page.locator("#inspect")).toBeVisible();
          await expect(page.locator("#i-pull")).toHaveText(/^Pull down \(\+\d+ supply\)$/);
          await page.locator("#i-pull").click();
        }),
      // Click the fence, check the panel shows the worker's current cost,
      // then the panel's Repair button.
      repair: (id) =>
        uiAction(page, async () => {
          const s = (await hook(page, (h) => h.structures)).find((x) => x.id === id)!;
          if (s.kind.type !== "fence") throw new Error("repair: fences only");
          const c = s.kind.cells[Math.floor(s.kind.cells.length / 2)];
          const [x, y] = await hookWith(page, (h, k) => [((k % h.level!.gridW) + 0.5) * h.level!.cell, (Math.floor(k / h.level!.gridW) + 0.5) * h.level!.cell], c);
          await clickSim(page, x, y);
          await expect(page.locator("#inspect")).toBeVisible();
          await expect(page.locator("#inspect")).toHaveAttribute("data-structure", String(id));
          const pick = await hookWith(page, (h, p) => h.pick(p[0], p[1]), [x, y]);
          expect(pick.structure).toBe(id);
          const cost = pick.repairCost;
          expect(cost).toBeGreaterThan(0);
          await expect(page.locator("#i-repair")).toHaveText(`Repair (${cost} supply)`);
          await expect(page.locator("#i-repair")).toBeEnabled();
          await page.locator("#i-repair").click();
        }),
      playTactical: (i, p) =>
        uiAction(page, async () => {
          await clickCard(page, i);
          await clickSim(page, p[0], p[1]);
        }),
      mulligan: () => uiAction(page, () => page.locator("#mulligan").click()),
      keep: async (indices) => {
        // Toggle Keep on each wanted card (none are marked yet in prep).
        for (const i of indices) {
          const e = await uiAction(page, () => page.locator(`#hand .hcard[data-index="${i}"] .c-keep`).click());
          if (e) return e;
          await expect(page.locator(`#hand .hcard[data-index="${i}"] .c-keep`)).toHaveClass(/\bon\b/);
        }
        if (indices.length === 0) return hookWith(page, (h, a) => h.keep(a).then((e) => (e ? e.message : null)), indices);
        return null;
      },
      // Start paused (test-only `startPaused`: every prep starts unpaused,
      // and a pause belongs to its wave): the wave then waits for runWave,
      // which knows the tick.
      startWave: async () => {
        await hook(page, (h) => h.startPaused());
        const e = await uiAction(page, () => page.locator("#start").click());
        if (e === null) await expect.poll(() => hook(page, (h) => h.perf!.paused)).toBe(true);
        return e;
      },
      nextWave: async () => {
        await expect(page.locator("#result")).toBeVisible();
        return uiAction(page, () => page.locator("#r-next").click());
      },
      retryWave: async () => {
        await expect(page.locator("#result")).toBeVisible();
        await expect(page.locator("#r-title")).toHaveText(/^Wave \d lost$/);
        return uiAction(page, () => page.locator("#r-retry").click());
      },
    },
  };
}

/** Drag a straight line between two sim points (both on screen). */
export async function dragSim(page: Page, a: [number, number], b: [number, number]) {
  await centreOn(page, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  const [sa, sb] = await hookWith(page, (h, p) => [h.toScreen(p[0][0], p[0][1])!, h.toScreen(p[1][0], p[1][1])!], [a, b]);
  await page.mouse.move(sa.x, sa.y);
  await page.mouse.down();
  await page.mouse.move(sb.x, sb.y, { steps: 20 });
  await page.mouse.up();
}
