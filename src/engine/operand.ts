/**
 * Api.Flags.Operand: parsing of condition operands, shared by write validation and evaluation. All functions are
 * total: `null` is Elixir's `:error`. Elixir library behaviour (`String.trim`, `Integer.parse`, `Float.parse`,
 * `DateTime/NaiveDateTime/Date.from_iso8601`, `Version.parse/compare`, Elixir 1.14.5) is ported by hand and checked
 * against Elixir-generated fixtures in test/fixtures.
 *
 * Where Elixir raises instead of answering `:error`, the port answers `null`, a parse failure that makes the condition
 * not match (a raised ArgumentError would crash the evaluation). The two cases are marked below and tagged "raise" in
 * test/fixtures/operand-elixir.json.
 */
import { elixirNumberToString } from "./elixir-number.ts";
import type { Ordering } from "./elixir-number.ts";
import { isJNumber } from "./json.ts";
import { jfloat, jint } from "./types.ts";
import type { JNumber, JsonValue } from "./types.ts";

// ---------------------------------------------------------------------------------------------------------------
// Elixir string and number-prefix primitives
// ---------------------------------------------------------------------------------------------------------------

/** Code points `String.trim/1` strips (Unicode White_Space as Elixir 1.14 defines it; verified over all code points). */
function isElixirWhitespace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

/** `String.trim/1`. */
export function elixirTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isElixirWhitespace(value.charCodeAt(start))) start++;
  while (end > start && isElixirWhitespace(value.charCodeAt(end - 1))) end--;
  return value.slice(start, end);
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

interface Parsed<T> {
  readonly value: T;
  readonly rest: string;
}

/** `Integer.parse/1`: optional sign, then at least one ASCII digit; returns the integer and the unparsed rest. */
export function integerParse(input: string): Parsed<bigint> | null {
  let index = 0;
  if (input.startsWith("+") || input.startsWith("-")) index = 1;
  const digitsStart = index;
  while (index < input.length && isAsciiDigit(input.charCodeAt(index))) index++;
  if (index === digitsStart) return null;
  return { value: BigInt(input.slice(0, index)), rest: input.slice(index) };
}

/**
 * `Float.parse/1`: sign, digits, an optional `.digits` (a dot needs a digit after it), an optional exponent
 * (`e`/`E`, optional sign, digits; an incomplete exponent is left in the rest). `null` for no number. A value that does
 * not fit a double is `:error` in Elixir when written with an exponent (`null` here) but makes Elixir RAISE
 * ArgumentError when written as plain digits (309 or more of them, with or without a fraction): that is `"raises"`.
 */
export function floatParse(input: string): Parsed<number> | "raises" | null {
  let index = 0;
  const negative = input.startsWith("-");
  if (negative || input.startsWith("+")) index = 1;
  if (index >= input.length || !isAsciiDigit(input.charCodeAt(index))) return null;
  let acc = "";
  let hasDot = false;
  let hasExponent = false;
  while (index < input.length) {
    const ch = input[index] as string;
    const next = input.charCodeAt(index + 1);
    if (isAsciiDigit(input.charCodeAt(index))) {
      acc += ch;
      index++;
    } else if (ch === "." && !hasDot && !hasExponent && isAsciiDigit(next)) {
      acc += `.${input[index + 1] as string}`;
      hasDot = true;
      index += 2;
    } else if ((ch === "e" || ch === "E") && !hasExponent && isAsciiDigit(next)) {
      acc += `${hasDot ? "" : ".0"}e${input[index + 1] as string}`;
      hasDot = true;
      hasExponent = true;
      index += 2;
    } else if (
      (ch === "e" || ch === "E") &&
      !hasExponent &&
      (input[index + 1] === "-" || input[index + 1] === "+") &&
      isAsciiDigit(input.charCodeAt(index + 2))
    ) {
      acc += `${hasDot ? "" : ".0"}e${input[index + 1] as string}${input[index + 2] as string}`;
      hasDot = true;
      hasExponent = true;
      index += 3;
    } else break;
  }
  const magnitude = Number(hasDot ? acc : `${acc}.0`);
  if (!Number.isFinite(magnitude)) return hasExponent ? null : "raises";
  return { value: negative ? -magnitude : magnitude, rest: input.slice(index) };
}

