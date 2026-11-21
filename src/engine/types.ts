/**
 * Engine types: a literal mirror of commerce-api's Api.Flags structs (jamlance/main c96baabb), so the port reads
 * line by line against the Elixir. Field names are camelCase; meanings and nil-ness are the Elixir ones.
 * No I/O and no Node APIs anywhere in packages/engine (it runs in Workers, Node and browsers).
 */

/**
 * JSON numbers keep Elixir's integer/float split (Jason decodes `1` as integer and `1.0`, `1e5` as float), and
 * integers keep full precision. Plain tagged objects (not classes), so they survive structuredClone (Durable
 * Object storage, postMessage) and cross-bundle checks. They never go through JSON.stringify directly: json.ts
 * (LAT-10/LAT-59) is the one reader and writer, and nothing on an evaluation path uses JSON.parse.
 */
export interface JInt {
  readonly kind: "int";
  readonly value: bigint;
}
export interface JFloat {
  readonly kind: "float";
  readonly value: number;
}
export type JNumber = JInt | JFloat;
export const jint = (value: bigint): JInt => ({ kind: "int", value });
export const jfloat = (value: number): JFloat => ({ kind: "float", value });

/** Any JSON value as the engine sees it (Api.Flags.Schema.JsonValue). `null` is JSON null (Elixir nil). */
export type JsonValue = null | boolean | string | JNumber | readonly JsonValue[] | JsonObject;
/**
 * A JSON object. The lossless reader creates these with a null prototype, and every lookup goes through an
 * own-key check (Elixir `Map.fetch`), so keys like `constructor` or `__proto__` behave as plain data.
 */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** Own-key lookup with Elixir `Map.fetch` semantics: `undefined` means the key is absent. */
export function getOwn(object: JsonObject, key: string): JsonValue | undefined {
  return Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;
}

/** Api.Flags.Schema.Kinds.flag_kinds/0 */
export const FlagKind = { Boolean: "boolean", String: "string", Number: "number", Json: "json" } as const;
export type FlagKind = (typeof FlagKind)[keyof typeof FlagKind];

/**
 * Api.Flags.Schema.Kinds.ops/0, plus `ip_in_cidr` (new in Latch, spec section 5). Inkress rejects `ip_in_cidr`, so
 * parity fixtures never contain it; it has its own unit tests.
 */
export const Op = {
  In: "in",
  Contains: "contains",
  StartsWith: "starts_with",
  EndsWith: "ends_with",
  Matches: "matches",
  Lt: "lt",
  Lte: "lte",
  Gt: "gt",
  Gte: "gte",
  Before: "before",
  After: "after",
  SemverEq: "semver_eq",
  SemverLt: "semver_lt",
  SemverGt: "semver_gt",
  Segment: "segment",
  IpInCidr: "ip_in_cidr",
} as const;
export type Op = (typeof Op)[keyof typeof Op];

/** Rollout weights are thousandths of a percent and sum to this (Kinds.weight_total/0). */
export const WEIGHT_TOTAL = 100_000;

/** Kinds.limit/1, plus `regexInputBytes` from SafeRegex @max_input. */
export const Limits = {
  flagsPerMerchant: 500,
  segmentsPerMerchant: 200,
  rulesPerFlag: 50,
  conditionsPerRule: 20,
  targetKeysPerFlag: 10_000,
  contextBytes: 10_240,
  regexLength: 256,
  regexInputBytes: 4_096,
  valuesPerCondition: 1_000,
  segmentIds: 10_000,
} as const;

/** Api.Flags.Schema.Variant */
export interface Variant {
  readonly key: string;
  readonly value: JsonValue;
}

/** Api.Flags.Schema.WeightedVariant */
export interface WeightedVariant {
  readonly variant: string;
  readonly weight: number;
}

/**
 * Api.Flags.Schema.Serve: exactly one of `variant` or a non-empty `rollout` (validated on write).
 * `bucketBy` null means "targetingKey", as `bucket_by || "targetingKey"` in the evaluator.
 */
export interface Serve {
  readonly variant: string | null;
  readonly rollout: readonly WeightedVariant[];
  readonly bucketBy: string | null;
}

/** Api.Flags.Schema.Condition. `attribute` is null only for `segment`. */
export interface Condition {
  readonly attribute: string | null;
  readonly op: Op;
  readonly values: readonly JsonValue[];
  readonly negate: boolean;
}

/** Api.Flags.Schema.Rule */
export interface Rule {
  readonly id: string;
  readonly conditions: readonly Condition[];
  readonly serve: Serve;
}

