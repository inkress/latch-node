import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, ErrorCode, Reason } from "../src/index.ts";
import type { LatchClient } from "../src/index.ts";
import { betaRule, fakeFetch, flag, jint, json, rulesetBody } from "./helpers.ts";
import type { Call } from "./helpers.ts";

const KEY = "srv-dev-abcdefghij";
const open: LatchClient[] = [];
afterEach(() => {
  for (const c of open.splice(0)) c.close();
  vi.useRealTimers();
});

function start(handler: (call: Call) => Response | Promise<Response>, extra: Record<string, unknown> = {}): { client: LatchClient; calls: Call[]; errors: Error[] } {
  const { fetch, calls } = fakeFetch(handler);
  const errors: Error[] = [];
  const client = createClient({ serverKey: KEY, baseUrl: "https://edge.test", fetch, onError: (e) => errors.push(e), ...extra });
  open.push(client);
  return { client, calls, errors };
}

const flags = [
  flag("checkout"),
  flag("tier", { kind: "string", variants: [{ key: "a", value: "gold" }, { key: "b", value: "base" }], offVariant: "b", fallthrough: { variant: "b", rollout: [], bucketBy: null }, rules: [{ ...betaRule, serve: { variant: "a", rollout: [], bucketBy: null } }] } as never),
  flag("limit", { kind: "number", variants: [{ key: "n", value: jint(25n) }], offVariant: "n", fallthrough: { variant: "n", rollout: [], bucketBy: null } } as never),
  flag("paywall"),
];

