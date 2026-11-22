// Match seeds: a u64 in sim-core, sent to the worker as a decimal string
// (JS numbers are exact only up to 2^53).

const U64_MAX = BigInt("18446744073709551615");

/** `v` as a canonical decimal u64 string ("007" gives "7"), or null if it is
 *  not a whole number from 0 to 2^64 - 1. Never goes through `Number`. */
export function parseSeed(v: string): string | null {
  const t = v.trim();
  if (!/^\d{1,20}$/.test(t)) return null;
  const b = BigInt(t);
  return b <= U64_MAX ? b.toString() : null;
}
