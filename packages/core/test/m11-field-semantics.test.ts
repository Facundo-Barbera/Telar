// M11 (docs/m11-discuss-iteration.md, finding 6) — FIELD SEMANTICS across the
// contract pipeline. Ground truth (run #3, loom_mriuu8la_lrtwxx): the planner
// INVERTED the fields — it put the RUNNABLE in `observable` ("bun test") and PROSE
// in `expected` ("exit code 0") — so the gate layer (which reads only `expected`)
// executed the prose and ignored the real command. Finding 6:
//   - validateContract REJECTS a non-blank `observable` on a command/gate at author
//     time (naming the right field) so the planner fixes it in-session. A `db`
//     legitimately pairs expected SQL + observable, so it is EXEMPT. A blank/absent
//     observable is fine (every existing command/gate fixture leaves it undefined).
//   - contractErrorsRepairable classifies the finding-6 + finding-7 error pair as
//     author-repairable (consumed by dispatch reviveRepairableAuthored + the
//     executor fail-closed floor — Lane B integration edits).
//   - tightenAuthoredContract ADOPTS a runnable `observable` as a sanctioned repair
//     SOURCE for a legacy/started field-inverted command, moving it into `expected`
//     (and clearing the stray observable), event-trailed.
// Hermetic (pure functions, no LLM/dispatch; TELAR_HOME pinned only so the
// executor.ts import graph inside weave-contracts never touches ~/.telar).
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateContract, type ContractAssertion, type VerificationContract } from "../src/schemas";
import type { Loom } from "../src/looms";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m11-fs-"));
process.env.TELAR_HOME = home;

