/**
 * Lossless JSON for the engine (LAT-59). Reads text the way Jason decodes it into Elixir terms, and writes
 * `JsonValue`s the way `Jason.encode!/1` does, so `1` and `1.0` stay apart, integers keep every digit, and a
 * context's size is the byte size Elixir would measure. No `JSON.parse` / `JSON.stringify` anywhere on this path.
 *
 * Decoder rules (Jason 1.2.2, the version in commerce-api's lockfile, checked against the real library in test/fixtures/json-elixir.json):
 * - a number with no `.`, `e` or `E` is an integer of any size (`JInt`); every other number is a `JFloat`, and a
 *   float that overflows a double is an error;
 * - `-0` is integer 0, `-0.0` is negative-zero float, and `-0e0` / `-0E1` / `-0e-0` (no fraction, with an exponent) is
 *   POSITIVE zero (a quirk of Jason's float path that the port reproduces);
 * - leading zeros, `+`, `.5`, `1.`, NaN, trailing commas, single quotes and control characters inside strings are
 *   errors; only space, tab, CR and LF are whitespace; a BOM is an error;
 * - `😀` is one code point; a lone surrogate escape is an error;
 * - with duplicate keys the FIRST one wins (Jason builds the map from a reversed list). The LAT-10 brief said "last";
 *   the real library says first, and the engine follows the library.
 * Parsing, encoding, sizing and comparing are iterative, so nesting depth is not limited by the JS call stack.
 * Object keys that look like array indexes (`"1"`, `"20"`) are enumerated first by JavaScript whatever their insertion
 * order; nothing in the engine depends on key order (`encodeJson` offers `sortKeys` for a stable, Jason-like order).
 */
import { elixirNumberToString } from "./elixir-number.ts";
import { jfloat, jint } from "./types.ts";
import type { JNumber, JsonObject, JsonValue } from "./types.ts";

export type JsonParseResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly position: number; readonly message: string };

const CH = {
  tab: 0x09,
  lf: 0x0a,
  cr: 0x0d,
  space: 0x20,
  quote: 0x22,
  plus: 0x2b,
  comma: 0x2c,
  minus: 0x2d,
  dot: 0x2e,
  slash: 0x2f,
  zero: 0x30,
  nine: 0x39,
  colon: 0x3a,
  upperE: 0x45,
  openBracket: 0x5b,
  backslash: 0x5c,
  closeBracket: 0x5d,
  lowerE: 0x65,
  openBrace: 0x7b,
  closeBrace: 0x7d,
} as const;

class JsonSyntaxError extends Error {
  readonly position: number;
  constructor(position: number, message: string) {
    super(message);
    this.position = position;
  }
}

function isDigit(code: number): boolean {
  return code >= CH.zero && code <= CH.nine;
}

function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
}

const SIMPLE_ESCAPES: Readonly<Record<number, string>> = {
  [0x22]: '"',
  [0x5c]: "\\",
  [0x2f]: "/",
  [0x62]: "\b",
  [0x66]: "\f",
  [0x6e]: "\n",
  [0x72]: "\r",
  [0x74]: "\t",
};

/** An open array or object while parsing. */
type Frame = { readonly array: JsonValue[] } | { readonly object: Record<string, JsonValue>; key: string | null };

class Reader {
  private readonly text: string;
  private index = 0;

  constructor(text: string) {
    this.text = text;
  }

  parse(): JsonValue {
    const stack: Frame[] = [];
    let result: JsonValue = null;
    for (;;) {
      // Read one value (or open a container).
      this.skipWhitespace();
      const code = this.peek();
      let value: JsonValue;
      let opened = false;
      if (code === CH.openBracket) {
        this.index++;
        this.skipWhitespace();
        if (this.peek() === CH.closeBracket) {
          this.index++;
          value = [];
        } else {
          stack.push({ array: [] });
          opened = true;
          value = null;
        }
      } else if (code === CH.openBrace) {
        this.index++;
        this.skipWhitespace();
        if (this.peek() === CH.closeBrace) {
          this.index++;
          value = Object.create(null) as JsonObject;
        } else {
          stack.push({ object: Object.create(null) as Record<string, JsonValue>, key: this.readKey() });
          opened = true;
          value = null;
        }
      } else {
        value = this.readScalar();
      }
      if (opened) continue;

      // Attach it to its parent, closing finished containers on the way up.
      for (;;) {
        const frame = stack[stack.length - 1];
        if (frame === undefined) {
          result = value;
          this.skipWhitespace();
          if (this.index < this.text.length) throw new JsonSyntaxError(this.index, "unexpected data after value");
          return result;
        }
        if ("array" in frame) {
          frame.array.push(value);
          this.skipWhitespace();
          const next = this.peek();
          if (next === CH.comma) {
            this.index++;
            break;
          }
          if (next !== CH.closeBracket) throw new JsonSyntaxError(this.index, "expected , or ]");
          this.index++;
          value = frame.array;
        } else {
          const key = frame.key;
          if (key === null) throw new JsonSyntaxError(this.index, "missing key");
          if (!Object.prototype.hasOwnProperty.call(frame.object, key)) frame.object[key] = value; // first duplicate wins
          this.skipWhitespace();
          const next = this.peek();
          if (next === CH.comma) {
            this.index++;
            this.skipWhitespace();
            frame.key = this.readKey();
            break;
          }
          if (next !== CH.closeBrace) throw new JsonSyntaxError(this.index, "expected , or }");
          this.index++;
          value = frame.object;
        }
        stack.pop();
      }
    }
  }

