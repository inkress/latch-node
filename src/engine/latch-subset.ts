/**
 * Latch's regex subset (DECISIONS.md, "Latch's regex subset"): a whitelist of the PCRE syntax Latch supports. A pattern that
 * Inkress accepts but is not in the subset is refused on write with "regex uses a feature Latch doesn't support"; a pattern
 * Inkress refuses is never accepted (Inkress's own checks run first). The grammar:
 *
 * - literals (any character that is not special, `{` and `}` that do not form a quantifier, `]` outside a class) and
 *   escaped punctuation (a backslash and any ASCII character that is not a letter or digit);
 * - `\d \w \s \h \v \D \W \S \H \V \b \B \A \z \Z`, `\n \r \t \f \e`, `\xHH` (exactly two hex digits), `\x{..}`, `\0` with up
 *   to two octal digits, `\Q..\E` (at top level and in classes), `\p{..}` / `\P{..}` / `\pL` with PCRE's property names;
 * - bracket classes with ranges, those escapes (and `\b` for backspace), POSIX `[:name:]` / `[:^name:]`, but not the complement of
 *   one of PCRE's extra properties (`[\P{Xan}]`);
 * - groups `( )`, `(?: )`, `(?<name> )`, `(?P<name> )`; inline flags `(?imsx-imsx)` and `(?imsx: )` with at least one letter
 *   (`x` ignores ASCII whitespace and `#` comments only);
 * - alternation `|`, anchors `^ $`, `.`, and the quantifiers `* + ? {n} {n,} {n,m}` with their lazy forms (the possessive forms
 *   are refused earlier, by the unsafe list).
 * Everything else is outside: `(*VERBS)`, callouts, `(?#..)`, `(?X)` `(?U)` `(?J)`, `(?|`, `(?'n'..)`, conditionals, recursion,
 * lookaround, atomic groups, back references, `\c \R \X \C \K \G \N \o{}`, one-digit `\x`, `\a`, other letter escapes, stray `\E`.
 */
import { PCRE_PROPERTY_NAMES } from "./pcre-properties.ts";

const EXTRA_PROPERTIES = new Set(["L&", "Xan", "Xwd", "Xsp", "Xps", "Xuc", "Any"]);
const SIMPLE_ESCAPES = new Set("dwshvDWSHVbBAzZnrtfe");
const CLASS_ESCAPES = new Set("dwshvDWSHVbnrtfe");
const POSIX = new Set(["alpha", "digit", "alnum", "upper", "lower", "space", "blank", "punct", "print", "graph", "cntrl", "xdigit", "word", "ascii"]);
const FLAG_GROUP = /^\(\?([imsx]*)(?:-([imsx]*))?([:)])/;
const NAMED_GROUP = /^\(\?P?<[A-Za-z_][A-Za-z0-9_]*>/;
const QUANTIFIER = /^\{\d+(?:,\d*)?\}/;
const ASCII_SPACE = /^[ \t\n\v\f\r]$/;

function isAsciiPunctuationOrSpace(ch: string): boolean {
  return ch.charCodeAt(0) < 128 && !/^[A-Za-z0-9]$/.test(ch);
}

/** The length of the `\x`, `\0`, `\p`, `\P` escape that starts at `i` (the backslash), or 0 if it is not valid in the subset. */
function numericOrPropertyEscape(pattern: string, i: number): number {
  const rest = pattern.slice(i + 1);
  const letter = rest[0];
  if (letter === "x") {
    const braced = /^x\{[0-9A-Fa-f]+\}/.exec(rest);
    if (braced !== null) return 1 + braced[0].length;
    return /^x[0-9A-Fa-f]{2}/.test(rest) ? 4 : 0;
  }
  if (letter === "0") return 1 + (/^0[0-7]{0,2}/.exec(rest) as RegExpExecArray)[0].length;
  if (letter === "p" || letter === "P") {
    if (rest[1] === "{") {
      const end = rest.indexOf("}");
      if (end === -1) return 0;
      const name = rest.slice(2, end);
      return PCRE_PROPERTY_NAMES.has(name.startsWith("^") ? name.slice(1) : name) ? 1 + end + 1 : 0;
    }
    return rest[1] !== undefined && /^[LMNPSZC]$/.test(rest[1]) ? 3 : 0;
  }
  return 0;
}

/** Index after a valid bracket class starting at `start`, or -1 if it uses anything outside the subset. */
function scanClass(pattern: string, start: number): number {
  let i = start + 1;
  if (pattern[i] === "^") i++;
  // PCRE then reads a following ] as a member; the subset leaves that corner out.
  if (pattern.startsWith("\\Q\\E", i)) return -1;
  let first = true;
  while (i < pattern.length) {
    const ch = pattern[i] as string;
    if (ch === "]" && !first) return i + 1;
    first = false;
    if (ch === "[" && pattern[i + 1] === ":") {
      const end = pattern.indexOf(":]", i + 2);
      if (end !== -1 && /^\^?[a-z]+$/.test(pattern.slice(i + 2, end))) {
        const name = pattern.slice(i + 2, end);
        if (!POSIX.has(name.startsWith("^") ? name.slice(1) : name)) return -1;
        i = end + 2;
        continue;
      }
    }
    if (ch === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) return -1;
      if (next === "Q") {
        const end = pattern.indexOf("\\E", i + 2);
        if (end === -1) return -1;
        first = end === i + 2 && start + 1 === i; // `[\Q\E]` leaves the next ] literal (Inkress refuses that pattern anyway)
        i = end + 2;
        continue;
      }
      if (CLASS_ESCAPES.has(next)) i += 2;
      else if (next === "x" || next === "0" || next === "p" || next === "P") {
        const length = numericOrPropertyEscape(pattern, i);
        if (length === 0) return -1;
        // RE2 cannot put the complement of a union (\P{Xan}, \p{^L&}) inside a class.
        const name = pattern.slice(i + 3, i + length - 1);
        const negated = next === "P" ? !name.startsWith("^") : name.startsWith("^");
        if ((next === "p" || next === "P") && negated && EXTRA_PROPERTIES.has(name.replace("^", ""))) return -1;
        i += length;
      } else if (isAsciiPunctuationOrSpace(next)) i += 2;
      else return -1;
      continue;
    }
    i++;
  }
  return -1;
}

