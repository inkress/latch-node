/**
 * Compiled rulesets and the budgeted bulk evaluator (LAT-61).
 *
 * `compileRuleset` turns a stored ruleset into a `CompiledRuleset` (compile-model.ts): operands parsed once, `in`
 * sets as `Set`s, regexes compiled once per distinct pattern into a private pool (never the global SafeRegex LRU),
 * target and segment key lists indexed, variant values frozen. The origin can `serializeCompiled` it and a Worker
 * `loadCompiled` it (compile-codec.ts).
 *
 * `evaluateAllCompiled` answers exactly what `evaluate` answers on the raw flag (the parity suite runs through it)
 * and stops at a work budget. The budget charges what costs CPU: every condition, every element of a list attribute,
 * text length, regex work, and whatever compile work a cold ruleset still owes (flag decode, Set builds, RE2
 * builds). A charge that would pass the budget is refused before the work runs, so charged units never exceed it. Flags
 * the budget did not reach answer a GENERAL error, with "(warming)" in the details when they still have to be
 * compiled: what was compiled stays compiled, so warm-up spreads over requests and a retry gets further.
 *
 * `evaluator.ts` stays the reference: the small serve / plan helpers below are line-for-line copies of its private ones.
 */
import { bucket, pick } from "./bucket.ts";
import { compareNumbers, elixirNumberToString } from "./elixir-number.ts";
import { elixirEquals, same } from "./equality.ts";
import { errorEvaluation, okEvaluation } from "./evaluation.ts";
import { isJsonObject } from "./context.ts";
import { PREREQUISITE_DEPTH_LIMIT, RAW_NUMBER_DETAILS, INTERNAL_ERROR_DETAILS, recordInternalError, valueOfKind } from "./evaluator.ts";
import { ipInCidr } from "./ip.ts";
import { isJNumber, parseJson } from "./json.ts";
import { orderingSatisfies, stringOp } from "./operators.ts";
import * as Operand from "./operand.ts";
import { etag } from "./ruleset.ts";
import type { BulkResult } from "./ruleset.ts";
import { WORK_BUDGET } from "./safe-regex.ts";
import { ErrorCode, Reason, getOwn } from "./types.ts";
import type { Context, Evaluation, JNumber, JsonValue, Prerequisite, Resolved } from "./types.ts";
import { decodeFlag, decodeSegment, loadFrom, patternHandle, serializeWith, slotCost } from "./compile-codec.ts";
import {
  BudgetCost, Broken, CompileCost, SMALL_KEY_LIST, attempt, compareKeys, compileFlag, compileSegment, deepFreeze, measure, newRuleset, ok, readSource,
} from "./compile-model.ts";
import type {
  CompiledCondition, CompiledFlag, CompiledRuleset, CompiledSegment, CompiledServe, FlagSlot, Matcher, Part, RawRuleset, RulesetMeasure, SegmentSlot, Slot, StringList, ValueList,
} from "./compile-model.ts";

export { BudgetCost, CompileCost } from "./compile-model.ts";
export type { CompiledRuleset, FlagSlot, RawRuleset, RulesetMeasure, SegmentSlot } from "./compile-model.ts";

/**
 * Default budget for one `evaluateAllCompiled` call. A realistic 200-flag environment spends under 2% of it, a
 * maximum-size one is cut at about 2 ms of warm CPU in Node, and a cold isolate (several times slower per unit) stays
 * inside the 10 ms free-tier limit. Overridable per call.
 */
export const DEFAULT_BUDGET_UNITS = 40_000;

export const BUDGET_EXCEEDED_DETAILS = "evaluation budget exceeded";
export const BUDGET_WARMING_DETAILS = "evaluation budget exceeded (warming)";

/** Is this evaluation one the budget cut (including the warming kind)? */
export function isBudgetCut(evaluation: Evaluation): boolean {
  return evaluation.errorCode === ErrorCode.General && (evaluation.errorDetails === BUDGET_EXCEEDED_DETAILS || evaluation.errorDetails === BUDGET_WARMING_DETAILS);
}