  private peek(): number {
    return this.index < this.text.length ? this.text.charCodeAt(this.index) : -1;
  }

  private skipWhitespace(): void {
    for (;;) {
      const code = this.peek();
      if (code === CH.space || code === CH.tab || code === CH.lf || code === CH.cr) this.index++;
      else return;
    }
  }

  /** An object key and the `:` after it. */
  private readKey(): string {
    if (this.peek() !== CH.quote) throw new JsonSyntaxError(this.index, "expected a string key");
    const key = this.readString();
    this.skipWhitespace();
    if (this.peek() !== CH.colon) throw new JsonSyntaxError(this.index, "expected :");
    this.index++;
    return key;
  }

  private readScalar(): JsonValue {
    const code = this.peek();
    if (code === CH.quote) return this.readString();
    if (code === CH.minus || isDigit(code)) return this.readNumber();
    if (this.text.startsWith("true", this.index)) {
      this.index += 4;
      return true;
    }
    if (this.text.startsWith("false", this.index)) {
      this.index += 5;
      return false;
    }
    if (this.text.startsWith("null", this.index)) {
      this.index += 4;
      return null;
    }
    throw new JsonSyntaxError(this.index, "unexpected token");
  }

  private readNumber(): JsonValue {
    const start = this.index;
    if (this.peek() === CH.minus) this.index++;
    const firstDigit = this.peek();
    if (!isDigit(firstDigit)) throw new JsonSyntaxError(this.index, "expected a digit");
    this.index++;
    if (firstDigit !== CH.zero) while (isDigit(this.peek())) this.index++;
    let isFloat = false;
    if (this.peek() === CH.dot) {
      this.index++;
      if (!isDigit(this.peek())) throw new JsonSyntaxError(this.index, "expected a digit after .");
      while (isDigit(this.peek())) this.index++;
      isFloat = true;
    }
    const marker = this.peek();
    if (marker === CH.lowerE || marker === CH.upperE) {
      this.index++;
      const sign = this.peek();
      if (sign === CH.plus || sign === CH.minus) this.index++;
      if (!isDigit(this.peek())) throw new JsonSyntaxError(this.index, "expected an exponent digit");
      while (isDigit(this.peek())) this.index++;
      isFloat = true;
    }
    const token = this.text.slice(start, this.index);
    if (!isFloat) return jint(BigInt(token));
    const number = Number(token);
    if (!Number.isFinite(number)) throw new JsonSyntaxError(start, "float out of range");
    // Jason 1.2.2 builds `-0e0` (negative zero, exponent, no fraction) as +0.0.
    if (number === 0 && /^-0[eE]/.test(token)) return jfloat(0);
    return jfloat(number);
  }

  private readString(): string {
    this.index++; // opening quote
    let out = "";
    let runStart = this.index;
    for (;;) {
      if (this.index >= this.text.length) throw new JsonSyntaxError(this.index, "unterminated string");
      const code = this.text.charCodeAt(this.index);
      if (code === CH.quote) {
        out += this.text.slice(runStart, this.index);
        this.index++;
        return out;
      }
      if (code < 0x20) throw new JsonSyntaxError(this.index, "control character in string");
      if (code === CH.backslash) {
        out += this.text.slice(runStart, this.index);
        out += this.readEscape();
        runStart = this.index;
        continue;
      }
      if (code >= 0xd800 && code <= 0xdfff) {
        // Raw surrogates are only valid as a high+low pair (a binary cannot hold a lone one).
        const next = this.index + 1 < this.text.length ? this.text.charCodeAt(this.index + 1) : -1;
        if (code > 0xdbff || next < 0xdc00 || next > 0xdfff) throw new JsonSyntaxError(this.index, "invalid character");
        this.index += 2;
        continue;
      }
      this.index++;
    }
  }

