/**
 * `String.length/1` in Elixir counts extended grapheme clusters by UAX #29 as of Elixir's Unicode version (14.0 in
 * Elixir 1.14, 15.0 in 1.15): without rule GB9c (Indic conjunct clusters), which `Intl.Segmenter` applies when the
 * host's ICU is Unicode 15.1 or newer. `क्ष` is two graphemes in Elixir and one in newer ICU. To count the same
 * everywhere, take the host's clusters and split them again where GB9c alone joined them: before a consonant that
 * follows a virama (a "linker"). Where the host's ICU is older and has no GB9c this does nothing.
 *
 * Elixir also differs from UAX #29 in one emoji case, found by running it: after `ExtPict Extend* ZWJ` the cluster
 * continues only if the next character is itself Extended_Pictographic. `😀 ZWJ U+FE0F` (and `ZWJ` followed by a skin
 * tone, a keycap, another ZWJ, ...) is two graphemes in Elixir 1.14 and 1.15, one in ICU. The same splitting applies.
 * Both rules are checked against Elixir on 2,254 random Indic, emoji and mixed strings (test/fixtures/graphemes-elixir.json).
 */

/** InCB=Linker (Unicode 15.1): the viramas of the scripts that form conjuncts. */
const LINKERS: ReadonlySet<number> = new Set([0x094d, 0x09cd, 0x0acd, 0x0b4d, 0x0c4d, 0x0d4d]);

/** InCB=Consonant (Unicode 15.1), inclusive ranges. */
const CONSONANTS: readonly (readonly [number, number])[] = [
  [0x0915, 0x0939], [0x0958, 0x095f], [0x0978, 0x097f],
  [0x0995, 0x09a8], [0x09aa, 0x09b0], [0x09b2, 0x09b2], [0x09b6, 0x09b9], [0x09dc, 0x09dd], [0x09df, 0x09df], [0x09f0, 0x09f1],
  [0x0a95, 0x0aa8], [0x0aaa, 0x0ab0], [0x0ab2, 0x0ab3], [0x0ab5, 0x0ab9], [0x0af9, 0x0af9],
  [0x0b15, 0x0b28], [0x0b2a, 0x0b30], [0x0b32, 0x0b33], [0x0b35, 0x0b39], [0x0b5c, 0x0b5d], [0x0b5f, 0x0b5f], [0x0b71, 0x0b71],
  [0x0c15, 0x0c28], [0x0c2a, 0x0c39], [0x0c58, 0x0c5a],
  [0x0d15, 0x0d3a],
];

function isConsonant(code: number): boolean {
  return CONSONANTS.some(([lo, hi]) => code >= lo && code <= hi);
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const EXTENDED_PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;
const EXTEND = /^[\p{Grapheme_Extend}\p{Emoji_Modifier}]$/u;
const ZERO_WIDTH_JOINER = 0x200d;

/** How many graphemes the cluster the host reports really is, under Elixir's rules. */
function clusterParts(cluster: string): number {
  const chars = Array.from(cluster);
  let parts = 1;
  let sawLinker = false; // Indic: a virama since the last consonant
  let pictographRun = false; // `ExtPict Extend*` so far
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;
    const code = ch.codePointAt(0) as number;
    if (isConsonant(code)) {
      if (sawLinker) parts++;
      sawLinker = false;
    } else if (LINKERS.has(code)) sawLinker = true;
    if (EXTENDED_PICTOGRAPHIC.test(ch)) pictographRun = true;
    else if (code === ZERO_WIDTH_JOINER) {
      const next = chars[i + 1];
      if (pictographRun && next !== undefined && !EXTENDED_PICTOGRAPHIC.test(next)) parts++;
      pictographRun = false;
    } else if (!EXTEND.test(ch)) pictographRun = false;
  }
  return parts;
}

/** `String.length(text) > max`, stopping as soon as the answer is known. */
export function graphemeCountExceeds(text: string, max: number): boolean {
  if (text.length <= max) return false; // a grapheme is at least one UTF-16 unit
  let count = 0;
  for (const part of segmenter.segment(text)) {
    count += part.segment.length > 1 ? clusterParts(part.segment) : 1;
    if (count > max) return true;
  }
  return false;
}

/** `String.length(text)`. */
export function graphemeCount(text: string): number {
  let count = 0;
  for (const part of segmenter.segment(text)) count += part.segment.length > 1 ? clusterParts(part.segment) : 1;
  return count;
}
