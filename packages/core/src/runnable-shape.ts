// M11 (docs/m11-discuss-iteration.md, findings 2 + 7). PURE, deterministic, no I/O.
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
// FINDING 7 (run #3, loom_mriuu8la_lrtwxx) sharpened the prose signal: the OLD
// >=5-plain-words + English-stopword heuristic let THREE new false-positives
// through — "exit code 0", "process exit code 0; summary output reports 0 fail",
// "…; summary output reports 0 fail" — because they lack a stopword. Those
// prose-expecteds passed the shape gate, so validateContract accepted them at
// author time AND the sanctioned repair refused to replace them (the no-overwrite
// moat protects a "runnable" authored expected). False-positives were self-sealing.
// Finding 7 REPLACES the word-count/stopword heuristic with a first-token
// ENTRYPOINT discipline: an all-plain-word segment of length >=2 is a runnable
// only when its FIRST token is a known program/runner (the allowlist below).
// Everything else all-plain-and-multiword is prose. This rejects the three live
// false-positives while accepting every real command form (a command's head is a
// program; a command-shaped token anywhere still clears the whole segment).
//
// isRunnableShape distinguishes an executable shell command from prose / a JS
// expression. It is a SHAPE gate, NOT a semantic one — it does not (and cannot)
// prove a command actually settles its criterion (isTrivialPass in
// weave-contracts.ts guards the always-green degenerate separately). The design
// bias stays CONSERVATIVE-toward-ACCEPT for anything COMMAND-SHAPED (a flag, a
// path, `$var`, a quote, a dotted name → the escape hatch keeps `node cli.js
// --help`, `python eval.py --min-acc 0.9`, `pg_prove t/*.sql`, `NODE_ENV=x bun
// test`). The tightening applies only to the residual all-plain-word case, where
// a first-token allowlist is the right floor: a real multi-word command opens
// with an actual program name, an English clause opens with anything else.
//
// Signals (deterministic, cited):
//  1. JS-expression: a top-level `===`, `!==`, or `=>` never appears in a shell
//     command (shell equality is `-eq` / `[ = ]`, never `===`; `=>` is an arrow
//     fn). BUT such an operator legitimately appears INSIDE a quoted `-e`/`-c`
//     SCRIPT arg (`node -e "assert(x === y)"`, `python -c "..."`), which IS a
//     runnable. So we test for the operator only in the string with balanced
//     quoted spans REMOVED — a top-level operator (`parse('1.2.3') === {...}`)
//     rejects; one buried in a quoted script body does not.
//  2. Entrypoint discipline (finding 7): split on shell separators (`&&`, `||`,
//     `;`, `|`, newline). For each segment —
//       - if ANY token is command-shaped (isPlainWord false — a flag, path, `$`,
//         glob, quote, paren/brace/bracket, dotted/underscored name, operator),
//         the whole segment is a command (escape hatch, unchanged intent).
//       - else every token is a plain word / bare integer: a length-1 segment is
//         a bare command name (`true`, `:`, `a && b`) → accept; a length>=2
//         segment is a runnable ONLY if its FIRST token (lowercased) is an
//         ENTRYPOINT (a known program/runner) — otherwise it is prose and the
//         whole expected REJECTS.
//     Special arg-discipline for the no-op builtins that mean something only with
//     trivial args: `exit` accepts a length>=2 segment ONLY when every arg is a
//     bare integer (so "exit 0"/"exit 1" pass, "exit code 0" — a prose fragment
//     the run #3 planner authored — REJECTS). A real runner (bun/make/node/…)
//     accepts any bare subcommand/target list ("make build test lint docs
//     release", "bun run build test lint check").
//
// Boundary (honest): a false-ACCEPT merely defers to the runtime gate (`foo:
// command not found`), never a fake green; a false-REJECT would block a real
// command at author time and license the escalation repair to overwrite a
// genuinely-runnable authored yardstick. The tightening is deliberately biased so
// the residual ambiguous case (all-plain multi-word, non-runner head) resolves to
// REJECT — that residual is, by construction, prose or an unknown non-program
// head, and both fail closed at execution anyway.

// ENTRYPOINT allowlist — the first token of an all-plain-word command. Covers
// every runner the suite uses plus common programs/shells/tools. A head NOT in
// this set, in an all-plain multi-word segment, is treated as the opening word of
// an English clause (prose), not a program. (A command-shaped token anywhere in
// the segment bypasses this check entirely — see the escape hatch above; so a
// program invoked with a flag/path/dotted name never needs to be listed here.)
// Deliberately broad on real programs, strict on the residual: adding a common
// runner errs toward ACCEPT (safe); the risk is only a prose clause whose FIRST
// word happens to be a program name, which is vanishingly rare and still fails
// closed at run.
const ENTRYPOINTS = new Set([
  "bun", "bunx", "node", "deno", "npm", "npx", "pnpm", "yarn",
  "sh", "bash", "zsh",
  "git", "grep", "rg", "diff", "curl", "wget", "test", "cat", "ls",
  "make", "cargo", "go", "python", "python3", "pip", "pytest",
  "jq", "awk", "sed", "tsc", "eslint", "prettier", "pg_prove", "psql", "docker",
  "echo", "true", "false", ":", "exit",
]);

// A "plain" token = a purely-alphabetic word or a bare non-negative integer:
// something an English sentence is built from and a shell command almost never
// is in isolation. Anything containing a flag dash, path slash/dot, `$`, glob,
// quote, paren/brace/bracket, underscore, or operator char is "command-shaped"
// and clears the prose suspicion for its whole segment.
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

  // Signal 2 — the entrypoint discipline (finding 7). Each shell segment must be a
  // command: either it carries a command-shaped token (escape hatch), or it is a
  // bare command name (length 1), or its all-plain multi-word head is a known
  // runner. A single prose segment rejects the whole expected.
  const segments = s
    .split(/&&|\|\||;|\||\n/)
    .map((seg) => seg.trim())
    .filter(Boolean);
  for (const seg of segments) {
    const tokens = seg.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    if (tokens.some((t) => !isPlainWord(t))) continue; // command-shaped token clears the segment
    if (tokens.length === 1) continue; // a bare command name

    const head = tokens[0].toLowerCase();
    if (head === "exit") {
      // A no-op builtin that is a real command only with a numeric status arg.
      // "exit 0"/"exit 1" run; "exit code 0" is a prose fragment (the run #3 bug).
      if (tokens.slice(1).every((t) => /^[0-9]+$/.test(t))) continue;
      return false;
    }
    if (ENTRYPOINTS.has(head)) continue; // a known runner + bare subcommand/target args
    return false; // all-plain multi-word with a non-runner head → prose
  }

  return true;
}
