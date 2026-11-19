/**
 * Elixir equality over JSON terms: `==` (maps compare deeply, `1 == 1.0`), `===`, and the evaluator's `same?/2`
 * (Api.Flags.Evaluator, used by the `in` operator).
 */
import { numbersEqual } from "./elixir-number.ts";
import { isJNumber } from "./json.ts";
import * as Operand from "./operand.ts";
import type { JsonObject, JsonValue } from "./types.ts";
import { getOwn } from "./types.ts";

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !isJNumber(value);
}

function isList(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

/** Iterative, so a 5,000-deep context cannot overflow the stack. */
function deepEquals(a: JsonValue, b: JsonValue, strict: boolean): boolean {
  const pending: [JsonValue, JsonValue][] = [[a, b]];
  while (pending.length > 0) {
    const [x, y] = pending.pop() as [JsonValue, JsonValue];
    if (isJNumber(x)) {
      if (!isJNumber(y) || (strict && x.kind !== y.kind) || !numbersEqual(x, y)) return false;
    } else if (isJNumber(y)) return false;
    else if (x === null || typeof x !== "object") {
      if (x !== y) return false;
    } else if (isList(x)) {
      if (!isList(y) || x.length !== y.length) return false;
      for (let i = 0; i < x.length; i++) pending.push([x[i] as JsonValue, y[i] as JsonValue]);
    } else {
      if (!isObject(y)) return false;
      const keys = Object.keys(x);
      if (keys.length !== Object.keys(y).length) return false;
      for (const key of keys) {
        const other = getOwn(y, key);
        if (other === undefined) return false;
        pending.push([x[key] as JsonValue, other]);
      }
    }
  }
  return true;
}

/**
 * Elixir `a == b` over JSON terms. Numbers compare by value (`1 == 1.0`, `0.0 == -0.0`); lists compare element by
 * element and maps by keys and values with the same rule; nothing else is equal across types.
 */
export function elixirEquals(a: JsonValue, b: JsonValue): boolean {
  return deepEquals(a, b, false);
}

/** Elixir `a === b` over JSON terms: as `==`, except an integer is never `===` a float (at any depth). */
export function elixirStrictEquals(a: JsonValue, b: JsonValue): boolean {
  return deepEquals(a, b, true);
}

/**
 * `Api.Flags.Evaluator.same?/2`, the equality behind the `in` operator:
 * - two binaries compare as binaries;
 * - two numbers compare by value (`1` is `1.0`);
 * - if either side is a boolean, both must be the same boolean (`===`);
 * - anything else compares as `Operand.text`, and a side without text (nil, list, map) never matches.
 */
export function same(expected: JsonValue, actual: JsonValue): boolean {
  if (typeof expected === "string" && typeof actual === "string") return expected === actual;
  if (isJNumber(expected) && isJNumber(actual)) return numbersEqual(expected, actual);
  if (typeof expected === "boolean" || typeof actual === "boolean") return expected === actual;
  const a = Operand.text(expected);
  const b = Operand.text(actual);
  return a !== null && b !== null && a === b;
}
