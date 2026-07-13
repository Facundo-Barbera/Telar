// M11 (docs/m11-discuss-iteration.md, finding 2) — the runnable-shape predicate.
// PURE unit test, no store/LLM/dispatch. Pins the conservative accept/reject
// boundary: every real command form the suite uses MUST be accepted, and the two
// unambiguous non-command shapes the live evidence produced (prose sentences, bare
// JS expressions) MUST be rejected. Ambiguous → accept (never a false reject of a
// real command).
import { describe, expect, test } from "bun:test";
import { isRunnableShape } from "../src/runnable-shape";

describe("isRunnableShape — MUST ACCEPT every real command form in the suite", () => {
  const accept = [
    "bun test",
    "bun run build",
    "bun build",
    "echo ok",
    "echo a",
    "echo all good",
    "true",
    "exit 1",
    "exit 0",
    "node cli.js --help",
    "python eval.py --min-acc 0.9",
    "diff a b",
    "diff x y",
    "a && b",
    "a; b",
    "node cli.js --nope; test $? -eq 2",
    "bun test --coverage --min 90",
    "pg_prove t/*.sql",
    "bun test test/contract-parse.test.ts",
    "./scripts/run.sh",
    ":",
    // Adaptive-verification review finding 1 — real commands the OLD predicate
    // false-rejected. A `-e`/`-c` script arg may hold `===`/`=>` (Signal 1 now
    // strips quoted spans first); a multi-target runner is >=5 bare words with no
    // English function word (Signal 2 now requires a stopword).
    'node -e "assert(x === y)"',
    'node -e "process.exit(a === b ? 0 : 1)"',
    "make build test lint docs release",
    "bun run build test lint check",
  ];
  for (const cmd of accept) {
    test(`accepts ${JSON.stringify(cmd)}`, () => {
      expect(isRunnableShape(cmd)).toBe(true);
    });
  }
});

describe("isRunnableShape — MUST REJECT the live-bug non-command shapes", () => {
  const reject = [
    // The loom_mriqnl72 live bug: prose that reached sh -c verbatim.
    "process exits with code 0; test runner summary reports 0 failing tests",
    "process exits with code 0; all tests green",
    "the process exits with code zero and prints a summary",
    // The loom_mrirhfm4 live bug: a bare JS expression as a proofHint run.
    "parse('1.2.3') === {major: 1, minor: 2, patch: 3}",
    "result !== undefined",
    "items.map(x => x.id)",
    // Empty / whitespace is not a runnable.
    "",
    "   ",
  ];
  for (const prose of reject) {
    test(`rejects ${JSON.stringify(prose)}`, () => {
      expect(isRunnableShape(prose)).toBe(false);
    });
  }
});

describe("isRunnableShape — boundary honesty (documented conservatism)", () => {
  // M11 finding 7 CHANGE (called out loudly per lane-A spec): the OLD >=5-plain-
  // words + English-stopword heuristic accepted a SHORT prose fragment like
  // "all tests green" (3 words, below the old floor). Finding 7 REPLACES that with
  // a first-token ENTRYPOINT discipline, so an all-plain multi-word fragment whose
  // head is not a known runner is now REJECTED as prose — "all" is not a program.
  // This is the intended tightening (a stronger fail-closed floor), not a
  // regression: the old accept merely deferred to a fail-closed run; the new reject
  // routes the author-time validateContract to reject / the escalation repair to
  // fire. The exhaustive new accept/reject boundary lives in
  // m11-runnable-shape-tightening.test.ts.
  test("a SHORT all-plain prose fragment (non-runner head) is now REJECTED (finding 7)", () => {
    expect(isRunnableShape("all tests green")).toBe(false);
  });

  test("a capitalized sentence is still caught (case-insensitive head lookup)", () => {
    expect(isRunnableShape("Process exits cleanly and reports zero failures")).toBe(false);
  });
});