/** The text with (?x)'s ignored parts removed: ASCII whitespace and `#` comments up to the end of the line. */
function withoutIgnored(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ASCII_SPACE.test(ch)) continue;
    if (ch === "#") {
      const end = text.indexOf("\n", i);
      if (end === -1) break;
      i = end;
      continue;
    }
    out += ch;
  }
  return out;
}

/** `true` when every construct in the pattern is in Latch's subset. */
export function inLatchSubset(pattern: string): boolean {
  let extended = false;
  const saved: boolean[] = [];
  let i = 0;
  /** The previous token was a quantifier (or its lazy suffix); under (?x) only whitespace or comments may have followed it. */
  let afterQuantifier = false;
  let ignoredAfterQuantifier = false;
  while (i < pattern.length) {
    const ch = pattern[i] as string;
    if (extended && ASCII_SPACE.test(ch)) {
      ignoredAfterQuantifier ||= afterQuantifier;
      i++;
      continue;
    }
    if (extended && ch === "#") {
      ignoredAfterQuantifier ||= afterQuantifier;
      const end = pattern.indexOf("\n", i);
      i = end === -1 ? pattern.length : end + 1;
      continue;
    }
    // `a+ ?` and `a{2} ?`: whether PCRE reads the second quantifier as a lazy or possessive suffix across ignored text is
    // not something the subset relies on.
    if (ignoredAfterQuantifier && (ch === "?" || ch === "+")) return false;
    const wasQuantifier: boolean = afterQuantifier;
    afterQuantifier = false;
    ignoredAfterQuantifier = false;
    if (ch === "*" || ch === "+" || ch === "?") {
      afterQuantifier = !(wasQuantifier && ch !== "*"); // a lazy ? / possessive + suffix ends the run
      i++;
    } else if (ch === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) return false;
      if (next === "Q") {
        const end = pattern.indexOf("\\E", i + 2);
        i = end === -1 ? pattern.length : end + 2;
      } else if (SIMPLE_ESCAPES.has(next)) i += 2;
      else if (next === "x" || next === "0" || next === "p" || next === "P") {
        const length = numericOrPropertyEscape(pattern, i);
        if (length === 0) return false;
        i += length;
      } else if (isAsciiPunctuationOrSpace(next)) i += 2;
      else return false;
    } else if (ch === "[") {
      const end = scanClass(pattern, i);
      if (end === -1) return false;
      i = end;
    } else if (ch === "(") {
      if (pattern[i + 1] !== "?") {
        if (pattern[i + 1] === "*") return false;
        saved.push(extended);
        i++;
      } else if (pattern.startsWith("(?:", i)) {
        saved.push(extended);
        i += 3;
      } else {
        const named = NAMED_GROUP.exec(pattern.slice(i));
        const flags = FLAG_GROUP.exec(pattern.slice(i));
        if (named !== null) {
          saved.push(extended);
          i += named[0].length;
        } else if (flags !== null && (flags[1] as string).length + (flags[2] ?? "").length > 0) {
          const scoped = flags[3] === ":";
          if (scoped) saved.push(extended);
          if ((flags[1] as string).includes("x")) extended = true;
          if ((flags[2] ?? "").includes("x")) extended = false;
          i += flags[0].length;
        } else return false;
      }
    } else if (ch === ")") {
      extended = saved.pop() ?? extended;
      i++;
    } else if (ch === "{") {
      const quantifier = QUANTIFIER.exec(pattern.slice(i));
      // Under (?x) a `{` that is literal to PCRE can become a quantifier once ignored text is removed (`a{1, 2}`): refuse.
      if (quantifier === null && extended && QUANTIFIER.test(withoutIgnored(pattern.slice(i, i + 80)))) return false;
      afterQuantifier = quantifier !== null;
      i += quantifier === null ? 1 : quantifier[0].length;
    } else i++;
  }
  return true;
}