// ---------------------------------------------------------------------------------------------------------------
// Operand.number/1
// ---------------------------------------------------------------------------------------------------------------

/**
 * `Operand.number/1`: a number as is; a string after `String.trim`, whole-string `Integer.parse` then `Float.parse`.
 * Elixir computes both parses before choosing, so a digit string that makes `Float.parse` raise makes the whole call
 * raise, even when `Integer.parse` would have succeeded (`"1"` x 400). The port treats that as `null`.
 */
export function number(value: JsonValue): JNumber | null {
  if (isJNumber(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = elixirTrim(value);
  const asFloat = floatParse(trimmed);
  if (asFloat === "raises") return null;
  const asInteger = integerParse(trimmed);
  if (asInteger !== null && asInteger.rest === "") return jint(asInteger.value);
  if (asFloat !== null && asFloat.rest === "") return jfloat(asFloat.value);
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Operand.datetime/1
// ---------------------------------------------------------------------------------------------------------------

/** An instant as whole microseconds since 1970-01-01T00:00:00Z (the precision of Elixir's `DateTime`). */
export type Microseconds = bigint;

const MICROS_PER_SECOND = 1_000_000n;
/** Calendar.ISO accepts years -9999..9999; iso days are counted from 0000-01-01, the Unix epoch is day 719_528. */
const MIN_YEAR = -9999;
const MAX_YEAR = 9999;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Days since 1970-01-01 of a proleptic Gregorian date (Hinnant's days_from_civil, valid for negative years). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/** Whole days since 1970-01-01 bounds of years -9999-01-01 and 9999-12-31, i.e. iso days -3_652_059..3_652_424. */
const MIN_UNIX_DAY = -3_652_059 - 719_528;
const MAX_UNIX_DAY = 3_652_424 - 719_528;

const DATE_PART = "([0-9]{4})-([0-9]{2})-([0-9]{2})";
const DATE_ONLY = new RegExp(`^${DATE_PART}$`);
const DATE_TIME = new RegExp(`^${DATE_PART}[T ]([0-9]{2}):([0-9]{2}):([0-9]{2})([^]*)$`);

interface Fraction {
  readonly micros: number;
  readonly rest: string;
}

/** `Calendar.ISO.parse_microsecond/1`: `.` or `,` and at least one digit; more than six digits are truncated. */
function parseFraction(text: string): Fraction | null {
  if (!text.startsWith(".") && !text.startsWith(",")) return { micros: 0, rest: text };
  let end = 1;
  while (end < text.length && isAsciiDigit(text.charCodeAt(end))) end++;
  if (end === 1) return null;
  const digits = text.slice(1, end).slice(0, 6).padEnd(6, "0");
  return { micros: Number(digits), rest: text.slice(end) };
}

/** `Integer.parse(part)` that must consume the whole part and be below `limit` (negative parts pass, as in Elixir). */
function offsetPart(part: string, limit: number): number | null {
  const parsed = integerParse(part);
  if (parsed === null || parsed.rest !== "" || parsed.value >= BigInt(limit)) return null;
  return Number(parsed.value);
}

/** `Calendar.ISO.parse_offset/1`: seconds east of UTC, `"none"` when absent, `null` when malformed. */
function parseOffset(text: string): number | "none" | null {
  if (text === "") return "none";
  if (text === "Z") return 0;
  if (text === "-00:00") return null;
  const sign = text[0] === "+" ? 1 : text[0] === "-" ? -1 : 0;
  if (sign === 0) return null;
  let hourText: string;
  let minuteText: string;
  let rest: string;
  if (text.length >= 6 && text[3] === ":") {
    hourText = text.slice(1, 3);
    minuteText = text.slice(4, 6);
    rest = text.slice(6);
  } else if (text.length >= 5) {
    hourText = text.slice(1, 3);
    minuteText = text.slice(3, 5);
    rest = text.slice(5);
  } else if (text.length >= 3) {
    hourText = text.slice(1, 3);
    minuteText = "00";
    rest = text.slice(3);
  } else return null;
  const hour = offsetPart(hourText, 24);
  const minute = offsetPart(minuteText, 60);
  if (hour === null || minute === null || rest !== "") return null;
  return (hour * 60 + minute) * 60 * sign;
}

function validDate(year: number, month: number, day: number): boolean {
  return year >= MIN_YEAR && year <= MAX_YEAR && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/** Splits a leading `-` or `+` year sign off the string (`parse_*_guarded`); returns the year multiplier. */
function splitYearSign(text: string): { readonly sign: 1 | -1; readonly body: string } {
  if (text.startsWith("-")) return { sign: -1, body: text.slice(1) };
  if (text.startsWith("+")) return { sign: 1, body: text.slice(1) };
  return { sign: 1, body: text };
}

/**
 * `Operand.datetime/1`: `DateTime.from_iso8601`, else `NaiveDateTime.from_iso8601` read as UTC, else
 * `Date.from_iso8601` at midnight UTC. Extended ISO 8601 only (`2015-01-23T23:50:07.123+02:30`); `T` or a space
 * between date and time; `,` or `.` before the fraction; offsets `Z`, `±HH:MM`, `±HHMM`, `±HH`; no leap seconds.
 * Years -9999..9999. The result is a microsecond count, so ordering and range match `DateTime.compare/2`.
 *
 * Elixir raises (FunctionClauseError) when an offset moves the instant outside years -9999..9999; the port answers
 * `null`.
 */
export function datetime(value: JsonValue): Microseconds | null {
  if (typeof value !== "string") return null;
  const { sign, body } = splitYearSign(value);
  const parts = DATE_TIME.exec(body);
  if (parts !== null) {
    const year = sign * Number(parts[1]);
    const month = Number(parts[2]);
    const day = Number(parts[3]);
    const hour = Number(parts[4]);
    const minute = Number(parts[5]);
    const second = Number(parts[6]);
    const fraction = parseFraction(parts[7] as string);
    if (fraction === null) return null;
    const offset = parseOffset(fraction.rest);
    if (offset === null) return null;
    if (!validDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return null;
    // A missing offset is NaiveDateTime read as UTC; otherwise the instant is the local time minus the offset.
    const offsetSeconds = offset === "none" ? 0 : offset;
    const day0 = daysFromCivil(year, month, day);
    const seconds = day0 * 86_400 + hour * 3600 + minute * 60 + second - offsetSeconds;
    const resultDay = Math.floor(seconds / 86_400);
    if (resultDay < MIN_UNIX_DAY || resultDay > MAX_UNIX_DAY) return null;
    return BigInt(seconds) * MICROS_PER_SECOND + BigInt(fraction.micros);
  }
  const dateOnly = DATE_ONLY.exec(body);
  if (dateOnly === null) return null;
  const year = sign * Number(dateOnly[1]);
  const month = Number(dateOnly[2]);
  const day = Number(dateOnly[3]);
  if (!validDate(year, month, day)) return null;
  return BigInt(daysFromCivil(year, month, day) * 86_400) * MICROS_PER_SECOND;
}

/** `DateTime.compare/2`. */
export function compareDatetimes(a: Microseconds, b: Microseconds): Ordering {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Operand.semver/1
// ---------------------------------------------------------------------------------------------------------------

/** A `Version` as the comparison sees it: build metadata is dropped. Numeric pre-release identifiers are bigints. */
export interface SemVer {
  readonly major: bigint;
  readonly minor: bigint;
  readonly patch: bigint;
  readonly pre: readonly (bigint | string)[];
}

const SEMVER_TOLERANT = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?([-+][^\n]*)?$/;
const ASCII_DIGITS = /^[0-9]+$/;
const SEMVER_IDENTIFIER = /^[0-9A-Za-z-]+$/;

/** `Version.Parser.require_digits/1`: digits only, and no leading zero unless the part is a single `0`. */
function requireDigits(part: string): bigint | null {
  if (part.length > 1 && part.startsWith("0")) return null;
  return ASCII_DIGITS.test(part) ? BigInt(part) : null;
}

/** `Version.parse/1` (strict SemVer 2.0.0, `major.minor.patch[-pre][+build]`). */
export function versionParse(input: string): SemVer | null {
  const plus = input.indexOf("+");
  const withPre = plus === -1 ? input : input.slice(0, plus);
  const build = plus === -1 ? null : input.slice(plus + 1);
  const dash = withPre.indexOf("-");
  const core = dash === -1 ? withPre : withPre.slice(0, dash);
  const pre = dash === -1 ? null : withPre.slice(dash + 1);
  const segments = core.split(".");
  if (segments.length !== 3) return null;
  const major = requireDigits(segments[0] as string);
  const minor = requireDigits(segments[1] as string);
  const patch = requireDigits(segments[2] as string);
  if (major === null || minor === null || patch === null) return null;
  const identifiers: (bigint | string)[] = [];
  if (pre !== null) {
    for (const part of pre.split(".")) {
      if (!SEMVER_IDENTIFIER.test(part)) return null;
      if (ASCII_DIGITS.test(part)) {
        if (part.length > 1 && part.startsWith("0")) return null;
        identifiers.push(BigInt(part));
      } else identifiers.push(part);
    }
  }
  if (build !== null && !build.split(".").every((part) => SEMVER_IDENTIFIER.test(part))) return null;
  return { major, minor, patch, pre: identifiers };
}

/** `Operand.semver/1`: trims, drops leading `v`s, accepts `1`, `1.2`, `1.2.3` (missing parts are 0) plus a suffix. */
export function semver(value: JsonValue): SemVer | null {
  if (typeof value !== "string") return null;
  let trimmed = elixirTrim(value);
  while (trimmed.startsWith("v")) trimmed = trimmed.slice(1);
  const parts = SEMVER_TOLERANT.exec(trimmed);
  if (parts === null) return null;
  const major = parts[1] as string;
  const minor = parts[2] === undefined || parts[2] === "" ? "0" : parts[2];
  const patch = parts[3] === undefined || parts[3] === "" ? "0" : parts[3];
  return versionParse(`${major}.${minor}.${patch}${parts[4] ?? ""}`);
}

function compareBigInt(a: bigint, b: bigint): Ordering {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Erlang term order for pre-release identifiers: numbers before binaries, binaries bytewise (ASCII here). */
function compareIdentifier(a: bigint | string, b: bigint | string): Ordering {
  if (typeof a === "bigint") return typeof b === "bigint" ? compareBigInt(a, b) : -1;
  if (typeof b === "bigint") return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `Version.compare/2`: numeric core, then a version with no pre-release outranks one with, then SemVer order. */
export function compareSemver(a: SemVer, b: SemVer): Ordering {
  const core = compareBigInt(a.major, b.major) || compareBigInt(a.minor, b.minor) || compareBigInt(a.patch, b.patch);
  if (core !== 0) return core;
  if (a.pre.length === 0 && b.pre.length !== 0) return 1;
  if (a.pre.length !== 0 && b.pre.length === 0) return -1;
  const shared = Math.min(a.pre.length, b.pre.length);
  for (let i = 0; i < shared; i++) {
    const order = compareIdentifier(a.pre[i] as bigint | string, b.pre[i] as bigint | string);
    if (order !== 0) return order;
  }
  return a.pre.length < b.pre.length ? -1 : a.pre.length > b.pre.length ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Operand.text/1
// ---------------------------------------------------------------------------------------------------------------

/** `Operand.text/1`: a scalar as a string for the string operators; lists, maps and nil have none. */
export function text(value: JsonValue): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (isJNumber(value)) return elixirNumberToString(value);
  return null;
}
