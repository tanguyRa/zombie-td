// WASM benchmark under Node: same level, seed and tick count as the native bench.
//   node tools/wasm-bench.mjs --pops 10000,50000,100000 --ticks 3000 --out reports/bench-wasm.json
// Expects `wasm-pack build crates/sim-wasm --release --target nodejs --out-dir pkg-node` first.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { WasmSim } = require(join(root, "crates/sim-wasm/pkg-node/sim_wasm.js"));

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
};
const pops = arg("--pops", "10000,50000,100000").split(",").map(Number);
const ticks = Number(arg("--ticks", "3000"));
const seed = Number(arg("--seed", "1"));
const level = arg("--level", "paris-marais");
const out = arg("--out", join(root, "reports/bench-wasm.json"));

const levelJson = readFileSync(join(root, "levels", `${level}.json`), "utf8");
const configJson = readFileSync(join(root, "config.default.json"), "utf8");

const runs = [];
for (const population of pops) {
  const sim = new WasmSim(levelJson, configJson, population, seed);
  sim.start();
  const run = { runtime: "wasm", population, ticks, tick_ms: [], phase_ms: [], dormant_share: [] };
  for (let t = 0; t < ticks; t++) {
    if (sim.game_phase() >= 2) break;
    sim.step(1);
    const ph = Array.from(sim.phase_ms());
    run.tick_ms.push(ph.reduce((a, b) => a + b, 0));
    run.phase_ms.push(ph);
    const st = sim.stats();
    run.dormant_share.push(st[0] > 0 ? st[4] / st[0] : 0);
  }
  const sorted = [...run.tick_ms].sort((a, b) => a - b);
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.round((q / 100) * (sorted.length - 1)))];
  console.error(`wasm ${population}: p50 ${p(50).toFixed(2)} p95 ${p(95).toFixed(2)} max ${sorted.at(-1).toFixed(2)} ms`);
  runs.push(run);
  sim.free();
}
writeFileSync(out, JSON.stringify(runs));