/** Api.Flags.Schema.Target */
export interface Target {
  readonly variant: string;
  readonly keys: readonly string[];
}

/**
 * Latch addition (LAT-23): this flag works only while another flag serves one of its variants. Optional on the flag:
 * a flag without the field is evaluated exactly as in Inkress.
 */
export interface Prerequisite {
  /** The parent flag's key. */
  readonly flag: string;
  /** The parent variant key that must be served for the same context. */
  readonly variant: string;
}

/**
 * Api.Flags.Schema.Flag as the evaluator reads it. In Latch this is a compiled flag: project-level fields
 * (key, kind, variants, salt) merged with one environment's flag_configs row.
 */
export interface Flag {
  readonly key: string;
  readonly kind: FlagKind;
  readonly variants: readonly Variant[];
  readonly enabled: boolean;
  readonly offVariant: string;
  readonly targets: readonly Target[];
  readonly rules: readonly Rule[];
  readonly fallthrough: Serve;
  readonly salt: string;
  readonly clientVisible: boolean;
  /** Latch (V2 plan phase 1): unsigned client contexts get the off variant. */
  readonly requiresSignedContext: boolean;
  readonly version: number;
  /** Latch (LAT-23): flags that must serve a given variant first, else this flag serves its off variant. Absent means none. */
  readonly prerequisites?: readonly Prerequisite[];
}

/** Api.Flags.Schema.Segment (conditions never reference another segment). */
export interface Segment {
  readonly key: string;
  readonly included: readonly string[];
  readonly excluded: readonly string[];
  readonly conditions: readonly Condition[];
}

/**
 * Api.Flags.Evaluator.Resolved: the environment's segments and the subject's live plan features. Plan feature
 * values come through the lossless reader too, so `==` and value_of_kind? see 1 and 1.0 as Elixir does.
 */
export interface Resolved {
  readonly segments: ReadonlyMap<string, Segment>;
  readonly planFeatures: ReadonlyMap<string, JsonValue>;
  /** Latch (LAT-23): the environment's flags by key, so a prerequisite can be looked up. Only read for flags that have prerequisites. */
  readonly flags?: ReadonlyMap<string, Flag>;
}

/** A context after validation: a JSON object (Api.Flags.Context.t). */
export type Context = JsonObject;

/** OFREP wire reasons (Api.Flags.Evaluation.wire/1 of the reason atoms). */
export const Reason = {
  Static: "STATIC",
  TargetingMatch: "TARGETING_MATCH",
  Split: "SPLIT",
  Disabled: "DISABLED",
  Error: "ERROR",
} as const;
export type Reason = (typeof Reason)[keyof typeof Reason];

/** OFREP wire error codes (Api.Flags.Evaluation.error_code). */
export const ErrorCode = {
  FlagNotFound: "FLAG_NOT_FOUND",
  TargetingKeyMissing: "TARGETING_KEY_MISSING",
  InvalidContext: "INVALID_CONTEXT",
  ParseError: "PARSE_ERROR",
  General: "GENERAL",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Elixir metadata today holds only strings (`ruleId`, `source`); numbers are allowed by the OFREP shape. */
export type MetadataValue = string | number | boolean;

/** Api.Flags.Evaluation. On success `errorCode` is null; on failure `value`/`variant` are null and reason is ERROR. */
export interface Evaluation {
  readonly key: string;
  readonly value: JsonValue;
  readonly variant: string | null;
  readonly reason: Reason;
  readonly errorCode: ErrorCode | null;
  readonly errorDetails: string | null;
  readonly metadata: Readonly<Record<string, MetadataValue>>;
}

/** Reserved attribute keys Latch fills and callers may not set (Api.Flags.Context.strip_reserved/1). */
export const ReservedAttribute = {
  Access: "inkress.access",
  Plan: "inkress.plan",
  SubscriptionStatus: "inkress.subscription_status",
} as const;
export type ReservedAttribute = (typeof ReservedAttribute)[keyof typeof ReservedAttribute];

/** Api.Access.State: which states may use the product (State.allowed?/1). */
export const AccessState = {
  Active: "active",
  Trialing: "trialing",
  Grace: "grace",
  Paused: "paused",
  Blocked: "blocked",
  None: "none",
} as const;
export type AccessState = (typeof AccessState)[keyof typeof AccessState];
export const ALLOWED_ACCESS_STATES: readonly AccessState[] = [AccessState.Active, AccessState.Trialing, AccessState.Grace];
