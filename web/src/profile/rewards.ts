// Match payout, daily caps and the local day (pure functions; the service
// stores the results).

import type { RewardsTable } from "./data";
import type { MatchSummary, Payout } from "./types";

/// The payout of one match (paid once per match id, see `claimMatch`):
///
///   wave      = furthest_wave_tickets[furthestWave - 1]
///   cleared   = cleared_tickets                 if wavesWon == 8, else 0
///   civilians = min(max_civilian_tickets, floor(max(savedPerWave) / civilians_per_ticket))
///   noRetry   = no_retry_bonus_tickets          if cleared and retries == 0, else 0
///   total     = wave + cleared + civilians + noRetry
///
/// Abandoning in wave 1 pays nothing (wave 1 is worth 0 and no wave was won,
/// so savedPerWave is empty). Civilians are the most alive at the end of any
/// won wave: survivors carry over, so a sum would count them several times.
/// The tier changes nothing here: harder tiers pay better crates, not more tickets.
export function computePayout(t: RewardsTable["payout"], s: MatchSummary): Payout {
  const furthest = Math.min(8, Math.max(1, Math.floor(s.furthestWave)));
  const cleared = s.wavesWon >= 8;
  const waveTickets = t.furthest_wave_tickets[furthest - 1] ?? 0;
  const clearedTickets = cleared ? t.cleared_tickets : 0;
  const saved = s.savedPerWave.length ? Math.max(0, ...s.savedPerWave.map((v) => (Number.isFinite(v) ? v : 0))) : 0;
  const civilianTickets = Math.min(t.max_civilian_tickets, Math.floor(saved / t.civilians_per_ticket));
  const noRetryBonus = cleared && s.retries === 0 ? t.no_retry_bonus_tickets : 0;
  return { waveTickets, clearedTickets, civilianTickets, noRetryBonus, total: waveTickets + clearedTickets + civilianTickets + noRetryBonus };
}

/// Checks a summary is self-consistent before anything is paid. Returns a
/// list of problems ([] = fine).
export function checkSummary(s: MatchSummary): string[] {
  const p: string[] = [];
  const int = (v: unknown) => typeof v === "number" && Number.isInteger(v);
  if (typeof s.matchId !== "string" || !s.matchId) p.push("matchId is empty");
  if (!int(s.wavesWon) || s.wavesWon < 0 || s.wavesWon > 8) p.push("wavesWon must be 0..8");
  if (!int(s.furthestWave) || s.furthestWave < 1 || s.furthestWave > 8) p.push("furthestWave must be 1..8");
  if (int(s.wavesWon) && int(s.furthestWave) && s.furthestWave !== Math.min(8, s.wavesWon + 1)) p.push("furthestWave must be wavesWon + 1 (8 when cleared)");
  if (!Array.isArray(s.savedPerWave) || s.savedPerWave.length > s.wavesWon || s.savedPerWave.some((v) => !(typeof v === "number" && v >= 0))) p.push("savedPerWave: one count >= 0 per wave won");
  if (!int(s.retries) || s.retries < 0) p.push("retries must be >= 0");
  if (!(typeof s.defendedRadiusM === "number" && s.defendedRadiusM >= 0)) p.push("defendedRadiusM must be >= 0");
  if (!s.center || !Number.isFinite(s.center.lat) || !Number.isFinite(s.center.lon) || Math.abs(s.center.lat) > 90 || Math.abs(s.center.lon) > 180) p.push("center is not a lat/lon");
  return p;
}

/// The clock, injectable for tests: epoch ms and the local UTC offset
/// (minutes east of UTC) at that instant.
export interface Clock {
  now(): number;
  utcOffsetMinutes(at: number): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  utcOffsetMinutes: (at) => -new Date(at).getTimezoneOffset(),
};

/// The local calendar day "YYYY-MM-DD" at `at` with that UTC offset.
export function localDay(at: number, offsetMinutes: number): string {
  return new Date(at + offsetMinutes * 60000).toISOString().slice(0, 10);
}

/// The day the daily counters use: the local day, but never earlier than
/// the last day stored. Travelling west after midnight (or setting the clock
/// back) doesn't reopen a day whose caps were already used; travelling east
/// starts the next day early, once.
export function effectiveDay(clock: Clock, lastDay: string): string {
  const now = clock.now();
  const d = localDay(now, clock.utcOffsetMinutes(now));
  return lastDay && lastDay > d ? lastDay : d;
}
