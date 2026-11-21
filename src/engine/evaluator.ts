/**
 * Api.Flags.Evaluator, line by line. Order: disabled, targets, first matching rule, plan features, fallthrough.
 * Helper names follow the Elixir (camelCased). `evaluate` never throws: where Elixir would raise (a malformed flag
 * that validation would have refused, such as an empty rollout or a non-segment condition without an attribute) the
 * result is a GENERAL error with a stable message.
 */
import { bucket, pick } from "./bucket.ts";
import { elixirNumberToString } from "./elixir-number.ts";
import { elixirEquals } from "./equality.ts";
import { errorEvaluation, okEvaluation } from "./evaluation.ts";
import { isJNumber } from "./json.ts";
import { opMatches } from "./operators.ts";
import { isJsonObject } from "./context.ts";
import { ErrorCode, FlagKind, Op, Reason, getOwn } from "./types.ts";
import type { Condition, Context, Evaluation, Flag, JsonValue, Resolved, Rule, Segment, Serve } from "./types.ts";

const EMPTY_RESOLVED: Resolved = { segments: new Map(), planFeatures: new Map() };

export const INTERNAL_ERROR_DETAILS = "internal evaluation error";

let internalErrors = 0;
/** How many times `evaluate` has caught an unexpected throw and answered `INTERNAL_ERROR_DETAILS`. Monotonic; the parity gate diffs it. */
export function internalErrorCount(): number {
  return internalErrors;
}

/** For other evaluation paths (the compiled one) that catch an unexpected throw and answer `INTERNAL_ERROR_DETAILS`. */
export function recordInternalError(): void {
  internalErrors++;
}

/** `Evaluator.targeting_key/1`: a non-empty string, or an integer as text; anything else is nil. */
export function targetingKey(context: Context): string | null {
  const key = getOwn(context, "targetingKey");
  if (typeof key === "string" && key !== "") return key;
  if (key !== undefined && isJNumber(key) && key.kind === "int") return key.value.toString();
  return null;
}

/** `Evaluator.nested/2` */
function nested(value: JsonValue | undefined, path: readonly string[]): JsonValue {
  let current: JsonValue | undefined = value;
  for (const head of path) {
    if (current === undefined || current === null || !isJsonObject(current)) return null;
    current = getOwn(current, head);
  }
  return current === undefined ? null : current;
}

/** `Evaluator.attribute/2`: the exact key first, then a dotted path through nested objects. */
export function attribute(context: Context, name: string | null): JsonValue {
  if (name === null) throw new TypeError("condition has no attribute");
  if (name === "targetingKey") return targetingKey(context);
  const exact = getOwn(context, name);
  if (exact !== undefined) return exact;
  return nested(context, name.split("."));
}

/** `Evaluator.bucket_value/2` */
export function bucketValue(context: Context, name: string): string | null {
  if (name === "targetingKey") return targetingKey(context);
  const value = attribute(context, name);
  if (typeof value === "string" && value !== "") return value;
  if (isJNumber(value)) return elixirNumberToString(value);
  return null;
}

/** `Evaluator.in_segment?/2` */
export function inSegment(segment: Segment, context: Context): boolean {
  const key = targetingKey(context);
  if (key !== null && segment.excluded.includes(key)) return false;
  if (key !== null && segment.included.includes(key)) return true;
  if (segment.conditions.length === 0) return false;
  return segment.conditions.every((condition) => conditionMatches(condition, context, EMPTY_RESOLVED));
}

function targetVariant(flag: Flag, context: Context): string | null {
  const key = targetingKey(context);
  if (key === null) return null;
  for (const target of flag.targets) if (target.keys.includes(key)) return target.variant;
  return null;
}

function ruleMatches(rule: Rule, context: Context, resolved: Resolved): boolean {
  return rule.conditions.every((condition) => conditionMatches(condition, context, resolved));
}

/** `Evaluator.condition_matches?/3` */
export function conditionMatches(condition: Condition, context: Context, resolved: Resolved): boolean {
  if (condition.op === Op.Segment) {
    const hit = condition.values.some((key) => {
      if (typeof key !== "string") return false;
      const segment = resolved.segments.get(key);
      return segment !== undefined && inSegment(segment, context);
    });
    return hit !== condition.negate;
  }
  const value = attribute(context, condition.attribute);
  // A missing attribute never matches, negated or not.
  if (value === null) return false;
  return opMatches(condition.op, value, condition.values) !== condition.negate;
}

function served(flag: Flag, variantKey: string, reason: Reason): Evaluation {
  const variant = flag.variants.find((candidate) => candidate.key === variantKey);
  if (variant === undefined) return errorEvaluation(flag.key, ErrorCode.General, `variant ${variantKey} is not defined`);
  return okEvaluation(flag.key, variant.value, variant.key, reason);
}

