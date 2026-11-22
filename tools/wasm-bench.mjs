// WASM benchmark under Node: same level, seed and tick count as the native bench.
//   node tools/wasm-bench.mjs --pops 10000,50000,100000 --ticks 3000 --out reports/bench-wasm.json
// Expects `wasm-pack build crates/sim-wasm --release --target nodejs --out-dir pkg-node` first.
// The scale bench (`sim-headless bench --scale`) passes --level-file and
// --config-file instead of a committed level name.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const wasmPkg = require(join(root, "crates/sim-wasm/pkg-node/sim_wasm.js"));
const { WasmSim } = wasmPkg;

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
};
const pops = arg("--pops", "10000,50000,100000").split(",").map(Number);
const ticks = Number(arg("--ticks", "3000"));
const seed = Number(arg("--seed", "1"));
const level = arg("--level", "paris-marais");
const out = arg("--out", join(root, "reports/bench-wasm.json"));
// Stop once civilians fall below this share of the population (0 = never).
const stopCiv = Number(arg("--stop-civ-share", "0"));

const levelFile = arg("--level-file", join(root, "levels", `${level}.json`));
const levelJson = readFileSync(levelFile, "utf8");
const configJson = readFileSync(arg("--config-file", join(root, "config.default.json")), "utf8");

const runs = [];
for (const population of pops) {
  const t0 = performance.now();
  const sim = new WasmSim(levelJson, configJson, population, seed);
  sim.start();
  const setup_ms = performance.now() - t0;
  const run = { runtime: "wasm", population, ticks, tick_ms: [], phase_ms: [], dormant_share: [], setup_ms, memory_bytes: 0, fence_cells_broken: 0, break_ticks: 0 };
  for (let t = 0; t < ticks; t++) {
    if (sim.game_phase() >= 2) break;
    if (stopCiv > 0 && sim.stats()[0] < stopCiv * population) break;
    const broken = sim.stats()[11];
    sim.step(1);
    const ph = Array.from(sim.phase_ms());
    run.tick_ms.push(ph.reduce((a, b) => a + b, 0));
    run.phase_ms.push(ph);
    const st = sim.stats();
    run.dormant_share.push(st[0] > 0 ? st[4] / st[0] : 0);
    if (st[11] > broken) run.break_ticks++;
    run.fence_cells_broken = st[11];
  }
  // Linear memory only grows, so this is the peak for this run (and earlier ones).
  run.memory_bytes = wasmPkg.__wasm.memory.buffer.byteLength;
  const sorted = [...run.tick_ms].sort((a, b) => a - b);
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.round((q / 100) * (sorted.length - 1)))];
  console.error(`wasm ${population}: p50 ${p(50).toFixed(2)} p95 ${p(95).toFixed(2)} max ${sorted.at(-1).toFixed(2)} ms, memory ${(run.memory_bytes / 1048576).toFixed(0)} MB, ${run.fence_cells_broken} fence cells broken on ${run.break_ticks} ticks`);
  runs.push(run);
  sim.free();
}
writeFileSync(out, JSON.stringify(runs));
