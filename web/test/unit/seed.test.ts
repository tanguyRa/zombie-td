// Match seeds stay exact decimal u64 strings (never a JS number).
import { describe, expect, it } from "vitest";
import { parseSeed } from "../../src/seed";

describe("parseSeed", () => {
  it("keeps seeds above 2^53 exact", () => {
    expect(parseSeed("9007199254740993")).toBe("9007199254740993");
    expect(parseSeed("18446744073709551615")).toBe("18446744073709551615");
  });
  it("normalises leading zeros and spaces", () => {
    expect(parseSeed(" 007 ")).toBe("7");
    expect(parseSeed("0")).toBe("0");
  });
  it("refuses what is not a u64", () => {
    for (const v of ["", "-1", "1.5", "1e3", "abc", "18446744073709551616", "0x10", "123456789012345678901"]) expect(parseSeed(v)).toBeNull();
  });
});
