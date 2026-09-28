export type DictationContext = {
  sessionTitles: readonly string[];
  projectNames: readonly string[];
  branches: readonly string[];
};

// Deepgram's keyterm budget is 500 tokens, and a subword token never covers fewer than one
// byte: a list of at most this many UTF-8 bytes cannot be refused, whatever script it is in.
export const DEEPGRAM_KEYTERM_PROVABLE_BYTES = 500;

// Measured against the live endpoint (1.70–2.83 bytes per token), not proved; `fit.ts` confirms it.
export const DEEPGRAM_KEYTERM_BYTE_BUDGET = 700;

const encoder = new TextEncoder();

export function keytermBytes(terms: readonly string[]): number {
  let total = 0;
  for (const term of terms) total += encoder.encode(term).length;
  return total;
}

// A sentence-long title is the wrong kind of thing for a keyterm, whatever the budget.
const MAX_TERM_CHARACTERS = 80;

export const TELAR_KEYTERMS: readonly string[] = ["Telar", "Agent", "worktree", "nightly", "PR", "cockpit", "rail"];

// Order is priority and the budget cuts from the tail, so the result is always a prefix:
// the person's vocabulary, the app's words, session titles, project names, then branches.
export function deepgramKeyterms(input: { vocabulary: readonly string[]; context: DictationContext; budgetBytes?: number }): string[] {
  const budget = input.budgetBytes ?? DEEPGRAM_KEYTERM_BYTE_BUDGET;
  const kept: string[] = [];
  const seen = new Set<string>();
  let spent = 0;

  for (const candidate of [
    ...input.vocabulary,
    ...TELAR_KEYTERMS,
    ...input.context.sessionTitles,
    ...input.context.projectNames,
    ...input.context.branches,
  ]) {
    const term = candidate.replace(/\s+/g, " ").trim();
    if (!term || term.length > MAX_TERM_CHARACTERS) continue;
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    const cost = keytermBytes([term]);
    if (spent + cost > budget) break;
    seen.add(key);
    kept.push(term);
    spent += cost;
  }
  return kept;
}
