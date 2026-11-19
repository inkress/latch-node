/** OFREP over HTTP for the flags a server cannot evaluate itself (`remote: true`), and the shared request plumbing with fallback. */
import { DEFAULT_BASE_URL, ErrorCode, Reason } from "./types.ts";
import type { EvaluationDetail, FetchLike, JsonPlain, LatchContext } from "./types.ts";

export interface Transport {
  readonly serverKey: string;
  readonly baseUrl: string;
  readonly fallbackUrl: string | null;
  readonly timeoutMs: number;
  readonly fetch: FetchLike;
}

export function transportOf(options: { serverKey: string; baseUrl?: string; fallbackUrl?: string; requestTimeoutMs?: number; fetch?: FetchLike }): Transport {
  return {
    serverKey: options.serverKey,
    baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    fallbackUrl: options.fallbackUrl === undefined ? null : options.fallbackUrl.replace(/\/+$/, ""),
    timeoutMs: options.requestTimeoutMs ?? 10_000,
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
  };
}

const shouldFallBack = (status: number): boolean => status === 429 || status >= 500;

/** Send to the edge; on a network error, 429 or 5xx try the fallback once. Returns the last response, or throws the last network error. */
export async function send(transport: Transport, path: string, init: { method: string; headers?: Record<string, string>; body?: string }, signal?: AbortSignal): Promise<Response> {
  const headers = { authorization: `Bearer ${transport.serverKey}`, accept: "application/json", ...init.headers };
  const attempt = async (base: string): Promise<Response> => {
    const timeout = AbortSignal.timeout(transport.timeoutMs);
    const joined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    return transport.fetch(`${base}${path}`, { method: init.method, headers, ...(init.body === undefined ? {} : { body: init.body }), signal: joined });
  };
  let primary: Response | null = null;
  let failure: unknown = null;
  try {
    primary = await attempt(transport.baseUrl);
  } catch (error) {
    failure = error;
  }
  if (primary !== null && (!shouldFallBack(primary.status) || transport.fallbackUrl === null)) return primary;
  if (transport.fallbackUrl === null || signal?.aborted === true) throw failure instanceof Error ? failure : new Error(String(failure));
  try {
    return await attempt(transport.fallbackUrl);
  } catch (error) {
    if (primary !== null) return primary;
    throw error instanceof Error ? error : new Error(String(error));
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const REASONS: readonly string[] = Object.values(Reason);
const CODES: readonly string[] = Object.values(ErrorCode);

/** One OFREP flag body, checked: nothing from the network is trusted untyped. */
export function detailFromWire(body: unknown, fallbackKey: string): EvaluationDetail<unknown> | null {
  if (!isRecord(body)) return null;
  const key = typeof body["key"] === "string" ? body["key"] : fallbackKey;
  const metadata: Record<string, string | number | boolean> = {};
  if (isRecord(body["metadata"])) for (const [name, value] of Object.entries(body["metadata"])) if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") metadata[name] = value;
  if (typeof body["errorCode"] === "string") {
    const code = CODES.includes(body["errorCode"]) ? (body["errorCode"] as ErrorCode) : ErrorCode.General;
    return { key, value: null, variant: null, reason: Reason.Error, errorCode: code, errorDetails: typeof body["errorDetails"] === "string" ? body["errorDetails"] : null, metadata };
  }
  const reason = typeof body["reason"] === "string" && REASONS.includes(body["reason"]) ? (body["reason"] as Reason) : Reason.Static;
  return { key, value: (body["value"] ?? null) as JsonPlain, variant: typeof body["variant"] === "string" ? body["variant"] : null, reason, errorCode: null, errorDetails: null, metadata };
}

const failed = (key: string, code: ErrorCode, details: string): EvaluationDetail<unknown> => ({ key, value: null, variant: null, reason: Reason.Error, errorCode: code, errorDetails: details, metadata: {} });

/** `contextKey`: the same context always gives the same text (keys sorted), so it can key a cache. */
export function stableText(value: unknown): string {
  if (Array.isArray(value)) return `[${(value as unknown[]).map(stableText).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableText(value[k])}`).join(",")}}`;
  return value === undefined || typeof value === "function" || typeof value === "symbol" ? "null" : JSON.stringify(value);
}

interface Cached {
  readonly at: number;
  readonly detail: EvaluationDetail<unknown>;
}

export interface RemoteEvaluator {
  one(key: string, context: LatchContext): Promise<EvaluationDetail<unknown>>;
  /** Every flag the key can see, in one call. */
  all(context: LatchContext): Promise<readonly EvaluationDetail<unknown>[]>;
  clear(): void;
}

const MAX_CACHED = 1000;

export function remoteEvaluator(transport: Transport, cacheMs: number, now: () => number = Date.now): RemoteEvaluator {
  const cache = new Map<string, Cached>();
  const read = async (response: Response): Promise<unknown> => {
    const body: unknown = await response.json().catch(() => null);
    return body;
  };
  return {
    async one(key, context) {
      const cacheKey = `${key}\n${stableText(context)}`;
      const hit = cache.get(cacheKey);
      if (hit && now() - hit.at < cacheMs) return hit.detail;
      let response: Response;
      try {
        response = await send(transport, `/ofrep/v1/evaluate/flags/${encodeURIComponent(key)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ context }) });
      } catch (error) {
        return failed(key, ErrorCode.General, `could not reach Latch: ${error instanceof Error ? error.message : String(error)}`);
      }
      const body = await read(response);
      const detail = detailFromWire(body, key);
      if (response.status === 401 || response.status === 403) return failed(key, ErrorCode.Unauthorized, "the server key was refused");
      if (!detail) return failed(key, ErrorCode.General, `unexpected answer (${String(response.status)})`);
      // Only real answers are reused: a failure is retried on the next call.
      if (detail.errorCode === null) {
        if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
        cache.set(cacheKey, { at: now(), detail });
      }
      return detail;
    },
    async all(context) {
      const response = await send(transport, "/ofrep/v1/evaluate/flags", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ context }) });
      const body = await read(response);
      if (!response.ok || !isRecord(body) || !Array.isArray(body["flags"])) throw new Error(`Latch bulk evaluation failed (${String(response.status)})`);
      const out: EvaluationDetail<unknown>[] = [];
      for (const item of body["flags"] as unknown[]) {
        const detail = detailFromWire(item, "");
        if (detail && detail.key !== "") out.push(detail);
      }
      return out;
    },
    clear: () => {
      cache.clear();
    },
  };
}
