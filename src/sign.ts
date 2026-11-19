/**
 * `signContext`: sign an end user's attributes with the environment's signing secret (HS256 JWT, spec section 4), so a
 * browser or app can send them to the edge and the edge trusts them. The token's claims are the context, with `targetingKey` carried as `sub`; `exp` is
 * required and at most 24 hours ahead.
 */
import { createHmac } from "node:crypto";
import type { LatchContext } from "./types.ts";

export const MAX_LIFETIME_SECONDS = 24 * 60 * 60;
export const DEFAULT_LIFETIME_SECONDS = 60 * 60;
/** Claims the SDK sets itself; a context cannot carry them. */
const OWN_CLAIMS: ReadonlySet<string> = new Set(["exp", "iat", "nbf"]);

export interface SignOptions {
  /** Lifetime in seconds, 1 to 86 400. Default 3 600. */
  readonly ttlSeconds?: number;
  /** The secret's id, so the edge checks the right one first during a rotation. */
  readonly kid?: string;
  /** Injected for tests. */
  readonly now?: () => Date;
}

const b64url = (data: string | Buffer): string => Buffer.from(data).toString("base64url");

export function signContext(secret: string, context: LatchContext, options: SignOptions = {}): string {
  if (secret === "") throw new RangeError("signContext: the signing secret is empty");
  const ttl = options.ttlSeconds ?? DEFAULT_LIFETIME_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_LIFETIME_SECONDS) throw new RangeError(`signContext: ttlSeconds must be a whole number from 1 to ${String(MAX_LIFETIME_SECONDS)}`);
  const iat = Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
  const claims: Record<string, unknown> = {};
  // The edge takes the targeting key from `sub` only, so `targetingKey` travels as `sub`.
  for (const name of Object.keys(context)) if (!OWN_CLAIMS.has(name) && name !== "targetingKey" && name !== "sub" && context[name] !== undefined) claims[name] = context[name];
  const subject = context["targetingKey"] ?? context["sub"];
  if (typeof subject === "string" && subject !== "") claims["sub"] = subject;
  claims["iat"] = iat;
  claims["exp"] = iat + ttl;
  const header = { alg: "HS256", typ: "JWT", ...(options.kid === undefined ? {} : { kid: options.kid }) };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  return `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`;
}