function serve(flag: Flag, spec: Serve, context: Context, reason: Reason): Evaluation {
  if (typeof spec.variant === "string") return served(flag, spec.variant, reason);
  const name = spec.bucketBy ?? "targetingKey";
  const value = bucketValue(context, name);
  if (value === null) return errorEvaluation(flag.key, ErrorCode.TargetingKeyMissing, `rollout needs a value for ${name}`);
  return served(flag, pick(spec.rollout, bucket(flag.key, flag.salt, value)), Reason.Split);
}

/** `Flag.value_of_kind?/2` */
export function valueOfKind(kind: FlagKind, value: JsonValue): boolean {
  switch (kind) {
    case FlagKind.Boolean:
      return typeof value === "boolean";
    case FlagKind.String:
      return typeof value === "string";
    case FlagKind.Number:
      return isJNumber(value);
    case FlagKind.Json:
      return true;
    default:
      return false;
  }
}

function planValue(flag: Flag, value: JsonValue): Evaluation {
  const variant = flag.variants.find((candidate) => elixirEquals(candidate.value, value));
  return { ...okEvaluation(flag.key, value, variant === undefined ? null : variant.key, Reason.TargetingMatch), metadata: { source: "plan" } };
}

function putMeta(evaluation: Evaluation, key: string, value: string): Evaluation {
  if (evaluation.errorCode !== null) return evaluation;
  return { ...evaluation, metadata: { ...evaluation.metadata, [key]: value } };
}

/** How many flags deep a prerequisite chain may go; a longer chain (or a cycle) counts as not met. */
export const PREREQUISITE_DEPTH_LIMIT = 16;

/** Latch (LAT-23): the first prerequisite whose parent does not serve the wanted variant for this context, or null when all are met. */
function unmetPrerequisite(flag: Flag, context: Context, resolved: Resolved, trail: readonly string[]): string | null {
  for (const prerequisite of flag.prerequisites ?? []) {
    const parent = resolved.flags?.get(prerequisite.flag);
    if (parent === undefined || trail.includes(parent.key) || parent.key === flag.key || trail.length >= PREREQUISITE_DEPTH_LIMIT) return prerequisite.flag;
    const result = evaluateObject(parent, context, resolved, [...trail, flag.key]);
    if (result.errorCode !== null || result.variant !== prerequisite.variant) return prerequisite.flag;
  }
  return null;
}

function evaluateObject(flag: Flag, context: Context, resolved: Resolved, trail: readonly string[] = []): Evaluation {
  if (!flag.enabled) return served(flag, flag.offVariant, Reason.Disabled);

  if (flag.prerequisites !== undefined && flag.prerequisites.length > 0) {
    const unmet = unmetPrerequisite(flag, context, resolved, trail);
    if (unmet !== null) return putMeta(served(flag, flag.offVariant, Reason.Disabled), "prerequisite", unmet);
  }

  const target = targetVariant(flag, context);
  if (target !== null) return served(flag, target, Reason.TargetingMatch);

  const rule = flag.rules.find((candidate) => ruleMatches(candidate, context, resolved));
  if (rule !== undefined) return putMeta(serve(flag, rule.serve, context, Reason.TargetingMatch), "ruleId", rule.id);

  const plan = resolved.planFeatures.get(flag.key);
  if (plan !== undefined && valueOfKind(flag.kind, plan)) return planValue(flag, plan);

  return serve(flag, flag.fallthrough, context, Reason.Static);
}

export const RAW_NUMBER_DETAILS = "context holds a raw JavaScript number; read the context with the lossless JSON reader (parseJson)";

/** Iterative scan for a raw JS number anywhere in a context (`1` and `1.0` are indistinguishable once it is one). */
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

/**
 * `Evaluator.evaluate/3`. `context` must come from the lossless reader (`parseJson`, `fromPlain`): Elixir keeps `1` and
 * `1.0` apart and a JS number cannot, so a raw `number` anywhere in it is `INVALID_CONTEXT`. A non-object is
 * `INVALID_CONTEXT` too. Never throws.
 */
export function evaluate(flag: Flag, context: JsonValue | undefined, resolved: Resolved): Evaluation {
  try {
    if (!isJsonObject(context)) return errorEvaluation(flag.key, ErrorCode.InvalidContext, "context must be an object");
    if (holdsRawNumber(context)) return errorEvaluation(flag.key, ErrorCode.InvalidContext, RAW_NUMBER_DETAILS);
    return evaluateObject(flag, context, resolved);
  } catch {
    internalErrors++;
    // `flag` itself may be bad (null from an untyped caller): never let the key read throw here.
    const key = (flag as Flag | null)?.key;
    return errorEvaluation(typeof key === "string" ? key : "", ErrorCode.General, INTERNAL_ERROR_DETAILS);
  }
}
