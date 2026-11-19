/**
 * The compiled shape of a ruleset (LAT-61): what `compileRuleset` builds from a stored ruleset, what the codec writes
 * and reads, and what the budgeted evaluator walks. Plain data plus a few lazily built indexes (a `Set`, a regex
 * handle), so it serialises.
 *
 * Errors are isolated the way the reference evaluator isolates them: a malformed part of a flag fails only when an
 * evaluation reaches it. Compilation therefore never throws for the whole ruleset; a part that cannot be compiled is
 * stored as a `Broken` marker, and reaching it throws (once per request, never recompiled).
 */
import * as Operand from "./operand.ts";
import { compilePattern } from "./safe-regex.ts";
import type { CompiledPattern } from "./safe-regex.ts";
import { Op } from "./types.ts";
import type { Condition, Flag, JNumber, JsonValue, Rule, Segment, Serve, Variant, WeightedVariant } from "./types.ts";
import type { NumericOperator, StringOperator } from "./operators.ts";

// ---------------------------------------------------------------------------------------------------------------
// Work units
// ---------------------------------------------------------------------------------------------------------------

/**
 * What evaluation costs, in work units. One unit is about the cost of one cheap condition (a string `in` against a
 * set): 0.04 to 0.1 microseconds on a warm Node 22 isolate. Every term below charges something that costs CPU in
 * proportion to a size the caller or the ruleset controls: the length of a list attribute, of a text, the number of
 * values in a list. The calibration (cost scripts, test/budget.test.ts) is in DONE.md.
 */
export const BudgetCost = {
  /** Entering a flag. */
  flag: 1,
  /** Every condition, before its operator. */
  condition: 1,
  /** Each target list checked. */
  target: 1,
  /** Every element taken off the stack when an attribute is a list (lists and the scalars in them each count once). */
  listElement: 1,
  /** A scalar that is not a string meeting an `in` set: its text is built. */
  scalarText: 1,
  /** `in` over values that are not all strings: units per value compared, per scalar (`same?` costs about 3). */
  linearUnitsPerValue: 3,
  /** Numeric, date and version comparisons: one unit per this many operands, per scalar. */
  operandsPerUnit: 8,
  /** Parsing an attribute string as a number, a datetime or a version (once per distinct string per call). */
  parse: 4,
  /** Text operators: one unit per this many characters of text times needles, per scalar. */
  textCharsPerUnit: 64,
  /** `ip_in_cidr` parses address and range on every check: units per string scalar, per range. */
  cidrPerRange: 24,
  /** A percentage rollout: the SHA-1 bucket. */
  bucket: 4,
  /** Segment membership check (before its conditions). */
  segment: 1,
  /** Every regex run, before its work term. */
  regexBase: 25,
  /** A regex run: one unit per this much weighted program work times input length. */
  regexWorkPerUnit: 250,
  /** First use of a regex: units per character of its text (analysis and RE2 compile) before it is analysed. */
  regexBuildPerChar: 110,
  /** First use of a loaded regex: units per RE2 program instruction (the program, and each `$` split) it builds. */
  regexBuildPerInstruction: 26,
  /** Building a `Set` (an `in` set, a long key list): units per entry. */
  setBuildUnitsPerEntry: 1,
} as const;

