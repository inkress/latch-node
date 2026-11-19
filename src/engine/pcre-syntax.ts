/**
 * A syntax check that answers "would Inkress's PCRE (`:re.compile(pattern, [:unicode])`, PCRE 8.45) refuse this
 * pattern?". Inkress rejects those on write, and Latch keeps rejecting them with the same message
 * ("regex does not compile"), whether or not RE2 would also refuse them.
 *
 * It is a structural scan, not a regex engine: balanced groups, class syntax and ranges, escapes PCRE does not
 * know, quantifier placement and bounds, group names and references, flags, verbs. It deliberately errs on the side
 * of accepting: PCRE-only syntax that is valid in PCRE (`\K`, `(?|`, conditionals, ...) is accepted here, and then
 * refused by the RE2 compile step with its own message. The rules were derived from, and are checked against,
 * test/fixtures/regex-elixir.json (915 patterns run through the real PCRE).
 */
import { PCRE_PROPERTY_NAMES } from "./pcre-properties.ts";

const MAX_REPEAT = 65535;
const MAX_NAME_LENGTH = 32;
const POSIX_CLASSES = new Set(["alpha", "digit", "alnum", "upper", "lower", "space", "blank", "punct", "print", "graph", "cntrl", "xdigit", "word", "ascii"]);
/** Escapes of ASCII letters PCRE 8.45 refuses (the other unknown letter escapes stand for themselves). */
const BAD_LETTER_ESCAPES = new Set(["l", "L", "u", "U"]);
const CLASS_ESCAPES = new Set(["d", "D", "w", "W", "s", "S", "h", "H", "v", "V", "p", "P", "R", "X", "N"]);
const NOT_REPEATABLE_ESCAPES = new Set(["b", "B", "A", "z", "Z", "G", "K"]);
const VERBS = new Set(["ACCEPT", "COMMIT", "FAIL", "F", "PRUNE", "SKIP", "THEN"]);
const START_VERBS = /^(UTF8|UTF|UCP|CR|LF|CRLF|ANYCRLF|ANY|BSR_ANYCRLF|BSR_UNICODE|NO_START_OPT|LIMIT_MATCH=\d+|LIMIT_RECURSION=\d+)$/;

class PcreSyntaxError extends Error {}

