/**
 * Rewrites a PCRE pattern (as Inkress runs it: Erlang `:re` with the `unicode` option) into an equivalent RE2
 * pattern, for the parts where RE2 differs from PCRE and the difference can be written in RE2 itself.
 *
 * What Erlang's PCRE does (found by running it over 66 class patterns x 120 characters, test/fixtures/regex-elixir.json):
 * `\d \w \s` and the POSIX classes use Latin-1 ctype tables for code points below 256 and match nothing above 255
 * (so `\w` covers `a-z A-Z 0-9 _` plus the Latin-1 letters ª µ º À-Ö Ø-ö ø-ÿ, but not `Ā` or `日`); `\s` includes VT;
 * `\h` and `\v` are the Unicode horizontal and vertical whitespace sets; `\p{..}` is Unicode-aware and never case
 * folded. RE2 has ASCII-only `\d \w \s`, `\s` without VT, no `\h \H \v \V \N \R \e \cX \Z`, and folds `\p{Lu}`
 * under `(?i)`. Every item here is a plain union, so it works inside bracket classes too.
 * What cannot be written in RE2 stays different and is listed in REGEX-PARITY.md.
 */

type Range = readonly [number, number];
const MAX_CODE_POINT = 0x10ffff;

const ALPHA: readonly Range[] = [[0x41, 0x5a], [0x61, 0x7a], [0xaa, 0xaa], [0xb5, 0xb5], [0xba, 0xba], [0xc0, 0xd6], [0xd8, 0xf6], [0xf8, 0xff]];
const DIGIT: readonly Range[] = [[0x30, 0x39]];
const WORD: readonly Range[] = [[0x30, 0x39], [0x41, 0x5a], [0x5f, 0x5f], [0x61, 0x7a], [0xaa, 0xaa], [0xb5, 0xb5], [0xba, 0xba], [0xc0, 0xd6], [0xd8, 0xf6], [0xf8, 0xff]];
const ALNUM: readonly Range[] = [[0x30, 0x39], ...ALPHA];
const UPPER: readonly Range[] = [[0x41, 0x5a], [0xc0, 0xd6], [0xd8, 0xde]];
const LOWER: readonly Range[] = [[0x61, 0x7a], [0xaa, 0xaa], [0xb5, 0xb5], [0xba, 0xba], [0xdf, 0xf6], [0xf8, 0xff]];
const SPACE: readonly Range[] = [[0x09, 0x0d], [0x20, 0x20]];
const BLANK: readonly Range[] = [[0x09, 0x09], [0x20, 0x20]];
const PUNCT: readonly Range[] = [[0x21, 0x2f], [0x3a, 0x40], [0x5b, 0x60], [0x7b, 0x7e], [0xa0, 0xa9], [0xab, 0xb4], [0xb6, 0xb9], [0xbb, 0xbf], [0xd7, 0xd7], [0xf7, 0xf7]];
const GRAPH: readonly Range[] = [[0x21, 0x7e], [0xa0, 0xff]];
const PRINT: readonly Range[] = [[0x20, 0x7e], [0xa0, 0xff]];
const CNTRL: readonly Range[] = [[0x00, 0x1f], [0x7f, 0x9f]];
const ASCII: readonly Range[] = [[0x00, 0xff]]; // sic: Erlang's table says every Latin-1 character is ASCII
const XDIGIT: readonly Range[] = [[0x30, 0x39], [0x41, 0x46], [0x61, 0x66]];
const HSPACE: readonly Range[] = [[0x09, 0x09], [0x20, 0x20], [0xa0, 0xa0], [0x1680, 0x1680], [0x180e, 0x180e], [0x2000, 0x200a], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000]];
const VSPACE: readonly Range[] = [[0x0a, 0x0d], [0x85, 0x85], [0x2028, 0x2029]];

function hex(code: number): string {
  return `\\x{${code.toString(16)}}`;
}

/** Bracket-class items for a set of ranges. */
function items(ranges: readonly Range[]): string {
  return ranges.map(([lo, hi]) => (lo === hi ? hex(lo) : `${hex(lo)}-${hex(hi)}`)).join("");
}

/** The complement of a set of ranges over all code points. */
function complement(ranges: readonly Range[]): readonly Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  let next = 0;
  for (const [lo, hi] of sorted) {
    if (lo > next) out.push([next, lo - 1]);
    next = hi + 1;
  }
  if (next <= MAX_CODE_POINT) out.push([next, MAX_CODE_POINT]);
  return out;
}

const CLASS_ESCAPES: Readonly<Record<string, string>> = {
  d: items(DIGIT),
  D: items(complement(DIGIT)),
  w: items(WORD),
  W: items(complement(WORD)),
  s: items(SPACE),
  S: items(complement(SPACE)),
  h: items(HSPACE),
  H: items(complement(HSPACE)),
  v: items(VSPACE),
  V: items(complement(VSPACE)),
};
const STANDALONE_ESCAPES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(CLASS_ESCAPES).map(([letter, set]) => [letter, `[${set}]`])),
  e: "\\x1b",
  Z: "\\z",
};
const POSIX_SETS: Readonly<Record<string, readonly Range[]>> = {
  alpha: ALPHA, digit: DIGIT, alnum: ALNUM, upper: UPPER, lower: LOWER, space: SPACE, blank: BLANK, word: WORD, punct: PUNCT,
  graph: GRAPH, print: PRINT, cntrl: CNTRL, ascii: ASCII, xdigit: XDIGIT,
};
const POSIX_ITEMS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(POSIX_SETS).flatMap(([name, set]) => [[name, items(set)], [`^${name}`, items(complement(set))]]),
);

