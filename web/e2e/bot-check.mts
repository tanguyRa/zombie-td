// Runs the browser match test's scenario (scenario.ts, used by
// match.spec.ts) on WasmMatch under Node, without a browser, to check that
// a seed clears it and how many ticks it takes:
//   npm run wasm && node e2e/bot-check.mts [seed ...]
// The plays the browser test makes through the UI are plain actions here.
// Not part of any test run.
import { readFileSync } from "node:fs";
import { initSync, verify_level, WasmMatch } from "../src/wasm/pkg/sim_wasm.js";
import { runScenario, type ScenarioApi } from "./scenario.ts";
import type { Action, BotView } from "./bot.ts";

const root = new URL("../../", import.meta.url);
const wasm = initSync({ module: readFileSync(new URL("web/src/wasm/pkg/sim_wasm_bg.wasm", root)) });
const level = readFileSync(new URL("levels/paris-marais.json", root), "utf8");
const cards = JSON.parse(readFileSync(new URL("cards.json", root), "utf8"));

function api(m: WasmMatch): ScenarioApi {
  const view = (): BotView => {
    const st = JSON.parse(m.status_json());
    const info = m.building_info();
    const buildings = [];
    for (let i = 0; i < info.length / 6; i++)
      buildings.push({ index: i, x: info[6 * i], y: info[6 * i + 1], area: info[6 * i + 2], floors: info[6 * i + 3], cells: info[6 * i + 4], wave: info[6 * i + 5] });
    const t = m.towers();
    const towers = [];
    for (let i = 0; i < t.length; i += 5) towers.push({ building: t[i], x: t[i + 1], y: t[i + 2] });
    const rings = [];
    for (let w = 1; w <= st.waves; w++) rings.push(m.ring_radius_m(w));
    return { wave: st.wave, center: Array.from(m.center()) as [number, number], radius: st.radius_m, rings, hand: JSON.parse(m.hand_json()), buildings, towers, mulliganAvailable: st.mulligan_available };
  };
  return {
    view: async () => view(),
    apply: async (a: Action) => {
      try {
        m.apply(JSON.stringify(a));
        return null;
      } catch (e) {
        return JSON.parse(String(e)).message;
      }
    },
    fenceLength: async (pts) => {
      try {
        return m.fence_length_m(new Float32Array(pts.flat()));
      } catch {
        return null;
      }
    },
    status: async () => JSON.parse(m.status_json()),
    structures: async () => JSON.parse(m.structures_json()),
    repairCost: async (id) => m.repair_cost(id),
    zombies: async () => {
      m.pack();
      const n = m.count();
      const pos = new Float32Array(wasm.memory.buffer, m.positions_ptr(), n * 2);
      const st = new Uint8Array(wasm.memory.buffer, m.render_ptr(), n);
      const out: [number, number][] = [];
      for (let i = 0; i < n; i++) if (st[i] === 2) out.push([pos[2 * i], pos[2 * i + 1]]);
      return out;
    },
    runWave: async (every) => {
      while (m.phase() === "running") {
        m.step(1);
        if (m.phase() === "running" && JSON.parse(m.status_json()).wave_tick % 40 === 39) await every();
      }
    },
  };
}

const seeds = process.argv.slice(2).map(Number);
for (const seed of seeds.length ? seeds : [1]) {
  const m = new WasmMatch(level, JSON.stringify({ seed }));
  const t0 = performance.now();
  const log = await runScenario(api(m), cards, (s) => console.log(`  ${s}`));
  const st = JSON.parse(m.status_json());
  const t1 = performance.now();
  const v = JSON.parse(verify_level(m.record(), level));
  console.log(
    `seed ${seed}: ${st.phase} at wave ${st.wave}, ${st.tick} ticks, ${st.retries} retries, played in ${((t1 - t0) / 1000).toFixed(1)} s, ` +
      `verified (${v.attempt_hashes.length} attempts) in ${((performance.now() - t1) / 1000).toFixed(1)} s; ${JSON.stringify(log.counts)}`,
  );
  m.free();
}
