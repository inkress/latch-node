/**
 * Api.Flags.SafeRegex: the `matches` operator on RE2 (re2js) instead of PCRE. Linear-time matching means no
 * backtracking match limit is needed; instead a work budget stands in for it (below). The differences from Inkress's
 * PCRE behaviour are in REGEX-PARITY.md.
 *
 * `validate` keeps every rule Inkress enforces (so a pattern Inkress refuses stays refused, with Inkress's message)
 * and adds two: the pattern must be in Latch's subset (`latch-subset.ts`) and compile in RE2 below a size cap, because that
 * is what runs it. Inkress's checks come first, so its message wins whenever Inkress refuses and the scan models the
 * construct; for the exotic constructs the scan does not model, when both refuse, Latch may give its out-of-subset message.
 */
import { RE2JS } from "re2js";
import { graphemeCountExceeds } from "./grapheme.ts";
import { utf8ByteLength } from "./json.ts";
import { analyzeDollars } from "./pcre-dollar.ts";
import { inLatchSubset } from "./latch-subset.ts";
import { pcreRejects } from "./pcre-syntax.ts";
import { translateToRe2 } from "./re2-translate.ts";
import { Limits } from "./types.ts";

export type RegexValidation = { readonly ok: true } | { readonly ok: false; readonly error: string };

export const RegexError = {
  NotAString: "regex must be a string",
  TooLong: `regex longer than ${Limits.regexLength} characters`,
  Unsafe: "regex uses a feature outside RE2 (backreference, lookaround or possessive)",
  DoesNotCompile: "regex does not compile",
  NotInSubset: "regex uses a feature Latch doesn't support",
  TooComplex: "regex too complex",
} as const;

/** Patterns whose compiled RE2 program is larger than this are refused on write; it bounds cold compile cost. */
export const MAX_PROGRAM_SIZE = 5_000;

/**
 * Run-time work budget: weighted program size times input length (UTF-16 units). Above it `matches` answers false, which is
 * the accepted "PCRE match limit" difference (PCRE also gives up, on its own count, and answers false). The weight counts
 * every instruction once and every epsilon instruction (alternation, empty-width assertion, no-op: what nullable repeats and
 * alternations compile to) three more times, because those are what slows the RE2JS simulation down. See REGEX-PARITY.md for
 * the measurements.
 */
export const WORK_BUDGET = 125_000;
const EPSILON_WEIGHT = 3;

interface ProgramInternals {
  readonly re2Input?: { readonly prog?: { readonly inst?: readonly { readonly op?: number }[] } };
}
/** RE2JS Inst opcodes that consume no input: ALT, ALT_MATCH, EMPTY_WIDTH, NOP. */
const EPSILON_OPS: ReadonlySet<number> = new Set([1, 2, 4, 7]);

/** Program size with epsilon instructions weighted; falls back to the plain size if RE2JS hides its program. */
function programWork(re2: RE2JS): number {
  const instructions = (re2 as unknown as ProgramInternals).re2Input?.prog?.inst;
  if (instructions === undefined) return re2.programSize() * (1 + EPSILON_WEIGHT);
  let epsilon = 0;
  for (const inst of instructions) if (inst.op !== undefined && EPSILON_OPS.has(inst.op)) epsilon++;
  return instructions.length + EPSILON_WEIGHT * epsilon;
}

