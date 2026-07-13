// M11 (docs/m11-discuss-iteration.md, finding 2). PURE, deterministic, no I/O.
//
// The SHAPE gate that keeps a non-runnable `expected` out of `sh -c`. The live
// bug (loom_mriqnl72): an authored `command` assertion carried PROSE in its
// `expected` — "process exits with code 0; test runner summary reports 0 failing
// tests…" — and runContractGates ran it verbatim ("process: command not found",
// "test: too many arguments"), burning three repair attempts on a gate no builder
// can ever fix (it is contract state, not project code). A sibling bug: the
// planner authored a bare JS EXPRESSION (`parse('1.2.3') === {...}`) as a
// ProofHint.run. Neither is an executable shell command.
//
// isRunnableShape distinguishes an executable shell command from prose / a JS
// expression. It is a SHAPE gate, NOT a semantic one — it does not (and cannot)
// prove a command actually settles its criterion (isTrivialPass in
// weave-contracts.ts guards the always-green degenerate separately). The design
// bias is CONSERVATIVE toward ACCEPT: worst case for anything ambiguous is
// "runnable" (today's behavior), so a real command a heuristic can't classify is
// never wrongly rejected. It aims to REJECT only the two unambiguous non-command
// shapes the live evidence produced (a top-level JS expression, an English
// sentence) — and both signals below carry an explicit escape hatch so a real
// command that merely LOOKS operator-ish or word-heavy still passes.
//
// Signals (deterministic, cited):
//  1. JS-expression: a top-level `===`, `!==`, or `=>` never appears in a shell
//     command (shell equality is `-eq` / `[ = ]`, never `===`; `=>` is an arrow
//     fn). BUT such an operator legitimately appears INSIDE a quoted `-e`/`-c`
//     SCRIPT arg (`node -e "assert(x === y)"`, `python -c "..."`), which IS a
//     runnable. So we test for the operator only in the string with balanced
//     quoted spans REMOVED — a top-level operator (`parse('1.2.3') === {...}`)
//     rejects; one buried in a quoted script body does not. (Adaptive-verification
//     review finding 1: the old unconditional `===` test false-rejected every
//     `node -e`/`python -c` script that compares with `===`.)
//  2. Prose: split on shell separators (`&&`, `||`, `;`, `|`, newline); a segment
//     is a sentence only when it is a run of >= PROSE_WORD_FLOOR plain words
//     (purely alphabetic, or a bare integer) with ZERO command-shaped token (no
//     flag, path, `$var`, glob, quote, paren/brace/bracket, dotted name, operator)
//     AND it contains an English FUNCTION WORD (article/preposition/conjunction/
//     copula — the STOPWORDS set below). The function-word requirement is what
//     separates an English clause ("process exits WITH code 0") from a multi-
//     target command whose args are also bare words ("make build test lint docs
//     release", "bun run build test lint check") — a command's target list has NO
//     function word. (Adaptive-verification review finding 1: the old bare
//     >=5-plain-words floor false-rejected these real multi-target commands.)
//     Real commands otherwise hit a command-shaped token fast (`--help`,
//     `cli.js`, `$?`, `t/*.sql`) or are short.
//
// Boundary (honest): a SHORT prose fragment (< 5 plain words, e.g. "all tests
// green"), OR a wordy fragment with no function word, is accepted — but such a
// fragment still fails closed at execution (`all: command not found`) rather than
// silently passing, and the author-time validateContract + the escalation repair
// both key on this same predicate, so the worst case is "no worse than today,"
// never "a fake green." The conservatism is deliberately asymmetric: a
// false-ACCEPT merely defers to the runtime gate; a false-REJECT (the bug this
// revision fixes) would block a real command at author time and, worse, license
// the escalation repair to overwrite a genuinely-runnable authored yardstick.

const PROSE_WORD_FLOOR = 5;

// English FUNCTION words — articles, prepositions, conjunctions, copulas/
// auxiliaries, demonstratives. These build an English clause but essentially
// never appear as a bare standalone argument in a shell command's target list.
// A segment needs one of these (plus the plain-word floor) to be judged prose;
// this is the gate that lets a wordy multi-target command through. Deliberately
// moderate: a narrower set errs toward ACCEPT (the safe direction), a wider set
// risks false-rejecting a command whose arg happens to be one of these words.
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "nor", "with", "without", "of", "to",
  "in", "into", "on", "onto", "at", "by", "for", "from", "as", "is", "are",
  "was", "were", "be", "been", "being", "am", "it", "its", "that", "this",
  "these", "those", "then", "than", "when", "while", "if", "so", "such",
]);

// A "plain" token = a purely-alphabetic word or a bare non-negative integer:
// something an English sentence is built from and a shell command almost never
// is in isolation. Anything containing a flag dash, path slash/dot, `$`, glob,
// quote, paren/brace/bracket, or operator char is "command-shaped" and clears the
// prose suspicion for its whole segment.
function isPlainWord(token: string): boolean {
  return /^[A-Za-z]+$/.test(token) || /^[0-9]+$/.test(token);
}

// Remove balanced double- and single-quoted spans so an operator or prose living
// INSIDE a quoted script arg (`-e "..."`, `-c '...'`) is not mistaken for a top-
// level JS expression. Unbalanced quotes leave their content in place (we only
// strip what we can pair) — conservative, since a stray quote is more command-
// than expression-shaped anyway.
function stripQuoted(s: string): string {
  return s.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
}

export function isRunnableShape(expected: string): boolean {
  const s = expected.trim();
  if (!s) return false; // empty is not a runnable (validateContract rejects it separately)

  // Signal 1 — a top-level JS expression, never a shell command. Operators inside
  // a quoted script body are stripped first so real `-e`/`-c` scripts pass.
  if (/===|!==|=>/.test(stripQuoted(s))) return false;

  // Signal 2 — a prose sentence in any shell segment (plain-word floor + an
  // English function word; a function-word-less target list is a command).
  const segments = s
    .split(/&&|\|\||;|\||\n/)
    .map((seg) => seg.trim())
    .filter(Boolean);
  for (const seg of segments) {
    const tokens = seg.split(/\s+/).filter(Boolean);
    const hasCommandShapedToken = tokens.some((t) => !isPlainWord(t));
    if (hasCommandShapedToken) continue; // a command-shaped token clears the whole segment
    const hasStopword = tokens.some((t) => STOPWORDS.has(t.toLowerCase()));
    if (tokens.length >= PROSE_WORD_FLOOR && hasStopword) return false;
  }

  return true;
}
