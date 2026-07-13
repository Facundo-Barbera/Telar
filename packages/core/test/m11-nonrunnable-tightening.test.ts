// M11 (docs/m11-discuss-iteration.md, findings 2a/2b/2c + 3) — the non-runnable
// guard across the contract pipeline. Hermetic (pure functions, no LLM/dispatch;
// TELAR_HOME pinned only so the executor.ts import graph never touches ~/.telar):
//   - 2a EMIT: Charter.parse REJECTS a present, non-runnable proofHint run
//     (prose / JS expression); a BLANK run stays valid (collectProofHints drops it)
//   - 2a AUTHOR-TIME: validateContract REJECTS a `command` whose expected is
//     non-runnable prose; a `gate` (name) and a `db` (SQL) are exempt
//   - 2b INSTALL: synthesizeContract never installs a non-runnable hint into an
//     `expected` — the criterion keeps live-critic (collectProofHints drops it)
//   - 2c/3 REPAIR: a DETERMINISTIC `command` with a NON-runnable prose expected +
//     a matching runnable hint OR the human-answered verifyCommand is REPAIRED,
//     event-trailed; a RUNNABLE authored expected stays untouched; flag-off no-op
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Charter, validateContract, type ContractAssertion, type VerificationContract } from "../src/schemas";
import type { Loom } from "../src/looms";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m11-nrt-"));
process.env.TELAR_HOME = home;

