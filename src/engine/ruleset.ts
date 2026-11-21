/**
 * Api.Flags.evaluate_ruleset/4: every requested flag, sorted by key. The ETag is Latch's own (not parity-gated):
 * `<rulesetVersion>-<sha1-16 of canonical context + plan features>`.
 */
import { evaluate } from "./evaluator.ts";
import { encodeJson } from "./json.ts";
import { sha1, toHex } from "./sha1.ts";
import type { Context, Evaluation, Flag, JsonObject, JsonValue, Resolved, Segment } from "./types.ts";

export interface BulkResult {
  readonly evaluations: readonly Evaluation[];
  readonly etag: string;
}

declare const TextEncoder: new () => { encode(input: string): Uint8Array };

function planFeaturesObject(features: ReadonlyMap<string, JsonValue>): JsonObject {
  const out = Object.create(null) as Record<string, JsonValue>;
  for (const [key, value] of features) out[key] = value;
  return out;
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * `<rulesetVersion>-<sha1-16>` over a canonical (sorted-key) JSON of the context, plan features, the selection (the
 * sorted, de-duplicated requested keys, or "all") and the caller's scope string (for example "server" or "client").
 * A different selection or scope is a different tag.
 */
export function etag(
  rulesetVersion: string,
  context: JsonValue,
  planFeatures: ReadonlyMap<string, JsonValue>,
  keys: readonly string[] | "all",
  scope: string,
): string {
  const selection: JsonValue = keys === "all" ? "all" : [...new Set(keys)].sort(compareKeys);
  const canonical = encodeJson({ context, planFeatures: planFeaturesObject(planFeatures), selection, scope }, { sortKeys: true });
  return `${rulesetVersion}-${toHex(sha1(new TextEncoder().encode(canonical))).slice(0, 16)}`;
}

function isFlagList(flags: ReadonlyMap<string, Flag> | readonly Flag[]): flags is readonly Flag[] {
  return Array.isArray(flags);
}

/** `evaluate_ruleset`: unknown keys are skipped, results sorted by flag key. */
export function evaluateAll(
  flags: ReadonlyMap<string, Flag> | readonly Flag[],
  segments: ReadonlyMap<string, Segment>,
  context: Context,
  resolved: Resolved,
  keys: readonly string[] | "all",
  rulesetVersion: string,
  scope: string,
): BulkResult {
  const byKey: ReadonlyMap<string, Flag> = isFlagList(flags) ? new Map(flags.map((flag) => [flag.key, flag] as const)) : flags;
  const withSegments: Resolved = { ...resolved, segments, flags: byKey };
  const selected: Flag[] = [];
  if (keys === "all") selected.push(...byKey.values());
  else
    for (const key of keys) {
      const flag = byKey.get(key);
      if (flag !== undefined) selected.push(flag);
    }
  selected.sort((a, b) => compareKeys(a.key, b.key));
  return {
    evaluations: selected.map((flag) => evaluate(flag, context, withSegments)),
    etag: etag(rulesetVersion, context, resolved.planFeatures, keys, scope),
  };
}