/** What turning a stored flag or segment into its compiled form costs, charged from the same request budget. */
export const CompileCost = {
  flag: 10,
  variant: 4,
  target: 3,
  rule: 6,
  condition: 8,
  serve: 3,
  /** Parsing an operand (number, datetime, version): per value. */
  parsedValue: 6,
  /** Interning a regex pattern: per value. */
  patternValue: 16,
  /** Copying any other value into the matcher: per value. */
  plainValue: 0.1,
  /** Target and segment key lists are kept as given; the Set is built (and charged) on first use. */
  keys: 0.02,
  /** Decoding a serialised flag or segment: units per character of its chunk (about 0.05 microseconds each). */
  loadUnitsPerChar: 0.3,
  /** Decoding a serialised string list: characters per unit (JSON.parse of strings is fast). */
  listCharsPerUnit: 6,
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Parts that may be broken
// ---------------------------------------------------------------------------------------------------------------

/** A part of a flag that could not be compiled; reaching it throws, like the reference evaluator on the raw part. */
export class Broken {
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
}
export type Part<T> = T | Broken;

export function ok<T>(part: Part<T>): T {
  if (part instanceof Broken) throw new TypeError(part.message);
  return part;
}

export function attempt<T>(build: () => T): Part<T> {
  try {
    return build();
  } catch (error) {
    return new Broken(error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Compiled shapes
// ---------------------------------------------------------------------------------------------------------------

export type SemverOperator = typeof Op.SemverEq | typeof Op.SemverLt | typeof Op.SemverGt;
export type DatetimeOperator = typeof Op.Before | typeof Op.After;

export type Matcher =
  | { readonly kind: "segment"; readonly keys: readonly string[] }
  /** `in` over strings only: `Set` membership decides every attribute type (see `scalarMatches`). The set is built on first use. */
  | { readonly kind: "inSet"; readonly list: StringList }
  | { readonly kind: "in"; readonly list: ValueList }
  | { readonly kind: "text"; readonly op: StringOperator; readonly needles: readonly string[] }
  /** Indexes into the ruleset's pattern pool: one compile per distinct pattern. */
  | { readonly kind: "regex"; readonly patterns: readonly number[] }
  | { readonly kind: "number"; readonly op: NumericOperator; readonly operands: readonly JNumber[] }
  | { readonly kind: "datetime"; readonly op: DatetimeOperator; readonly operands: readonly Operand.Microseconds[] }
  | { readonly kind: "semver"; readonly op: SemverOperator; readonly operands: readonly Operand.SemVer[] }
  | { readonly kind: "cidr"; readonly cidrs: readonly string[] }
  /** An op outside the type (an untyped ruleset): `opMatches` answers `undefined` for it, which is never equal to `negate`. */
  | { readonly kind: "unknown" };

export interface CompiledCondition {
  /** A string or null; a number only in an untyped ruleset (the reference reads the exact key first). */
  readonly attribute: string | number | null;
  /** The dotted path, split on first need (so a non-string attribute fails where the reference fails). */
  path: readonly string[] | null;
  readonly negate: boolean;
  readonly matcher: Matcher;
}

/**
 * A list of strings: the values of an `in` set, a target's keys, a segment's ids. Scanned while short and indexed (once,
 * charged) when long. A loaded long list is shared by every condition that holds it and decoded on first use.
 */
export interface StringList {
  values: readonly string[] | null;
  set: ReadonlySet<string> | null;
  source: Source | null;
}
/** The values of an `in` that are not all strings; shared and decoded on first use like a `StringList`. */
export interface ValueList {
  values: readonly JsonValue[] | null;
  source: Source | null;
}
export type KeyList = StringList;
export const SMALL_KEY_LIST = 16;

export function stringList(values: readonly string[]): StringList {
  if (!Array.isArray(values)) throw new TypeError("not a list of strings");
  return { values, set: null, source: null };
}

export interface CompiledSegment {
  readonly included: Part<KeyList>;
  readonly excluded: Part<KeyList>;
  readonly conditions: Part<readonly Part<CompiledCondition>[]>;
}

export interface CompiledServe {
  readonly variant: string | null;
  readonly rollout: readonly WeightedVariant[];
  readonly bucketBy: string | number;
  path: readonly string[] | null;
}

export interface CompiledRule {
  readonly id: string;
  readonly conditions: Part<readonly Part<CompiledCondition>[]>;
  readonly serve: Part<CompiledServe>;
}

export interface CompiledTarget {
  readonly variant: string;
  readonly keys: Part<KeyList>;
}

export interface CompiledFlag {
  readonly key: string;
  readonly kind: Flag["kind"];
  readonly salt: string;
  readonly enabled: boolean;
  readonly offVariant: string;
  /** Frozen copies: an answer's value is shared between requests and cannot be changed by one of them. */
  readonly variants: Part<readonly Variant[]>;
  readonly variantsByKey: Part<ReadonlyMap<string, Variant>>;
  readonly targets: Part<readonly Part<CompiledTarget>[]>;
  readonly rules: Part<readonly Part<CompiledRule>[]>;
  readonly fallthrough: Part<CompiledServe>;
}

/** Where a serialised chunk lives. */
export interface Source {
  readonly body: string;
  readonly offset: number;
  readonly length: number;
}
export function readSource(source: Source): string {
  return source.body.slice(source.offset, source.offset + source.length);
}

/** A flag or segment waiting to be compiled (from `raw`) or decoded (from `source`) by the first evaluation that reaches it. */
export interface Slot<Raw, Compiled> {
  readonly key: string;
  /** Dropped once compiled. */
  raw: Raw | null;
  source: Source | null;
  /** A memo, not state: set once, or set to a `Broken` marker that is never retried. */
  compiled: Part<Compiled> | null;
}
export type FlagSlot = Slot<Flag, CompiledFlag>;
export type SegmentSlot = Slot<Segment, CompiledSegment>;

export interface PatternSlot {
  handle: CompiledPattern | null;
  source: Source | null;
}

/** A stored ruleset: one environment's flags and segments at one version, as the lossless reader produced them. */
export interface RawRuleset {
  readonly version: string;
  readonly flags: ReadonlyMap<string, Flag> | readonly Flag[];
  readonly segments: ReadonlyMap<string, Segment> | readonly Segment[];
}

export interface CompiledRuleset {
  readonly version: string;
  readonly flags: ReadonlyMap<string, FlagSlot>;
  /** Every flag, sorted by flag key (the order `evaluate_ruleset` answers in). */
  readonly sorted: readonly FlagSlot[];
  readonly segments: ReadonlyMap<string, SegmentSlot>;
  readonly patterns: PatternSlot[];
  /** Long string lists of a loaded ruleset, by id. */
  readonly lists: StringList[];
  /** Value lists (mixed `in`) of a loaded ruleset, by id. */
  readonly valueLists: ValueList[];
  /** Raw pattern text to pool index, while compiling from a raw ruleset. */
  readonly patternIds: Map<string, number>;
  /** Rough memory the ruleset holds (for the cache's byte cap). */
  readonly approxBytes: number;
}

export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Frozen values
// ---------------------------------------------------------------------------------------------------------------

/** A deep, frozen copy of a JSON value (numbers are tagged objects; they are frozen too). Iterative: depth is unbounded. */
export function frozenCopy(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  const root: unknown = Array.isArray(value) ? [] : Object.create(null);
  const pending: [unknown, unknown][] = [[value, root]];
  while (pending.length > 0) {
    const [from, to] = pending.pop() as [unknown, unknown];
    const keys = Object.keys(from as object);
    for (const key of keys) {
      const item = (from as Record<string, unknown>)[key];
      if (item === null || typeof item !== "object") (to as Record<string, unknown>)[key] = item;
      else {
        const copy: unknown = Array.isArray(item) ? [] : Object.create(null);
        (to as Record<string, unknown>)[key] = copy;
        pending.push([item, copy]);
      }
    }
  }
  return deepFreeze(root as JsonValue);
}

/** Freezes in place, iteratively. */
export function deepFreeze<T extends JsonValue>(value: T): T {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === null || typeof item !== "object" || Object.isFrozen(item)) continue;
    Object.freeze(item);
    for (const key of Object.keys(item)) pending.push((item as Record<string, unknown>)[key]);
  }
  return value;
}

// ---------------------------------------------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------------------------------------------

function parsed<T>(values: readonly JsonValue[], parse: (value: JsonValue) => T | null): T[] {
  const out: T[] = [];
  for (const value of values) {
    const item = parse(value);
    if (item !== null) out.push(item);
  }
  return out;
}

function isStringList(values: readonly JsonValue[]): values is readonly string[] {
  return values.every((value) => typeof value === "string");
}

/** Interns a pattern into the ruleset's pool: one slot (and one compile) per distinct pattern text. */
function internPattern(ruleset: CompiledRuleset, pattern: string): number {
  const known = ruleset.patternIds.get(pattern);
  if (known !== undefined) return known;
  const id = ruleset.patterns.length;
  ruleset.patterns.push({ handle: compilePattern(pattern), source: null });
  ruleset.patternIds.set(pattern, id);
  return id;
}

function matcherOf(ruleset: CompiledRuleset, op: Op, values: readonly JsonValue[]): Matcher {
  switch (op) {
    case Op.Segment:
      return { kind: "segment", keys: values.filter((value): value is string => typeof value === "string") };
    case Op.In:
      return isStringList(values) ? { kind: "inSet", list: stringList(values) } : { kind: "in", list: { values, source: null } };
    case Op.Contains:
    case Op.StartsWith:
    case Op.EndsWith:
      return { kind: "text", op, needles: parsed(values, Operand.text) };
    case Op.Matches:
      return { kind: "regex", patterns: values.filter((value): value is string => typeof value === "string").map((pattern) => internPattern(ruleset, pattern)) };
    case Op.Lt:
    case Op.Lte:
    case Op.Gt:
    case Op.Gte:
      return { kind: "number", op, operands: parsed(values, Operand.number) };
    case Op.Before:
    case Op.After:
      return { kind: "datetime", op, operands: parsed(values, Operand.datetime) };
    case Op.SemverEq:
    case Op.SemverLt:
    case Op.SemverGt:
      return { kind: "semver", op, operands: parsed(values, Operand.semver) };
    case Op.IpInCidr:
      return { kind: "cidr", cidrs: values.filter((value): value is string => typeof value === "string") };
    default:
      return { kind: "unknown" };
  }
}

function compileCondition(ruleset: CompiledRuleset, condition: Condition): CompiledCondition {
  return {
    attribute: condition.attribute,
    path: null,
    negate: condition.negate,
    matcher: matcherOf(ruleset, condition.op, condition.values),
  };
}

function compileServe(serve: Serve): CompiledServe {
  return {
    variant: typeof serve.variant === "string" ? serve.variant : null,
    rollout: serve.rollout.map((entry) => ({ variant: entry.variant, weight: entry.weight })),
    bucketBy: serve.bucketBy ?? "targetingKey",
    path: null,
  };
}


function compileConditions(ruleset: CompiledRuleset, conditions: readonly Condition[]): readonly Part<CompiledCondition>[] {
  return conditions.map((condition) => attempt(() => compileCondition(ruleset, condition)));
}

function compileRule(ruleset: CompiledRuleset, rule: Rule): CompiledRule {
  return {
    id: rule.id,
    conditions: attempt(() => compileConditions(ruleset, rule.conditions)),
    serve: attempt(() => compileServe(rule.serve)),
  };
}

export function compileFlag(ruleset: CompiledRuleset, flag: Flag): CompiledFlag {
  const variants = attempt((): readonly Variant[] => flag.variants.map((variant) => ({ key: variant.key, value: frozenCopy(variant.value) })));
  return {
    key: flag.key,
    kind: flag.kind,
    salt: flag.salt,
    enabled: flag.enabled,
    offVariant: flag.offVariant,
    variants,
    variantsByKey: attempt((): ReadonlyMap<string, Variant> => {
      const byKey = new Map<string, Variant>();
      for (const variant of ok(variants)) if (!byKey.has(variant.key)) byKey.set(variant.key, variant);
      return byKey;
    }),
    targets: attempt(() => flag.targets.map((target) => attempt((): CompiledTarget => ({ variant: target.variant, keys: attempt(() => stringList(target.keys)) })))),
    rules: attempt(() => flag.rules.map((rule) => attempt(() => compileRule(ruleset, rule)))),
    fallthrough: attempt(() => compileServe(flag.fallthrough)),
  };
}

export function compileSegment(ruleset: CompiledRuleset, segment: Segment): CompiledSegment {
  return {
    included: attempt(() => stringList(segment.included)),
    excluded: attempt(() => stringList(segment.excluded)),
    conditions: attempt(() => compileConditions(ruleset, segment.conditions)),
  };
}

/** Builds the slots of a raw ruleset. Nothing is compiled yet. */
export function newRuleset(raw: RawRuleset): CompiledRuleset {
  const flagMap: ReadonlyMap<string, Flag> = Array.isArray(raw.flags)
    ? new Map((raw.flags as readonly Flag[]).map((flag) => [flag.key, flag] as const))
    : (raw.flags as ReadonlyMap<string, Flag>);
  const segmentMap: ReadonlyMap<string, Segment> = Array.isArray(raw.segments)
    ? new Map((raw.segments as readonly Segment[]).map((segment) => [segment.key, segment] as const))
    : (raw.segments as ReadonlyMap<string, Segment>);
  const flags = new Map<string, FlagSlot>();
  for (const [key, flag] of flagMap) flags.set(key, { key: flag.key, raw: flag, source: null, compiled: null });
  const segments = new Map<string, SegmentSlot>();
  for (const [key, segment] of segmentMap) segments.set(key, { key: segment.key, raw: segment, source: null, compiled: null });
  const sorted = [...flags.values()].sort((a, b) => compareKeys(a.key, b.key));
  return { version: raw.version, flags, sorted, segments, patterns: [], lists: [], valueLists: [], patternIds: new Map(), approxBytes: measure(raw).bytes };
}

// ---------------------------------------------------------------------------------------------------------------
// What a ruleset costs to compile
// ---------------------------------------------------------------------------------------------------------------

function valueCost(op: unknown): number {
  switch (op) {
    case Op.Lt:
    case Op.Lte:
    case Op.Gt:
    case Op.Gte:
    case Op.Before:
    case Op.After:
    case Op.SemverEq:
    case Op.SemverLt:
    case Op.SemverGt:
      return CompileCost.parsedValue;
    case Op.Matches:
      return CompileCost.patternValue;
    default:
      return CompileCost.plainValue;
  }
}

function lengthOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function conditionsCost(conditions: unknown): number {
  if (!Array.isArray(conditions)) return 0;
  let units = 0;
  for (const condition of conditions as readonly Condition[]) units += CompileCost.condition + lengthOf(condition.values) * valueCost(condition.op);
  return units;
}

/** Units charged to compile one flag (a count of its parts; defensive about untyped input). */
export function flagCost(flag: Flag): number {
  try {
    let units = CompileCost.flag + lengthOf(flag.variants) * CompileCost.variant + CompileCost.serve;
    if (Array.isArray(flag.targets)) for (const target of flag.targets as Flag["targets"]) units += CompileCost.target + lengthOf(target.keys) * CompileCost.keys;
    if (Array.isArray(flag.rules)) for (const rule of flag.rules as Flag["rules"]) units += CompileCost.rule + CompileCost.serve + conditionsCost(rule.conditions);
    return Math.ceil(units);
  } catch {
    return CompileCost.flag;
  }
}

export function segmentCost(segment: Segment): number {
  try {
    return Math.ceil(CompileCost.flag + (lengthOf(segment.included) + lengthOf(segment.excluded)) * CompileCost.keys + conditionsCost(segment.conditions));
  } catch {
    return CompileCost.flag;
  }
}

export interface RulesetMeasure {
  /** Units to compile every flag and segment (and intern their patterns), the work a cold isolate must spread over requests. */
  readonly compileUnits: number;
  /** The most expensive single flag or segment: it must fit in one request's budget to ever compile. */
  readonly largestUnits: number;
  readonly flags: number;
  readonly segments: number;
  readonly conditions: number;
  /** Rough memory of the raw ruleset (and of its compiled form, which is the same order). */
  readonly bytes: number;
}

function sizeOfConditions(conditions: unknown): { conditions: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  if (!Array.isArray(conditions)) return { conditions: 0, bytes: 0 };
  for (const condition of conditions as readonly Condition[]) {
    count++;
    bytes += 64 + (typeof condition.attribute === "string" ? condition.attribute.length * 2 : 0);
    if (Array.isArray(condition.values)) for (const value of condition.values) bytes += typeof value === "string" ? 24 + value.length * 2 : 32;
  }
  return { conditions: count, bytes };
}

/** Walks a raw ruleset once and measures it. Never throws. */
export function measure(raw: RawRuleset): RulesetMeasure {
  const flags: readonly Flag[] = Array.isArray(raw.flags) ? (raw.flags as readonly Flag[]) : [...(raw.flags as ReadonlyMap<string, Flag>).values()];
  const segments: readonly Segment[] = Array.isArray(raw.segments) ? (raw.segments as readonly Segment[]) : [...(raw.segments as ReadonlyMap<string, Segment>).values()];
  let units = 0;
  let largest = 0;
  let conditions = 0;
  let bytes = 256;
  for (const flag of flags) {
    const cost = flagCost(flag);
    units += cost;
    largest = Math.max(largest, cost);
    bytes += 256;
    try {
      if (Array.isArray(flag.targets)) for (const target of flag.targets as Flag["targets"]) bytes += 48 + lengthOf(target.keys) * 40;
      if (Array.isArray(flag.rules)) {
        for (const rule of flag.rules as Flag["rules"]) {
          const sized = sizeOfConditions(rule.conditions);
          conditions += sized.conditions;
          bytes += 96 + sized.bytes;
        }
      }
      bytes += lengthOf(flag.variants) * 96;
    } catch {
      // malformed: counted as it is
    }
  }
  for (const segment of segments) {
    const cost = segmentCost(segment);
    units += cost;
    largest = Math.max(largest, cost);
    try {
      const sized = sizeOfConditions(segment.conditions);
      conditions += sized.conditions;
      bytes += 256 + sized.bytes + (lengthOf(segment.included) + lengthOf(segment.excluded)) * 40;
    } catch {
      bytes += 256;
    }
  }
  return { compileUnits: units, largestUnits: largest, flags: flags.length, segments: segments.length, conditions, bytes };
}
