// Verify a run record under Node with the WASM build (the same verifier as
// `sim-headless verify`, compiled to WASM):
//   wasm-pack build crates/sim-wasm --release --target nodejs --out-dir pkg-node
//   node tools/verify-run.mjs run.json --level levels/paris-marais.json
//   node tools/verify-run.mjs run.json --chunks chunks.json --shell shell.json
//   node tools/verify-run.mjs run.json --chunks map.json --shell map.json  (a map bundle)
//        [--expect-seed N] [--expect-deck id,id,...] [--expect-multiplier K]
// The map is always the verifier's: a level, or the shell (level JSON
// without buildings) and the chunks. The --expect-* flags are what the
// server issued. Prints the replay summary (exit 0) or the rejection (exit 1);
// exit 2 on bad arguments (unknown flag, flag given twice, stray argument).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const usage = (why) => {
  if (why) console.error(`verify-run: ${why}`);
  console.error(
    "usage: node tools/verify-run.mjs <run.json> (--level <level.json> | --chunks <chunks.json> --shell <shell.json>) " +
      "[--expect-seed N] [--expect-deck id,id,...] [--expect-multiplier K]",
  );
  process.exit(2);
};

// Every argument after the run is a known flag followed by its value, each
// flag at most once: an unknown flag, a repeated one or a stray argument is
// a usage error (an expectation must never be silently dropped). Parsed
// before the WASM package is loaded, so usage errors need no build.
const VALUED = ["--level", "--chunks", "--shell", "--expect-seed", "--expect-deck", "--expect-multiplier"];
const argv = process.argv.slice(2);
const run = argv[0];
if (!run || run.startsWith("--")) usage();
const flags = new Map();
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (!VALUED.includes(a)) usage(a.startsWith("--") ? `unknown flag ${a}` : `unexpected argument ${JSON.stringify(a)}`);
  if (flags.has(a)) usage(`${a} given twice`);
  const v = argv[++i];
  if (v === undefined || v.startsWith("--")) usage(`${a} needs a value`);
  flags.set(a, v);
}
const arg = (name) => flags.get(name);
const level = arg("--level");
const chunks = arg("--chunks");
const shell = arg("--shell");
if (!!level === !!chunks || !!chunks !== !!shell) usage("give either --level, or --chunks and --shell");

// One number grammar with `sim-headless verify` (parse_integer and
// parse_decimal in crates/sim-headless/src/verify.rs, same tests): a seed
// is `^\d+$` up to 2^64 - 1, a multiplier a plain decimal `^\d+(\.\d+)?$`
// (no sign, spaces, exponent, hex, inf or nan).
const U64_MAX = (1n << 64n) - 1n;
function integerArg(name, v) {
  if (!/^\d+$/.test(v)) usage(`${name} ${JSON.stringify(v)}: not a whole number (digits only)`);
  if (BigInt(v) > U64_MAX) usage(`${name} ${JSON.stringify(v)}: over 18446744073709551615`);
  return v; // a decimal string: JS numbers stop at 2^53
}
function decimalArg(name, v) {
  if (!/^\d+(\.\d+)?$/.test(v)) usage(`${name} ${JSON.stringify(v)}: not a plain decimal number (digits, optionally a point and more digits)`);
  const k = Number(v);
  if (!Number.isFinite(Math.fround(k))) usage(`${name} ${JSON.stringify(v)}: too large`);
  return k;
}

const expected = {};
const seed = arg("--expect-seed");
if (seed !== undefined) expected.seed = integerArg("--expect-seed", seed);
const deck = arg("--expect-deck");
if (deck !== undefined) expected.deck = deck.split(",").map((s) => s.trim()).filter(Boolean);
const mult = arg("--expect-multiplier");
if (mult !== undefined) expected.population_multiplier = decimalArg("--expect-multiplier", mult);
const expectedJson = Object.keys(expected).length ? JSON.stringify(expected) : undefined;

// A `BuildingChunk[]`, or a map bundle (the browser's "Download map": the
// shell plus a `chunks` array, so the same file is also the --shell). Read
// before the WASM package is loaded: a wrong file is a bad argument (exit 2).
function chunksJson(path) {
  const bad = (why) => {
    console.error(`verify-run: ${path}: not a chunk list or a map bundle (${why})`);
    process.exit(2);
  };
  let v;
  try {
    v = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    bad(e instanceof SyntaxError ? `invalid JSON: ${e.message}` : String(e?.message ?? e));
  }
  if (Array.isArray(v)) return JSON.stringify(v);
  if (v === null || typeof v !== "object") bad("neither an array nor an object");
  if (!Array.isArray(v.chunks)) bad("map bundle: no `chunks` array");
  return JSON.stringify(v.chunks);
}
const chunksText = chunks ? chunksJson(chunks) : undefined;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { verify_level, verify_chunks } = require(join(root, "crates/sim-wasm/pkg-node/sim_wasm.js"));

// The verdict's note on the setup fields not compared with an issued run
// ("" when all three were, i.e. `setup_checked`).
function notChecked(c) {
  const missing = [
    [c.seed, "seed"],
    [c.deck, "deck"],
    [c.population_multiplier, "multiplier"],
  ]
    .filter(([on]) => !on)
    .map(([, n]) => n);
  return missing.length ? ` (${missing.join(", ")} not checked against an issued run: --expect-*)` : "";
}

const record = readFileSync(run, "utf8");
const t0 = performance.now();
try {
  const summary = level
    ? verify_level(record, readFileSync(level, "utf8"), expectedJson)
    : verify_chunks(record, readFileSync(shell, "utf8"), chunksText, expectedJson);
  const s = JSON.parse(summary);
  console.log(JSON.stringify(s, null, 2));
  console.log(`verified: ${s.phase} at wave ${s.wave}, ${s.waves_won} waves won, ${s.attempts} attempts, ${s.end_tick} ticks, ${((performance.now() - t0) / 1000).toFixed(2)}s (WASM)${notChecked(s.checked)}`);
} catch (e) {
  const err = JSON.parse(String(e));
  console.log(JSON.stringify(err));
  console.log(`rejected: ${err.message}`);
  process.exit(1);
}
