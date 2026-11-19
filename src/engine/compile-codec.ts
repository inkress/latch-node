/**
 * The serialised form of a compiled ruleset (LAT-61): the origin builds it once per version and publishes it (KV);
 * a Worker loads it with `loadCompiled`, which reads only the header. Flags, segments and regex analyses are separate
 * chunks, decoded the first time an evaluation reaches them (and charged to that request's budget), so a cold isolate
 * never pays for a whole environment at once.
 *
 * Layout: one header line of JSON, a newline, then the chunks back to back. The header lists each chunk's key and its
 * offset and length in the body. Parsed operands travel as data (numbers, datetimes and versions as tagged strings, so
 * integers keep full precision), `in` sets as arrays, regexes as their analysis, deduplicated: a pattern used by many
 * conditions is one chunk. Variant values and mixed `in` lists go through the lossless JSON writer.
 *
 * The chunks are read from text this module wrote, so `decode*` trusts their shape (one cast per chunk, after the
 * header's format version is checked).
 */
import { encodeJson, parseJson } from "./json.ts";
import { Broken, SMALL_KEY_LIST, compareKeys, deepFreeze, flagCost, readSource, segmentCost } from "./compile-model.ts";
import type {
  CompiledCondition, CompiledFlag, CompiledRuleset, CompiledSegment, CompiledServe, DatetimeOperator, FlagSlot, KeyList, Matcher, Part,
  PatternSlot, SegmentSlot, SemverOperator, Slot, Source, StringList, ValueList,
} from "./compile-model.ts";
import type { NumericOperator, StringOperator } from "./operators.ts";
import type * as Operand from "./operand.ts";
import { loadPattern } from "./safe-regex.ts";
import type { CompiledPattern, PatternData } from "./safe-regex.ts";
import { jfloat, jint } from "./types.ts";
import type { JNumber, JsonValue, Variant, WeightedVariant } from "./types.ts";

export const FORMAT_VERSION = 1;

// ---------------------------------------------------------------------------------------------------------------
// Encoded shapes (what JSON.parse hands back)
// ---------------------------------------------------------------------------------------------------------------

type EncodedNumber = readonly ["i", string] | readonly ["f", number];
type EncodedPre = readonly ["i", string] | readonly ["s", string];
type EncodedVersion = readonly [string, string, string, readonly EncodedPre[]];

type EncodedMatcher =
  | { readonly k: "segment"; readonly keys: readonly string[] }
  | { readonly k: "inSet"; readonly v: EncodedList }
  | { readonly k: "in"; readonly v: string | number }
  | { readonly k: "text"; readonly op: StringOperator; readonly n: readonly string[] }
  | { readonly k: "regex"; readonly p: readonly number[] }
  | { readonly k: "number"; readonly op: NumericOperator; readonly o: readonly EncodedNumber[] }
  | { readonly k: "datetime"; readonly op: DatetimeOperator; readonly o: readonly string[] }
  | { readonly k: "semver"; readonly op: SemverOperator; readonly o: readonly EncodedVersion[] }
  | { readonly k: "cidr"; readonly c: readonly string[] }
  | { readonly k: "unknown" };

/** Short lists inline; long ones by id in the shared list pool. */
type EncodedList = readonly string[] | number;

interface EncodedBroken {
  readonly "!": string;
}
type Enc<T> = T | EncodedBroken;

interface EncodedCondition {
  readonly a: string | number | null;
  readonly n: boolean;
  readonly m: EncodedMatcher;
}
interface EncodedServe {
  readonly v: string | null;
  readonly r: readonly (readonly [string, number])[];
  readonly b: string | number;
}
interface EncodedRule {
  readonly id: string;
  readonly c: Enc<readonly Enc<EncodedCondition>[]>;
  readonly s: Enc<EncodedServe>;
}
interface EncodedFlag {
  readonly k: string;
  readonly kd: CompiledFlag["kind"];
  readonly sa: string;
  readonly e: boolean;
  readonly o: string;
  readonly v: Enc<readonly (readonly [string, string])[]>;
  readonly t: Enc<readonly Enc<{ readonly v: string; readonly k: Enc<EncodedList> }>[]>;
  readonly r: Enc<readonly Enc<EncodedRule>[]>;
  readonly f: Enc<EncodedServe>;
}
interface EncodedSegment {
  readonly i: Enc<EncodedList>;
  readonly x: Enc<EncodedList>;
  readonly c: Enc<readonly Enc<EncodedCondition>[]>;
}

