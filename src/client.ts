/**
 * The Node SDK client (LAT-30). Downloads the environment's compiled ruleset, polls for a new one, and evaluates flags
 * in-process with the engine's compiled path, so a check costs no network. Flags marked `remote: true` (plans,
 * `inkress.*` conditions) go through OFREP, cached per context for 60 s.
 */
import { evaluateAllCompiled, fromPlain, isJNumber, prepareContext } from "./engine/index.ts";
import type { Evaluation, JsonValue } from "./engine/index.ts";
import { remoteEvaluator, transportOf } from "./remote.ts";
import type { RemoteEvaluator, Transport } from "./remote.ts";
import { fetchRuleset } from "./ruleset.ts";
import type { LoadedRuleset } from "./ruleset.ts";
import { signContext } from "./sign.ts";
import type { SignOptions } from "./sign.ts";
import { DEFAULT_POLL_MS, ErrorCode, Reason } from "./types.ts";
import type { ChangeEvent, EvaluationDetail, JsonPlain, LatchContext, LatchOptions } from "./types.ts";

export const MIN_POLL_MS = 1_000;

/** engine values -> plain JSON. Integers beyond 2^53 lose precision, as in any JS JSON consumer. */
function plainOf(value: JsonValue): JsonPlain {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (Array.isArray(value)) return (value as readonly JsonValue[]).map(plainOf);
  if (isJNumber(value)) return Number(value.value);
  const out: Record<string, JsonPlain> = {};
  for (const name of Object.keys(value)) out[name] = plainOf((value as { readonly [k: string]: JsonValue })[name] as JsonValue);
  return out;
}

function detailOf(evaluation: Evaluation): EvaluationDetail<unknown> {
  const failed = evaluation.errorCode !== null;
  return {
    key: evaluation.key,
    value: failed ? null : plainOf(evaluation.value),
    variant: evaluation.variant,
    reason: failed ? Reason.Error : (evaluation.reason),
    errorCode: evaluation.errorCode,
    errorDetails: evaluation.errorDetails,
    metadata: evaluation.metadata,
  };
}

const failedDetail = <T>(key: string, value: T, code: ErrorCode, details: string): EvaluationDetail<T> => ({ key, value, variant: null, reason: Reason.Error, errorCode: code, errorDetails: details, metadata: {} });

type Guard<T> = (value: unknown) => value is T;
const isBool: Guard<boolean> = (v): v is boolean => typeof v === "boolean";
const isString: Guard<string> = (v): v is string => typeof v === "string";
const isNumber: Guard<number> = (v): v is number => typeof v === "number" && Number.isFinite(v);
const isJson = (v: unknown): v is JsonPlain => v !== undefined;

export class LatchClient {
  readonly #options: LatchOptions;
  readonly #transport: Transport;
  readonly #remote: RemoteEvaluator;
  readonly #listeners = new Set<(event: ChangeEvent) => void>();
  readonly #abort = new AbortController();
  #ruleset: LoadedRuleset | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;
  #refused = false;
  #ready: Promise<void>;
  #markReady!: () => void;

