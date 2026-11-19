import { describe, expect, it } from "vitest";
import { verifySignedContext } from "./edge/signed-context.ts";
import { signContext } from "../src/index.ts";

/** The SDK's tokens must be accepted by the edge's own verifier: same algorithm, claims and limits. */
describe("signContext against the edge verifier", () => {
  const now = new Date("2027-03-01T12:00:00Z");
  const secrets = [{ kid: "k1", secret: "environment-signing-secret" }];
  const nowSeconds = now.getTime() / 1000;

  it("is accepted, and the claims become the context", async () => {
    const token = signContext("environment-signing-secret", { targetingKey: "u1", plan: "pro", seats: 5 }, { now: () => now, kid: "k1" });
    const result = await verifySignedContext(token, secrets, nowSeconds);
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.context).sort()).toEqual(["plan", "seats", "targetingKey"]);
    expect(result.ok && result.context["targetingKey"]).toBe("u1");
  });

  it("is refused when signed with another secret, when expired, and a 24 hour token is the longest accepted", async () => {
    const wrong = await verifySignedContext(signContext("not-the-secret", { targetingKey: "u1" }, { now: () => now }), secrets, nowSeconds);
    expect(wrong).toMatchObject({ ok: false, reason: "signature" });
    const stale = await verifySignedContext(signContext("environment-signing-secret", { targetingKey: "u1" }, { now: () => now, ttlSeconds: 60 }), secrets, nowSeconds + 120);
    expect(stale).toMatchObject({ ok: false, reason: "expired" });
    const longest = await verifySignedContext(signContext("environment-signing-secret", { targetingKey: "u1" }, { now: () => now, ttlSeconds: 86_400 }), secrets, nowSeconds);
    expect(longest.ok).toBe(true);
  });
});