// ---------------------------------------------------------------------------------------------------------------
// Compile, serialise, load
// ---------------------------------------------------------------------------------------------------------------

export interface CompileOptions {
  /** Compile every flag and segment now instead of on first use. Never throws for a malformed part. */
  readonly eager?: boolean;
}

/** An unlimited meter, for compiling outside a request (eager compile, serialising). */
function unmetered(ruleset: CompiledRuleset): State {
  return newState(ruleset, {}, null, new Map(), Infinity);
}

function flagOf(slot: FlagSlot, state: State): Part<CompiledFlag> {
  return materialize(slot, state, (raw) => compileFlag(state.ruleset, raw), (text) => decodeFlag(text, state.ruleset));
}

function segmentOf(slot: SegmentSlot, state: State): Part<CompiledSegment> {
  return materialize(slot, state, (raw) => compileSegment(state.ruleset, raw), (text) => decodeSegment(text, state.ruleset));
}

/**
 * Brings a slot to compiled form, charging the compile (or decode) work first. A refused charge leaves the slot as it
 * was; a compile that fails is stored as a `Broken` marker and never retried.
 */
function materialize<Raw, Compiled>(
  slot: Slot<Raw, Compiled>,
  state: State,
  fromRaw: (raw: Raw) => Compiled,
  fromChunk: (text: string) => Compiled,
): Part<Compiled> {
  if (slot.compiled !== null) return slot.compiled;
  chargeCompile(state, slotCost(slot as FlagSlot | SegmentSlot, CompileCost.loadUnitsPerChar));
  const { raw, source } = slot;
  slot.compiled = attempt(() => {
    if (raw !== null) return fromRaw(raw);
    if (source === null) throw new TypeError("compiled ruleset: slot has nothing to compile");
    return fromChunk(source.body.slice(source.offset, source.offset + source.length));
  });
  slot.raw = null;
  slot.source = null;
  return slot.compiled;
}

/**
 * Compiles a stored ruleset. Lazy and memoised by default: a flag (or segment) is compiled the first time an
 * evaluation reaches it, and a regex the first time it runs, so answering one flag out of 500 compiles one flag. Never
 * throws for a malformed flag: the malformed part fails when an evaluation reaches it, as `evaluate` does.
 */
export function compileRuleset(raw: RawRuleset, options: CompileOptions = {}): CompiledRuleset {
  const ruleset = newRuleset(raw);
  if (options.eager === true) {
    const state = unmetered(ruleset);
    for (const slot of ruleset.flags.values()) flagOf(slot, state);
    for (const slot of ruleset.segments.values()) segmentOf(slot, state);
  }
  return ruleset;
}

/** What compiling `raw` costs in work units, and its largest single piece; for the write path to bound (see DONE.md). */
export function compileCostOf(raw: RawRuleset): RulesetMeasure {
  return measure(raw);
}

/** The serialised form of a ruleset (compiled first if it is not). Pure data: publish it, `loadCompiled` it elsewhere. */
export function serializeCompiled(ruleset: CompiledRuleset): string {
  const state = unmetered(ruleset);
  return serializeWith(
    ruleset,
    (slot) => ok(flagOf(slot, state)),
    (slot) => ok(segmentOf(slot, state)),
  );
}

/** A ruleset from `serializeCompiled`'s text. Reads the header only; flags, segments and patterns decode when reached. */
export function loadCompiled(text: string): CompiledRuleset {
  return loadFrom(text);
}

// ---------------------------------------------------------------------------------------------------------------
// Per-call state and the work meter
// ---------------------------------------------------------------------------------------------------------------

/** Thrown (one shared instance each) when a charge would pass the budget; caught per flag, never escapes. */
class BudgetExceeded extends Error {}
const EXCEEDED = new BudgetExceeded("evaluation budget exceeded");
/** The same, for a charge that was compile work: what is left is warm-up. */
const WARMING = new BudgetExceeded("evaluation budget exceeded (warming)");