  constructor(options: LatchOptions) {
    if (!options.serverKey.startsWith("srv-")) throw new RangeError("LatchClient needs a server key (srv-…). Browser keys belong in @latch/js.");
    this.#options = options;
    this.#transport = transportOf(options);
    this.#remote = remoteEvaluator(this.#transport, options.remoteCacheMs ?? 60_000);
    this.#ready = new Promise<void>((resolve) => {
      this.#markReady = resolve;
    });
    void this.#poll();
  }

  /** The loaded ruleset version, or null before the first download. */
  get version(): number | null {
    return this.#ruleset?.version ?? null;
  }

  /** Resolves once the first ruleset is loaded. Rejects after `timeoutMs` (default 5 000) or when the key is refused. */
  async waitForReady(timeoutMs = 5_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(this.#refused ? "Latch refused the server key" : "Latch did not answer in time"));
      }, timeoutMs);
    });
    try {
      await Promise.race([this.#ready, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Register a listener for new ruleset versions. Returns the function that removes it. */
  onChange(listener: (event: ChangeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Sign a context for a browser or app (HS256, at most 24 hours). `secret` is the environment's signing secret. */
  signContext(secret: string, context: LatchContext, options?: SignOptions): string {
    return signContext(secret, context, options);
  }

  boolVariation(key: string, context: LatchContext, fallback: boolean): Promise<boolean> {
    return this.#value(this.boolVariationDetail(key, context, fallback));
  }
  stringVariation(key: string, context: LatchContext, fallback: string): Promise<string> {
    return this.#value(this.stringVariationDetail(key, context, fallback));
  }
  numberVariation(key: string, context: LatchContext, fallback: number): Promise<number> {
    return this.#value(this.numberVariationDetail(key, context, fallback));
  }
  jsonVariation(key: string, context: LatchContext, fallback: JsonPlain): Promise<JsonPlain> {
    return this.#value(this.jsonVariationDetail(key, context, fallback));
  }
  boolVariationDetail(key: string, context: LatchContext, fallback: boolean): Promise<EvaluationDetail<boolean>> {
    return this.#typed(key, context, fallback, isBool, "a boolean");
  }
  stringVariationDetail(key: string, context: LatchContext, fallback: string): Promise<EvaluationDetail<string>> {
    return this.#typed(key, context, fallback, isString, "a string");
  }
  numberVariationDetail(key: string, context: LatchContext, fallback: number): Promise<EvaluationDetail<number>> {
    return this.#typed(key, context, fallback, isNumber, "a number");
  }
  jsonVariationDetail(key: string, context: LatchContext, fallback: JsonPlain): Promise<EvaluationDetail<JsonPlain>> {
    return this.#typed(key, context, fallback, isJson, "JSON");
  }

  /** Every flag's value for a context. Flags that fail are left out. Remote flags are fetched in one bulk call. */
  async allFlags(context: LatchContext): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const detail of await this.allFlagsDetail(context)) if (detail.errorCode === null) out[detail.key] = detail.value;
    return out;
  }

  async allFlagsDetail(context: LatchContext): Promise<readonly EvaluationDetail<unknown>[]> {
    const ruleset = this.#ruleset;
    if (!ruleset) return [];
    const prepared = this.#prepare(context);
    if (typeof prepared === "string") return ruleset.keys.map((key) => failedDetail<unknown>(key, null, ErrorCode.InvalidContext, prepared));
    const local = ruleset.keys.filter((k) => !ruleset.remote.has(k));
    const details = evaluateAllCompiled(ruleset.compiled, prepared, { planFeatures: new Map() }, local, { scope: "sdk" }).evaluations.map(detailOf);
    if (ruleset.remote.size > 0) {
      try {
        for (const detail of await this.#remote.all(context)) if (ruleset.remote.has(detail.key)) details.push(detail);
      } catch (error) {
        for (const key of ruleset.remote) details.push(failedDetail<unknown>(key, null, ErrorCode.General, error instanceof Error ? error.message : String(error)));
      }
    }
    return details.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /**
   * The flags a browser may see, evaluated for this user, in the shape `@latch/js` and `@latch/react` take as
   * `bootstrap`. Render it into the page so the first paint already shows the right values. Only `client_visible`
   * flags are included, and values only, never rules.
   */
  async bootstrap(context: LatchContext): Promise<{ readonly flags: readonly Record<string, unknown>[] }> {
    const visible = this.#ruleset?.clientVisible;
    const flags: Record<string, unknown>[] = [];
    for (const d of await this.allFlagsDetail(context)) {
      if (visible?.has(d.key) !== true) continue;
      flags.push(d.errorCode === null ? { key: d.key, value: d.value, reason: d.reason, ...(d.variant === null ? {} : { variant: d.variant }), metadata: d.metadata } : { key: d.key, errorCode: d.errorCode, errorDetails: d.errorDetails ?? "" });
    }
    return { flags };
  }

  /** Stop polling and drop pending requests. Safe to call twice. */
  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#abort.abort();
    this.#remote.clear();
    this.#listeners.clear();
  }

  #prepare(context: LatchContext): JsonValue | string {
    try {
      const prepared = prepareContext(fromPlain(context));
      return prepared.ok ? prepared.context : prepared.error;
    } catch (error) {
      return error instanceof Error ? error.message : "the context could not be read";
    }
  }

  async #value<T>(detail: Promise<EvaluationDetail<T>>): Promise<T> {
    return (await detail).value;
  }

  async #typed<T>(key: string, context: LatchContext, fallback: T, guard: Guard<T>, label: string): Promise<EvaluationDetail<T>> {
    const found = await this.#evaluate(key, context);
    if (found.errorCode !== null) return { ...found, value: fallback, reason: found.errorCode === ErrorCode.NotReady ? Reason.Default : Reason.Error };
    if (!guard(found.value)) return failedDetail(key, fallback, ErrorCode.TypeMismatch, `flag ${key} does not serve ${label}`);
    return found as EvaluationDetail<T>;
  }

  async #evaluate(key: string, context: LatchContext): Promise<EvaluationDetail<unknown>> {
    const ruleset = this.#ruleset;
    if (!ruleset) return failedDetail<unknown>(key, null, ErrorCode.NotReady, "the ruleset has not loaded yet");
    if (!ruleset.compiled.flags.has(key)) return failedDetail<unknown>(key, null, ErrorCode.FlagNotFound, `flag ${key} was not found`);
    if (ruleset.remote.has(key)) return this.#remote.one(key, context);
    const prepared = this.#prepare(context);
    if (typeof prepared === "string") return failedDetail<unknown>(key, null, ErrorCode.InvalidContext, prepared);
    const [evaluation] = evaluateAllCompiled(ruleset.compiled, prepared, { planFeatures: new Map() }, [key], { scope: "sdk" }).evaluations;
    return evaluation ? detailOf(evaluation) : failedDetail<unknown>(key, null, ErrorCode.FlagNotFound, `flag ${key} was not found`);
  }

  async #poll(): Promise<void> {
    if (this.#closed) return;
    const outcome = await fetchRuleset(this.#transport, this.#ruleset, this.#abort.signal);
    if (this.#abort.signal.aborted) return;
    switch (outcome.kind) {
      case "updated": {
        const previous = this.#ruleset;
        this.#ruleset = outcome.ruleset;
        this.#refused = false;
        this.#markReady();
        if (previous && previous.version !== outcome.ruleset.version) this.#emit({ version: outcome.ruleset.version, previousVersion: previous.version, flags: outcome.ruleset.keys });
        break;
      }
      case "unchanged":
        break;
      case "refused":
        this.#refused = true;
        this.#report(new Error(`Latch refused the server key (${String(outcome.status)})`));
        break;
      case "failed":
        this.#report(outcome.error);
        break;
    }
    const wait = Math.max(MIN_POLL_MS, this.#options.pollIntervalMs ?? DEFAULT_POLL_MS);
    this.#timer = setTimeout(() => void this.#poll(), wait);
    // A polling timer must not keep a process alive.
    this.#timer.unref();
  }

  #emit(event: ChangeEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        this.#report(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  #report(error: Error): void {
    try {
      this.#options.onError?.(error);
    } catch {
      // a reporting callback must not break polling
    }
  }
}

export function createClient(options: LatchOptions): LatchClient {
  return new LatchClient(options);
}
