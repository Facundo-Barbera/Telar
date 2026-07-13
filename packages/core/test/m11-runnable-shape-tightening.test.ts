// M11 (docs/m11-discuss-iteration.md, finding 7) — the TIGHTENED runnable-shape
// predicate. PURE unit test, no store/LLM/dispatch. Finding 7 replaces the OLD
// >=5-plain-words + English-stopword prose heuristic with a first-token ENTRYPOINT
// discipline: an all-plain-word segment of length >=2 is a runnable ONLY if its
// first token is a known program/runner. This file enumerates the ACCEPT/REJECT
// boundary EXHAUSTIVELY — especially the three run #3 false-positives the old
// heuristic let through, and the full MUST-ACCEPT set that must survive the tighten.
import { describe, expect, test } from "bun:test";
import { isRunnableShape } from "../src/runnable-shape";

describe("finding 7 — the three run #3 false-positives now REJECT", () => {
  // Ground truth (run #3, loom_mriuu8la_lrtwxx): the planner authored these as a
  // command `expected`; they passed the OLD shape gate (no English stopword), were
  // executed verbatim by the gate layer, and the no-overwrite moat protected them
  // from repair. Finding 7 makes them non-runnable so validateContract rejects them
  // and the sanctioned repair fires.
  const reject = [
    "exit code 0", // head "exit" + a non-numeric arg → prose, not "exit <status>"
    "process exit code 0; summary output reports 0 fail", // both segments prose
    "process exit code 0", // head "process" not a runner
    "summary output reports 0 fail", // head "summary" not a runner
    "process exit code 0; summary output reports 0 fail\nzero runtime deps present",
  ];
  for (const s of reject) {
    test(`rejects ${JSON.stringify(s)}`, () => {
      expect(isRunnableShape(s)).toBe(false);
    });
  }
});

describe("finding 7 — exit builtin arg discipline", () => {
  test("accepts a numeric status (exit 0 / exit 1 / exit 137)", () => {
    expect(isRunnableShape("exit 0")).toBe(true);
    expect(isRunnableShape("exit 1")).toBe(true);
    expect(isRunnableShape("exit 137")).toBe(true);
  });
  test("accepts bare exit (length-1 segment)", () => {
    expect(isRunnableShape("exit")).toBe(true);
  });
  test("rejects exit with a non-numeric arg (prose)", () => {
    expect(isRunnableShape("exit code 0")).toBe(false);
    expect(isRunnableShape("exit cleanly")).toBe(false);
    expect(isRunnableShape("exit with code zero")).toBe(false);
  });
});

describe("finding 7 — MUST ACCEPT: every real command form survives the tighten", () => {
  const accept = [
    // Allowlisted runner heads, bare subcommand/target args.
    "bun test",
    "bun run build",
    "bun run build test lint check",
    "make build test lint docs release",
    "npm run test",
    "pnpm test",
    "yarn build",
    "go test",
    "cargo build",
    "pytest tests",
    "git status",
    "diff a b",
    "echo ok",
    "echo all good",
    // Length-1 bare command names.
    "true",
    "false",
    ":",
    "bun",
    // Command-shaped tokens (escape hatch): flags, paths, dotted names, globs, $.
    "node cli.js --help",
    "python eval.py --min-acc 0.9",
    "pg_prove t/*.sql",
    "bun test --coverage --min 90",
    "bun test test/contract-parse.test.ts",
    "./scripts/run.sh",
    "NODE_ENV=production bun test",
    "node cli.js --nope; test $? -eq 2",
    // Multi-segment: each segment is independently a command.
    "a && b",
    "a; b",
    "bun run build && bun test",
    // Quoted `-e`/`-c` script bodies holding JS operators (Signal 1 strips quotes).
    'node -e "assert(x === y)"',
    'node -e "process.exit(a === b ? 0 : 1)"',
  ];
  for (const cmd of accept) {
    test(`accepts ${JSON.stringify(cmd)}`, () => {
      expect(isRunnableShape(cmd)).toBe(true);
    });
  }
});

describe("finding 7 — REJECT: prose whose head is not a runner", () => {
  const reject = [
    "all tests green", // head "all"
    "the suite passes", // head "the"
    "coverage stays above ninety", // head "coverage"
    "no runtime dependencies remain", // head "no"
    "tests pass and lint is clean", // head "tests"; also a stopword-y clause
    "process exits with code 0", // head "process" (the original loom_mriqnl72 shape)
  ];
  for (const s of reject) {
    test(`rejects ${JSON.stringify(s)}`, () => {
      expect(isRunnableShape(s)).toBe(false);
    });
  }
});

describe("finding 7 — Signal 1 (JS expression) unchanged", () => {
  test("rejects a top-level JS expression", () => {
    expect(isRunnableShape("parse('1.2.3') === {major: 1}")).toBe(false);
    expect(isRunnableShape("result !== undefined")).toBe(false);
    expect(isRunnableShape("items.map(x => x.id)")).toBe(false);
  });
});

describe("finding 7 — one prose segment poisons a mixed sequence", () => {
  test("a real command AND-ed with a prose fragment rejects (fails closed)", () => {
    // The command segment is fine, but "summary reports 0 fail" is prose → the
    // whole expected is not safe to sh -c verbatim, so reject.
    expect(isRunnableShape("bun test && summary reports 0 fail")).toBe(false);
  });
  test("two real command segments accept", () => {
    expect(isRunnableShape("bun test && bun run build")).toBe(true);
  });
});
