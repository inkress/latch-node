import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signContext } from "../src/index.ts";

const NOW = new Date("2027-01-01T00:00:00Z");
const now = (): Date => NOW;
const parts = (token: string): { header: Record<string, unknown>; claims: Record<string, unknown>; sig: string } => {
  const [h, c, sig] = token.split(".") as [string, string, string];
  return { header: JSON.parse(Buffer.from(h, "base64url").toString()) as Record<string, unknown>, claims: JSON.parse(Buffer.from(c, "base64url").toString()) as Record<string, unknown>, sig };
};

describe("signContext", () => {
  it("signs HS256 with the context as claims and a one hour default expiry", () => {
    const token = signContext("secret-1", { targetingKey: "u1", plan: "pro" }, { now, kid: "k1" });
    const { header, claims, sig } = parts(token);
    expect(header).toEqual({ alg: "HS256", typ: "JWT", kid: "k1" });
    const iat = NOW.getTime() / 1000;
    expect(claims).toEqual({ sub: "u1", plan: "pro", iat, exp: iat + 3600 });
    const [h, c] = token.split(".");
    expect(sig).toBe(createHmac("sha256", "secret-1").update(`${h ?? ""}.${c ?? ""}`).digest("base64url"));
  });

  it("allows up to 24 hours and refuses more, zero, fractions and an empty secret", () => {
    expect(parts(signContext("s", {}, { now, ttlSeconds: 86_400 })).claims["exp"]).toBe(NOW.getTime() / 1000 + 86_400);
    for (const ttl of [86_401, 0, -5, 1.5, Number.NaN]) expect(() => signContext("s", {}, { ttlSeconds: ttl })).toThrow(RangeError);
    expect(() => signContext("", {})).toThrow(/empty/);
  });

  it("a context cannot set its own expiry", () => {
    const { claims } = parts(signContext("s", { exp: 9_999_999_999, iat: 1, nbf: 1, a: 1 }, { now }));
    expect(claims["exp"]).toBe(NOW.getTime() / 1000 + 3600);
    expect(claims["nbf"]).toBeUndefined();
  });
});
