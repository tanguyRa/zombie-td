// The replay panel's check rows (src/ui/replayui.ts `checkRows`): which row,
// or the final one, a `diverged` error from the Replayer turns red.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { ReplayCheck, VerifyErrorJson } from "../../src/protocol";
import type { RecordView } from "../../src/replay";
import { checkRows } from "../../src/ui/replayui";
import { REPO } from "./fixtures";

const GOLDEN = JSON.parse(readFileSync(`${REPO}crates/sim-core/tests/fixtures/run_record_golden.json`, "utf8")) as RecordView;
const withEnd = (phase: string): RecordView => ({ ...GOLDEN, end: { ...GOLDEN.end, phase } });
const diverged = (attempt: number, what: string): VerifyErrorJson => ({ error: "diverged", message: "x", attempt, wave: 8, tick: 1, what, record: "a", replay: "b" });
const noChecks: ReplayCheck[] = [];

describe("replay panel check rows", () => {
  const n = GOLDEN.attempts.length;

  for (const phase of ["wave_won", "wave_lost", "match_won"])
    for (const what of ["start_tick", "prep_hash", "end_hash"])
      it(`a ${what} divergence at attempt n marks the final row on a record ending in ${phase}`, () => {
        const { rows, final } = checkRows(withEnd(phase), noChecks, diverged(n, what));
        expect(rows).toHaveLength(n);
        expect(rows.every((r) => r.prep !== "bad" && r.end !== "bad")).toBe(true);
        expect(final).toBe("bad");
      });

  for (const phase of ["prep", "running"])
    it(`a prep divergence at attempt n marks the open attempt's prep on a record ending in ${phase}`, () => {
      const { rows, final } = checkRows(withEnd(phase), noChecks, diverged(n, "prep_hash"));
      expect(rows).toHaveLength(n + 1);
      expect(rows[n].prep).toBe("bad");
      expect(final).toBe("pending");
    });

  it("a divergence inside the record marks its attempt's row, not the final one", () => {
    const { rows, final } = checkRows(GOLDEN, noChecks, diverged(2, "prep_hash"));
    expect(rows[2].prep).toBe("bad");
    expect(final).toBe("pending");
    const e = checkRows(GOLDEN, noChecks, diverged(3, "end_hash"));
    expect(e.rows[3].end).toBe("bad");
    expect(e.final).toBe("pending");
  });

  it("a final hash divergence and a non-divergence error mark the final row", () => {
    expect(checkRows(GOLDEN, noChecks, diverged(n, "final_hash")).final).toBe("bad");
    expect(checkRows(GOLDEN, noChecks, { error: "bad_record", message: "x" }).final).toBe("bad");
    expect(checkRows(GOLDEN, [{ attempt: n, wave: 8, tick: 1, what: "final", hash: "h" }], null).final).toBe("ok");
  });
});