interface Header {
  readonly format: number;
  readonly version: string;
  /** `[map key, flag key, offset, length]` */
  readonly flags: readonly (readonly [string, string, number, number])[];
  readonly segments: readonly (readonly [string, string, number, number])[];
  /** `[offset, length]` */
  readonly patterns: readonly (readonly [number, number])[];
  readonly lists: readonly (readonly [number, number])[];
  /** `[offset, length]` of each shared value list (mixed `in`) */
  readonly valueLists: readonly (readonly [number, number])[];
}

// ---------------------------------------------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------------------------------------------

function broken(part: Broken): EncodedBroken {
  return { "!": part.message };
}

function mapPart<T, U>(part: Part<T>, encode: (value: T) => U): Enc<U> {
  return part instanceof Broken ? broken(part) : encode(part);
}

const encodeNumber = (n: JNumber): EncodedNumber => (n.kind === "int" ? ["i", n.value.toString()] : ["f", n.value]);
const encodeJsonList = (values: readonly JsonValue[]): string => encodeJson(values);

/** The shared pool of long string lists a serialisation builds: identical lists are written once. */
export class ListPool {
  readonly texts: string[] = [];
  readonly valueTexts: string[] = [];
  private readonly byValues = new Map<string, number>();
  private readonly byList = new Map<StringList, number>();
  private readonly byText = new Map<string, number>();

  /** A value list (mixed `in`) by id; identical lists are one chunk. */
  encodeValues(values: readonly JsonValue[]): number {
    const text = encodeJsonList(values);
    let id = this.byValues.get(text);
    if (id === undefined) {
      id = this.valueTexts.length;
      this.valueTexts.push(text);
      this.byValues.set(text, id);
    }
    return id;
  }

  /** The list inline when short, otherwise its id in the pool. `values` must be the decoded list. */
  encode(list: StringList, values: readonly string[]): EncodedList {
    if (values.length <= SMALL_KEY_LIST) return values;
    const known = this.byList.get(list);
    if (known !== undefined) return known;
    const text = JSON.stringify(values);
    let id = this.byText.get(text);
    if (id === undefined) {
      id = this.texts.length;
      this.texts.push(text);
      this.byText.set(text, id);
    }
    this.byList.set(list, id);
    return id;
  }
}

/** Reads a list's values, decoding them if they are still serialised (outside any budget: serialising is the origin's work). */
function valuesOfList(list: StringList): readonly string[] {
  if (list.values === null) {
    if (list.source === null) throw new TypeError("compiled ruleset: list has no values");
    list.values = JSON.parse(readSource(list.source)) as string[];
    list.source = null;
  }
  return list.values;
}

function valuesOfValueList(list: ValueList): readonly JsonValue[] {
  if (list.values === null) {
    if (list.source === null) throw new TypeError("compiled ruleset: list has no values");
    list.values = decodeJsonValue(readSource(list.source)) as readonly JsonValue[];
    list.source = null;
  }
  return list.values;
}

