/**
 * Api.Flags.Evaluation: constructors and the OFREP wire shape. The wire object is a `JsonObject`, so numbers keep
 * Elixir's integer/float split and `toWireJson` writes it with the lossless writer.
 */
import { encodeJson, fromPlain } from "./json.ts";
import { Reason } from "./types.ts";
import type { ErrorCode, Evaluation, JsonObject, JsonValue } from "./types.ts";

/** `Evaluation.error/3` */
export function errorEvaluation(key: string, code: ErrorCode, details: string): Evaluation {
  return { key, value: null, variant: null, reason: Reason.Error, errorCode: code, errorDetails: details, metadata: {} };
}

/** A success: `%Evaluation{key, value, variant, reason}` with empty metadata. */
export function okEvaluation(key: string, value: JsonValue, variant: string | null, reason: Reason): Evaluation {
  return { key, value, variant, reason, errorCode: null, errorDetails: null, metadata: {} };
}

/** `Evaluation.ok?/1` */
export function isOk(evaluation: Evaluation): boolean {
  return evaluation.errorCode === null;
}

/** The OFREP evaluation shape `{key, value, variant, reason, errorCode, errorDetails, metadata}`. */
export function toWire(evaluation: Evaluation): JsonObject {
  const wire: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  wire["key"] = evaluation.key;
  wire["value"] = evaluation.value;
  wire["variant"] = evaluation.variant;
  wire["reason"] = evaluation.reason;
  wire["errorCode"] = evaluation.errorCode;
  wire["errorDetails"] = evaluation.errorDetails;
  const metadata: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [name, value] of Object.entries(evaluation.metadata)) metadata[name] = fromPlain(value);
  wire["metadata"] = metadata;
  return wire;
}

/** `toWire` serialised by the lossless writer (keys in the order above). */
export function toWireJson(evaluation: Evaluation): string {
  return encodeJson(toWire(evaluation));
}
