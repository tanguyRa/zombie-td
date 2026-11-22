// Verify a run record under Node with the WASM build (the same verifier as
// `sim-headless verify`, compiled to WASM):
//   wasm-pack build crates/sim-wasm --release --target nodejs --out-dir pkg-node
//   node tools/verify-run.mjs run.json --level levels/paris-marais.json
//   node tools/verify-run.mjs run.json --chunks chunks.json
// Prints the replay summary (exit 0) or the rejection (exit 1).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { verify_level, verify_chunks } = require(join(root, "crates/sim-wasm/pkg-node/sim_wasm.js"));

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const run = process.argv[2];
const level = arg("--level");
const chunks = arg("--chunks");
if (!run || run.startsWith("--") || !!level === !!chunks) {
  console.error("usage: node tools/verify-run.mjs <run.json> (--level <level.json> | --chunks <chunks.json>)");
  process.exit(2);
}
const record = readFileSync(run, "utf8");
const t0 = performance.now();
try {
  const summary = level ? verify_level(record, readFileSync(level, "utf8")) : verify_chunks(record, readFileSync(chunks, "utf8"));
  const s = JSON.parse(summary);
  console.log(JSON.stringify(s, null, 2));
  console.log(`verified: ${s.phase} at wave ${s.wave}, ${s.waves_won} waves won, ${s.attempts} attempts, ${s.end_tick} ticks, ${((performance.now() - t0) / 1000).toFixed(2)}s (WASM)`);
} catch (e) {
  const err = JSON.parse(String(e));
  console.log(JSON.stringify(err));
  console.log(`rejected: ${err.message}`);
  process.exit(1);
}