const { synthesizeContract, tightenAuthoredContract } = await import("../src/weave-contracts");

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function fakeLoom(overrides: Partial<Loom> = {}): Loom {
  return {
    id: "fake_m11_nrt",
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

// A RAW charter object (NOT Charter.parse) so we can plant a non-runnable hint
// past the emit-time superRefine and exercise collectProofHints' runtime drop.
function rawCharter(proofHints: { criterion: string; run: string }[]): Loom["charter"] {
  return {
    objective: "o",
    proofStrategy: "verifier-criteria",
    scope: {},
    budget: {},
    decomposition: [],
    version: 1,
    proofHints,
  } as unknown as Loom["charter"];
}

const command = (id: string, description: string, expected: string): ContractAssertion => ({
  id,
  subGoalId: "ALL",
  description,
  type: "command",
  expected,
  blocker: true,
});

const ON = { adaptiveVerification: true };

describe("2a EMIT — Charter.parse rejects a non-runnable proofHint run", () => {
  test("a PROSE run is rejected at the schema boundary", () => {
    const r = Charter.safeParse({
      objective: "o",
      proofStrategy: "verifier-criteria",
      scope: {},
      budget: {},
      proofHints: [{ criterion: "suite passes", run: "process exits with code 0; all tests green" }],
    });
    expect(r.success).toBe(false);
  });

  test("a bare JS expression run is rejected", () => {
    const r = Charter.safeParse({
      objective: "o",
      proofStrategy: "verifier-criteria",
      scope: {},
      budget: {},
      proofHints: [{ criterion: "parses", run: "parse('1.2.3') === {major: 1}" }],
    });
    expect(r.success).toBe(false);
  });

  test("a real command run is accepted", () => {
    const r = Charter.safeParse({
      objective: "o",
      proofStrategy: "verifier-criteria",
      scope: {},
      budget: {},
      proofHints: [{ criterion: "suite passes", run: "bun test" }],
    });
    expect(r.success).toBe(true);
  });

  test("a BLANK run stays valid (additive — collectProofHints drops it, no regression)", () => {
    const r = Charter.safeParse({
      objective: "o",
      proofStrategy: "verifier-criteria",
      scope: {},
      budget: {},
      proofHints: [{ criterion: "suite passes", run: "   " }],
    });
    expect(r.success).toBe(true);
  });
});

describe("2a AUTHOR-TIME — validateContract rejects a non-runnable command expected", () => {
  test("a command whose expected is PROSE is a contract error", () => {
    const c: VerificationContract = {
      version: 1,
      assertions: [command("suite", "the suite passes", "process exits with code 0; all tests green")],
    };
    const errors = validateContract(c);
    expect(errors.some((e) => e.includes("non-runnable expected"))).toBe(true);
  });

  test("a command with a RUNNABLE expected is accepted", () => {
    const c: VerificationContract = { version: 1, assertions: [command("suite", "the suite passes", "bun test")] };
    expect(validateContract(c)).toEqual([]);
  });

  test("a GATE expected (a manifest-gate NAME, even multi-word) is exempt from the runnable check", () => {
    const c: VerificationContract = {
      version: 1,
      assertions: [{ id: "g", subGoalId: "ALL", description: "gate", type: "gate", expected: "the full lint suite", blocker: true }],
    };
    expect(validateContract(c)).toEqual([]);
  });

  test("a DB expected (SQL-shaped) is exempt from the runnable check", () => {
    const c: VerificationContract = {
      version: 1,
      assertions: [{ id: "d", subGoalId: "ALL", description: "db", type: "db", expected: "SELECT id, name, email FROM users WHERE active", blocker: true }],
    };
    expect(validateContract(c)).toEqual([]);
  });
});

describe("2b INSTALL — synthesizeContract never installs a non-runnable hint", () => {
  test("a criterion whose (raw) hint run is prose keeps live-critic, never a prose command", () => {
    const loom = fakeLoom({
      acceptanceCriteria: ["the suite passes"],
      charter: rawCharter([{ criterion: "the suite passes", run: "process exits with code 0; all tests green" }]),
    });
    const c = synthesizeContract(loom, { adaptiveVerification: true });
    expect(c.assertions[0]!.type).toBe("live-critic");
    expect(c.assertions[0]!.expected).toBeUndefined();
  });

  test("a criterion whose hint run IS runnable tightens to a command (the honored path)", () => {
    const loom = fakeLoom({
      acceptanceCriteria: ["the suite passes"],
      charter: rawCharter([{ criterion: "the suite passes", run: "bun test" }]),
    });
    const c = synthesizeContract(loom, { adaptiveVerification: true });
    expect(c.assertions[0]!.type).toBe("command");
    expect(c.assertions[0]!.expected).toBe("bun test");
  });
});

describe("2c/3 REPAIR — a broken command's prose expected is repaired to a sanctioned runnable", () => {
  test("a matching runnable HINT repairs a non-runnable command expected (event-trailed)", () => {
    const c: VerificationContract = {
      version: 1,
      assertions: [command("bun-test-suite-passes", "the bun test suite passes", "process exits with code 0; all tests green")],
    };
    const loom = fakeLoom({
      charter: rawCharter([{ criterion: "bun-test-suite-passes", run: "bun test" }]),
    });
    const { contract, tightenings } = tightenAuthoredContract(c, loom, ON);
    expect(contract.assertions[0]!.type).toBe("command");
    expect(contract.assertions[0]!.expected).toBe("bun test");
    expect(tightenings).toEqual([
      {
        id: "bun-test-suite-passes",
        fromType: "command",
        fromExpected: "process exits with code 0; all tests green",
        toType: "command",
        toExpected: "bun test",
      },
    ]);
    expect(validateContract(contract)).toEqual([]);
  });

  test("the human-answered verifyCommand repairs a broken command with NO matching hint (finding 3)", () => {
    const c: VerificationContract = {
      version: 1,
      assertions: [command("suite", "the suite passes", "process exits with code 0; all tests green")],
    };
    const loom = fakeLoom({ charter: rawCharter([]) });
    const { contract, tightenings } = tightenAuthoredContract(c, loom, { adaptiveVerification: true, verifyCommand: "bun test" });
    expect(contract.assertions[0]!.expected).toBe("bun test");
    expect(tightenings.map((t) => t.id)).toEqual(["suite"]);
  });

  test("a RUNNABLE authored command expected is NEVER replaced (the §M.2 yardstick)", () => {
    const c: VerificationContract = {
      version: 1,
      assertions: [command("suite", "the suite passes", "bun test --coverage --min 90")],
    };
    const loom = fakeLoom({ charter: rawCharter([{ criterion: "suite", run: "bun test" }]) });
    const r = tightenAuthoredContract(c, loom, { adaptiveVerification: true, verifyCommand: "bun test" });
    expect(r.tightenings).toEqual([]);
    expect(r.contract).toBe(c);
    expect(r.contract.assertions[0]!.expected).toBe("bun test --coverage --min 90");
  });

  test("a non-runnable expected with NO sanctioned runnable is left as-authored (fails closed to escalation)", () => {
    const c: VerificationContract = {
      version: 1,
      assertions: [command("suite", "the suite passes", "process exits with code 0")],
    };
    const loom = fakeLoom({ charter: rawCharter([]) });
    const r = tightenAuthoredContract(c, loom, ON); // no hint, no verifyCommand
    expect(r.tightenings).toEqual([]);
    expect(r.contract).toBe(c);
  });

  test("flag-off is a strict no-op even with a verifyCommand present", () => {
    const c: VerificationContract = {
      version: 1,
      assertions: [command("suite", "the suite passes", "process exits with code 0; all tests green")],
    };
    const loom = fakeLoom({ charter: rawCharter([]) });
    const r = tightenAuthoredContract(c, loom, { adaptiveVerification: false, verifyCommand: "bun test" });
    expect(r.contract).toBe(c);
    expect(r.tightenings).toEqual([]);
  });

  test("idempotent — re-running over the repaired output produces zero tightenings", () => {
    const c: VerificationContract = {
      version: 1,
      assertions: [command("suite", "the suite passes", "process exits with code 0; all tests green")],
    };
    const loom = fakeLoom({ charter: rawCharter([{ criterion: "suite", run: "bun test" }]) });
    const first = tightenAuthoredContract(c, loom, ON);
    expect(first.tightenings.length).toBe(1);
    const second = tightenAuthoredContract(first.contract, loom, ON);
    expect(second.tightenings).toEqual([]);
    expect(second.contract).toBe(first.contract);
  });
});
