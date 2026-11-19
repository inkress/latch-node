/** Public types of the Node SDK. Values cross the SDK boundary as plain JSON; the engine's lossless types stay inside. */

export type JsonPlain = null | boolean | number | string | readonly JsonPlain[] | { readonly [key: string]: JsonPlain };

/** An evaluation context: `targetingKey` plus any attributes. */
export type LatchContext = { readonly [attribute: string]: unknown };

/** Why a value was served (OFREP reasons). */
export const Reason = { Static: "STATIC", TargetingMatch: "TARGETING_MATCH", Split: "SPLIT", Disabled: "DISABLED", Error: "ERROR", Default: "DEFAULT" } as const;
export type Reason = (typeof Reason)[keyof typeof Reason];

/** Error codes: the engine's, plus the three only an SDK can raise. */
export const ErrorCode = {
  FlagNotFound: "FLAG_NOT_FOUND",
  TargetingKeyMissing: "TARGETING_KEY_MISSING",
  InvalidContext: "INVALID_CONTEXT",
  ParseError: "PARSE_ERROR",
  General: "GENERAL",
  TypeMismatch: "TYPE_MISMATCH",
  NotReady: "PROVIDER_NOT_READY",
  Unauthorized: "UNAUTHORIZED",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface EvaluationDetail<T> {
  readonly key: string;
  /** The served value, or the default you passed when `errorCode` is set. */
  readonly value: T;
  readonly variant: string | null;
  readonly reason: Reason;
  readonly errorCode: ErrorCode | null;
  readonly errorDetails: string | null;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

export interface ChangeEvent {
  readonly version: number;
  readonly previousVersion: number | null;
  /** Every flag key in the new ruleset: a version bump can come from a flag, a group or a plan change, so all flags may differ. */
  readonly flags: readonly string[];
}

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;

export interface LatchOptions {
  /** A server key (`srv-…`). Keep it on the server. */
  readonly serverKey: string;
  /** Edge base URL. Default: the production edge. */
  readonly baseUrl?: string;
  /** Tried when the edge answers 429, 5xx or does not answer (spec: the origin, `<host>/api`). */
  readonly fallbackUrl?: string;
  /** How often to look for a new ruleset. Default 30 000 ms (minimum 1 000). */
  readonly pollIntervalMs?: number;
  /** Per request. Default 10 000 ms. */
  readonly requestTimeoutMs?: number;
  /** How long a remote flag's answer is reused for the same context. Default 60 000 ms. */
  readonly remoteCacheMs?: number;
  readonly fetch?: FetchLike;
  readonly onError?: (error: Error) => void;
}

export const DEFAULT_BASE_URL = "https://latch-edge.inkress.com";
export const DEFAULT_POLL_MS = 30_000;