  private readHex4(at: number): number {
    if (at + 4 > this.text.length) throw new JsonSyntaxError(at, "short \\u escape");
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const digit = hexValue(this.text.charCodeAt(at + i));
      if (digit < 0) throw new JsonSyntaxError(at + i, "bad \\u escape");
      value = value * 16 + digit;
    }
    return value;
  }

  /** At a backslash; consumes the escape and returns the text it stands for. */
  private readEscape(): string {
    const marker = this.index + 1 < this.text.length ? this.text.charCodeAt(this.index + 1) : -1;
    const simple = SIMPLE_ESCAPES[marker];
    if (simple !== undefined) {
      this.index += 2;
      return simple;
    }
    if (marker !== 0x75) throw new JsonSyntaxError(this.index, "invalid escape");
    const high = this.readHex4(this.index + 2);
    this.index += 6;
    if (high >= 0xdc00 && high <= 0xdfff) throw new JsonSyntaxError(this.index - 6, "lone low surrogate");
    if (high < 0xd800 || high > 0xdbff) return String.fromCharCode(high);
    if (this.text.charCodeAt(this.index) !== CH.backslash || this.text.charCodeAt(this.index + 1) !== 0x75) {
      throw new JsonSyntaxError(this.index, "lone high surrogate");
    }
    const low = this.readHex4(this.index + 2);
    if (low < 0xdc00 || low > 0xdfff) throw new JsonSyntaxError(this.index, "high surrogate without low surrogate");
    this.index += 6;
    return String.fromCharCode(high, low);
  }
}

/** Reads JSON text like `Jason.decode/1`. Never throws. */
export function parseJson(text: string): JsonParseResult {
  try {
    return { ok: true, value: new Reader(text).parse() };
  } catch (error) {
    if (error instanceof JsonSyntaxError) return { ok: false, position: error.position, message: error.message };
    throw error;
  }
}

const HEX_DIGITS = "0123456789ABCDEF";

/** Jason's default string escaping: `"`, `\`, the C0 controls; everything else (DEL, U+2028, `/`) is written as is. */
function encodeString(value: string): string {
  let out = '"';
  let runStart = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    let escape: string | null = null;
    if (code === CH.quote) escape = '\\"';
    else if (code === CH.backslash) escape = "\\\\";
    else if (code < 0x20) {
      escape =
        code === 0x08 ? "\\b" : code === 0x09 ? "\\t" : code === 0x0a ? "\\n" : code === 0x0c ? "\\f" : code === 0x0d ? "\\r" : `\\u00${HEX_DIGITS[code >> 4]}${HEX_DIGITS[code & 0xf]}`;
    }
    if (escape !== null) {
      out += value.slice(runStart, i) + escape;
      runStart = i + 1;
    }
  }
  return `${out}${value.slice(runStart)}"`;
}

/** Order object keys by code point (= UTF-8 byte order), which is how Erlang orders the keys of a small map. */
function compareKeys(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i) ?? 0;
    const y = b.codePointAt(j) ?? 0;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  return i < a.length ? 1 : j < b.length ? -1 : 0;
}

function entriesOf(object: JsonObject, sortKeys: boolean): string[] {
  const keys = Object.keys(object);
  return sortKeys ? keys.sort(compareKeys) : keys;
}

export interface EncodeOptions {
  /** Write object keys in code point order, as Jason does for maps of up to 32 keys. Default false (insertion order). */
  readonly sortKeys?: boolean;
}

/**
 * A tagged number, as opposed to a JSON object that happens to have `kind` and `value` keys: a number's `value` is a
 * bigint or a double, which no parsed JSON object can hold.
 */
export function isJNumber(value: JsonValue): value is JNumber {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const tagged = value as { readonly kind?: unknown; readonly value?: unknown };
  return (tagged.kind === "int" && typeof tagged.value === "bigint") || (tagged.kind === "float" && typeof tagged.value === "number");
}

function isArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