const { tightenAuthoredContract, contractErrorsRepairable } = await import("../src/weave-contracts");

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function fakeLoom(overrides: Partial<Loom> = {}): Loom {
  return {
    id: "fake_m11_fs",
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

const ON = { adaptiveVerification: true };
const OBS_ERR = "observable is only valid on live-critic";

describe("finding 6 — validateContract rejects observable on command/gate", () => {
  test("a command carrying a non-blank observable is a contract error naming `expected`", () => {
    const c: VerificationContract = {
      version: 1,
      assertions: [{ id: "c", subGoalId: "ALL", description: "the suite passes", type: "command", expected: "exit code 0", observable: "bun test", blocker: true }],
    };
    const errors = validateContract(c);
    expect(errors.some((e) => e.includes(OBS_ERR))).toBe(true);
  });

  test("a gate carrying a non-blank observable is a contract error", () => {
    const c: VerificationContract = {
      version: 1,
      assertions: [{ id: "g", subGoalId: "ALL", description: "lint gate", type: "gate", expected: "lint", observable: "bun run lint", blocker: true }],
    };
    expect(validateContract(c).some((e) => e.includes(OBS_ERR))).toBe(true);
  });

  test("a command with observable UNDEFINED is accepted (existing fixtures, byte-identical)", () => {
    const c: VerificationContract = {
      version: 1,
      assertions: [{ id: "c", subGoalId: "ALL", description: "the suite passes", type: "command", expected: "bun test", observable: undefined, blocker: true }],
    };
    expect(validateContract(c)).toEqual([]);
  });

  test("a command with a BLANK observable is accepted (only non-blank is rejected)", () => {
    const c: VerificationContract = {
      version: 1,
      assertions: [{ id: "c", subGoalId: "ALL", description: "the suite passes", type: "command", expected: "bun test", observable: "   ", blocker: true }],
    };
    expect(validateContract(c)).toEqual([]);
  });

  test("a live-critic REQUIRES observable — the field's legitimate home is untouched", () => {
    const c: VerificationContract = {
      version: 1,
      synthesized: true,
      assertions: [{ id: "lc", subGoalId: "ALL", description: "feels premium", type: "live-critic", observable: "the UI feels premium", blocker: true }],
    };
    expect(validateContract(c)).toEqual([]);
  });

  test("a db legitimately pairs expected SQL + observable — EXEMPT from the reject", () => {
    const c: VerificationContract = {
      version: 1,
      assertions: [{ id: "d", subGoalId: "ALL", description: "migration applied", type: "db", expected: "SELECT count(*) FROM users", observable: "the users table exists", blocker: true }],
    };
    expect(validateContract(c).some((e) => e.includes(OBS_ERR))).toBe(false);
  });
});

describe("finding 6 — contractErrorsRepairable classification", () => {
  test("the finding-6 field-inverted pair (non-runnable expected + stray observable) is repairable", () => {
    // A legacy field-inverted command yields BOTH errors at once.
    const errors = validateContract({
      version: 1,
      assertions: [{ id: "c", subGoalId: "ALL", description: "d", type: "command", expected: "exit code 0", observable: "bun test", blocker: true }],
    });
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(contractErrorsRepairable(errors)).toBe(true);
  });

  test("a lone non-runnable-expected error is repairable", () => {
    expect(contractErrorsRepairable(["command assertion c has a non-runnable expected (prose...): exit code 0"])).toBe(true);
  });

  test("a lone observable error is repairable", () => {
    expect(contractErrorsRepairable([`command/gate assertion c carries an observable ("bun test") — ${OBS_ERR}; put the runnable in \`expected\``])).toBe(true);
  });

  test("an empty error set is NOT repairable (nothing to revive)", () => {
    expect(contractErrorsRepairable([])).toBe(false);
  });

  test("a NON-repairable error (prose-only, dangling file, floor breach) falls through to synthesize", () => {
    expect(contractErrorsRepairable(["assertion c is prose-only: needs expected or expectedFile"])).toBe(false);
    expect(contractErrorsRepairable(["assertion c points at a bundle file that doesn't exist: x.json"])).toBe(false);
    expect(contractErrorsRepairable(["contract must have at least one non-live-critic (hard-gate) assertion"])).toBe(false);
    // A mix — one repairable, one not — is NOT repairable (every error must be a repair class).
    expect(contractErrorsRepairable([
      "command assertion c has a non-runnable expected: exit code 0",
      "assertion d is prose-only: needs expected or expectedFile",
    ])).toBe(false);
  });
});

describe("finding 6 REPAIR SYNERGY — a runnable observable is adopted as the repair source", () => {
  test("the run #3 field-inverted command: prose expected + runnable observable → expected repaired, observable cleared", () => {
    const c: VerificationContract = {
      version: 1,
      assertions: [{ id: "test-suite-green", subGoalId: "ALL", description: "the suite is green", type: "command", expected: "process exit code 0; summary output reports 0 fail", observable: "bun test", blocker: true }],
    };
    const loom = fakeLoom({ charter: rawCharter([]) }); // no hint, no verifyCommand — the observable IS the repair
    const { contract, tightenings } = tightenAuthoredContract(c, loom, ON);
    expect(contract.assertions[0]!.expected).toBe("bun test");
    expect(contract.assertions[0]!.observable).toBeUndefined();
    expect(tightenings.map((t) => ({ id: t.id, toExpected: t.toExpected }))).toEqual([{ id: "test-suite-green", toExpected: "bun test" }]);
    // The repaired contract is now valid (observable cleared, expected runnable).
    expect(validateContract(contract)).toEqual([]);
  });

  test("a matching HINT outranks the inverted observable (hint is the primary source)", () => {
    const c: VerificationContract = {
      version: 1,
      assertions: [{ id: "suite", subGoalId: "ALL", description: "the suite passes", type: "command", expected: "exit code 0", observable: "bun test", blocker: true }],
    };
    const loom = fakeLoom({ charter: rawCharter([{ criterion: "suite", run: "bun run verify" }]) });
    const { contract } = tightenAuthoredContract(c, loom, ON);
    expect(contract.assertions[0]!.expected).toBe("bun run verify");
    expect(contract.assertions[0]!.observable).toBeUndefined();
  });

  test("a NON-runnable observable is NOT a repair source — falls through to verifyCommand", () => {
    const c: VerificationContract = {
      version: 1,
      assertions: [{ id: "suite", subGoalId: "ALL", description: "the suite passes", type: "command", expected: "exit code 0", observable: "the suite is all green", blocker: true }],
    };
    const loom = fakeLoom({ charter: rawCharter([]) });
    const { contract, tightenings } = tightenAuthoredContract(c, loom, { adaptiveVerification: true, verifyCommand: "bun test" });
    expect(contract.assertions[0]!.expected).toBe("bun test");
    expect(tightenings.map((t) => t.id)).toEqual(["suite"]);
  });

  test("no sanctioned source at all (prose observable, no hint, no verifyCommand) leaves it as-authored → escalation", () => {
    const c: VerificationContract = {
      version: 1,
      assertions: [{ id: "suite", subGoalId: "ALL", description: "the suite passes", type: "command", expected: "exit code 0", observable: "the suite is all green", blocker: true }],
    };
    const loom = fakeLoom({ charter: rawCharter([]) });
    const r = tightenAuthoredContract(c, loom, ON);
    expect(r.tightenings).toEqual([]);
    expect(r.contract).toBe(c);
  });

  // Fix-round-3 critical (finding-6 repair): an observable that is runnable-SHAPED
  // but ALWAYS-GREEN ("true"/":"/"echo ok"/"exit 0") must NEVER be adopted as the
  // repair source — doing so rewrites a fail-closed prose gate into an unconditional
  // pass (verdict-floor breach) and persists it under the auto:tighten-authored
  // self-cosign. It must fall through to a genuine sanctioned runnable, or stay
  // as-authored (fail closed to escalation) when none exists.
  for (const trivial of ["true", ":", "echo ok", "exit 0"]) {
    test(`a TRIVIAL-PASS observable (${JSON.stringify(trivial)}) is NOT adopted — stays as-authored, fails closed to escalation`, () => {
      const c: VerificationContract = {
        version: 1,
        assertions: [{ id: "suite", subGoalId: "ALL", description: "the suite passes", type: "command", expected: "exit code 0", observable: trivial, blocker: true }],
      };
      const loom = fakeLoom({ charter: rawCharter([]) }); // no hint, no verifyCommand — only the trivial observable
      const r = tightenAuthoredContract(c, loom, ON);
      expect(r.tightenings).toEqual([]);
      expect(r.contract).toBe(c); // byte-identical reference — no fake-green tightening emitted
    });

    test(`a genuine verifyCommand OUTRANKS a trivial-pass observable (${JSON.stringify(trivial)})`, () => {
      const c: VerificationContract = {
        version: 1,
        assertions: [{ id: "suite", subGoalId: "ALL", description: "the suite passes", type: "command", expected: "exit code 0", observable: trivial, blocker: true }],
      };
      const loom = fakeLoom({ charter: rawCharter([]) });
      const { contract, tightenings } = tightenAuthoredContract(c, loom, { adaptiveVerification: true, verifyCommand: "bun test" });
      expect(contract.assertions[0]!.expected).toBe("bun test"); // never "true"/"exit 0"
      expect(contract.assertions[0]!.observable).toBeUndefined();
      expect(tightenings.map((t) => t.id)).toEqual(["suite"]);
    });
  }
});
