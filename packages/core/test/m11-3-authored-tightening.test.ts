// M11.1 deliverable (b) — TIGHTENING-ONLY derivation over an AUTHORED contract
// (docs/adaptive-verification.md §3.1). Proves, hermetically (pure function, no
// LLM, no dispatch, no filesystem beyond a pinned TELAR_HOME sandbox):
//   - flag-off (or no manifest) is a STRICT no-op: the input contract is returned
//     unchanged with an empty tightenings list (byte-identical bundle path)
//   - flag-on, an AGENT-JUDGED assertion (live-critic / golden-diff) whose id or
//     description exactly carries a charter proofHint is CONVERTED to a runnable
//     {type:"command", expected: hint.run} — the tightening synthesizeContract's
//     authored-contract choke point never reached before
//   - flag-on, a DETERMINISTIC assertion (command/gate/db) is NEVER edited — it
//     already carries an authored runnable and editing that expected is "editing
//     the yardstick" (§M.2); a matching hint is a no-op (adaptive-verification
//     review finding 1: a stricter human `bun test --coverage --min 90` must NOT be
//     swapped for a charter hint's weaker `bun test`)
//   - a trivially-passing hint (`run:"true"` / `"exit 0"`) is INERT — it never
//     converts a live-critic into an always-green command (review finding 2)
//   - a hint-LESS assertion keeps today's routing untouched (never demoted)
//   - re-running over the already-tightened output produces ZERO tightenings and
//     an unchanged contract (idempotency — what makes the dispatcher rewrite/event
//     safe on re-dispatch)
//   - a tightening that would yield an INVALID contract is DISCARDED and the
//     original assertion kept (fail-safe — an invalid contract is never emitted)
//   - the reverse (deterministic → live-critic) has NO path; subjective:true never
//     rides a converted command; the result validates
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Charter, validateContract, type ContractAssertion, type VerificationContract } from "../src/schemas";
import type { Loom } from "../src/looms";

// tightenAuthoredContract is pure w.r.t. the store, but pin TELAR_HOME anyway so
// the import graph (executor.ts → looms/store) can never touch a real ~/.telar.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m11-3-"));
process.env.TELAR_HOME = home;

const { tightenAuthoredContract } = await import("../src/weave-contracts");

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function fakeLoom(overrides: Partial<Loom> = {}): Loom {
  return {
    id: "fake_m11_3",
    project: "p",
    kind: "custom",
    title: "Ship it",
    prompt: "Build it end-to-end.",
    account: "personal",
    state: "queued",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    attempts: [],
    error: null,
    ...overrides,
  };
}

function charter(overrides: Record<string, unknown> = {}) {
  return Charter.parse({ objective: "o", proofStrategy: "verifier-criteria", scope: {}, budget: {}, ...overrides });
}

const liveCritic = (id: string, description: string): ContractAssertion => ({
  id,
  subGoalId: "ALL",
  description,
  type: "live-critic",
  observable: description,
  blocker: true,
});

const command = (id: string, description: string, expected: string): ContractAssertion => ({
  id,
  subGoalId: "ALL",
  description,
  type: "command",
  expected,
  blocker: true,
});

const ON = { adaptiveVerification: true };

describe("flag-off / no manifest — strict no-op", () => {
  const c: VerificationContract = {
    version: 1,
    assertions: [liveCritic("parse-contract-file-placed", "the parse contract file is placed"), command("gate", "a gate", "bun build")],
  };
  const loom = fakeLoom({
    charter: charter({ proofHints: [{ criterion: "parse-contract-file-placed", run: "diff a b" }] }),
  });

  test("no manifest returns the input contract unchanged + empty tightenings", () => {
    const r = tightenAuthoredContract(c, loom);
    expect(r.contract).toBe(c);
    expect(r.tightenings).toEqual([]);
  });

  test("manifest WITHOUT the flag returns the input contract unchanged + empty tightenings", () => {
    const r = tightenAuthoredContract(c, loom, { adaptiveVerification: false });
    expect(r.contract).toBe(c);
    expect(r.tightenings).toEqual([]);
  });

  test("flag-on but a charter with NO hints is a no-op (empty hint map short-circuit)", () => {
    const r = tightenAuthoredContract(c, fakeLoom({ charter: charter() }), ON);
    expect(r.contract).toBe(c);
    expect(r.tightenings).toEqual([]);
  });
});

