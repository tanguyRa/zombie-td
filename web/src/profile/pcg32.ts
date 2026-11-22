// PCG32 (XSH-RR), a port of sim-core's `rng.rs` (same constants, same
// seeding, same `below`), for the profile's crate rolls. Crates are not part
// of a match or a replay: this generator is seeded locally per profile and
// never touches the match seed. BigInt arithmetic: crates are not hot.

const MASK = (1n << 64n) - 1n;
const MULT = 6364136223846793005n;

export interface Rng {
  nextU32(): number;
  /// Uniform in [0, n).
  below(n: number): number;
  /// Uniform in [0, 1) with 24 bits (like sim-core's `f32`).
  float(): number;
}

export class Pcg32 implements Rng {
  private state: bigint;
  private inc: bigint;

  constructor(seed: bigint, stream: bigint) {
    this.state = 0n;
    this.inc = ((stream << 1n) | 1n) & MASK;
    this.nextU32();
    this.state = (this.state + (seed & MASK)) & MASK;
    this.nextU32();
  }

  /// Rebuild from a saved `toJSON()`.
  static fromState(s: { state: string; inc: string }): Pcg32 {
    const r = new Pcg32(0n, 0n);
    r.state = BigInt("0x" + s.state) & MASK;
    r.inc = BigInt("0x" + s.inc) & MASK;
    return r;
  }

  toJSON(): { state: string; inc: string } {
    return { state: this.state.toString(16), inc: this.inc.toString(16) };
  }

  nextU32(): number {
    const old = this.state;
    this.state = (old * MULT + this.inc) & MASK;
    const xorshifted = Number((((old >> 18n) ^ old) >> 27n) & 0xffffffffn);
    const rot = Number(old >> 59n);
    return ((xorshifted >>> rot) | (xorshifted << ((32 - rot) & 31))) >>> 0;
  }

  below(n: number): number {
    if (!Number.isInteger(n) || n <= 0 || n > 0xffffffff) throw new Error(`below(${n})`);
    const threshold = (0x100000000 - n) % n;
    for (;;) {
      const r = this.nextU32();
      if (r >= threshold) return r % n;
    }
  }

  float(): number {
    return (this.nextU32() >>> 8) / 16777216;
  }
}

/// Stream id of the crate generator (a named constant, like sim-core's systems).
export const CRATE_STREAM = 0x7a_63_72_61n; // "zcra"

/// A random 64-bit seed from `crypto.getRandomValues` (Math.random if missing).
export function randomSeed(): bigint {
  const c = globalThis.crypto;
  if (c?.getRandomValues) {
    const a = c.getRandomValues(new Uint32Array(2));
    return (BigInt(a[0]) << 32n) | BigInt(a[1]);
  }
  return (BigInt(Math.floor(Math.random() * 2 ** 32)) << 32n) | BigInt(Math.floor(Math.random() * 2 ** 32));
}
