/**
 * RANKING A LIST AGAINST WHAT SOMEBODY HAS TYPED SO FAR.
 *
 * Ported from t3 code's `packages/shared/src/searchRanking.ts`, near enough
 * verbatim: the tiers, the penalties and the insertion sort are theirs. It is
 * worth copying rather than reinventing because the tiers encode a judgement
 * that is easy to get subtly wrong — an EXACT match must beat a PREFIX match
 * must beat a WORD-BOUNDARY match must beat a substring must beat a fuzzy
 * subsequence, and each tier is separated by a wide enough base that a long
 * prefix hit can never outrank a short exact one.
 *
 * LOW SCORES WIN. Every base is a floor and every penalty adds, so "how bad is
 * this match" is the number, and 0 is perfect. It reads backwards the first
 * time and then never again.
 *
 * THE CALLER NORMALISES. `scoreQueryMatch` compares strings as given, so both
 * sides must already be trimmed and lowercased — `normalizeSearchQuery` is the
 * one place that happens, and doing it per candidate inside the scorer would
 * lowercase the same haystack once per keystroke per row.
 */

export type RankedSearchResult<T> = {
  item: T;
  score: number;
  /** Breaks a tie deterministically. Two rows that score the same must not
   *  reorder between keystrokes — a list that shuffles under the cursor is how
   *  you pick the wrong file. */
  tieBreaker: string;
};

export function normalizeSearchQuery(input: string, options?: { trimLeadingPattern?: RegExp }): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  return options?.trimLeadingPattern ? trimmed.replace(options.trimLeadingPattern, "").toLowerCase() : trimmed.toLowerCase();
}

/**
 * The fuzzy tier: are the query's characters all present, in order?
 *
 * The penalties are what stop "abc" matching a 300-line path as well as it
 * matches `a/b/c.ts`: how late the run starts, how scattered it is, and how
 * much of the candidate is left over.
 */
export function scoreSubsequenceMatch(value: string, query: string): number | null {
  if (!query) return 0;

  let queryIndex = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -1;
  let gapPenalty = 0;

  for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) continue;

    if (firstMatchIndex === -1) firstMatchIndex = valueIndex;
    if (previousMatchIndex !== -1) gapPenalty += valueIndex - previousMatchIndex - 1;

    previousMatchIndex = valueIndex;
    queryIndex += 1;
    if (queryIndex === query.length) {
      const spanPenalty = valueIndex - firstMatchIndex + 1 - query.length;
      const lengthPenalty = Math.min(64, value.length - query.length);
      return firstMatchIndex * 2 + gapPenalty * 3 + spanPenalty + lengthPenalty;
    }
  }

  return null;
}

/** Capped, so a 4,000-character candidate is not ranked purely by its length. */
function lengthPenalty(value: string, query: string): number {
  return Math.min(64, Math.max(0, value.length - query.length));
}

function findBoundaryMatchIndex(value: string, query: string, boundaryMarkers: readonly string[]): number | null {
  let bestIndex: number | null = null;
  for (const marker of boundaryMarkers) {
    const index = value.indexOf(`${marker}${query}`);
    if (index === -1) continue;
    const matchIndex = index + marker.length;
    if (bestIndex === null || matchIndex < bestIndex) bestIndex = matchIndex;
  }
  return bestIndex;
}

/**
 * How badly `value` matches `query`, or nothing when it does not match at all.
 *
 * A tier the caller does not supply a base for is SKIPPED, which is how the
 * same function serves both "match a filename generously" (fuzzy on) and
 * "match a command name strictly" (fuzzy off).
 */
export function scoreQueryMatch(input: {
  value: string;
  query: string;
  exactBase: number;
  prefixBase?: number;
  boundaryBase?: number;
  includesBase?: number;
  fuzzyBase?: number;
  boundaryMarkers?: readonly string[];
}): number | null {
  const { value, query } = input;
  if (!value || !query) return null;
  if (value === query) return input.exactBase;
  if (input.prefixBase !== undefined && value.startsWith(query)) return input.prefixBase + lengthPenalty(value, query);

  if (input.boundaryBase !== undefined) {
    const boundaryIndex = findBoundaryMatchIndex(value, query, input.boundaryMarkers ?? [" ", "-", "_", "/"]);
    if (boundaryIndex !== null) return input.boundaryBase + boundaryIndex * 2 + lengthPenalty(value, query);
  }

  if (input.includesBase !== undefined) {
    const includesIndex = value.indexOf(query);
    if (includesIndex !== -1) return input.includesBase + includesIndex * 2 + lengthPenalty(value, query);
  }

  if (input.fuzzyBase !== undefined) {
    const fuzzyScore = scoreSubsequenceMatch(value, query);
    if (fuzzyScore !== null) return input.fuzzyBase + fuzzyScore;
  }

  return null;
}

export function compareRankedSearchResults<T>(left: RankedSearchResult<T>, right: RankedSearchResult<T>): number {
  const scoreDelta = left.score - right.score;
  if (scoreDelta !== 0) return scoreDelta;
  return left.tieBreaker.localeCompare(right.tieBreaker);
}

function findInsertionIndex<T>(rankedEntries: RankedSearchResult<T>[], candidate: RankedSearchResult<T>): number {
  let low = 0;
  let high = rankedEntries.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const current = rankedEntries[middle];
    if (!current) break;
    if (compareRankedSearchResults(candidate, current) < 0) high = middle;
    else low = middle + 1;
  }
  return low;
}

/**
 * Keep the best `limit` results without sorting the whole corpus.
 *
 * A repository listing is tens of thousands of paths and this runs on every
 * keystroke; sorting all of them to show ten is the version that makes the menu
 * stutter. Insertion into a bounded array is O(limit) per candidate and the
 * array is already in display order when the scan ends.
 */
export function insertRankedSearchResult<T>(rankedEntries: RankedSearchResult<T>[], candidate: RankedSearchResult<T>, limit: number): void {
  if (limit <= 0) return;
  const insertionIndex = findInsertionIndex(rankedEntries, candidate);
  if (rankedEntries.length < limit) {
    rankedEntries.splice(insertionIndex, 0, candidate);
    return;
  }
  if (insertionIndex >= limit) return;
  rankedEntries.splice(insertionIndex, 0, candidate);
  rankedEntries.pop();
}
