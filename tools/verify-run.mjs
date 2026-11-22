// Verify a run record under Node with the WASM build (the same verifier as
// `sim-headless verify`, compiled to WASM):
//   wasm-pack build crates/sim-wasm --release --target nodejs --out-dir pkg-node
//   node tools/verify-run.mjs run.json --level levels/paris-marais.json
//   node tools/verify-run.mjs run.json --chunks chunks.json --shell shell.json
//        [--expect-seed N] [--expect-deck id,id,...] [--expect-multiplier K]
// The map is always the verifier's: a level, or the shell (level JSON
// without buildings) and the chunks. The --expect-* flags are what the
// server issued. Prints the replay summary (exit 0) or the rejection (exit 1).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { verify_level, verify_chunks } = require(join(root, "crates/sim-wasm/pkg-node/sim_wasm.js"));

const usage = () => {
  console.error(
    "usage: node tools/verify-run.mjs <run.json> (--level <level.json> | --chunks <chunks.json> --shell <shell.json>) " +
      "[--expect-seed N] [--expect-deck id,id,...] [--expect-multiplier K]",
  );
  process.exit(2);
};
const arg = (name) => {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) usage();
  return v;
};
const run = process.argv[2];
const level = arg("--level");
const chunks = arg("--chunks");
const shell = arg("--shell");
if (!run || run.startsWith("--") || !!level === !!chunks || !!chunks !== !!shell) usage();

const expected = {};
const seed = arg("--expect-seed");
if (seed !== undefined) {
  if (!/^\d+$/.test(seed)) usage();
  expected.seed = seed; // a decimal string: JS numbers stop at 2^53
}
const deck = arg("--expect-deck");
if (deck !== undefined) expected.deck = deck.split(",").map((s) => s.trim()).filter(Boolean);
const mult = arg("--expect-multiplier");
if (mult !== undefined) {
  if (!Number.isFinite(Number(mult))) usage();
  expected.population_multiplier = Number(mult);
}
const expectedJson = Object.keys(expected).length ? JSON.stringify(expected) : undefined;

const record = readFileSync(run, "utf8");
const t0 = performance.now();
try {
  const summary = level
    ? verify_level(record, readFileSync(level, "utf8"), expectedJson)
    : verify_chunks(record, readFileSync(shell, "utf8"), readFileSync(chunks, "utf8"), expectedJson);
  const s = JSON.parse(summary);
  console.log(JSON.stringify(s, null, 2));
  console.log(`verified: ${s.phase} at wave ${s.wave}, ${s.waves_won} waves won, ${s.attempts} attempts, ${s.end_tick} ticks, ${((performance.now() - t0) / 1000).toFixed(2)}s (WASM)`);
} catch (e) {
  const err = JSON.parse(String(e));
  console.log(JSON.stringify(err));
  console.log(`rejected: ${err.message}`);
  process.exit(1);
}