/** Writes a value like `Jason.encode!/1`: integers as digits, floats in Elixir's shortest form, compact output. */
export function encodeJson(value: JsonValue, options: EncodeOptions = {}): string {
  const sortKeys = options.sortKeys ?? false;
  // A work list instead of recursion: an item is either text to emit or a value still to write.
  const out: string[] = [];
  const stack: { readonly text?: string; readonly value?: JsonValue }[] = [{ value }];
  while (stack.length > 0) {
    const item = stack.pop() as { readonly text?: string; readonly value?: JsonValue };
    if (item.text !== undefined) {
      out.push(item.text);
      continue;
    }
    const v = item.value as JsonValue;
    if (v === null) out.push("null");
    else if (typeof v === "boolean") out.push(v ? "true" : "false");
    else if (typeof v === "string") out.push(encodeString(v));
    else if (isArray(v)) {
      out.push("[");
      stack.push({ text: "]" });
      for (let i = v.length - 1; i >= 0; i--) {
        stack.push({ value: v[i] });
        if (i > 0) stack.push({ text: "," });
      }
    } else if (isJNumber(v)) out.push(elixirNumberToString(v));
    else {
      const object = v;
      const keys = entriesOf(object, sortKeys);
      out.push("{");
      stack.push({ text: "}" });
      for (let i = keys.length - 1; i >= 0; i--) {
        const key = keys[i] as string;
        stack.push({ value: object[key] });
        stack.push({ text: `${encodeString(key)}:` });
        if (i > 0) stack.push({ text: "," });
      }
    }
  }
  return out.join("");
}

/** UTF-8 byte length of a JS string (lone surrogates count as the 3-byte replacement, as `TextEncoder` writes them). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** `byte_size(Jason.encode!(value))`: the size the 10,240-byte context limit is measured in. Iterative. */
export function jsonByteSize(value: JsonValue): number {
  let size = 0;
  const stack: JsonValue[] = [value];
  while (stack.length > 0) {
    const v = stack.pop() as JsonValue;
    if (v === null) size += 4;
    else if (typeof v === "boolean") size += v ? 4 : 5;
    else if (typeof v === "string") size += utf8ByteLength(encodeString(v));
    else if (isArray(v)) {
      size += 2 + Math.max(0, v.length - 1);
      for (const item of v) stack.push(item);
    } else if (isJNumber(v)) size += elixirNumberToString(v).length; // digits, signs, `.` and `e` are ASCII
    else {
      const object = v;
      const keys = Object.keys(object);
      size += 2 + Math.max(0, keys.length - 1);
      for (const key of keys) {
        size += utf8ByteLength(encodeString(key)) + 1;
        stack.push(object[key] as JsonValue);
      }
    }
  }
  return size;
}

/**
 * Builds a `JsonValue` from plain JS data, for tests and fixtures: whole JS numbers and bigints become integers,
 * other numbers floats, objects get a null prototype. Already-tagged numbers (`jint` / `jfloat`) pass through, which
 * is how a test writes the float `1.0`.
 */
export function fromPlain(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "bigint") return jint(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON numbers are finite");
    return Number.isInteger(value) && !Object.is(value, -0) ? jint(BigInt(value)) : jfloat(value);
  }
  if (Array.isArray(value)) return value.map((item: unknown) => fromPlain(item));
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 2 && record["kind"] === "int" && typeof record["value"] === "bigint") return jint(record["value"]);
    if (keys.length === 2 && record["kind"] === "float" && typeof record["value"] === "number") return jfloat(record["value"]);
    const object = Object.create(null) as Record<string, JsonValue>;
    for (const key of keys) object[key] = fromPlain(record[key]);
    return object;
  }
  throw new TypeError(`not a JSON value: ${typeof value}`);
}

/**
 * Decodes UTF-8 strictly, as a binary must be valid UTF-8 before Jason accepts it: overlong forms, encoded
 * surrogates, code points above U+10FFFF, stray continuation bytes and truncated sequences are all `null`.
 */
export function decodeUtf8Strict(bytes: Uint8Array): string | null {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i] as number;
    let code: number;
    let extra: number;
    let min: number;
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i++;
      continue;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      code = b0 & 0x1f;
      extra = 1;
      min = 0x80;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      code = b0 & 0x0f;
      extra = 2;
      min = 0x800;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      code = b0 & 0x07;
      extra = 3;
      min = 0x10000;
    } else return null;
    for (let k = 1; k <= extra; k++) {
      const b = bytes[i + k];
      if (b === undefined || (b & 0xc0) !== 0x80) return null;
      code = (code << 6) | (b & 0x3f);
    }
    if (code < min || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
    out += String.fromCodePoint(code);
    i += extra + 1;
  }
  return out;
}

/** `Jason.decode/1` on raw bytes: ill-formed UTF-8 is a parse error, like a lone surrogate escape. */
export function parseJsonBytes(bytes: Uint8Array): JsonParseResult {
  const text = decodeUtf8Strict(bytes);
  if (text === null) return { ok: false, position: 0, message: "invalid UTF-8" };
  return parseJson(text);
}
