// Cross-browser determinism: the fixture run (Paris, 5k agents, seed 2026, one
// tower, one fence, 400 ticks) must hash exactly like native sim-core.
import native from "../../crates/sim-core/tests/fixtures/native_hash.json" with { type: "json" };
import { expect, test } from "./offline";

test("fixture hash matches native", async ({ page, browserName }) => {
  // Firefox takes 15-18 s for the fixture alone, but once took 134 s while
  // another Playwright run shared the machine: give it 3x the test timeout
  // and a 400 s wait. The hash must still match exactly.
  const firefox = browserName === "firefox";
  test.slow(firefox, "Firefox runs the fixture slowly under load");
  await page.goto("/e2e/pages/fixture.html");
  const r = await page.waitForFunction(() => (window as unknown as { __fixture?: unknown }).__fixture, null, { timeout: firefox ? 400_000 : 120_000 });
  const res = (await r.jsonValue()) as { hash?: string; ms?: number; error?: string };
  expect(res.error, "fixture threw").toBeUndefined();
  console.log(`${browserName}: fixture hash ${res.hash} in ${res.ms?.toFixed(0)} ms (native ${native.hash})`);
  expect(res.hash).toBe(native.hash);
});