function encodeMatcher(m: Matcher, pool: ListPool): EncodedMatcher {
  switch (m.kind) {
    case "segment":
      return { k: "segment", keys: m.keys };
    case "inSet":
      return { k: "inSet", v: pool.encode(m.list, valuesOfList(m.list)) };
    case "in":
      return { k: "in", v: pool.encodeValues(valuesOfValueList(m.list)) };
    case "text":
      return { k: "text", op: m.op, n: m.needles };
    case "regex":
      return { k: "regex", p: m.patterns };
    case "number":
      return { k: "number", op: m.op, o: m.operands.map(encodeNumber) };
    case "datetime":
      return { k: "datetime", op: m.op, o: m.operands.map((value) => value.toString()) };
    case "semver":
      return {
        k: "semver",
        op: m.op,
        o: m.operands.map((v): EncodedVersion => [v.major.toString(), v.minor.toString(), v.patch.toString(), v.pre.map((p): EncodedPre => (typeof p === "bigint" ? ["i", p.toString()] : ["s", p]))]),
      };
    case "cidr":
      return { k: "cidr", c: m.cidrs };
    case "unknown":
      return { k: "unknown" };
  }
}

const encodeCondition = (c: CompiledCondition, pool: ListPool): EncodedCondition => ({ a: c.attribute, n: c.negate, m: encodeMatcher(c.matcher, pool) });
const encodeConditions = (list: Part<readonly Part<CompiledCondition>[]>, pool: ListPool): Enc<readonly Enc<EncodedCondition>[]> =>
  mapPart(list, (items) => items.map((item) => mapPart(item, (c) => encodeCondition(c, pool))));
const encodeServe = (s: CompiledServe): EncodedServe => ({ v: s.variant, r: s.rollout.map((entry) => [entry.variant, entry.weight] as const), b: s.bucketBy });
const encodeKeys = (list: Part<KeyList>, pool: ListPool): Enc<EncodedList> => mapPart(list, (keys) => pool.encode(keys, valuesOfList(keys)));

export function encodeFlag(flag: CompiledFlag, pool: ListPool): string {
  const encoded: EncodedFlag = {
    k: flag.key,
    kd: flag.kind,
    sa: flag.salt,
    e: flag.enabled,
    o: flag.offVariant,
    v: mapPart(flag.variants, (variants) => variants.map((variant) => [variant.key, encodeJson(variant.value)] as const)),
    t: mapPart(flag.targets, (targets) => targets.map((target) => mapPart(target, (t) => ({ v: t.variant, k: encodeKeys(t.keys, pool) })))),
    r: mapPart(flag.rules, (rules) =>
      rules.map((rule) => mapPart(rule, (r): EncodedRule => ({ id: r.id, c: encodeConditions(r.conditions, pool), s: mapPart(r.serve, encodeServe) }))),
    ),
    f: mapPart(flag.fallthrough, encodeServe),
  };
  return JSON.stringify(encoded);
}

export function encodeSegment(segment: CompiledSegment, pool: ListPool): string {
  const encoded: EncodedSegment = { i: encodeKeys(segment.included, pool), x: encodeKeys(segment.excluded, pool), c: encodeConditions(segment.conditions, pool) };
  return JSON.stringify(encoded);
}

// ---------------------------------------------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------------------------------------------

/** The shared lists of a loaded ruleset, by id. */
export interface Pools {
  readonly lists: readonly StringList[];
  readonly valueLists: readonly ValueList[];
}

function isBroken<T>(value: Enc<T>): value is EncodedBroken {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "!" in value;
}

function unmapPart<T, U>(value: Enc<T>, decode: (value: T) => U): Part<U> {
  return isBroken(value) ? new Broken(value["!"]) : decode(value);
}

const decodeNumber = (n: EncodedNumber): JNumber => (n[0] === "i" ? jint(BigInt(n[1])) : jfloat(n[1]));

function decodeJsonValue(text: string): JsonValue {
  const result = parseJson(text);
  if (!result.ok) throw new SyntaxError(`compiled ruleset: ${result.message}`);
  return deepFreeze(result.value);
}

/** A list from its encoding: inline values, or the shared pool entry (decoded on first use). */
function decodeList(encoded: EncodedList, lists: readonly StringList[]): StringList {
  if (typeof encoded !== "number") return { values: encoded, set: null, source: null };
  const list = lists[encoded];
  if (list === undefined) throw new RangeError("compiled ruleset: unknown list");
  return list;
}