/** The unsafe-pattern list from safe_regex.ex, verbatim. Run against the pattern text. */
const UNSAFE: readonly RegExp[] = [/\\[1-9]/, /\\k[<{']/, /\(\?[=!]/, /\(\?<[=!]/, /\(\?>/, /[*+?}]\+/];

/** PCRE reads the pattern as a C string, so a NUL character ends it (`"a\0b"` is the pattern `a`). */
function cut(pattern: string): string {
  const nul = pattern.indexOf("\u0000");
  return nul === -1 ? pattern : pattern.slice(0, nul);
}

/**
 * How a pattern is compiled. `search` is the pattern itself. The tail of a `$` split is matched against the final
 * newline only: `tail` when nothing precedes it (the subject was empty), `tailAfter` when the subject's last character
 * precedes it, so `^`, `\A` and `\b` in the tail see the right context.
 */
type Mode = "search" | "tail" | "tailAfter";

/** A `$`-split alternative: `head` must end at the subject (the input minus its final newline), `tailText` must match the newline. */
interface Split {
  readonly head: RE2JS;
  readonly headSource: string;
  readonly tailText: string;
}

/** A pattern as both engines see it, cached. */
interface Analysis {
  readonly pcreRejects: boolean;
  readonly inSubset: boolean;
  /** `null` when the pattern is outside the subset or RE2 cannot compile it. */
  readonly re2: RE2JS | null;
  /** The RE2 source `re2` was built from (`null` when it is `null`). */
  readonly re2Source: string | null;
  readonly programSize: number;
  readonly work: number;
  readonly splits: readonly Split[];
  /** `$` inside a group: searched again without the final newline (exact only when nothing follows the `$`). */
  readonly nestedDollarRetry: boolean;
}

export const CACHE_LIMIT = 500;

/** Analyses by `mode:pattern`, evicted least-recently-used above `limit`. The global store is bounded; a per-ruleset one is not. */
interface Store {
  readonly entries: Map<string, Analysis>;
  readonly limit: number;
}
const cache: Store = { entries: new Map<string, Analysis>(), limit: CACHE_LIMIT };

function compile(source: string): RE2JS | null {
  try {
    return RE2JS.compile(source);
  } catch {
    return null;
  }
}

/** The RE2 source for a pattern fragment in a mode, with an optional trailing `\z`. */
function wrap(source: string, mode: Mode, end: boolean): string {
  const core = `(?:${source})${end ? "\\z" : ""}`;
  return mode === "search" ? core : mode === "tail" ? `^${core}` : `^(?s:.)${core}`;
}

function analyze(pattern: string, mode: Mode, store: Store = cache): Analysis {
  const key = `${mode}:${pattern}`;
  const cached = store.entries.get(key);
  if (cached !== undefined) {
    if (store.limit !== Infinity) {
      store.entries.delete(key); // re-insert: least recently used goes first
      store.entries.set(key, cached);
    }
    return cached;
  }
  const rejected = pcreRejects(pattern);
  const inSubset = !rejected && inLatchSubset(pattern);
  const re2Source = !inSubset ? null : mode === "search" ? translateToRe2(pattern) : wrap(translateToRe2(pattern), mode, false);
  const re2 = re2Source === null ? null : compile(re2Source);
  const splits: Split[] = [];
  let nestedDollarRetry = false;
  if (re2 !== null && re2.programSize() <= MAX_PROGRAM_SIZE) {
    const dollars = analyzeDollars(pattern);
    nestedDollarRetry = dollars.nestedDollar;
    for (const split of dollars.splits) {
      const headSource = wrap(translateToRe2(split.head), mode, true);
      const head = compile(headSource);
      if (head === null) nestedDollarRetry = true;
      else splits.push({ head, headSource, tailText: split.tail });
    }
  }
  const analysis: Analysis = {
    pcreRejects: rejected,
    inSubset,
    re2,
    re2Source: re2 === null ? null : re2Source,
    programSize: re2?.programSize() ?? 0,
    work: re2 === null ? 0 : programWork(re2),
    splits,
    nestedDollarRetry,
  };
  store.entries.set(key, analysis);
  if (store.entries.size > store.limit) store.entries.delete(store.entries.keys().next().value as string); // evict the least recently used
  return analysis;
}

/** `validate/1`: length, Inkress's unsafe list, "compiles in PCRE" (as Inkress checks), then "compiles in RE2". */
export function validate(pattern: unknown): RegexValidation {
  if (typeof pattern !== "string") return { ok: false, error: RegexError.NotAString };
  if (graphemeCountExceeds(pattern, Limits.regexLength)) return { ok: false, error: RegexError.TooLong };
  if (UNSAFE.some((unsafe) => unsafe.test(pattern))) return { ok: false, error: RegexError.Unsafe };
  const analysis = analyze(cut(pattern), "search");
  if (analysis.pcreRejects) return { ok: false, error: RegexError.DoesNotCompile };
  if (!analysis.inSubset || analysis.re2 === null) return { ok: false, error: RegexError.NotInSubset };
  if (analysis.programSize > MAX_PROGRAM_SIZE) return { ok: false, error: RegexError.TooComplex };
  return { ok: true };
}

/** Searches `input` the way PCRE does, including `$` / `\Z` before one final newline. */
function search(analysis: Analysis, re2: RE2JS, input: string, store: Store): boolean {
  if (re2.matcher(input).find()) return true;
  if (!input.endsWith("\n")) return false;
  const subject = input.slice(0, -1);
  for (const split of analysis.splits) {
    if (!split.head.matcher(subject).find()) continue;
    // The tail starts where the subject ends; show it the subject's last character so `^` and `\b` see their context.
    const last = subject === "" ? "" : (Array.from(subject.slice(-2)).pop() as string);
    const tail = analyze(split.tailText, last === "" ? "tail" : "tailAfter", store);
    if (tail.re2 !== null && search(tail, tail.re2, `${last}\n`, store)) return true;
  }
  return analysis.nestedDollarRetry && re2.matcher(subject).find();
}

/** Input over 4,096 UTF-8 bytes never matches. */
function overInputLimit(input: string): boolean {
  return input.length * 3 > Limits.regexInputBytes && utf8ByteLength(input) > Limits.regexInputBytes;
}

/** The checks and search of `matches` once the pattern's analysis is in hand. */
function run(analysis: Analysis, store: Store, input: string): boolean {
  if (analysis.programSize > MAX_PROGRAM_SIZE) return false;
  const re2 = analysis.re2;
  if (re2 === null) return false;
  if (searchesCharged(analysis, input) * analysis.work * input.length > WORK_BUDGET) return false;
  return search(analysis, re2, input, store);
}

/**
 * How many searches of the input `matches` may run: the pattern itself, and, only when the input ends with a newline (so
 * PCRE's `$` can match before it), each `$`-split head and the second run for a `$` inside a group. Each is charged in full.
 */
function searchesCharged(analysis: Analysis, input: string): number {
  if (!input.endsWith("\n")) return 1;
  return 1 + analysis.splits.length + (analysis.nestedDollarRetry ? 1 : 0);
}

/**
 * `matches?/2`: an unanchored search. A non-string, input over 4,096 UTF-8 bytes, a pattern PCRE would refuse or RE2
 * cannot compile, and input too large for the pattern (work budget) are all `false`.
 */
export function matches(pattern: unknown, input: unknown): boolean {
  if (typeof pattern !== "string" || typeof input !== "string") return false;
  if (overInputLimit(input)) return false;
  return run(analyze(cut(pattern), "search"), cache, input);
}

/** Is the pattern in the compiled-pattern cache? (For tests of the eviction order.) */
export function isCached(pattern: unknown): boolean {
  return typeof pattern === "string" && cache.entries.has(`search:${cut(pattern)}`);
}

/** Number of cached analyses (never above `CACHE_LIMIT`). */
export function cacheSize(): number {
  return cache.entries.size;
}

/**
 * The work `matches` charges per input unit for this pattern (`null` if it cannot run): weighted program size, times the
 * searches it may run when the input ends with a newline if `endsWithNewline`. For tests.
 */
export function programWorkOf(pattern: string, endsWithNewline = false): number | null {
  const analysis = analyze(cut(pattern), "search");
  if (analysis.re2 === null) return null;
  return analysis.work * searchesCharged(analysis, endsWithNewline ? "\n" : "");
}

/**
 * A pattern's analysis as plain data: what `compilePattern` worked out, so a ruleset can be built once (in the origin)
 * and loaded in a Worker, which then only compiles the RE2 programs, on first use.
 */
export interface PatternData {
  /** RE2 source of the pattern, or `null` when it cannot run (outside the subset, or RE2 refuses it). */
  readonly source: string | null;
  readonly programSize: number;
  /** Weighted program work per input unit (what `matches` multiplies by the input length). */
  readonly work: number;
  readonly splits: readonly { readonly head: string; readonly tail: string }[];
  readonly nestedDollarRetry: boolean;
}

/**
 * A pattern analysed once into a private store (its `$`-split tails included), so running it never touches the global
 * LRU, however many distinct patterns a ruleset holds. The analysis (or, for a loaded pattern, the RE2 build) happens on
 * first use, not when the handle is made: a cold isolate pays only for the patterns an evaluation actually reaches.
 * `matches` is `SafeRegex.matches(pattern, input)` exactly.
 */
export interface CompiledPattern {
  /** Has the expensive step (analysis, or the RE2 build of a loaded pattern) already run? */
  readonly ready: boolean;
  /** How big that step is: the pattern's length before analysis, the program size after it (loaded: before the build). 0 when ready. */
  readonly buildSize: number;
  /** Work `matches` compares with `WORK_BUDGET` for an input of this length (what a budget should charge); 0 if the pattern cannot run. Needs no RE2 build for a loaded pattern. */
  workFor(inputLength: number, endsWithNewline: boolean): number;
  matches(input: unknown): boolean;
  /** The analysis as data (runs the analysis if it has not run). */
  data(): PatternData;
}

function workOf(found: Analysis, inputLength: number, endsWithNewline: boolean): number {
  if (found.re2Source === null || found.programSize > MAX_PROGRAM_SIZE) return 0;
  return found.work * (endsWithNewline ? 1 + found.splits.length + (found.nestedDollarRetry ? 1 : 0) : 1) * inputLength;
}

export function compilePattern(pattern: unknown): CompiledPattern {
  if (typeof pattern !== "string") {
    const none: PatternData = { source: null, programSize: 0, work: 0, splits: [], nestedDollarRetry: false };
    return { ready: true, buildSize: 0, workFor: () => 0, matches: () => false, data: () => none };
  }
  const store: Store = { entries: new Map<string, Analysis>(), limit: Infinity };
  let analysis: Analysis | null = null;
  const analysed = (): Analysis => (analysis ??= analyze(cut(pattern), "search", store));
  return {
    get ready() {
      return analysis !== null;
    },
    get buildSize() {
      return analysis === null ? pattern.length : 0;
    },
    workFor: (inputLength, endsWithNewline) => workOf(analysed(), inputLength, endsWithNewline),
    matches: (input) => typeof input === "string" && !overInputLimit(input) && run(analysed(), store, input),
    data() {
      const found = analysed();
      return {
        source: found.re2Source,
        programSize: found.programSize,
        work: found.work,
        splits: found.splits.map((split) => ({ head: split.headSource, tail: split.tailText })),
        nestedDollarRetry: found.nestedDollarRetry,
      };
    },
  };
}

/** A pattern from its `PatternData`: no analysis, and the RE2 programs are built on first match. */
export function loadPattern(data: PatternData): CompiledPattern {
  const store: Store = { entries: new Map<string, Analysis>(), limit: Infinity };
  let built = false;
  let main: RE2JS | null | undefined;
  const heads = data.splits.map(() => undefined as RE2JS | undefined);
  const analysis: Analysis = {
    pcreRejects: false,
    inSubset: data.source !== null,
    get re2() {
      if (data.source === null) return null;
      if (main === undefined) {
        main = RE2JS.compile(data.source);
        built = true;
      }
      return main;
    },
    re2Source: data.source,
    programSize: data.programSize,
    work: data.work,
    splits: data.splits.map((split, index) => ({
      get head() {
        return (heads[index] ??= RE2JS.compile(split.head));
      },
      headSource: split.head,
      tailText: split.tail,
    })),
    nestedDollarRetry: data.nestedDollarRetry,
  };
  return {
    get ready() {
      return built || data.source === null || data.programSize > MAX_PROGRAM_SIZE;
    },
    get buildSize() {
      return built || data.source === null || data.programSize > MAX_PROGRAM_SIZE ? 0 : data.programSize * (1 + data.splits.length);
    },
    workFor: (inputLength, endsWithNewline) => workOf(analysis, inputLength, endsWithNewline),
    matches: (input) => typeof input === "string" && !overInputLimit(input) && run(analysis, store, input),
    data: () => data,
  };
}