describe("Direction 1 — CONVERT an agent-judged assertion that carries a hint", () => {
  test("a live-critic whose ID matches a proofHint becomes command+expected; hint-less peer stays live-critic", () => {
    const c: VerificationContract = {
      version: 1,
      assertions: [
        liveCritic("bun-test-suite-passes", "the bun test suite passes"),
        liveCritic("feels-premium", "the dashboard feels premium"),
      ],
    };
    const loom = fakeLoom({
      charter: charter({ proofHints: [{ criterion: "bun-test-suite-passes", run: "bun test" }] }),
    });
    const { contract, tightenings } = tightenAuthoredContract(c, loom, ON);

    expect(tightenings).toEqual([
      { id: "bun-test-suite-passes", fromType: "live-critic", fromExpected: undefined, toType: "command", toExpected: "bun test" },
    ]);
    expect(contract.assertions[0]).toEqual({
      id: "bun-test-suite-passes",
      subGoalId: "ALL",
      description: "the bun test suite passes",
      type: "command",
      expected: "bun test",
      observable: undefined,
      subjective: undefined,
      blocker: true,
    } as never);
    // hint-less peer untouched
    expect(contract.assertions[1]).toEqual(liveCritic("feels-premium", "the dashboard feels premium") as never);
    expect(validateContract(contract)).toEqual([]);
  });

  test("match falls back to DESCRIPTION when the id does not match", () => {
    const c: VerificationContract = {
      version: 1,
      assertions: [liveCritic("a1", "prints usage on --help"), command("hard", "a hard gate", "bun build")],
    };
    const loom = fakeLoom({
      charter: charter({ proofHints: [{ criterion: "prints usage on --help", run: "node cli.js --help" }] }),
    });
    const { contract, tightenings } = tightenAuthoredContract(c, loom, ON);
    expect(tightenings.map((t) => t.id)).toEqual(["a1"]);
    expect(contract.assertions[0]!.type).toBe("command");
    expect(contract.assertions[0]!.expected).toBe("node cli.js --help");
  });

  test("a golden-diff (agent-judged) with a matching hint converts too; subjective marker is stripped", () => {
    const c: VerificationContract = {
      version: 1,
      assertions: [
        { id: "gd", subGoalId: "ALL", description: "golden diff placed", type: "golden-diff", expectedFile: "x.diff", blocker: true },
        command("hard", "a hard gate", "bun build"),
      ],
    };
    const loom = fakeLoom({ charter: charter({ proofHints: [{ criterion: "gd", run: "diff x y" }] }) });
    const { contract } = tightenAuthoredContract(c, loom, ON);
    expect(contract.assertions[0]!.type).toBe("command");
    expect(contract.assertions[0]!.expected).toBe("diff x y");
    expect(contract.assertions[0]!.subjective).toBeUndefined();
  });
});

// Review finding 1 (CRITICAL): a DETERMINISTIC assertion already carries an
// authored runnable; editing its `expected` toward a charter hint is "editing the
// yardstick" (§M.2) and text can't tell stricter from looser. So there is NO edit
// path for a deterministic assertion — a matching hint is a strict no-op, whether
// the authored expected is a stricter runnable OR unrunnable prose (the latter is
// left to fail closed and be repaired by the HUMAN escalation surface).
describe("Direction 2 REMOVED — a deterministic assertion is never edited (finding 1)", () => {
  test("a stricter human command is NOT swapped for a weaker charter hint", () => {
    const c: VerificationContract = {
      version: 1,
      assertions: [command("suite", "the suite passes", "bun test --coverage --min 90")],
    };
    // The charter (agent-authored, not necessarily surfaced to the approver) carries
    // a WEAKER runnable for the same criterion. It must NOT replace the strict one.
    const loom = fakeLoom({
      charter: charter({ proofHints: [{ criterion: "suite", run: "bun test" }] }),
    });
    const r = tightenAuthoredContract(c, loom, ON);
    expect(r.tightenings).toEqual([]);
    expect(r.contract).toBe(c); // unchanged — the human yardstick is preserved
    expect(r.contract.assertions[0]!.expected).toBe("bun test --coverage --min 90");
  });

  test("a command with a PROSE expected + matching hint is left as-authored (repair is human's job)", () => {
    const c: VerificationContract = {
      version: 1,
      assertions: [command("bun-test-suite-passes", "the bun test suite passes", "process exits with code 0; all tests green")],
    };
    const loom = fakeLoom({
      charter: charter({ proofHints: [{ criterion: "bun-test-suite-passes", run: "bun test" }] }),
    });
    const r = tightenAuthoredContract(c, loom, ON);
    expect(r.tightenings).toEqual([]);
    expect(r.contract).toBe(c);
    expect(r.contract.assertions[0]!.expected).toBe("process exits with code 0; all tests green");
  });
});

