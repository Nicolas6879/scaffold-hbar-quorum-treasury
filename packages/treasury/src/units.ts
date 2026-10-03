/**
 * Amounts are always bigint in their smallest unit:
 *  - HBAR in tinybar (8 decimals). Inside the EVM `msg.value` is also tinybar; only the
 *    JSON-RPC relay speaks weibar (18 decimals) and divides by 1e10 on the way in.
 *  - USD in "usd6" (6 decimals), the same scale as USDC.
 */

export const TINYBAR_PER_HBAR = 100_000_000n;
export const WEIBAR_PER_TINYBAR = 10_000_000_000n;
export const USD6 = 1_000_000n;

/** Parse a decimal string ("12.5") into an integer with `decimals` places, rejecting extra precision. */
export function parseUnits(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`Invalid amount: "${value}"`);
  const [whole = "0", fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) throw new Error(`"${value}" has more than ${decimals} decimal places`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** Format an integer amount with `decimals` places, trimming trailing zeros. */
export function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export const hbarToTinybar = (hbar: string): bigint => parseUnits(hbar, 8);
export const tinybarToHbar = (tinybar: bigint): string => formatUnits(tinybar, 8);
export const tinybarToWeibar = (tinybar: bigint): bigint => tinybar * WEIBAR_PER_TINYBAR;

export function weibarToTinybar(weibar: bigint): bigint {
  if (weibar % WEIBAR_PER_TINYBAR !== 0n) {
    throw new Error(`${weibar} weibar is not a whole number of tinybar; the relay would truncate it`);
  }
  return weibar / WEIBAR_PER_TINYBAR;
}