function fail(): never {
  throw new PcreSyntaxError("pcre");
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

function propertyKnown(name: string): boolean {
  return PCRE_PROPERTY_NAMES.has(name.startsWith("^") ? name.slice(1) : name);
}

interface GroupFrame {
  readonly extended: boolean;
}

class Scanner {
  private readonly p: string;
  private i = 0;
  private groups = 0;
  private extended = false;
  private allowDuplicateNames = false;
  private readonly names = new Set<string>();
  private readonly stack: GroupFrame[] = [];
  private readonly numberedRefs: { readonly n: number; readonly relative: boolean }[] = [];
  private readonly namedRefs: string[] = [];
  /** Is the previous item something a quantifier may follow? */
  private repeatable = false;
  /** The previous token was a quantifier, so a `?` / `+` now is its lazy / possessive suffix. */
  private lazyAllowed = false;
  /** Has anything but a `(*VERB)` option been seen (those only belong at the very start). */
  private seenContent = false;

  constructor(pattern: string) {
    this.p = pattern;
  }

  run(): void {
    while (this.i < this.p.length) this.step();
    if (this.stack.length > 0) fail();
    for (const ref of this.numberedRefs) {
      const target = ref.relative ? this.groups + ref.n : ref.n;
      if (target < 0 || target > this.groups || (ref.relative && ref.n === 0)) fail();
    }
    for (const name of this.namedRefs) if (!this.names.has(name)) fail();
  }

  private at(offset = 0): string | undefined {
    return this.p[this.i + offset];
  }

  private step(): void {
    const ch = this.p[this.i] as string;
    if (this.extended) {
      // (?x) ignores ASCII whitespace and # comments; they are invisible between a quantifier and its lazy ? / possessive +.
      if (/^[ \t\n\v\f\r]$/.test(ch)) {
        this.i++;
        return;
      }
      if (ch === "#") {
        while (this.i < this.p.length && this.p[this.i] !== "\n") this.i++;
        return;
      }
    }
    const lazyAllowed = this.lazyAllowed;
    if (!this.p.startsWith("(?#", this.i)) this.lazyAllowed = false; // a comment is invisible between a quantifier and its ? / +
    switch (ch) {
      case "\\":
        this.escape();
        return;
      case "[":
        this.charClass();
        return;
      case "(":
        this.openGroup();
        return;
      case ")":
        this.closeGroup();
        return;
      case "|":
        this.i++;
        this.repeatable = false;
        this.seenContent = true;
        return;
      case "*":
      case "+":
      case "?":
        this.i++;
        if (lazyAllowed && ch !== "*") {
          this.lazyAllowed = false; // `?` or `+` right after a quantifier makes it lazy or possessive
          return;
        }
        this.quantifier();
        return;
      case "{": {
        const m = /^\{(\d+)(?:,(\d*))?\}/.exec(this.p.slice(this.i));
        if (m === null) {
          this.literal();
          return;
        }
        const min = Number(m[1]);
        const max = m[2] === undefined ? min : m[2] === "" ? Infinity : Number(m[2]);
        if (min > MAX_REPEAT || (max !== Infinity && max > MAX_REPEAT) || min > max) fail();
        this.i += m[0].length;
        this.quantifier();
        return;
      }
      case "^":
      case "$":
        this.i++;
        this.repeatable = false;
        this.seenContent = true;
        return;
      default:
        this.literal();
    }
  }

  private literal(): void {
    this.i += this.p.codePointAt(this.i) !== undefined && (this.p.codePointAt(this.i) as number) > 0xffff ? 2 : 1;
    this.repeatable = true;
    this.seenContent = true;
  }

  /** After a quantifier token: needs a repeatable item; then an optional lazy `?` or possessive `+`; no stacking. */
  private quantifier(): void {
    if (!this.repeatable) fail();
    this.repeatable = false;
    this.lazyAllowed = true;
  }

  private escape(): void {
    const next = this.at(1);
    if (next === undefined) fail();
    this.seenContent = true;
    const c = next;
    this.i += 2;
    if (c === "Q") {
      const end = this.p.indexOf("\\E", this.i);
      const quoted = end === -1 ? this.p.slice(this.i) : this.p.slice(this.i, end);
      this.i = end === -1 ? this.p.length : end + 2;
      if (quoted.length > 0) this.repeatable = true;
      return;
    }
    if (c === "E") return;
    if (isDigit(c) && c !== "0") {
      // A back reference; `\1`..`\9` are screened by SafeRegex's unsafe list before this check, so only multi-digit
      // forms like `\10` reach it. PCRE reads them as octal or as a reference to a group that must exist.
      let digits = c;
      while (isDigit(this.at())) digits += this.p[this.i++] as string;
      if (Number(digits) > 9 && Number(digits) > this.groups && /[89]/.test(digits)) fail();
      this.repeatable = true;
      return;
    }
    if (c === "0") {
      let n = 0;
      while (n < 2 && this.at() !== undefined && /[0-7]/.test(this.at() as string)) {
        this.i++;
        n++;
      }
      this.repeatable = true;
      return;
    }
    if (c === "x") {
      this.hexEscape();
      this.repeatable = true;
      return;
    }
    if (c === "c") {
      const target = this.at();
      if (target === undefined || target.charCodeAt(0) > 127 || target.charCodeAt(0) < 32) fail();
      this.i++;
      this.repeatable = true;
      return;
    }
    if (c === "p" || c === "P") {
      this.property();
      this.repeatable = true;
      return;
    }
    if (c === "o") {
      this.octalBraces();
      this.repeatable = true;
      return;
    }
    if (c === "g") {
      this.groupReference();
      this.repeatable = true;
      return;
    }
    if (c === "k") {
      const open = this.at();
      const close = open === "<" ? ">" : open === "{" ? "}" : open === "'" ? "'" : null;
      if (close === null) fail();
      const end = this.p.indexOf(close, this.i + 1);
      if (end === -1) fail();
      this.namedRefs.push(this.p.slice(this.i + 1, end));
      this.i = end + 1;
      this.repeatable = true;
      return;
    }
    if (BAD_LETTER_ESCAPES.has(c)) fail();
    if (c === "N" && this.at() === "{" && !/^\{\d+(?:,\d*)?\}/.test(this.p.slice(this.i))) fail(); // \N{name}
    this.repeatable = !NOT_REPEATABLE_ESCAPES.has(c);
  }

  private hexEscape(): void {
    if (this.at() === "{") {
      const end = this.p.indexOf("}", this.i);
      if (end === -1) fail();
      const digits = this.p.slice(this.i + 1, end);
      if (!/^[0-9A-Fa-f]{1,8}$/.test(digits)) fail();
      const code = Number.parseInt(digits, 16);
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) fail();
      this.i = end + 1;
      return;
    }
    let n = 0;
    while (n < 2 && this.at() !== undefined && /[0-9A-Fa-f]/.test(this.at() as string)) {
      this.i++;
      n++;
    }
  }

  /** `\o{101}`: braces and at least one octal digit are required. */
  private octalBraces(): void {
    const m = /^\{([0-7]+)\}/.exec(this.p.slice(this.i));
    if (m === null || Number.parseInt(m[1] as string, 8) > 0x10ffff) fail();
    this.i += m[0].length;
  }

  private property(): void {
    if (this.at() === "{") {
      const end = this.p.indexOf("}", this.i);
      if (end === -1) fail();
      if (!propertyKnown(this.p.slice(this.i + 1, end))) fail();
      this.i = end + 1;
      return;
    }
    const letter = this.at();
    if (letter === undefined || !/[A-Za-z]/.test(letter) || !propertyKnown(letter)) fail();
    this.i++;
  }

  /** `\g1`, `\g{1}`, `\g{-1}`, `\g{name}`, `\g<1>`, `\g'name'`: references that must resolve by the end. */
  private groupReference(): void {
    const open = this.at();
    let body: string;
    if (open === "{" || open === "<" || open === "'") {
      const close = open === "{" ? "}" : open === "<" ? ">" : "'";
      const end = this.p.indexOf(close, this.i + 1);
      if (end === -1) fail();
      body = this.p.slice(this.i + 1, end);
      this.i = end + 1;
    } else {
      const m = /^[+-]?\d+/.exec(this.p.slice(this.i));
      if (m === null) fail();
      body = m[0];
      this.i += body.length;
    }
    this.reference(body);
  }

  private reference(body: string): void {
    if (/^[+-]?\d+$/.test(body)) {
      const relative = body.startsWith("+") || body.startsWith("-");
      this.numberedRefs.push({ n: Number(body), relative });
    } else if (body.length > 0) this.namedRefs.push(body);
    else fail();
  }

  private charClass(): void {
    this.seenContent = true;
    this.i++; // [
    if (this.at() === "^") this.i++;
    // PCRE refuses a whole pattern class like [:alpha:] (a POSIX name outside a class).
    const posixOutside = /^([:.=])[a-z^]*\1\]/.exec(this.p.slice(this.i));
    if (posixOutside !== null) fail();
    let first = true;
    let previousWasRangeEnd = false;
    for (;;) {
      if (this.i >= this.p.length) fail();
      const ch = this.p[this.i] as string;
      if (ch === "]" && !first) {
        this.i++;
        break;
      }
      const wasFirst: boolean = first;
      first = false;
      if (ch === "[" && /^[:.=]/.test(this.p.slice(this.i + 1, this.i + 2))) {
        const kind = this.p[this.i + 1] as string;
        const end = this.p.indexOf(`${kind}]`, this.i + 2);
        if (end !== -1 && /^[a-zA-Z^]*$/.test(this.p.slice(this.i + 2, end)) || (end !== -1 && kind !== ":")) {
          if (kind !== ":") fail(); // collating elements and equivalence classes
          const name = this.p.slice(this.i + 2, end);
          if (!POSIX_CLASSES.has(name.startsWith("^") ? name.slice(1) : name)) fail();
          this.i = end + 2;
          previousWasRangeEnd = false;
          continue;
        }
      }
      if (ch === "\\" && this.at(1) === "Q") {
        const quoteEnd = this.p.indexOf("\\E", this.i + 2);
        first = wasFirst && quoteEnd === this.i + 2; // an empty \Q\E leaves a following ] literal
        this.i = quoteEnd === -1 ? this.p.length : quoteEnd + 2;
        continue;
      }
      const start = this.classAtom();
      // A range `a-z`: `-` followed by something other than the closing bracket.
      if (this.at() === "-" && this.p.startsWith("\\Q\\E", this.i + 1)) {
        this.i++; // `a-\Q\E`: nothing to end the range, the hyphen is a member
        continue;
      }
      if (this.at() === "-" && this.at(1) !== "]" && this.at(1) !== undefined) {
        const savedI = this.i;
        this.i++;
        const nextIsPosix = this.at() === "[" && this.at(1) === ":";
        if (start.kind === "set" || nextIsPosix) {
          // `[\d-z]` and `[[:alpha:]-z]`: the hyphen is literal in PCRE 8.45 when the left side is a set.
          if (nextIsPosix) this.i = savedI + 1;
          if (start.kind === "set") {
            this.i = savedI + 1;
            continue;
          }
        } else {
          const end = this.classAtom();
          if (end.kind === "set") fail();
          if (end.code < start.code) fail();
        }
      }
      previousWasRangeEnd = !previousWasRangeEnd;
    }
    this.repeatable = true;
  }

  private classAtom(): { readonly kind: "char"; readonly code: number } | { readonly kind: "set" } {
    const ch = this.p[this.i] as string;
    if (ch !== "\\") {
      const code = this.p.codePointAt(this.i) as number;
      this.i += code > 0xffff ? 2 : 1;
      return { kind: "char", code };
    }
    const c = this.at(1);
    if (c === undefined) fail();
    this.i += 2;
    if (c === "Q" || c === "E") return { kind: "char", code: 0 };
    if (c === "x") {
      const before = this.i;
      this.hexEscape();
      const text = this.p.slice(before, this.i);
      const digits = text.startsWith("{") ? text.slice(1, -1) : text;
      return { kind: "char", code: digits === "" ? 0 : Number.parseInt(digits, 16) };
    }
    if (c === "c") {
      const target = this.at();
      if (target === undefined || target.charCodeAt(0) > 127 || target.charCodeAt(0) < 32) fail();
      this.i++;
      return { kind: "char", code: target.charCodeAt(0) & 0x1f };
    }
    if (c === "p" || c === "P") {
      this.property();
      return { kind: "set" };
    }
    if (c === "o") {
      const before = this.i;
      this.octalBraces();
      return { kind: "char", code: Number.parseInt(this.p.slice(before + 1, this.i - 1), 8) };
    }
    if (c === "N") fail(); // \N is not allowed in a class
    if (isDigit(c)) {
      let n = 0;
      let digits = c;
      while (n < 2 && this.at() !== undefined && /[0-7]/.test(this.at() as string)) {
        digits += this.p[this.i++] as string;
        n++;
      }
      return { kind: "char", code: Number.parseInt(digits, 8) || 0 };
    }
    if (CLASS_ESCAPES.has(c) && c !== "N" && c !== "R" && c !== "X") return { kind: "set" };
    if (BAD_LETTER_ESCAPES.has(c)) fail();
    const simple: Record<string, number> = { n: 10, r: 13, t: 9, f: 12, a: 7, e: 27, b: 8 };
    return { kind: "char", code: simple[c] ?? (c.codePointAt(0) as number) };
  }

  private openGroup(): void {
    this.seenContent ||= false;
    if (this.at(1) === "*") {
      const end = this.p.indexOf(")", this.i);
      if (end === -1) fail();
      const verb = this.p.slice(this.i + 2, end);
      const name = verb.split(":")[0] as string;
      if (VERBS.has(name) || (name === "" && verb.startsWith(":"))) {
        this.i = end + 1;
        this.repeatable = false;
        return;
      }
      if (!START_VERBS.test(verb) || this.seenContent) fail();
      this.i = end + 1;
      return;
    }
    if (this.at(1) !== "?") {
      this.i++;
      this.groups++;
      this.push();
      return;
    }
    this.i += 2;
    const c = this.at();
    if (c === undefined) fail();
    if (c === "#") {
      const end = this.p.indexOf(")", this.i);
      if (end === -1) fail();
      this.i = end + 1;
      return; // a comment is not an item: repeatable stays as it was
    }
    if (c === ":" || c === "|" || c === ">" || c === "=" || c === "!") {
      this.i++;
      this.push();
      return;
    }
    if (c === "<" && (this.at(1) === "=" || this.at(1) === "!")) {
      this.i += 2;
      this.push();
      return;
    }
    if (c === "<" || c === "'" || (c === "P" && this.at(1) === "<")) {
      if (c === "P") this.i++;
      const close = this.at() === "'" ? "'" : ">";
      const end = this.p.indexOf(close, this.i + 1);
      if (end === -1) fail();
      const name = this.p.slice(this.i + 1, end);
      if (name === "" || isDigit(name[0]) || name.length > MAX_NAME_LENGTH || !/^[A-Za-z0-9_]+$/.test(name)) fail();
      if (this.names.has(name) && !this.allowDuplicateNames) fail();
      this.names.add(name);
      this.groups++;
      this.i = end + 1;
      this.push();
      return;
    }
    if (c === "P" && (this.at(1) === "=" || this.at(1) === ">")) {
      const end = this.p.indexOf(")", this.i);
      if (end === -1) fail();
      this.namedRefs.push(this.p.slice(this.i + 2, end));
      this.i = end + 1;
      this.repeatable = true;
      return;
    }
    if (c === "R" || c === "&" || isDigit(c) || ((c === "+" || c === "-") && isDigit(this.at(1)))) {
      const end = this.p.indexOf(")", this.i);
      if (end === -1) fail();
      const body = this.p.slice(this.i, end);
      this.i = end + 1;
      if (body === "R" || body === "0") {
        if (!this.seenContent) fail(); // recursion with nothing before it "could loop indefinitely"
      } else this.reference(body.startsWith("&") ? body.slice(1) : body);
      this.repeatable = true;
      return;
    }
    if (c === "C") {
      const end = this.p.indexOf(")", this.i);
      if (end === -1 || !/^C\d*$/.test(this.p.slice(this.i, end))) fail();
      this.i = end + 1;
      return;
    }
    if (c === "(") {
      // Conditional: (?(1)..|..), (?(<n>)..), (?('n')..), (?(R)..), (?(DEFINE)..), (?(?=..)..)
      const end = this.p.indexOf(")", this.i);
      if (end === -1) fail();
      const cond = this.p.slice(this.i + 1, end);
      if (cond.startsWith("?")) {
        this.push();
        return; // an assertion condition: scanned as ordinary nested syntax
      }
      if (/^[+-]?\d+$/.test(cond)) this.reference(cond);
      else if (/^<.*>$|^'.*'$/.test(cond)) this.reference(cond.slice(1, -1));
      else if (cond !== "R" && cond !== "DEFINE" && !/^R\d+$|^R&/.test(cond)) this.reference(cond);
      this.i = end + 1;
      this.push();
      return;
    }
    // Option setting: (?imsxJUX-imsxJUX) or (?imsxJUX-imsxJUX:...)
    const m = /^([imsxJUX]*)(?:-([imsxJUX]*))?([:)])/.exec(this.p.slice(this.i));
    if (m === null) fail();
    const on = m[1] as string;
    const off = m[2] ?? "";
    this.i += m[0].length;
    if (on.includes("J")) this.allowDuplicateNames = true;
    const previous = this.extended;
    if (on.includes("x")) this.extended = true;
    if (off.includes("x")) this.extended = false;
    if (m[3] === ":") {
      this.stack.push({ extended: previous });
      this.repeatable = false;
    } else this.repeatable = false; // an option setting is not repeatable
  }

  private push(): void {
    this.stack.push({ extended: this.extended });
    this.repeatable = false;
    this.seenContent = true;
  }

  private closeGroup(): void {
    const frame = this.stack.pop();
    if (frame === undefined) fail();
    this.extended = frame.extended;
    this.i++;
    this.repeatable = true;
  }
}

/** `true` when Inkress's PCRE would not compile the pattern. */
export function pcreRejects(pattern: string): boolean {
  try {
    new Scanner(pattern).run();
    return false;
  } catch (error) {
    if (error instanceof PcreSyntaxError) return true;
    throw error;
  }
}
