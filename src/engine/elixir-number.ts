/**
 * Elixir number semantics for the engine's `JNumber`: `Integer.to_string/1`, `Float.to_string/1` (the same text
 * `Jason.encode!/1` writes for a float), and the exact int/float comparison Erlang does for `==`, `<` and `>`.
 *
 * Float text is Erlang's shortest round-trip form (`:io_lib_format.fwrite_g/1`): the shortest digits that read
 * back to the same double, laid out as plain decimal or as `d.ddde<exp>`. The layout rule (plain unless longer than
 * scientific, never plain from 2^53 up) was derived from Elixir 1.14.5 / OTP 26 output over the whole (digit count,
 * exponent) grid and is checked against
 * `test/fixtures/numbers-elixir.json`.
 */
import type { JNumber } from "./types.ts";

/** -1, 0 or 1, as `Version.compare` / `DateTime.compare` ordering (`:lt`, `:eq`, `:gt`). */
export type Ordering = -1 | 0 | 1;

/** Shortest round-trip decimal digits of a finite, non-zero magnitude, and its base-10 exponent (d.ddd x 10^exp). */
function shortestDigits(magnitude: number): { readonly digits: string; readonly exponent: number } {
  const text = magnitude.toExponential(); // no argument: as many digits as needed to round-trip
  const e = text.indexOf("e");
  const mantissa = text.slice(0, e).replace(".", "");
  return { digits: mantissa, exponent: Number.parseInt(text.slice(e + 1), 10) };
}

const TWO_POW_53 = 9007199254740992;

/** `Float.to_string/1`. Non-finite floats do not exist in Elixir and are refused. */
export function floatToString(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError("Elixir floats are finite");
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const sign = value < 0 ? "-" : "";
  const { digits, exponent: x } = shortestDigits(Math.abs(value));
  const n = digits.length;
  // Plain decimal when it is no longer than d.ddde<x> (a tie goes to plain), except that magnitudes from 2^53 up are
  // always written in scientific form.
  const scientificLength = n + 1 + (n === 1 ? 1 : 0) + 1 + String(x).length;
  const plainLength = x >= 0 ? (n <= x + 1 ? x + 3 : n + 1) : n - x + 1;
  const plain = Math.abs(value) < TWO_POW_53 && plainLength <= scientificLength;
  if (!plain) {
    const fraction = n === 1 ? "0" : digits.slice(1);
    return `${sign}${digits.slice(0, 1)}.${fraction}e${x}`;
  }
  if (x >= 0) {
    if (n <= x + 1) return `${sign}${digits}${"0".repeat(x + 1 - n)}.0`;
    return `${sign}${digits.slice(0, x + 1)}.${digits.slice(x + 1)}`;
  }
  return `${sign}0.${"0".repeat(-x - 1)}${digits}`;
}

/** `Integer.to_string/1` for the integer or `Float.to_string/1` for the float (`to_string/1` of a number). */
export function elixirNumberToString(n: JNumber): string {
  return n.kind === "int" ? n.value.toString() : floatToString(n.value);
}

function compareBigInt(a: bigint, b: bigint): Ordering {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareFloats(a: number, b: number): Ordering {
  return a < b ? -1 : a > b ? 1 : 0; // -0.0 and 0.0 are equal, as in Erlang
}

/** Exact comparison of an integer with a finite float (no rounding of either side). */
function compareIntFloat(a: bigint, b: number): Ordering {
  if (Number.isInteger(b)) return compareBigInt(a, BigInt(b));
  // b has a fraction: a < b exactly when a <= floor(b).
  return a <= BigInt(Math.floor(b)) ? -1 : 1;
}

/** Erlang term comparison of two numbers: by value, integers and floats mixed exactly. */
export function compareNumbers(a: JNumber, b: JNumber): Ordering {
  if (a.kind === "int") {
    if (b.kind === "int") return compareBigInt(a.value, b.value);
    return compareIntFloat(a.value, b.value);
  }
  if (b.kind === "float") return compareFloats(a.value, b.value);
  const flipped = compareIntFloat(b.value, a.value);
  return flipped === 0 ? 0 : flipped === 1 ? -1 : 1;
}

/** Elixir `a == b` for numbers: `1 == 1.0`. */
export function numbersEqual(a: JNumber, b: JNumber): boolean {
  return compareNumbers(a, b) === 0;
}