describe("node SDK", () => {
  it("downloads the ruleset with the server key and evaluates locally with no further calls", async () => {
    const { client, calls } = start(() => json(rulesetBody(3, flags), { headers: { etag: '"v3"' } }));
    await client.waitForReady();
    expect(calls[0]?.url).toBe("https://edge.test/v1/sdk/ruleset");
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${KEY}`);
    expect(client.version).toBe(3);
    expect(await client.boolVariation("checkout", { targetingKey: "u1" }, false)).toBe(true);
    expect(await client.stringVariation("tier", { targetingKey: "u1", plan: "beta" }, "none")).toBe("gold");
    expect(await client.stringVariation("tier", { targetingKey: "u1", plan: "free" }, "none")).toBe("base");
    expect(await client.numberVariation("limit", { targetingKey: "u1" }, 0)).toBe(25);
    expect(calls).toHaveLength(1);
  });

  it("detail methods say why, and return the default with an error code for a missing flag or wrong type", async () => {
    const { client } = start(() => json(rulesetBody(1, flags)));
    await client.waitForReady();
    const ok = await client.boolVariationDetail("checkout", { targetingKey: "u1" }, false);
    expect(ok).toMatchObject({ value: true, variant: "on", errorCode: null });
    expect(await client.boolVariationDetail("nope", {}, true)).toMatchObject({ value: true, reason: Reason.Error, errorCode: ErrorCode.FlagNotFound });
    expect(await client.boolVariationDetail("limit", { targetingKey: "u1" }, false)).toMatchObject({ value: false, errorCode: ErrorCode.TypeMismatch });
    expect(await client.jsonVariation("limit", { targetingKey: "u1" }, null)).toBe(25);
  });

  it("returns the default before the ruleset has loaded, and an invalid context is an error not a throw", async () => {
    const { client } = start(() => new Promise<Response>(() => undefined));
    expect(await client.boolVariationDetail("checkout", {}, true)).toMatchObject({ value: true, errorCode: ErrorCode.NotReady });
    const ready = start(() => json(rulesetBody(1, flags)));
    await ready.client.waitForReady();
    expect(await ready.client.boolVariationDetail("checkout", { targetingKey: "u", bad: Infinity }, true)).toMatchObject({ value: true, errorCode: ErrorCode.InvalidContext });
  });

  it("polls with If-None-Match, keeps the ruleset on 304 and fires onChange on a new version", async () => {
    vi.useFakeTimers();
    let version = 1;
    const { client, calls } = start((call) => {
      if (call.headers["if-none-match"] === `"v${String(version)}"`) return new Response(null, { status: 304 });
      return json(rulesetBody(version, version === 1 ? flags : [...flags, flag("fresh")]), { headers: { etag: `"v${String(version)}"` } });
    }, { pollIntervalMs: 30_000 });
    const seen: number[] = [];
    client.onChange((e) => seen.push(e.version));
    await vi.advanceTimersByTimeAsync(0);
    await client.waitForReady();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls[1]?.headers["if-none-match"]).toBe('"v1"');
    expect(seen).toEqual([]);
    version = 2;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(seen).toEqual([2]);
    expect(client.version).toBe(2);
    expect(await client.boolVariation("fresh", { targetingKey: "u" }, false)).toBe(true);
  });

  it("keeps serving the last ruleset when a poll fails, and reports the error", async () => {
    vi.useFakeTimers();
    let down = false;
    const { client, errors } = start(() => (down ? new Response("x", { status: 500 }) : json(rulesetBody(1, flags))));
    await vi.advanceTimersByTimeAsync(0);
    await client.waitForReady();
    down = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(errors[0]?.message).toContain("500");
    expect(await client.boolVariation("checkout", { targetingKey: "u" }, false)).toBe(true);
  });

  it("falls back to the origin when the edge answers 503", async () => {
    const { fetch, calls } = fakeFetch((call) => (call.url.startsWith("https://edge.test") ? new Response("down", { status: 503 }) : json(rulesetBody(1, flags))));
    const client = createClient({ serverKey: KEY, baseUrl: "https://edge.test", fallbackUrl: "https://origin.test/api", fetch });
    open.push(client);
    await client.waitForReady();
    expect(calls.map((c) => c.url)).toEqual(["https://edge.test/v1/sdk/ruleset", "https://origin.test/api/v1/sdk/ruleset"]);
  });

  it("sends remote flags to OFREP and reuses the answer for the same context for 60 s", async () => {
    vi.useFakeTimers();
    let ofrep = 0;
    const { client, calls } = start((call) => {
      if (call.url.endsWith("/v1/sdk/ruleset")) return json(rulesetBody(1, flags, ["paywall"]));
      ofrep++;
      return json({ key: "paywall", value: false, reason: "TARGETING_MATCH", variant: "off", metadata: { ruleId: "r1" } });
    });
    await vi.advanceTimersByTimeAsync(0);
    await client.waitForReady();
    const ctx = { targetingKey: "u1", "inkress.plan": "pro" };
    expect(await client.boolVariationDetail("paywall", ctx, true)).toMatchObject({ value: false, variant: "off", reason: Reason.TargetingMatch, metadata: { ruleId: "r1" } });
    await client.boolVariation("paywall", { "inkress.plan": "pro", targetingKey: "u1" }, true);
    expect(ofrep).toBe(1);
    const call = calls.find((c) => c.url.includes("/ofrep/"));
    expect(call?.url).toBe("https://edge.test/ofrep/v1/evaluate/flags/paywall");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({ context: ctx });
    await vi.advanceTimersByTimeAsync(61_000);
    await client.boolVariation("paywall", ctx, true);
    expect(ofrep).toBe(2);
  });

  it("a remote flag that cannot be reached answers the default with GENERAL", async () => {
    const { client } = start((call) => {
      if (call.url.endsWith("/v1/sdk/ruleset")) return json(rulesetBody(1, flags, ["paywall"]));
      throw new Error("offline");
    });
    await client.waitForReady();
    expect(await client.boolVariationDetail("paywall", { targetingKey: "u" }, true)).toMatchObject({ value: true, errorCode: ErrorCode.General });
  });

  it("allFlags evaluates local flags in-process and fetches remote ones in one bulk call", async () => {
    const { client, calls } = start((call) => {
      if (call.url.endsWith("/v1/sdk/ruleset")) return json(rulesetBody(1, flags, ["paywall"]));
      return json({ flags: [{ key: "paywall", value: true, reason: "STATIC", variant: "on" }, { key: "checkout", value: false, reason: "STATIC" }] });
    });
    await client.waitForReady();
    const all = await client.allFlags({ targetingKey: "u1" });
    expect(all).toEqual({ checkout: true, limit: 25, paywall: true, tier: "base" });
    expect(calls.filter((c) => c.url.includes("/ofrep/"))).toHaveLength(1);
  });

  it("bootstrap holds only client-visible flags, as values, in the shape the browser SDK takes", async () => {
    const body = JSON.parse(rulesetBody(1, flags)) as { flags: { key: string; clientVisible?: boolean }[] };
    for (const f of body.flags) if (f.key === "checkout") f.clientVisible = true;
    const { client } = start(() => json(body));
    await client.waitForReady();
    const boot = await client.bootstrap({ targetingKey: "u1" });
    expect(boot.flags).toEqual([{ key: "checkout", value: true, reason: "STATIC", variant: "on", metadata: {} }]);
  });

  it("refuses a browser key and reports a refused server key through waitForReady", async () => {
    expect(() => createClient({ serverKey: "cli-dev-x" })).toThrow(/server key/);
    const { client, errors } = start(() => new Response("no", { status: 401 }));
    await expect(client.waitForReady(50)).rejects.toThrow(/refused/);
    expect(errors[0]?.message).toContain("401");
  });

  it("close stops polling", async () => {
    vi.useFakeTimers();
    const { client, calls } = start(() => json(rulesetBody(1, flags)));
    await vi.advanceTimersByTimeAsync(0);
    client.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toHaveLength(1);
  });
});
