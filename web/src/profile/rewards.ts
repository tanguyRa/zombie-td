// Match payout, daily caps and the local day (pure functions; the service
// stores the results).

import type { RewardsTable } from "./data";
import { TIERS, type MatchSummary, type Payout } from "./types";

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
/// list of problems ([] = fine). `maxRadiusM` bounds the defended radius
/// (`ProfileTables.maxDefendedRadiusM`): the coverage cells are enumerated
/// from it, so an absurd radius would mean millions of cells.
///
/// `isCard` tells known card ids (for `mvpCard`); without it any non-empty
/// string passes. `city` and `district` must be strings (they come from the
/// place search's admin fields, see place.ts); `cityId` is not checked here:
/// an id that isn't `osm:relation:<digits>` is ignored, not refused.
export function checkSummary(s: MatchSummary, maxRadiusM: number, isCard?: (id: string) => boolean): string[] {
  const p: string[] = [];
  if (!s || typeof s !== "object") return ["not a match summary"];
  const int = (v: unknown) => typeof v === "number" && Number.isInteger(v);
  if (typeof s.matchId !== "string" || !s.matchId) p.push("matchId is empty");
  if (!(TIERS as readonly unknown[]).includes(s.tier)) p.push(`unknown tier ${String(s.tier)}`);
  if (!int(s.wavesWon) || s.wavesWon < 0 || s.wavesWon > 8) p.push("wavesWon must be 0..8");
  if (!int(s.furthestWave) || s.furthestWave < 1 || s.furthestWave > 8) p.push("furthestWave must be 1..8");
  if (int(s.wavesWon) && int(s.furthestWave) && s.furthestWave !== Math.min(8, s.wavesWon + 1)) p.push("furthestWave must be wavesWon + 1 (8 when cleared)");
  if (!Array.isArray(s.savedPerWave) || s.savedPerWave.length > s.wavesWon || s.savedPerWave.some((v) => !(int(v) && v >= 0))) p.push("savedPerWave: one integer count >= 0 per wave won");
  if (!int(s.retries) || s.retries < 0) p.push("retries must be >= 0");
  if (!(typeof s.defendedRadiusM === "number" && Number.isFinite(s.defendedRadiusM) && s.defendedRadiusM >= 0 && s.defendedRadiusM <= maxRadiusM)) {
    p.push(`defendedRadiusM must be a number in 0..${maxRadiusM}`);
  }
  if (!s.center || !Number.isFinite(s.center.lat) || !Number.isFinite(s.center.lon) || Math.abs(s.center.lat) > 90 || Math.abs(s.center.lon) > 180) p.push("center is not a lat/lon");
  if (typeof s.city !== "string") p.push("city must be a string");
  if (typeof s.district !== "string") p.push("district must be a string");
  if (!(s.mvpCard === null || (typeof s.mvpCard === "string" && s.mvpCard.length > 0 && (isCard ? isCard(s.mvpCard) : true)))) p.push(`mvpCard must be a known card id or null, not ${String(s.mvpCard)}`);
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

/// Latest UTC offset in use (UTC+14, Kiribati), in minutes.
const MAX_UTC_OFFSET_MIN = 14 * 60;

/// The day the daily counters use: the local day, but never earlier than
/// the last day stored while that day is plausible. Travelling west after
/// midnight (or setting the clock back by less than a day) doesn't reopen a
/// day whose caps were already used; travelling east starts the next day
/// early, once.
///
/// The stored day is held only while it is at most one day ahead of today's
/// local day (or no later than the date at UTC+14, for a trip across the
/// date line): it is then a real current date somewhere. Further ahead, the
/// clock was wrong when it was stored (set a year ahead, then corrected) and
/// today's local day is used, so the caps don't freeze until real time
/// catches up. The cost is one extra set of caps per such clock change; a
/// server owns the counters with its own clock.
export function effectiveDay(clock: Clock, lastDay: string): string {
  const now = clock.now();
  const offset = clock.utcOffsetMinutes(now);
  const d = localDay(now, offset);
  if (!lastDay || lastDay <= d) return d;
  const tomorrow = localDay(now + 24 * 3600_000, offset);
  const furthest = localDay(now, MAX_UTC_OFFSET_MIN);
  return lastDay <= tomorrow || lastDay <= furthest ? lastDay : d;
}