interface State {
  readonly ruleset: CompiledRuleset;
  readonly context: Context;
  readonly planFeatures: ReadonlyMap<string, JsonValue>;
  readonly targetingKey: string | null;
  readonly attributes: Map<string, JsonValue>;
  readonly segmentHits: Map<string, boolean>;
  /** Attribute strings already parsed as a number, datetime or version (the same string is parsed by many conditions). */
  readonly parsedNumbers: Map<string, JNumber | null>;
  readonly parsedDatetimes: Map<string, Operand.Microseconds | null>;
  readonly parsedVersions: Map<string, Operand.SemVer | null>;
  readonly budget: number;
  spent: number;
  /** Segment conditions never see other segments (`EMPTY_RESOLVED`). */
  segmentsVisible: boolean;
  /** The flags being evaluated for a prerequisite check, outermost first (LAT-23): a flag already on it is a cycle. */
  readonly prerequisiteTrail: string[];
}

function newState(ruleset: CompiledRuleset, context: Context, planFeaturesOrNull: ReadonlyMap<string, JsonValue> | null, attributes: Map<string, JsonValue>, budget: number): State {
  return {
    ruleset,
    context,
    planFeatures: planFeaturesOrNull ?? new Map(),
    targetingKey: targetingKeyOf(context),
    attributes,
    segmentHits: new Map(),
    parsedNumbers: new Map(),
    parsedDatetimes: new Map(),
    parsedVersions: new Map(),
    budget,
    spent: 0,
    segmentsVisible: true,
    prerequisiteTrail: [],
  };
}

/** Charges before the work runs; a charge that would pass the budget is refused and not counted. */
function charge(state: State, units: number): void {
  if (state.spent + units > state.budget) throw EXCEEDED;
  state.spent += units;
}

/** `charge` for compile and build work: a refusal means "still warming". */
function chargeCompile(state: State, units: number): void {
  if (state.spent + units > state.budget) throw WARMING;
  state.spent += units;
}

/** `Evaluator.targeting_key/1` */
function targetingKeyOf(context: Context): string | null {
  const key = getOwn(context, "targetingKey");
  if (typeof key === "string" && key !== "") return key;
  if (key !== undefined && isJNumber(key) && key.kind === "int") return key.value.toString();
  return null;
}

function nestedLookup(context: Context, path: readonly string[]): JsonValue {
  let current: JsonValue | undefined = context;
  for (const head of path) {
    if (current === undefined || current === null || !isJsonObject(current)) return null;
    current = getOwn(current, head);
  }
  return current === undefined ? null : current;
}

/** The dotted path of an attribute name, split on first need: a name that is not a string fails here, as in the reference. */
function pathOf(holder: { path: readonly string[] | null }, name: string | number): readonly string[] {
  holder.path ??= (name as string).split(".");
  return holder.path;
}

/** `Evaluator.attribute/2`, memoised per call: the exact key first, then a dotted path. */
function lookup(state: State, name: string | number, holder: { path: readonly string[] | null }): JsonValue {
  if (name === "targetingKey") return state.targetingKey;
  const known = state.attributes.get(name as string);
  if (known !== undefined) return known;
  const exact = getOwn(state.context, name as string);
  const value = exact !== undefined ? exact : nestedLookup(state.context, pathOf(holder, name));
  state.attributes.set(name as string, value);
  return value;
}

