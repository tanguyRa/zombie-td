import type { Clock } from "../../src/profile/rewards";
import type { MatchSummary, Tier } from "../../src/profile/types";

/// A settable clock: epoch ms and a UTC offset in minutes (east positive).
export class FakeClock implements Clock {
  constructor(
    public t: number,
    public offset = 0,
  ) {}
  now() {
    return this.t;
  }
  utcOffsetMinutes() {
    return this.offset;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;

/// 2026-11-22 10:00 UTC.
export const T0 = Date.UTC(2026, 10, 22, 10, 0, 0);

export const PARIS = { lat: 48.8566, lon: 2.3522 };

let n = 0;
/// A cleared (default) or abandoned match summary.
export function summary(over: Partial<MatchSummary> = {}): MatchSummary {
  const wavesWon = over.wavesWon ?? 8;
  const s: MatchSummary = {
    matchId: `m-${++n}`,
    center: PARIS,
    city: "Paris",
    district: "Le Marais",
    tier: "recruit" as Tier,
    wavesWon,
    furthestWave: Math.min(8, wavesWon + 1),
    savedPerWave: Array.from({ length: wavesWon }, (_, i) => 1000 * (i + 1)),
    retries: 0,
    mvpCard: "rifles",
    defendedRadiusM: wavesWon >= 8 ? 1300 : 0,
    runRecordId: `rr-${n}`,
    ...over,
  };
  return s;
}
