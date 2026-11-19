/**
 * PCRE's `$` (and `\Z`) match at the end of the subject and also before one final newline; RE2's `$` only at the end
 * (without `(?m)`). This scanner finds the places where that matters so `safe-regex.ts` can emulate it exactly:
 * every top-level alternative that contains a `$` / `\Z` (outside classes, `\Q..\E` and `(?m)` scope) is split at its
 * first such token into a head and a tail. `$` inside a group is only reported (`nestedDollar`).
 */

export interface DollarSplit {
  /** Pattern text before the first `$` of the alternative, with the top-level flag groups seen so far in front. */
  readonly head: string;
  /** Pattern text after it, with the same flags in front. Matched against the single final newline. */
  readonly tail: string;
}

export interface DollarAnalysis {
  readonly splits: readonly DollarSplit[];
  /** A `$` / `\Z` inside a group: not split, emulated only for the "nothing follows it" case. */
  readonly nestedDollar: boolean;
}

const FLAG_GROUP = /^\(\?([a-zA-Z]*)(?:-([a-zA-Z]*))?([:)])/;

/** Index just after the bracket class that opens at `start` (a `[`), understanding `[:alpha:]`, escapes and `\Q..\E`. */
export function skipClass(pattern: string, start: number): number {
  let i = start + 1;
  if (pattern[i] === "^") i++;
  let first = true;
  while (i < pattern.length) {
    const ch = pattern[i] as string;
    if (ch === "]" && !first) return i + 1;
    const wasFirst: boolean = first;
    first = false;
    if (ch === "\\") {
      if (pattern[i + 1] === "Q") {
        const end = pattern.indexOf("\\E", i + 2);
        if (end === -1) return pattern.length;
        first = wasFirst && end === i + 2; // an empty \Q\E does not make the next ] a member
        i = end + 2;
        continue;
      }
      i += 2;
    } else if (ch === "[" && /^[:.=]/.test(pattern.slice(i + 1, i + 2))) {
      const kind = pattern[i + 1] as string;
      const end = pattern.indexOf(`${kind}]`, i + 2);
      i = end === -1 ? i + 1 : end + 2;
    } else i++;
  }
  return pattern.length;
}

export function analyzeDollars(pattern: string): DollarAnalysis {
  const splits: DollarSplit[] = [];
  let nestedDollar = false;
  let multiline = false;
  const saved: boolean[] = [];
  let flagsSoFar = ""; // top-level flag groups, in order
  let branchStart = 0;
  let firstDollar = -1;
  let firstDollarLength = 0;
  let flagsAtDollar = "";
  let flagsBeforeBranch = ""; // top-level flag groups of earlier alternatives, which still apply

  const closeBranch = (end: number): void => {
    if (firstDollar === -1) return;
    splits.push({
      head: flagsBeforeBranch + pattern.slice(branchStart, firstDollar),
      tail: flagsAtDollar + pattern.slice(firstDollar + firstDollarLength, end),
    });
  };

  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] as string;
    if (ch === "\\") {
      const next = pattern[i + 1];
      if (next === "Q") {
        const end = pattern.indexOf("\\E", i + 2);
        i = end === -1 ? pattern.length : end + 2;
      } else if (next === "Z") {
        if (saved.length === 0) {
          if (firstDollar === -1) {
            firstDollar = i;
            firstDollarLength = 2;
            flagsAtDollar = flagsSoFar;
          }
        } else nestedDollar = true;
        i += 2;
      } else i += 2;
    } else if (ch === "[") {
      i = skipClass(pattern, i);
    } else if (ch === "(") {
      const flag = FLAG_GROUP.exec(pattern.slice(i));
      if (pattern.startsWith("(?#", i)) {
        const end = pattern.indexOf(")", i);
        i = end === -1 ? pattern.length : end + 1;
      } else if (flag !== null) {
        const on = flag[1] as string;
        const off = flag[2] ?? "";
        const scoped = flag[3] === ":";
        if (scoped) saved.push(multiline);
        else if (saved.length === 0) flagsSoFar += flag[0];
        if (on.includes("m")) multiline = true;
        if (off.includes("m")) multiline = false;
        i += flag[0].length;
      } else {
        saved.push(multiline);
        i += 1;
      }
    } else if (ch === ")") {
      const previous = saved.pop();
      if (previous !== undefined) multiline = previous;
      i++;
    } else if (ch === "|" && saved.length === 0) {
      closeBranch(i);
      branchStart = i + 1;
      flagsBeforeBranch = flagsSoFar;
      firstDollar = -1;
      i++;
    } else if (ch === "$" && !multiline) {
      if (saved.length === 0) {
        if (firstDollar === -1) {
          firstDollar = i;
          firstDollarLength = 1;
          flagsAtDollar = flagsSoFar;
        }
      } else nestedDollar = true;
      i++;
    } else i++;
  }
  closeBranch(pattern.length);
  return { splits, nestedDollar };
}