/** Properties PCRE has and RE2 lacks, as bracket-class items. */
const SPACE_PROPERTY = "\\p{Z}\\t-\\r\\x{85}\\x{180e}";
const EXTRA_PROPERTIES: Readonly<Record<string, string>> = {
  "L&": "\\p{Lu}\\p{Ll}\\p{Lt}",
  Xan: "\\p{L}\\p{N}",
  Xwd: "\\p{L}\\p{N}_",
  Xsp: SPACE_PROPERTY,
  Xps: SPACE_PROPERTY,
  Any: "\\x{0}-\\x{10ffff}",
  Xuc: "\\x{24}\\x{40}\\x{60}\\x{a0}-\\x{d7ff}\\x{e000}-\\x{10ffff}",
};

/** `\p{..}`, `\P{..}`, `\pL` starting at `start` (the backslash): the RE2 text and the index after it. */
function property(pattern: string, start: number, inClass: boolean): { readonly text: string; readonly next: number } {
  const letter = pattern[start + 1] as string;
  const braced = pattern[start + 2] === "{";
  const close = braced ? pattern.indexOf("}", start + 2) : start + 2;
  const next = close === -1 ? pattern.length : close + 1;
  const original = pattern.slice(start, next);
  const rawName = braced ? pattern.slice(start + 3, close === -1 ? pattern.length : close) : (pattern[start + 2] ?? "");
  const hatted = rawName.startsWith("^");
  const items = EXTRA_PROPERTIES[hatted ? rawName.slice(1) : rawName];
  const negative = (letter === "P") !== hatted;
  if (inClass) return { text: items !== undefined && !negative ? items : original, next };
  // PCRE never case-folds \p{..}; RE2 does under (?i).
  return { text: items !== undefined ? `(?-i:[${negative ? "^" : ""}${items}])` : `(?-i:${original})`, next };
}

function codePointAt(pattern: string, index: number): number {
  return pattern.codePointAt(index) as number;
}

/** `\x{..}` for a code point, which RE2 reads as that literal character everywhere. */
function literal(code: number): string {
  return `\\x{${code.toString(16)}}`;
}

const FLAG_GROUP = /^\(\?([imsx]*)(?:-([imsx]*))?([:)])/;
const ASCII_SPACE = /^[ \t\n\v\f\r]$/;

/**
 * Rewrites a PCRE pattern inside Latch's subset (`latch-subset.ts`) for RE2 (see the file comment). `\Z` becomes `\z`; the
 * caller emulates the final-newline rule. Constructs outside the subset never get here.
 */
export function translateToRe2(pattern: string): string {
  let out = "";
  let i = 0;
  let inClass = false;
  let extended = false; // PCRE (?x): RE2 has no such flag, so ASCII whitespace and # comments are removed here
  const groupStack: boolean[] = [];
  while (i < pattern.length) {
    const ch = pattern[i] as string;
    if (ch === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) {
        out += ch;
        i++;
      } else if (next === "Q") {
        const end = pattern.indexOf("\\E", i + 2);
        const stop = end === -1 ? pattern.length : end + 2;
        if (inClass) {
          for (const quoted of pattern.slice(i + 2, end === -1 ? pattern.length : end)) out += literal(codePointAt(quoted, 0));
        } else out += pattern.slice(i, stop);
        i = stop;
      } else if (next === "p" || next === "P") {
        const prop = property(pattern, i, inClass);
        out += prop.text;
        i = prop.next;
      } else if (inClass) {
        out += CLASS_ESCAPES[next] ?? (next === "b" ? "\\x08" : next === "e" ? "\\x1b" : pattern.slice(i, i + 2));
        i += 2;
      } else {
        out += STANDALONE_ESCAPES[next] ?? pattern.slice(i, i + 2);
        i += 2;
      }
    } else if (inClass) {
      if (ch === "[" && pattern[i + 1] === ":") {
        const end = pattern.indexOf(":]", i + 2);
        const items = end === -1 ? undefined : POSIX_ITEMS[pattern.slice(i + 2, end)];
        if (end !== -1 && items !== undefined) {
          out += items;
          i = end + 2;
          continue;
        }
      }
      if (ch === "]") inClass = false;
      out += ch;
      i++;
    } else if (ch === "(") {
      const flags = FLAG_GROUP.exec(pattern.slice(i));
      if (flags === null) {
        out += ch; // a plain, non-capturing or named group
        i++;
        groupStack.push(extended);
        continue;
      }
      const on = flags[1] as string;
      const off = flags[2] ?? "";
      const scoped = flags[3] === ":";
      const before = extended;
      if (on.includes("x")) extended = true;
      if (off.includes("x")) extended = false;
      const keptOn = on.replace("x", "");
      const keptOff = off.replace("x", "");
      const body = `${keptOn}${keptOff === "" ? "" : `-${keptOff}`}`;
      out += body === "" ? (scoped ? "(?:" : "(?:)") : `(?${body}${scoped ? ":" : ")"}`;
      if (scoped) groupStack.push(before);
      i += flags[0].length;
    } else if (ch === ")") {
      out += ch;
      i++;
      extended = groupStack.pop() ?? extended;
    } else if (extended && ASCII_SPACE.test(ch)) {
      i++; // (?x): whitespace outside a class is ignored (ASCII only)
    } else if (extended && ch === "#") {
      const end = pattern.indexOf("\n", i);
      i = end === -1 ? pattern.length : end + 1; // (?x): a comment to the end of the line
    } else if (ch === "[") {
      inClass = true;
      out += ch;
      i++;
      if (pattern[i] === "^") {
        out += "^";
        i++;
      }
      if (pattern[i] === "]") {
        out += "\\]"; // a leading ] is a literal in PCRE
        i++;
      }
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}
