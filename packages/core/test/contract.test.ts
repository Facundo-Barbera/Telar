import { describe, expect, test } from "bun:test";
import {
  assertProvenance,
  contractLoosenings,
  validateContract,
  WorkUnitState,
  type ContractAssertion,
  type VerificationContract,
} from "../src/schemas";

function assertion(overrides: Partial<ContractAssertion> = {}): ContractAssertion {
  return {
    id: overrides.id ?? "a1",
    subGoalId: overrides.subGoalId,
    description: overrides.description ?? "checks something",
    type: overrides.type ?? "value-equality",
    expected: overrides.expected,
    expectedFile: overrides.expectedFile,
    observable: overrides.observable,
    blocker: overrides.blocker ?? true,
  };
}

function contract(assertions: ContractAssertion[]): VerificationContract {
  return { version: 1, assertions };
}

describe("validateContract (pure)", () => {
  test("rejects an empty assertion list", () => {
    const errors = validateContract(contract([]));
    expect(errors).toContain("contract must have at least one assertion");
  });

  test("rejects a non-live-critic assertion with neither expected nor expectedFile", () => {
    const errors = validateContract(contract([assertion({ id: "a1" })]));
    expect(errors).toContain("assertion a1 is prose-only: needs expected or expectedFile");
  });

  test("rejects a whitespace-only expected value as prose-only", () => {
    const errors = validateContract(contract([assertion({ id: "a1", expected: "   " })]));
    expect(errors).toContain("assertion a1 is prose-only: needs expected or expectedFile");
  });

  test("accepts a non-live-critic assertion with a non-empty expectedFile", () => {
    const errors = validateContract(contract([assertion({ id: "a1", expectedFile: "spec/golden.txt" })]));
    expect(errors).not.toContain("assertion a1 is prose-only: needs expected or expectedFile");
  });

  test("rejects a live-critic assertion with a blank observable", () => {
    const errors = validateContract(contract([assertion({ id: "a2", type: "live-critic", observable: "  " })]));
    expect(errors).toContain("live-critic assertion a2 must name an observable");
  });

  test("accepts a live-critic assertion with a non-empty observable, alongside a hard gate", () => {
    const errors = validateContract(
      contract([
        assertion({ id: "a1", type: "value-equality", expected: "42" }),
        assertion({ id: "a2", type: "live-critic", observable: "export button downloads a PDF" }),
      ]),
    );
    expect(errors).toEqual([]);
  });

  test("rejects an all-live-critic contract (no falsifiable hard gate)", () => {
    const errors = validateContract(
      contract([
        assertion({ id: "a1", type: "live-critic", observable: "it feels right and modern" }),
        assertion({ id: "a2", type: "live-critic", observable: "nothing looks broken" }),
      ]),
    );
    expect(errors).toContain("contract must have at least one non-live-critic (hard-gate) assertion");
  });

  test("rejects an expectedFile pointer that doesn't exist in the bundle when existingFiles is supplied", () => {
    const errors = validateContract(
      contract([assertion({ id: "a1", expectedFile: "spec/golden.txt" })]),
      { existingFiles: new Set(["spec/other.txt"]) },
    );
    expect(errors).toContain("assertion a1 points at a bundle file that doesn't exist: spec/golden.txt");
  });

  test("accepts an expectedFile pointer that does exist when existingFiles is supplied", () => {
    const errors = validateContract(
      contract([assertion({ id: "a1", expectedFile: "spec/golden.txt" })]),
      { existingFiles: new Set(["spec/golden.txt"]) },
    );
    expect(errors).toEqual([]);
  });

  test("does not crash and reports the missing-assertions error when assertions is undefined (unparsed input)", () => {
    const errors = validateContract({ version: 1 } as VerificationContract);
    expect(errors).toContain("contract must have at least one assertion");
  });

  test("rejects an assertion with a blank description", () => {
    const errors = validateContract(contract([assertion({ id: "a1", description: "  ", expected: "42" })]));
    expect(errors).toContain("assertion a1 must have a non-empty description");
  });

  test("accepts a valid mixed contract (empty errors)", () => {
    const c = contract([
      assertion({ id: "a1", type: "golden-diff", expectedFile: "spec/golden.diff" }),
      assertion({ id: "a2", type: "value-equality", expected: "42" }),
      assertion({ id: "a3", type: "schema-match", expectedFile: "spec/schema.json" }),
      assertion({ id: "a4", type: "contains", expected: "success" }),
      assertion({ id: "a5", type: "live-critic", observable: "checkout completes without an error toast" }),
    ]);
    expect(validateContract(c)).toEqual([]);
  });

  // Unit 4: the new command/gate/db kinds validate through the SAME non-live-
  // critic else-branch — they require expected/expectedFile exactly like a
  // value-equality, so a prose-only one is rejected as non-falsifiable, and a
  // command/gate/db satisfies the anti-all-live-critic hard-gate floor.
  test("accepts a valid command/gate/db contract (they carry a runnable in expected)", () => {
    const c = contract([
      assertion({ id: "c1", type: "command", expected: "bun test" }),
      assertion({ id: "g1", type: "gate", expected: "lint" }),
      assertion({ id: "d1", type: "db", expected: "pg_prove t/*.sql" }),
    ]);
    expect(validateContract(c)).toEqual([]);
  });

  test("a prose-only command is rejected as non-falsifiable, same as a prose-only value-equality", () => {
    const errors = validateContract(contract([assertion({ id: "c1", type: "command" })]));
    expect(errors).toContain("assertion c1 is prose-only: needs expected or expectedFile");
  });

  test("a lone command satisfies the anti-all-live-critic hard-gate floor", () => {
    const errors = validateContract(contract([assertion({ id: "c1", type: "command", expected: "bun test" })]));
    expect(errors).not.toContain("contract must have at least one non-live-critic (hard-gate) assertion");
    expect(errors).toEqual([]);
  });
});

