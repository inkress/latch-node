// Copy of the Latch edge's verifier (apps/edge/src/signed-context.ts), refreshed by scripts/sync-engine.sh.
/**
 * Signed evaluation contexts (spec section 4). The customer's server signs the end user's attributes with the
 * environment's signing secret (HS256 JWT); the browser or app sends the token, and the edge trusts what is in it
 * rather than what the client claims. Token claims are the context, except the registered claims below; `sub` is the
 * `targetingKey` (a `targetingKey` claim is ignored). A token must carry `exp`, no more than 24 hours ahead, and is checked
 * against every published secret (the `kid` header picks one first), so a rotation overlap keeps working.
 */
import { fromPlain, prepareContext } from "../../src/engine/index.ts";
import type { JsonObject } from "../../src/engine/index.ts";
import type { SigningSecret } from "./wire.ts";

export const MAX_SIGNED_LIFETIME_SECONDS = 24 * 60 * 60;
/** Clock drift allowed on `nbf` and `iat`. */
export const CLOCK_SKEW_SECONDS = 60;

export const SignedContextFailure = {
  Malformed: "malformed",
  Algorithm: "algorithm",
  Signature: "signature",
  NoExpiry: "no_expiry",
  Expired: "expired",
  NotYetValid: "not_yet_valid",
  TooLong: "too_long",
  NoSecret: "no_secret",
  InvalidContext: "invalid_context",
} as const;
export type SignedContextFailure = (typeof SignedContextFailure)[keyof typeof SignedContextFailure];

export type SignedContextResult = { readonly ok: true; readonly context: JsonObject } | { readonly ok: false; readonly reason: SignedContextFailure };

const REGISTERED: ReadonlySet<string> = new Set(["exp", "nbf", "iat", "iss", "aud", "jti", "sub"]);
const encoder = new TextEncoder();

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "="));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function jsonObjectOf(bytes: Uint8Array | null): Record<string, unknown> | null {
  if (bytes === null) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function verifies(secret: string, signingInput: string, signature: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(signingInput));
}

/** Verify a token and return the context it carries. `nowSeconds` is injected so expiry is testable. */
export async function verifySignedContext(token: string, secrets: readonly SigningSecret[], nowSeconds: number): Promise<SignedContextResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: SignedContextFailure.Malformed };
  const [head, body, sig] = parts as [string, string, string];
  const header = jsonObjectOf(fromBase64Url(head));
  const claims = jsonObjectOf(fromBase64Url(body));
  const signature = fromBase64Url(sig);
  if (!header || !claims || !signature) return { ok: false, reason: SignedContextFailure.Malformed };
  if (header["alg"] !== "HS256") return { ok: false, reason: SignedContextFailure.Algorithm };
  if (secrets.length === 0) return { ok: false, reason: SignedContextFailure.NoSecret };

  const kid = header["kid"];
  const ordered = typeof kid === "string" ? [...secrets.filter((s) => s.kid === kid), ...secrets.filter((s) => s.kid !== kid)] : secrets;
  let valid = false;
  for (const candidate of ordered) {
    if (await verifies(candidate.secret, `${head}.${body}`, signature)) {
      valid = true;
      break;
    }
  }
  if (!valid) return { ok: false, reason: SignedContextFailure.Signature };

  const exp = claims["exp"];
  if (typeof exp !== "number" || !Number.isFinite(exp)) return { ok: false, reason: SignedContextFailure.NoExpiry };
  if (exp <= nowSeconds) return { ok: false, reason: SignedContextFailure.Expired };
  if (exp - nowSeconds > MAX_SIGNED_LIFETIME_SECONDS) return { ok: false, reason: SignedContextFailure.TooLong };
  const nbf = claims["nbf"];
  if (typeof nbf === "number" && nbf - nowSeconds > CLOCK_SKEW_SECONDS) return { ok: false, reason: SignedContextFailure.NotYetValid };
  const iat = claims["iat"];
  if (typeof iat === "number" && exp - iat > MAX_SIGNED_LIFETIME_SECONDS) return { ok: false, reason: SignedContextFailure.TooLong };

  const context: Record<string, unknown> = {};
  for (const name of Object.keys(claims)) if (!REGISTERED.has(name)) context[name] = claims[name];
  // The targeting key comes from `sub` only: a token cannot carry a second, competing identity.
  delete context["targetingKey"];
  if (typeof claims["sub"] === "string") context["targetingKey"] = claims["sub"];
  // The same rules as any context: size limit, and no reserved `inkress.*` attributes from a token.
  const prepared = prepareContext(fromPlain(context));
  return prepared.ok ? { ok: true, context: prepared.context } : { ok: false, reason: SignedContextFailure.InvalidContext };
}
