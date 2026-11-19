import { sha1Prefix60 } from "./sha1.ts";
import { WEIGHT_TOTAL } from "./types.ts";
import type { WeightedVariant } from "./types.ts";

/** 0xFFFFFFFFFFFFFFF: the largest 15-hex-digit value. */
const MAX_PREFIX = 0xfffffffffffffffn;
const TOTAL = BigInt(WEIGHT_TOTAL);
// TextEncoder exists in Workers, Node and browsers; src is type-checked without DOM or Node types.
declare const TextEncoder: new () => { encode(input: string): Uint8Array };
const encoder = new TextEncoder();

/** Scales a 60-bit hash prefix to 0..99_999: integer `div` by 0xFFFFFFFFFFFFFFF, capped. */
export function scalePrefix(n: bigint): number {
  const scaled = (n * TOTAL) / MAX_PREFIX;
  const cap = TOTAL - 1n;
  return Number(scaled < cap ? scaled : cap);
}

/**
 * Sticky bucket in 0..99_999: sha1("<flagKey>.<salt>.<value>") over UTF-8, first 15 hex digits
 * scaled by integer division. Port of Api.Flags.Bucket.bucket/3. Lone surrogates encode as U+FFFD
 * (TextEncoder); LAT-10's JSON reader rejects ill-formed strings, so they do not reach here.
 */
export function bucket(flagKey: string, salt: string, value: string): number {
  return scalePrefix(sha1Prefix60(encoder.encode(`${flagKey}.${salt}.${value}`)));
}

/**
 * Variant key whose cumulative weight range contains `bucketValue`; the last variant's key when
 * none does. Port of Api.Flags.Bucket.pick/2. `rollout` must be non-empty (Elixir raises on []).
 */
export function pick(rollout: readonly WeightedVariant[], bucketValue: number): string {
  let acc = 0;
  for (const { variant, weight } of rollout) {
    if (bucketValue < acc + weight) return variant;
    acc += weight;
  }
  const last = rollout[rollout.length - 1];
  if (last === undefined) throw new Error("pick: empty rollout");
  return last.variant;
}
