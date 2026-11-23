// The native verifier (`sim-headless verify`, release build) for the
// browser tests: verify a downloaded run record on a committed level.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
/** ~5 s per Marais record, plus a release build of sim-headless if its
 *  sources changed (cargo runs it; ~1 min from a warm cache). */
export const VERIFY_MS = 5 * 60_000;

export interface VerifiedRun {
  phase: string;
  waves_won: number;
  retries: number;
  attempts: number;
  attempt_hashes: string[];
  final_hash: string;
  setup: { seed: string; population_multiplier: number; deck: string[] };
}

/** `sim-headless verify <record> --level <level>`: the summary, or throws with its output. */
export function verifyNative(recordPath: string, level = "levels/paris-marais.json"): VerifiedRun {
  let out: string;
  try {
    out = execFileSync("cargo", ["run", "--release", "-q", "-p", "sim-headless", "--", "verify", recordPath, "--level", level, "--quiet"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 << 20,
      timeout: VERIFY_MS,
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    throw new Error(`sim-headless verify rejected the record:\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
  }
  const at = out.lastIndexOf("\nverified:");
  expect(at, out).toBeGreaterThan(0);
  return JSON.parse(out.slice(0, at));
}
