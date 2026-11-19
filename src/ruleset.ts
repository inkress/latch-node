/** Downloads `/v1/sdk/ruleset` with ETag and keeps the loaded engine ruleset. */
import { loadCompiled } from "./engine/index.ts";
import type { CompiledRuleset } from "./engine/index.ts";
import { send } from "./remote.ts";
import type { Transport } from "./remote.ts";

export interface LoadedRuleset {
  readonly version: number;
  readonly etag: string;
  readonly compiled: CompiledRuleset;
  /** Flags the server cannot evaluate (plans, `inkress.*`): answered by the eval API. */
  readonly remote: ReadonlySet<string>;
  readonly keys: readonly string[];
  /** Flags a browser or mobile key may see. */
  readonly clientVisible: ReadonlySet<string>;
}

export type FetchOutcome =
  | { readonly kind: "updated"; readonly ruleset: LoadedRuleset }
  | { readonly kind: "unchanged" }
  | { readonly kind: "refused"; readonly status: number }
  | { readonly kind: "failed"; readonly error: Error };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function parseRuleset(body: unknown, etag: string): LoadedRuleset | null {
  if (!isRecord(body) || typeof body["version"] !== "number" || typeof body["compiled"] !== "string" || !Array.isArray(body["flags"])) return null;
  const remote = new Set<string>();
  const clientVisible = new Set<string>();
  for (const info of body["flags"] as unknown[]) if (isRecord(info) && typeof info["key"] === "string") {
      if (info["remote"] === true) remote.add(info["key"]);
      if (info["clientVisible"] === true) clientVisible.add(info["key"]);
    }
  const compiled = loadCompiled(body["compiled"]);
  return { version: body["version"], etag, compiled, remote, keys: [...compiled.flags.keys()], clientVisible };
}

export async function fetchRuleset(transport: Transport, current: LoadedRuleset | null, signal: AbortSignal): Promise<FetchOutcome> {
  try {
    const response = await send(transport, "/v1/sdk/ruleset", { method: "GET", ...(current ? { headers: { "if-none-match": current.etag } } : {}) }, signal);
    if (response.status === 304) return { kind: "unchanged" };
    if (response.status === 401 || response.status === 403) return { kind: "refused", status: response.status };
    if (!response.ok) return { kind: "failed", error: new Error(`ruleset download failed (${String(response.status)})`) };
    const ruleset = parseRuleset((await response.json()), response.headers.get("etag") ?? `"v${String(current?.version ?? 0)}"`);
    return ruleset ? { kind: "updated", ruleset } : { kind: "failed", error: new Error("the ruleset answer was not understood") };
  } catch (error) {
    return { kind: "failed", error: error instanceof Error ? error : new Error(String(error)) };
  }
}
