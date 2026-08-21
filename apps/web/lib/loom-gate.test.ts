// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { describeGate, gateExitRows, gateTone, UNDECLARED_EXIT_SENTENCE } from "./loom-gate";

/**
 * The gate is tri-state and `unknown` is never a pass. These are the four
 * sentences the UI is allowed to say about a gate, pinned so a token edit
 * cannot silently turn "could not verify" green.
 */
describe("describeGate", () => {
  test("never gated is its own state, not `unknown`", () => {
    // "Nothing has run yet" and "something ran and could not be read" are
    // different facts, and a UI that collapses them is claiming the second when
    // it means the first.
    const none = describeGate(undefined);
    expect(none.tone).toBe("none");
    expect(none.className).not.toContain("success");
    expect(none.className).not.toContain("warning");
  });

  test("a pass says so and carries the success token", () => {
    const chip = describeGate({ command: "bun run ci", exitCode: 0, outcome: "pass" });
    expect(chip.tone).toBe("pass");
    expect(chip.label).toBe("exit 0 · passed");
    expect(chip.className).toContain("success");
  });

  test("a fail is destructive and names its exit code", () => {
    const chip = describeGate({ command: "bun run ci", exitCode: 1, outcome: "fail" });
    expect(chip.className).toContain("destructive");
    expect(chip.label).toContain("exit 1");
  });

  test("`unknown` is warning, says it could not be verified, and is not a pass", () => {
    const chip = describeGate({ command: "bun run ci", exitCode: 2, outcome: "unknown" });
    expect(chip.tone).toBe("unknown");
    expect(chip.className).toContain("warning");
    expect(chip.className).not.toContain("success");
    expect(chip.label).toContain("could not verify");
    expect(chip.detail).toContain("not a pass");
  });

  test("a gate that produced no exit code at all is still readable", () => {
    // Killed, timed out, never spawned. That is `unknown`, and the chip has to
    // say something other than "exit null".
    const chip = describeGate({ command: "bun run ci", exitCode: null, outcome: "unknown" });
    expect(chip.label).toContain("no exit code");
  });
});

describe("gateExitRows", () => {
  test("codes are sorted numerically, not lexically", () => {
    // A record's keys are strings on the wire, so `10` sorts before `2` unless
    // this coerces. A table that reads 0, 1, 10, 2 is a table nobody trusts.
    const rows = gateExitRows({ exits: { 10: "unknown", 2: "unknown", 0: "pass", 1: "fail" } });
    expect(rows.map((row) => row.code)).toEqual([0, 1, 2, 10]);
  });

  test("an empty table is legal and produces no rows", () => {
    expect(gateExitRows({ exits: {} })).toEqual([]);
  });

  test("each row carries the same word the chip uses", () => {
    const rows = gateExitRows({ exits: { 2: "unknown" } });
    expect(rows[0]?.label).toBe(gateTone("unknown").label);
  });

  test("the undeclared-code sentence points at `unknown`, never at `fail`", () => {
    // Assuming POSIX convention is exactly the imposition the design exists to
    // avoid, and it is wrong in both directions.
    expect(UNDECLARED_EXIT_SENTENCE).toContain("could not verify");
    expect(UNDECLARED_EXIT_SENTENCE).not.toContain("fail");
  });
});