/** `parse(value)`, remembered for string values (every other type parses in constant time); a miss costs `BudgetCost.parse`. */
function memoParse<T>(state: State, cache: Map<string, T | null>, parse: (value: JsonValue) => T | null, value: JsonValue): T | null {
  if (typeof value !== "string") return parse(value);
  const known = cache.get(value);
  if (known !== undefined) return known;
  charge(state, BudgetCost.parse);
  const result = parse(value);
  cache.set(value, result);
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Key lists, sets
// ---------------------------------------------------------------------------------------------------------------

/** A list's values; a loaded list decodes on first use, charged. */
function valuesOf(list: StringList, state: State): readonly string[] {
  if (list.values === null) {
    if (list.source === null) throw new TypeError("compiled ruleset: list has no values");
    chargeCompile(state, Math.ceil(list.source.length / CompileCost.listCharsPerUnit));
    list.values = JSON.parse(readSource(list.source)) as string[];
    list.source = null;
  }
  return list.values;
}

/** The values of a mixed `in`; a loaded list decodes on first use, charged. */
function valuesOfValueList(list: ValueList, state: State): readonly JsonValue[] {
  if (list.values === null) {
    if (list.source === null) throw new TypeError("compiled ruleset: list has no values");
    chargeCompile(state, Math.ceil(list.source.length / CompileCost.listCharsPerUnit));
    const parsed = parseJson(readSource(list.source));
    if (!parsed.ok) throw new SyntaxError(parsed.message);
    list.values = deepFreeze(parsed.value) as readonly JsonValue[];
    list.source = null;
  }
  return list.values;
}

/** A list's `Set`, built on first use, charged. */
function setOf(list: StringList, state: State): ReadonlySet<string> {
  if (list.set === null) {
    const values = valuesOf(list, state);
    chargeCompile(state, values.length * BudgetCost.setBuildUnitsPerEntry);
    list.set = new Set(values);
  }
  return list.set;
}

function listHas(list: StringList, key: string, state: State): boolean {
  const values = valuesOf(list, state);
  return values.length <= SMALL_KEY_LIST ? values.includes(key) : setOf(list, state).has(key);
}

// ---------------------------------------------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------------------------------------------

function scalarMatches(matcher: Matcher, value: JsonValue, state: State): boolean {
  switch (matcher.kind) {
    case "inSet": {
      // `same?/2` against all-string values: a string attribute is plain equality; a boolean never equals a string;
      // anything else is compared as its text, and a list or map has none.
      if (typeof value === "string") return listHas(matcher.list, value, state);
      if (typeof value === "boolean") return false;
      charge(state, BudgetCost.scalarText);
      const text = Operand.text(value);
      return text !== null && listHas(matcher.list, text, state);
    }
    case "in": {
      const values = valuesOfValueList(matcher.list, state);
      charge(state, values.length * BudgetCost.linearUnitsPerValue);
      return values.some((expected) => same(expected, value));
    }
    case "text": {
      const text = Operand.text(value);
      if (text === null) return false;
      charge(state, Math.ceil((text.length * matcher.needles.length) / BudgetCost.textCharsPerUnit));
      return matcher.needles.some((needle) => stringOp(matcher.op, text, needle));
    }
    case "regex": {
      const text = Operand.text(value);
      if (text === null) return false;
      const endsWithNewline = text.endsWith("\n");
      for (const id of matcher.patterns) {
        const slot = state.ruleset.patterns[id];
        if (slot === undefined) throw new TypeError("compiled ruleset: unknown pattern");
        const pattern = patternHandle(slot);
        if (!pattern.ready) chargeCompile(state, Math.ceil(pattern.buildSize * (slot.source === null ? BudgetCost.regexBuildPerChar : BudgetCost.regexBuildPerInstruction)));
        charge(state, BudgetCost.regexBase + Math.ceil(Math.min(pattern.workFor(text.length, endsWithNewline), WORK_BUDGET) / BudgetCost.regexWorkPerUnit));
        if (pattern.matches(text)) return true;
      }
      return false;
    }
    case "number": {
      const left = memoParse(state, state.parsedNumbers, Operand.number, value);
      if (left === null) return false;
      charge(state, Math.ceil(matcher.operands.length / BudgetCost.operandsPerUnit));
      return matcher.operands.some((right) => orderingSatisfies(matcher.op, compareNumbers(left, right)));
    }
    case "datetime": {
      const left = memoParse(state, state.parsedDatetimes, Operand.datetime, value);
      if (left === null) return false;
      charge(state, Math.ceil(matcher.operands.length / BudgetCost.operandsPerUnit));
      return matcher.operands.some((right) => (matcher.op === "before" ? Operand.compareDatetimes(left, right) < 0 : Operand.compareDatetimes(left, right) > 0));
    }
    case "semver": {
      const left = memoParse(state, state.parsedVersions, Operand.semver, value);
      if (left === null) return false;
      charge(state, Math.ceil(matcher.operands.length / BudgetCost.operandsPerUnit));
      return matcher.operands.some((right) => {
        const order = Operand.compareSemver(left, right);
        return matcher.op === "semver_eq" ? order === 0 : matcher.op === "semver_lt" ? order < 0 : order > 0;
      });
    }
    case "cidr":
      if (typeof value !== "string") return false;
      charge(state, BudgetCost.cidrPerRange * matcher.cidrs.length);
      return matcher.cidrs.some((cidr) => ipInCidr(value, cidr));
    case "segment":
    case "unknown":
      return false;
  }
}

/** `op_matches?/3`: a list attribute matches when any element does, at any depth (explicit stack, like operators.ts). Every element taken off the stack is charged. */
function matchValue(matcher: Matcher, value: JsonValue, state: State): boolean {
  if (!Array.isArray(value)) return scalarMatches(matcher, value, state);
  const pending: JsonValue[] = [value];
  while (pending.length > 0) {
    charge(state, BudgetCost.listElement);
    const item = pending.pop() as JsonValue;
    if (Array.isArray(item)) pending.push(...(item as readonly JsonValue[]));
    else if (scalarMatches(matcher, item, state)) return true;
  }
  return false;
}

function conditionsMatch(conditions: Part<readonly Part<CompiledCondition>[]>, state: State): boolean {
  for (const condition of ok(conditions)) if (!conditionMatches(ok(condition), state)) return false;
  return true;
}

function inSegment(segment: CompiledSegment, state: State): boolean {
  const key = state.targetingKey;
  if (key !== null && listHas(ok(segment.excluded), key, state)) return false;
  if (key !== null && listHas(ok(segment.included), key, state)) return true;
  const conditions = ok(segment.conditions);
  if (conditions.length === 0) return false;
  const outer = state.segmentsVisible;
  state.segmentsVisible = false;
  try {
    return conditionsMatch(conditions, state);
  } finally {
    state.segmentsVisible = outer;
  }
}

/** The segment answers are the same for every flag in one call (same context), so each is decided once. */
function segmentHit(key: string, state: State): boolean {
  if (!state.segmentsVisible) return false;
  const slot = state.ruleset.segments.get(key);
  if (slot === undefined) return false;
  const known = state.segmentHits.get(key);
  if (known !== undefined) return known;
  charge(state, BudgetCost.segment);
  const hit = inSegment(ok(segmentOf(slot, state)), state);
  state.segmentHits.set(key, hit);
  return hit;
}

/** `Evaluator.condition_matches?/3` */
function conditionMatches(condition: CompiledCondition, state: State): boolean {
  charge(state, BudgetCost.condition);
  const matcher = condition.matcher;
  if (matcher.kind === "segment") {
    const hit = matcher.keys.some((key) => segmentHit(key, state));
    return hit !== condition.negate;
  }
  if (condition.attribute === null) throw new TypeError("condition has no attribute");
  const value = lookup(state, condition.attribute, condition);
  // A missing attribute never matches, negated or not.
  if (value === null) return false;
  if (matcher.kind === "unknown") return Array.isArray(value) ? condition.negate : true;
  return matchValue(matcher, value, state) !== condition.negate;
}

// ---------------------------------------------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------------------------------------------

function served(flag: CompiledFlag, variantKey: string, reason: Reason): Evaluation {
  const variant = ok(flag.variantsByKey).get(variantKey);
  if (variant === undefined) return errorEvaluation(flag.key, ErrorCode.General, `variant ${variantKey} is not defined`);
  return okEvaluation(flag.key, variant.value, variant.key, reason);
}

/** `Evaluator.bucket_value/2` */
function bucketValueOf(state: State, spec: CompiledServe): string | null {
  const value = lookup(state, spec.bucketBy, spec);
  if (typeof value === "string" && value !== "") return value;
  if (isJNumber(value)) return elixirNumberToString(value);
  return null;
}

function serve(flag: CompiledFlag, spec: CompiledServe, state: State, reason: Reason): Evaluation {
  if (spec.variant !== null) return served(flag, spec.variant, reason);
  const value = bucketValueOf(state, spec);
  if (value === null) return errorEvaluation(flag.key, ErrorCode.TargetingKeyMissing, `rollout needs a value for ${String(spec.bucketBy)}`);
  charge(state, BudgetCost.bucket);
  return served(flag, pick(spec.rollout, bucket(flag.key, flag.salt, value)), Reason.Split);
}

function planValue(flag: CompiledFlag, value: JsonValue): Evaluation {
  const variant = ok(flag.variants).find((candidate) => elixirEquals(candidate.value, value));
  return { ...okEvaluation(flag.key, value, variant === undefined ? null : variant.key, Reason.TargetingMatch), metadata: { source: "plan" } };
}

function targetVariant(flag: CompiledFlag, state: State): string | null {
  const key = state.targetingKey;
  if (key === null) return null;
  for (const part of ok(flag.targets)) {
    const target = ok(part);
    charge(state, BudgetCost.target);
    if (listHas(ok(target.keys), key, state)) return target.variant;
  }
  return null;
}

/** Latch (LAT-23), mirrors `unmetPrerequisite` in evaluator.ts: the first prerequisite not met for this context, or null. */
function unmetPrerequisite(flag: CompiledFlag, prerequisites: readonly Prerequisite[], state: State): string | null {
  const trail = state.prerequisiteTrail;
  for (const prerequisite of prerequisites) {
    const slot = state.ruleset.flags.get(prerequisite.flag);
    if (slot === undefined || slot.key === flag.key || trail.includes(slot.key) || trail.length >= PREREQUISITE_DEPTH_LIMIT) return prerequisite.flag;
    const parent = ok(flagOf(slot, state));
    trail.push(flag.key);
    let result: Evaluation;
    try {
      result = evaluateFlag(parent, state);
    } finally {
      trail.pop();
    }
    if (result.errorCode !== null || result.variant !== prerequisite.variant) return prerequisite.flag;
  }
  return null;
}

function evaluateFlag(flag: CompiledFlag, state: State): Evaluation {
  charge(state, BudgetCost.flag);
  if (!flag.enabled) return served(flag, flag.offVariant, Reason.Disabled);

  if (flag.prerequisites !== undefined) {
    const unmet = unmetPrerequisite(flag, flag.prerequisites, state);
    if (unmet !== null) {
      const off = served(flag, flag.offVariant, Reason.Disabled);
      return off.errorCode !== null ? off : { ...off, metadata: { ...off.metadata, prerequisite: unmet } };
    }
  }

  const target = targetVariant(flag, state);
  if (target !== null) return served(flag, target, Reason.TargetingMatch);

  for (const part of ok(flag.rules)) {
    const rule = ok(part);
    if (conditionsMatch(rule.conditions, state)) {
      const result = serve(flag, ok(rule.serve), state, Reason.TargetingMatch);
      return result.errorCode !== null ? result : { ...result, metadata: { ...result.metadata, ruleId: rule.id } };
    }
  }

  const plan = state.planFeatures.get(flag.key);
  if (plan !== undefined && valueOfKind(flag.kind, plan)) return planValue(flag, plan);

  return serve(flag, ok(flag.fallthrough), state, Reason.Static);
}

/** `Evaluator.evaluate/3` on a flag slot: never throws; a refused charge comes back as the sentinel that refused it. */
function evaluateGuarded(slot: FlagSlot, state: State): Evaluation | BudgetExceeded {
  try {
    return evaluateFlag(ok(flagOf(slot, state)), state);
  } catch (error) {
    if (error instanceof BudgetExceeded) return error;
    recordInternalError();
    return errorEvaluation(slot.key, ErrorCode.General, INTERNAL_ERROR_DETAILS);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Bulk
// ---------------------------------------------------------------------------------------------------------------

/** Iterative scan for a raw JS number anywhere in a context (copy of evaluator.ts's guard). */
function holdsRawNumber(root: JsonValue): boolean {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item === "number") return true;
    if (item === null || typeof item !== "object" || isJNumber(item as JsonValue)) continue;
    if (Array.isArray(item)) pending.push(...(item as unknown[]));
    else for (const key of Object.keys(item)) pending.push((item as Record<string, unknown>)[key]);
  }
  return false;
}

export interface BudgetReport {
  readonly budgetUnits: number;
  /** Units charged for work that ran (never above `budgetUnits`). */
  readonly unitsSpent: number;
  /** Flags answered with the budget error. */
  readonly flagsSkipped: number;
  /** Of those, flags that still have to be compiled (retrying gets further). */
  readonly flagsWarming: number;
}

export interface BulkOptions {
  /** The caller's scope string, part of the ETag (for example "server" or "client"). */
  readonly scope: string;
  /** A positive integer; defaults to `DEFAULT_BUDGET_UNITS`. `Infinity` turns the budget off. */
  readonly budgetUnits?: number;
  /** Called once, after evaluation, when at least one flag was cut. A callback that throws is ignored. */
  readonly onBudgetExceeded?: (report: BudgetReport) => void;
}

export interface CompiledBulkResult extends BulkResult {
  readonly unitsSpent: number;
  /** Flags answered with the budget error (0 when the budget held). */
  readonly budgetExceededCount: number;
}

function validBudget(units: number): number {
  if (units === Infinity || (Number.isInteger(units) && units > 0)) return units;
  throw new RangeError("budgetUnits must be a positive integer (or Infinity)");
}

function selection(ruleset: CompiledRuleset, keys: readonly string[] | "all"): readonly FlagSlot[] {
  if (keys === "all") return ruleset.sorted;
  const selected: FlagSlot[] = [];
  for (const key of keys) {
    const flag = ruleset.flags.get(key);
    if (flag !== undefined) selected.push(flag);
  }
  return selected.sort((a, b) => compareKeys(a.key, b.key));
}

/** The ETag context of a context that cannot be evaluated: a sentinel, so it never collides with a real context (such as `{}`). */
function invalidContextTag(reason: string): JsonValue {
  return `invalid:${reason}`;
}

/**
 * `evaluate_ruleset` on a compiled ruleset, with a work budget. Unknown keys are skipped, results sorted by flag key.
 * Every flag the budget did not reach answers `{reason: "ERROR", errorCode: "GENERAL", errorDetails: "evaluation budget
 * exceeded"}` (with " (warming)" when it still has to be compiled), value null. For a given ruleset state, context,
 * plan features and selection the cut is deterministic. Compile work is charged only the first time it runs, so a cold
 * ruleset cuts earlier than a warm one.
 */
export function evaluateAllCompiled(
  ruleset: CompiledRuleset,
  context: JsonValue | undefined,
  resolved: Pick<Resolved, "planFeatures">,
  keys: readonly string[] | "all",
  options: BulkOptions,
): CompiledBulkResult {
  const budget = validBudget(options.budgetUnits ?? DEFAULT_BUDGET_UNITS);
  const selected = selection(ruleset, keys);
  const isObject = isJsonObject(context);
  const rawNumber = isObject && holdsRawNumber(context);
  const tagContext: JsonValue = !isObject ? invalidContextTag("not-an-object") : rawNumber ? invalidContextTag("raw-number") : context;
  const tag = etag(ruleset.version, tagContext, resolved.planFeatures, keys, options.scope);

  if (!isObject) {
    return { evaluations: selected.map((flag) => errorEvaluation(flag.key, ErrorCode.InvalidContext, "context must be an object")), etag: tag, unitsSpent: 0, budgetExceededCount: 0 };
  }
  if (rawNumber) {
    return { evaluations: selected.map((flag) => errorEvaluation(flag.key, ErrorCode.InvalidContext, RAW_NUMBER_DETAILS)), etag: tag, unitsSpent: 0, budgetExceededCount: 0 };
  }

  const state = newState(ruleset, context, new Map(resolved.planFeatures), new Map(), budget);
  const evaluations: Evaluation[] = [];
  let skipped = 0;
  let warming = 0;
  let cut: BudgetExceeded | null = null;
  for (const slot of selected) {
    const result: Evaluation | BudgetExceeded = cut === null ? evaluateGuarded(slot, state) : cut;
    if (result instanceof BudgetExceeded) {
      cut = result;
      skipped++;
      const isWarming = result === WARMING || slot.compiled === null;
      if (isWarming) warming++;
      evaluations.push(errorEvaluation(slot.key, ErrorCode.General, isWarming ? BUDGET_WARMING_DETAILS : BUDGET_EXCEEDED_DETAILS));
    } else evaluations.push(result);
  }
  if (skipped > 0 && options.onBudgetExceeded !== undefined) {
    try {
      options.onBudgetExceeded({ budgetUnits: budget, unitsSpent: state.spent, flagsSkipped: skipped, flagsWarming: warming });
    } catch {
      // a reporting callback must not break the answer
    }
  }
  return { evaluations, etag: tag, unitsSpent: state.spent, budgetExceededCount: skipped };
}

// ---------------------------------------------------------------------------------------------------------------
// Per-isolate cache
// ---------------------------------------------------------------------------------------------------------------

export const DEFAULT_CACHE_BYTES = 32 * 1024 * 1024;

export interface RulesetCache {
  /** The compiled ruleset for this environment if it is held at exactly this version. A hit makes it the most recently used. */
  get(environmentId: string, version: string): CompiledRuleset | undefined;
  /**
   * The ruleset for this environment at this version: cached, or loaded, compiled and cached. Each environment holds one
   * slot, replaced when another version arrives. If `load` returns a different version than asked for (a publish race),
   * that ruleset is cached and served: read its `version`.
   */
  getOrCompile(environmentId: string, version: string, load: () => RawRuleset): CompiledRuleset;
  /** The same for the serialised form (`serializeCompiled`'s text). */
  getOrLoad(environmentId: string, version: string, load: () => string): CompiledRuleset;
  readonly size: number;
  /** Approximate bytes held. */
  readonly bytes: number;
  clear(): void;
}

interface Entry {
  readonly ruleset: CompiledRuleset;
  readonly bytes: number;
}

/**
 * A least-recently-used cache of compiled rulesets, one slot per environment (a new version replaces the old, so one
 * tenant publishing many versions cannot push another out), weighted by approximate bytes with a total cap. The
 * ruleset just inserted is always kept, even if it alone exceeds the cap. The raw ruleset is not kept: each slot drops
 * its raw flag when it compiles.
 */
export function rulesetCache(maxBytes: number = DEFAULT_CACHE_BYTES): RulesetCache {
  if (!Number.isFinite(maxBytes) || maxBytes < 1) throw new RangeError("rulesetCache: maxBytes must be a positive number");
  const entries = new Map<string, Entry>();
  let total = 0;
  const touch = (environmentId: string, entry: Entry): void => {
    entries.delete(environmentId);
    entries.set(environmentId, entry);
  };
  const insert = (environmentId: string, ruleset: CompiledRuleset): CompiledRuleset => {
    const old = entries.get(environmentId);
    if (old !== undefined) {
      total -= old.bytes;
      entries.delete(environmentId);
    }
    entries.set(environmentId, { ruleset, bytes: ruleset.approxBytes });
    total += ruleset.approxBytes;
    for (const [id, entry] of entries) {
      if (total <= maxBytes || entries.size <= 1) break;
      if (id === environmentId) continue;
      entries.delete(id);
      total -= entry.bytes;
    }
    return ruleset;
  };
  const get = (environmentId: string, version: string): CompiledRuleset | undefined => {
    const entry = entries.get(environmentId);
    if (entry === undefined || entry.ruleset.version !== version) return undefined;
    touch(environmentId, entry);
    return entry.ruleset;
  };
  return {
    get,
    getOrCompile: (environmentId, version, load) => get(environmentId, version) ?? insert(environmentId, compileRuleset(load())),
    getOrLoad: (environmentId, version, load) => get(environmentId, version) ?? insert(environmentId, loadCompiled(load())),
    get size() {
      return entries.size;
    },
    get bytes() {
      return total;
    },
    clear() {
      entries.clear();
      total = 0;
    },
  };
}

export { Broken };
