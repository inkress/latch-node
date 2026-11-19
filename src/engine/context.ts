/**
 * Api.Flags.Context, the pure parts: `validate/1`, `strip_reserved/1` and `with_access/2`. Resolving the customer
 * (a database lookup in Inkress) is deferred; `withAccess` takes already-resolved data.
 */
import { jsonByteSize, isJNumber } from "./json.ts";
import { ALLOWED_ACCESS_STATES, Limits, ReservedAttribute } from "./types.ts";
import type { AccessState, Context, JsonObject, JsonValue } from "./types.ts";

export type PreparedContext = { readonly ok: true; readonly context: Context } | { readonly ok: false; readonly error: string };

/** An Elixir map: a JSON object, not a list, number or scalar. */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !isJNumber(value as JsonValue);
}

function emptyObject(): Record<string, JsonValue> {
  return Object.create(null) as Record<string, JsonValue>;
}

/** `Context.validate/1` */
export function validateContext(raw: JsonValue | undefined): PreparedContext {
  if (raw === undefined || raw === null) return { ok: true, context: emptyObject() };
  if (!isJsonObject(raw)) return { ok: false, error: "context must be an object" };
  if (jsonByteSize(raw) > Limits.contextBytes) return { ok: false, error: `context is larger than ${Limits.contextBytes} bytes` };
  return { ok: true, context: raw };
}

/** `Context.strip_reserved/1`: drops `inkress` and every `inkress.*` key. */
export function stripReserved(context: Context): Context {
  const out = emptyObject();
  for (const key of Object.keys(context)) {
    if (key === "inkress" || key.startsWith("inkress.")) continue;
    out[key] = context[key] as JsonValue;
  }
  return out;
}

/** `validate` then `strip_reserved` (the customer step of `Context.prepare/2` is separate). */
export function prepareContext(raw: JsonValue | undefined): PreparedContext {
  const validated = validateContext(raw);
  return validated.ok ? { ok: true, context: stripReserved(validated.context) } : validated;
}

/** The subscription fields `with_access/2` reads. */
export interface SubscriptionInfo {
  readonly planUid: string | null;
  readonly status: string;
}

/** `Context.with_access/2`: sets `inkress.access`, and `inkress.plan` / `inkress.subscription_status` when present. */
export function withAccess(context: Context, access: AccessState, subscription: SubscriptionInfo | null): Context {
  const out = emptyObject();
  for (const key of Object.keys(context)) out[key] = context[key] as JsonValue;
  out[ReservedAttribute.Access] = access;
  const plan = subscription !== null && ALLOWED_ACCESS_STATES.includes(access) ? subscription.planUid : null;
  if (plan !== null) out[ReservedAttribute.Plan] = plan;
  if (subscription !== null) out[ReservedAttribute.SubscriptionStatus] = subscription.status;
  return out;
}