function decodeMatcher(m: EncodedMatcher, pools: Pools): Matcher {
  switch (m.k) {
    case "segment":
      return { kind: "segment", keys: m.keys };
    case "inSet":
      return { kind: "inSet", list: decodeList(m.v, pools.lists) };
    case "in":
    {
      const list = typeof m.v === "number" ? pools.valueLists[m.v] : { values: decodeJsonValue(m.v) as readonly JsonValue[], source: null };
      if (list === undefined) throw new RangeError("compiled ruleset: unknown value list");
      return { kind: "in", list };
    }
    case "text":
      return { kind: "text", op: m.op, needles: m.n };
    case "regex":
      return { kind: "regex", patterns: m.p };
    case "number":
      return { kind: "number", op: m.op, operands: m.o.map(decodeNumber) };
    case "datetime":
      return { kind: "datetime", op: m.op, operands: m.o.map((value) => BigInt(value)) };
    case "semver":
      return {
        kind: "semver",
        op: m.op,
        operands: m.o.map((v): Operand.SemVer => ({ major: BigInt(v[0]), minor: BigInt(v[1]), patch: BigInt(v[2]), pre: v[3].map((p) => (p[0] === "i" ? BigInt(p[1]) : p[1])) })),
      };
    case "cidr":
      return { kind: "cidr", cidrs: m.c };
    case "unknown":
      return { kind: "unknown" };
  }
}

const decodeCondition = (c: EncodedCondition, pools: Pools): CompiledCondition => ({ attribute: c.a, path: null, negate: c.n, matcher: decodeMatcher(c.m, pools) });
const decodeConditions = (list: Enc<readonly Enc<EncodedCondition>[]>, pools: Pools): Part<readonly Part<CompiledCondition>[]> =>
  unmapPart(list, (items) => items.map((item) => unmapPart(item, (c) => decodeCondition(c, pools))));
const decodeServe = (s: EncodedServe): CompiledServe => ({
  variant: s.v,
  rollout: s.r.map(([variant, weight]): WeightedVariant => ({ variant, weight })),
  bucketBy: s.b,
  path: null,
});
const decodeKeys = (keys: Enc<EncodedList>, pools: Pools): Part<KeyList> => unmapPart(keys, (list) => decodeList(list, pools.lists));

export function decodeFlag(text: string, pools: Pools): CompiledFlag {
  const f = JSON.parse(text) as EncodedFlag;
  const variants = unmapPart(f.v, (list): readonly Variant[] => list.map(([key, value]) => ({ key, value: decodeJsonValue(value) })));
  return {
    key: f.k,
    kind: f.kd,
    salt: f.sa,
    enabled: f.e,
    offVariant: f.o,
    variants,
    variantsByKey: variants instanceof Broken ? variants : new Map(variants.map((variant) => [variant.key, variant] as const).reverse()),
    targets: unmapPart(f.t, (list) => list.map((target) => unmapPart(target, (t) => ({ variant: t.v, keys: decodeKeys(t.k, pools) })))),
    rules: unmapPart(f.r, (list) => list.map((rule) => unmapPart(rule, (r) => ({ id: r.id, conditions: decodeConditions(r.c, pools), serve: unmapPart(r.s, decodeServe) })))),
    fallthrough: unmapPart(f.f, decodeServe),
  };
}

export function decodeSegment(text: string, pools: Pools): CompiledSegment {
  const s = JSON.parse(text) as EncodedSegment;
  return { included: decodeKeys(s.i, pools), excluded: decodeKeys(s.x, pools), conditions: decodeConditions(s.c, pools) };
}

/** A pattern slot's handle, built from its chunk on first use. */
export function patternHandle(slot: PatternSlot): CompiledPattern {
  if (slot.handle === null) {
    if (slot.source === null) throw new TypeError("compiled ruleset: pattern has no source");
    slot.handle = loadPattern(JSON.parse(readSource(slot.source)) as PatternData);
  }
  return slot.handle;
}

// ---------------------------------------------------------------------------------------------------------------
// Whole rulesets
// ---------------------------------------------------------------------------------------------------------------

