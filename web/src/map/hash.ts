// FNV-1a 64 over UTF-8 bytes, in 16-bit limbs (no BigInt in the hot loop).
// Offset basis 0xcbf29ce484222325, prime 0x100000001b3 (= 2^40 + 0x1b3).

/// FNV-1a 64 of a string's UTF-8 bytes, as 16 lowercase hex digits.
export function fnv1a64Hex(s: string): string {
  const bytes = new TextEncoder().encode(s);
  // h = h3:h2:h1:h0, 16 bits each, h0 least significant.
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2;
  for (let i = 0; i < bytes.length; i++) {
    h0 ^= bytes[i];
    // h * 0x1b3
    const a0 = h0 * 0x1b3;
    const a1 = h1 * 0x1b3 + (a0 >>> 16);
    const a2 = h2 * 0x1b3 + (a1 >>> 16);
    const a3 = h3 * 0x1b3 + (a2 >>> 16);
    // + h << 40: limb 0 of h goes into bits 40..55 (limb 2 high byte / limb 3 low byte).
    // h << 40 = (h0 << 40) + (h1 << 56) (mod 2^64): limb 2 += (h0 & 0xff) << 8, limb 3 += (h0 >> 8) + (h1 & 0xff) << 8.
    const b2 = (a2 & 0xffff) + ((h0 & 0xff) << 8);
    const b3 = (a3 & 0xffff) + (h0 >>> 8) + ((h1 & 0xff) << 8) + (b2 >>> 16);
    h0 = a0 & 0xffff;
    h1 = a1 & 0xffff;
    h2 = b2 & 0xffff;
    h3 = b3 & 0xffff;
  }
  const hex = (v: number) => v.toString(16).padStart(4, "0");
  return hex(h3) + hex(h2) + hex(h1) + hex(h0);
}

/// Reference implementation with BigInt (slow; for tests and documentation).
export function fnv1a64HexBigInt(s: string): string {
  const mask = (1n << 64n) - 1n;
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(s)) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & mask;
  }
  return h.toString(16).padStart(16, "0");
}
