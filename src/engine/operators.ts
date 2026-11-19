/**
 * The condition operators as pure functions over parsed operands: `Api.Flags.Evaluator.op_matches?/3` and its
 * helpers (string_op, compare_numbers, compare_any). The evaluator (LAT-08) calls `opMatches` per condition value
 * list; everything else is exposed for tests and for write-time validation.
 */
import { compareNumbers } from "./elixir-number.ts";
import type { Ordering } from "./elixir-number.ts";
import { same } from "./equality.ts";
import { ipInCidr } from "./ip.ts";
import * as Operand from "./operand.ts";
import * as SafeRegex from "./safe-regex.ts";
import { Op } from "./types.ts";
import type { JsonValue } from "./types.ts";

export type StringOperator = typeof Op.Contains | typeof Op.StartsWith | typeof Op.EndsWith;
export type NumericOperator = typeof Op.Lt | typeof Op.Lte | typeof Op.Gt | typeof Op.Gte;

/** `string_op/3`: binary containment, prefix and suffix (the empty needle matches everything). */
export function stringOp(op: StringOperator, text: string, needle: string): boolean {
  switch (op) {
    case Op.Contains:
      return text.includes(needle);
    case Op.StartsWith:
      return text.startsWith(needle);
    case Op.EndsWith:
      return text.endsWith(needle);
  }
}

/** `compare_numbers/3` on an ordering. */
export function orderingSatisfies(op: NumericOperator, ordering: Ordering): boolean {
  switch (op) {
    case Op.Lt:
      return ordering < 0;
    case Op.Lte:
      return ordering <= 0;
    case Op.Gt:
      return ordering > 0;
    case Op.Gte:
      return ordering >= 0;
  }
}

/** `compare_any/4`: the attribute and one condition value must both parse, and the comparison must hold for some value. */
export function compareAny<T>(
  parse: (value: JsonValue) => T | null,
  value: JsonValue,
  values: readonly JsonValue[],
  compare: (left: T, right: T) => boolean,
): boolean {
  const left = parse(value);
  if (left === null) return false;
  return values.some((candidate) => {
    const right = parse(candidate);
    return right !== null && compare(left, right);
  });
}

/**
 * `op_matches?/3`: does the attribute `value` satisfy `op` against any of `values`? A list attribute matches when
 * any element does. `segment` is decided by the evaluator and never reaches here (`false`).
 */
export function opMatches(op: Op, value: JsonValue, values: readonly JsonValue[]): boolean {
  if (!Array.isArray(value)) return scalarMatches(op, value, values);
  // A list matches when any element does, at any depth. An explicit stack, not recursion: a 5,000-level list fits in
  // the 10 KB context limit and Inkress answers it (Elixir's stack is not bounded the way JS's is).
  const pending: JsonValue[] = [value];
  while (pending.length > 0) {
    const item = pending.pop() as JsonValue;
    if (Array.isArray(item)) pending.push(...(item as readonly JsonValue[]));
    else if (scalarMatches(op, item, values)) return true;
  }
  return false;
}

/** `op_matches?/3` for a value that is not a list. */
function scalarMatches(op: Op, value: JsonValue, values: readonly JsonValue[]): boolean {
  switch (op) {
    case Op.In:
      return values.some((expected) => same(expected, value));
    case Op.Contains:
    case Op.StartsWith:
    case Op.EndsWith: {
      const text = Operand.text(value);
      if (text === null) return false;
      return values.some((candidate) => {
        const needle = Operand.text(candidate);
        return needle !== null && stringOp(op, text, needle);
      });
    }
    case Op.Matches: {
      const text = Operand.text(value);
      if (text === null) return false;
      return values.some((pattern) => typeof pattern === "string" && SafeRegex.matches(pattern, text));
    }
    case Op.Lt:
    case Op.Lte:
    case Op.Gt:
    case Op.Gte:
      return compareAny(Operand.number, value, values, (a, b) => orderingSatisfies(op, compareNumbers(a, b)));
    case Op.Before:
      return compareAny(Operand.datetime, value, values, (a, b) => Operand.compareDatetimes(a, b) < 0);
    case Op.After:
      return compareAny(Operand.datetime, value, values, (a, b) => Operand.compareDatetimes(a, b) > 0);
    case Op.SemverEq:
      return compareAny(Operand.semver, value, values, (a, b) => Operand.compareSemver(a, b) === 0);
    case Op.SemverLt:
      return compareAny(Operand.semver, value, values, (a, b) => Operand.compareSemver(a, b) < 0);
    case Op.SemverGt:
      return compareAny(Operand.semver, value, values, (a, b) => Operand.compareSemver(a, b) > 0);
    case Op.IpInCidr:
      return typeof value === "string" && values.some((cidr) => typeof cidr === "string" && ipInCidr(value, cidr));
    case Op.Segment:
      return false;
  }
}
