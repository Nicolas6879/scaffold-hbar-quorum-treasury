import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fromLongZeroAddress, isLongZeroAddress, parseEntityId, toLongZeroAddress } from "../src/ids";
import { formatUnits, hbarToTinybar, parseUnits, tinybarToHbar, tinybarToWeibar, weibarToTinybar } from "../src/units";

describe("units", () => {
  it("parses HBAR into tinybar without floating point", () => {
    expect(hbarToTinybar("1")).toBe(100_000_000n);
    expect(hbarToTinybar("0.00000001")).toBe(1n);
    expect(hbarToTinybar("12.5")).toBe(1_250_000_000n);
  });

  it("rejects more precision than the unit has", () => {
    expect(() => hbarToTinybar("0.000000001")).toThrow(/decimal places/);
    expect(() => parseUnits("1.1234567", 6)).toThrow();
  });

  it.each(["", "abc", "-1", "1e3", "1.2.3", " . "])("rejects malformed amount %j", v => {
    expect(() => parseUnits(v, 8)).toThrow();
  });

  it("formats and trims trailing zeros", () => {
    expect(tinybarToHbar(150_000_000n)).toBe("1.5");
    expect(formatUnits(1_000_000n, 6)).toBe("1");
    expect(formatUnits(-5n, 2)).toBe("-0.05");
  });

  it("round-trips any amount", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 20n }), fc.integer({ min: 0, max: 18 }), (v, d) => {
        expect(parseUnits(formatUnits(v, d), d)).toBe(v);
      }),
    );
  });

  it("converts tinybar to weibar and refuses lossy weibar", () => {
    expect(tinybarToWeibar(1n)).toBe(10_000_000_000n);
    expect(weibarToTinybar(30_000_000_000n)).toBe(3n);
    expect(() => weibarToTinybar(1n)).toThrow(/truncate/);
  });
});

describe("ids", () => {
  it("converts an entity id to its long-zero address and back", () => {
    expect(toLongZeroAddress("0.0.19264")).toBe("0x0000000000000000000000000000000000004b40");
    expect(fromLongZeroAddress("0x0000000000000000000000000000000000004b40")).toBe("0.0.19264");
  });

  it("round-trips any account number", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 2n ** 63n }), n => {
        expect(fromLongZeroAddress(toLongZeroAddress(`0.0.${n}`))).toBe(`0.0.${n}`);
      }),
    );
  });

  it("refuses to treat an EVM alias as a long-zero address", () => {
    const alias = "0x8a3f1e6b2c4d5e6f708192a3b4c5d6e7f8091a2b";
    expect(isLongZeroAddress(alias)).toBe(false);
    expect(() => fromLongZeroAddress(alias)).toThrow(/alias/);
  });

  it("validates entity ids", () => {
    expect(parseEntityId(" 0.0.5 ").num).toBe(5n);
    expect(() => parseEntityId("0.0")).toThrow();
    expect(() => parseEntityId("0.0.-1")).toThrow();
  });
});
