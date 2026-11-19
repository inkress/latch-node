import { compileRuleset, FlagKind, jint, Op, serializeCompiled } from "../src/engine/index.ts";
import type { Flag } from "../src/engine/index.ts";
import type { FetchLike } from "../src/types.ts";

export function flag(key: string, over: Partial<Flag> = {}): Flag {
  return {
    key,
    kind: FlagKind.Boolean,
    variants: [{ key: "on", value: true }, { key: "off", value: false }],
    enabled: true,
    offVariant: "off",
    targets: [],
    rules: [],
    fallthrough: { variant: "on", rollout: [], bucketBy: null },
    salt: `salt-${key}`,
    clientVisible: false,
    ...over,
  } as Flag;
}

export const betaRule = {
  id: "beta",
  conditions: [{ attribute: "plan", op: Op.In, values: ["beta"], negate: false }],
  serve: { variant: "on", rollout: [], bucketBy: null },
} as unknown as Flag["rules"][number];

export function rulesetBody(version: number, flags: Flag[], remote: readonly string[] = []): string {
  const compiled = serializeCompiled(compileRuleset({ version: String(version), flags, segments: [] }, { eager: true }));
  return JSON.stringify({ version, flags: flags.map((f) => ({ key: f.key, remote: remote.includes(f.key) })), compiled });
}

export interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

export type Handler = (call: Call) => Response | Promise<Response>;

/** A fetch that records every call and answers with the handler. */
export function fakeFetch(handler: Handler): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: Call = { url, method: init.method, headers: init.headers, body: init.body };
    calls.push(call);
    return handler(call);
  };
  return { fetch, calls };
}

export const json = (body: unknown, init: ResponseInit = {}): Response => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
export { FlagKind };
export { jint };