// Review finding 2 (MAJOR): a hint whose runnable ALWAYS exits 0 (`true`, `exit 0`,
// `echo …`, `:`) is a fake check — honoring it would mint an always-green command
// replacing a live judge. collectProofHints drops it, so the hint is INERT and the
// assertion keeps its agent-judged routing (worst case unchanged, never green).
describe("finding 2 — a trivially-passing hint is inert, never an always-green command", () => {
  const cases: [string, string][] = [
    ["true", "true"],
    ["exit 0", "exit 0"],
    ["bare colon", ":"],
    ["echo done", "echo all good"],
  ];
  for (const [label, run] of cases) {
    test(`hint run "${label}" does NOT convert a matching live-critic`, () => {
      const c: VerificationContract = {
        version: 1,
        assertions: [liveCritic("suite", "the suite passes"), command("hard", "a hard gate", "bun build")],
      };
      const loom = fakeLoom({ charter: charter({ proofHints: [{ criterion: "suite", run }] }) });
      const r = tightenAuthoredContract(c, loom, ON);
      expect(r.tightenings).toEqual([]);
      expect(r.contract).toBe(c);
      expect(r.contract.assertions[0]!.type).toBe("live-critic");
    });
  }

  test("a REAL multi-segment check (one no-op segment + one real) is still honored", () => {
    // `node cli.js --nope; test $? -eq 2` — the second segment is a genuine exit-code
    // assertion, so the whole thing is NOT trivial-pass and converts as normal.
    const c: VerificationContract = {
      version: 1,
      assertions: [liveCritic("exit-code", "exits 2 on unknown flag")],
    };
    const loom = fakeLoom({
      charter: charter({ proofHints: [{ criterion: "exit-code", run: "node cli.js --nope; test $? -eq 2" }] }),
    });
    const r = tightenAuthoredContract(c, loom, ON);
    expect(r.tightenings.map((t) => t.id)).toEqual(["exit-code"]);
    expect(r.contract.assertions[0]!.type).toBe("command");
    expect(r.contract.assertions[0]!.expected).toBe("node cli.js --nope; test $? -eq 2");
  });
});

describe("idempotency — a re-run over the tightened output is a strict no-op", () => {
  test("converting then re-running yields zero tightenings and an unchanged contract", () => {
    const c: VerificationContract = {
      version: 1,
      assertions: [liveCritic("bun-test-suite-passes", "the bun test suite passes"), command("hard", "gate", "bun build")],
    };
    const loom = fakeLoom({
      charter: charter({ proofHints: [{ criterion: "bun-test-suite-passes", run: "bun test" }] }),
    });
    const first = tightenAuthoredContract(c, loom, ON);
    expect(first.tightenings.length).toBe(1);

    const second = tightenAuthoredContract(first.contract, loom, ON);
    expect(second.tightenings).toEqual([]);
    expect(second.contract).toBe(first.contract); // same reference — no rewrite
  });
});

describe("fail-safe — a tightening that would invalidate the contract is discarded", () => {
  test("a blank-description assertion (would fail validateContract) keeps its original type; nothing recorded", () => {
    // The candidate conversion would leave the blank description in place, so
    // validateContract flags it → the tightening is DISCARDED and the original
    // live-critic kept. The valid hard-gate peer keeps the contract otherwise well
    // formed, isolating the discard to the offending assertion.
    const c: VerificationContract = {
      version: 1,
      assertions: [
        { id: "blank", subGoalId: "ALL", description: "   ", type: "live-critic", observable: "x", blocker: true },
        command("hard", "a hard gate", "bun build"),
      ],
    };
    const loom = fakeLoom({ charter: charter({ proofHints: [{ criterion: "blank", run: "bun test" }] }) });
    const { contract, tightenings } = tightenAuthoredContract(c, loom, ON);
    expect(tightenings).toEqual([]);
    expect(contract).toBe(c); // unchanged — original preserved
    expect(contract.assertions[0]!.type).toBe("live-critic");
  });
});

describe("conservatism — the reverse direction has no path", () => {
  test("a hint-less deterministic assertion is never demoted to live-critic", () => {
    const c: VerificationContract = { version: 1, assertions: [command("cmd", "runs the build", "bun build")] };
    const loom = fakeLoom({ charter: charter({ proofHints: [{ criterion: "unrelated", run: "echo hi" }] }) });
    const r = tightenAuthoredContract(c, loom, ON);
    expect(r.contract).toBe(c);
    expect(r.tightenings).toEqual([]);
  });
});
