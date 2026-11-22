// Runs sim-core's determinism fixture (crates/sim-core/src/fixture.rs) with
// the WASM build the game uses and publishes the hash on `window.__fixture`.
import init, { fixture_hash } from "../../src/wasm/pkg/sim_wasm.js";
import level from "../../../levels/paris-marais.json?raw";

type Result = { hash: string; ms: number; isolated: boolean } | { error: string };
const out = document.getElementById("out")!;

async function run(): Promise<Result> {
  try {
    await init();
    const t0 = performance.now();
    const hash = fixture_hash(level);
    return { hash, ms: performance.now() - t0, isolated: self.crossOriginIsolated };
  } catch (e) {
    return { error: String(e) };
  }
}

void run().then((r) => {
  (window as unknown as { __fixture: Result }).__fixture = r;
  out.textContent = JSON.stringify(r);
});