describe("contractLoosenings (pure)", () => {
  test("flags an assertion removed outright", () => {
    const oldC = contract([assertion({ id: "a1", expected: "x" }), assertion({ id: "a2", expected: "y" })]);
    const newC = contract([assertion({ id: "a1", expected: "x" })]);
    expect(contractLoosenings(oldC, newC)).toEqual(["a2"]);
  });

  test("flags an assertion downgraded blocker true -> false", () => {
    const oldC = contract([assertion({ id: "a1", expected: "x", blocker: true })]);
    const newC = contract([assertion({ id: "a1", expected: "x", blocker: false })]);
    expect(contractLoosenings(oldC, newC)).toEqual(["a1"]);
  });

  test("does not flag tightening (blocker false -> true)", () => {
    const oldC = contract([assertion({ id: "a1", expected: "x", blocker: false })]);
    const newC = contract([assertion({ id: "a1", expected: "x", blocker: true })]);
    expect(contractLoosenings(oldC, newC)).toEqual([]);
  });

  test("does not flag unchanged assertions", () => {
    const oldC = contract([assertion({ id: "a1", expected: "x", blocker: true })]);
    const newC = contract([assertion({ id: "a1", expected: "x", blocker: true })]);
    expect(contractLoosenings(oldC, newC)).toEqual([]);
  });

  test("does not flag a newly added assertion", () => {
    const oldC = contract([assertion({ id: "a1", expected: "x" })]);
    const newC = contract([assertion({ id: "a1", expected: "x" }), assertion({ id: "a2", expected: "y" })]);
    expect(contractLoosenings(oldC, newC)).toEqual([]);
  });

  test("flags a hard-gate type swapped for live-critic on a still-blocking assertion", () => {
    const oldC = contract([assertion({ id: "a1", type: "value-equality", expected: "42", blocker: true })]);
    const newC = contract([
      assertion({ id: "a1", type: "live-critic", observable: "looks about right", blocker: true }),
    ]);
    expect(contractLoosenings(oldC, newC)).toEqual(["a1"]);
  });

  test("flags a changed expected value on a still-blocking assertion", () => {
    const oldC = contract([assertion({ id: "a1", expected: "exact-42", blocker: true })]);
    const newC = contract([
      assertion({ id: "a1", expected: "anything really, we loosened the expected value text itself", blocker: true }),
    ]);
    expect(contractLoosenings(oldC, newC)).toEqual(["a1"]);
  });

  test("flags a changed expectedFile pointer on a still-blocking assertion", () => {
    const oldC = contract([assertion({ id: "a1", expectedFile: "spec/golden.txt", blocker: true })]);
    const newC = contract([assertion({ id: "a1", expectedFile: "spec/other.txt", blocker: true })]);
    expect(contractLoosenings(oldC, newC)).toEqual(["a1"]);
  });

  test("does not flag a content change on an assertion that was never a blocker", () => {
    const oldC = contract([assertion({ id: "a1", expected: "x", blocker: false })]);
    const newC = contract([assertion({ id: "a1", expected: "y", blocker: false })]);
    expect(contractLoosenings(oldC, newC)).toEqual([]);
  });
});

describe("assertProvenance", () => {
  test("throws when approvedBy is missing/blank", () => {
    expect(() => assertProvenance({ approvedBy: "", humanApprovedAt: Date.now() })).toThrow();
    expect(() => assertProvenance({ approvedBy: "   ", humanApprovedAt: Date.now() })).toThrow();
    expect(() => assertProvenance({ humanApprovedAt: Date.now() })).toThrow();
  });

  test("throws when humanApprovedAt is not a positive number", () => {
    expect(() => assertProvenance({ approvedBy: "facundo", humanApprovedAt: 0 })).toThrow();
    expect(() => assertProvenance({ approvedBy: "facundo", humanApprovedAt: -1 })).toThrow();
    expect(() => assertProvenance({ approvedBy: "facundo", humanApprovedAt: NaN })).toThrow();
  });

  test("passes on a valid provenance", () => {
    expect(() =>
      assertProvenance({ approvedBy: "facundo", humanApprovedAt: Date.now(), sessionId: "sess_1" }),
    ).not.toThrow();
  });
});

describe("WorkUnitState", () => {
  test("accepts the new ready and blocked states", () => {
    expect(WorkUnitState.parse("ready")).toBe("ready");
    expect(WorkUnitState.parse("blocked")).toBe("blocked");
  });
});