/** Units to decode a serialised chunk, from its length. */
export function chunkCost(source: Source, unitsPerChar: number): number {
  return Math.ceil(source.length * unitsPerChar);
}

/** What a flag slot costs to bring into compiled form: from the raw flag, or from its chunk. */
export function slotCost(slot: FlagSlot | SegmentSlot, unitsPerChar: number): number {
  if (slot.source !== null) return chunkCost(slot.source, unitsPerChar);
  if (slot.raw === null) return 0;
  return "rules" in slot.raw ? flagCost(slot.raw) : segmentCost(slot.raw);
}

interface Chunks {
  readonly parts: string[];
  length: number;
}
function add(chunks: Chunks, text: string): readonly [number, number] {
  const entry = [chunks.length, text.length] as const;
  chunks.parts.push(text);
  chunks.length += text.length;
  return entry;
}

/**
 * Serialises a compiled ruleset: compiles everything not yet compiled (no budget; this is the origin's job) and writes
 * the header and chunks. `compileFlagSlot` and `compileSegmentSlot` bring a slot to compiled form.
 */
export function serializeWith(
  ruleset: CompiledRuleset,
  compileFlagSlot: (slot: FlagSlot) => CompiledFlag,
  compileSegmentSlot: (slot: SegmentSlot) => CompiledSegment,
): string {
  const chunks: Chunks = { parts: [], length: 0 };
  const pool = new ListPool();
  const flags: (readonly [string, string, number, number])[] = [];
  for (const [key, slot] of ruleset.flags) {
    const [offset, length] = add(chunks, encodeFlag(compileFlagSlot(slot), pool));
    flags.push([key, slot.key, offset, length]);
  }
  const segments: (readonly [string, string, number, number])[] = [];
  for (const [key, slot] of ruleset.segments) {
    const [offset, length] = add(chunks, encodeSegment(compileSegmentSlot(slot), pool));
    segments.push([key, slot.key, offset, length]);
  }
  const patterns = ruleset.patterns.map((slot) => add(chunks, JSON.stringify(patternHandle(slot).data())));
  const lists = pool.texts.map((text) => add(chunks, text));
  const valueLists = pool.valueTexts.map((text) => add(chunks, text));
  const header: Header = { format: FORMAT_VERSION, version: ruleset.version, flags, segments, patterns, lists, valueLists };
  return `${JSON.stringify(header)}\n${chunks.parts.join("")}`;
}

/** Builds a ruleset from serialised text. Reads the header only; every chunk waits for the evaluation that needs it. */
export function loadFrom(text: string): CompiledRuleset {
  const newline = text.indexOf("\n");
  if (newline === -1) throw new SyntaxError("compiled ruleset: no header");
  const header = JSON.parse(text.slice(0, newline)) as Header;
  if (header.format !== FORMAT_VERSION) throw new RangeError(`compiled ruleset: format ${String(header.format)} is not ${FORMAT_VERSION}`);
  const base = newline + 1;
  const source = (offset: number, length: number): Source => ({ body: text, offset: base + offset, length });
  const flags = new Map<string, FlagSlot>();
  for (const [key, flagKey, offset, length] of header.flags) flags.set(key, { key: flagKey, raw: null, source: source(offset, length), compiled: null });
  const segments = new Map<string, SegmentSlot>();
  for (const [key, segmentKey, offset, length] of header.segments) segments.set(key, { key: segmentKey, raw: null, source: source(offset, length), compiled: null });
  const patterns: PatternSlot[] = header.patterns.map(([offset, length]) => ({ handle: null, source: source(offset, length) }));
  const lists: StringList[] = header.lists.map(([offset, length]) => ({ values: null, set: null, source: source(offset, length) }));
  const valueLists: ValueList[] = header.valueLists.map(([offset, length]) => ({ values: null, source: source(offset, length) }));
  const sorted = [...flags.values()].sort((a, b) => compareKeys(a.key, b.key));
  return { version: header.version, flags, sorted, segments, patterns, lists, valueLists, patternIds: new Map(), approxBytes: text.length * 2 };
}

export type { Slot };
