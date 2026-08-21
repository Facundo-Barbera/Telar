/**
 * Tri-state gates.
 *
 * The assertion this file exists for is a NEGATIVE one: an exit code the
 * Program did not declare must come out `unknown`, and never `fail`. Exit 0
 * included — a project whose 0 means "skipped everything because Docker was
 * down" is the case that produced this whole design, and a classifier that
 * assumed POSIX convention would call that a green light.
 */
import { describe, expect, test } from "bun:test";
import type { LoomGate, LoomGateResult } from "@telar/engine-client";
import { classifyExit, decideAfterGates, shouldPublish, suiteUnknownPolicy } from "../src/loom/gates";

const gate = (exits: Record<number, "pass" | "fail" | "unknown">, onUnknown: "hold" | "publish" = "hold"): LoomGate => ({
  command: "bun run ci",
  exits,
  onUnknown,
});

const result = (outcome: "pass" | "fail" | "unknown", command = "bun run ci"): LoomGateResult => ({
  command,
  exitCode: outcome === "pass" ? 0 : 1,
  outcome,
});

describe("classifyExit", () => {
  test("a declared code means what the Program says it means", () => {
    const g = gate({ 0: "pass", 1: "fail", 2: "unknown" });
    expect(classifyExit(0, g)).toBe("pass");
    expect(classifyExit(1, g)).toBe("fail");
    expect(classifyExit(2, g)).toBe("unknown");
  });

  test("AN UNDECLARED CODE IS unknown, NEVER fail", () => {
    const g = gate({ 0: "pass", 1: "fail" });
    expect(classifyExit(2, g)).toBe("unknown");
    expect(classifyExit(3, g)).toBe("unknown");
    expect(classifyExit(127, g)).toBe("unknown"); // command not found
    expect(classifyExit(137, g)).toBe("unknown"); // SIGKILL
    expect(classifyExit(-1, g)).toBe("unknown");
  });

  test("EXIT 0 IS unknown WHEN 0 IS UNDECLARED — zero is not a promise", () => {
    // The project never said what 0 means. Treating it as a pass would publish
    // on the word of a convention nobody in this repo agreed to.
    expect(classifyExit(0, gate({ 1: "fail" }))).toBe("unknown");
    expect(classifyExit(0, gate({}))).toBe("unknown");
  });

  test("a project may declare 0 as a failure, and it is believed", () => {
    // `scripts/ci.ts` exiting 0 after skipping every suite is a real shape.
    expect(classifyExit(0, gate({ 0: "fail" }))).toBe("fail");
    expect(classifyExit(0, gate({ 0: "unknown" }))).toBe("unknown");
  });

  test("no exit code at all is unknown — killed is not failed", () => {
    const g = gate({ 0: "pass", 1: "fail" });
    expect(classifyExit(null, g)).toBe("unknown");
    expect(classifyExit(undefined, g)).toBe("unknown");
    expect(classifyExit(Number.NaN, g)).toBe("unknown");
    expect(classifyExit(1.5, g)).toBe("unknown");
  });
});

describe("decideAfterGates", () => {
  test("any fail decides, and names the gate that failed", () => {
    const decision = decideAfterGates(
      [result("pass", "typecheck"), result("fail", "test"), result("unknown", "e2e")],
      [],
    );
    expect(decision.outcome).toBe("fail");
    expect(decision.blocking?.command).toBe("test");
  });

  test("absent a fail, one unknown poisons the batch", () => {
    const decision = decideAfterGates([result("pass", "typecheck"), result("unknown", "pgtap")], []);
    expect(decision.outcome).toBe("unknown");
    expect(decision.blocking?.command).toBe("pgtap");
    // Four of five passing is NOT four-fifths of a pass.
  });

  test("all pass is the only pass", () => {
    const decision = decideAfterGates([result("pass"), result("pass")], []);
    expect(decision.outcome).toBe("pass");
    expect(decision.blocking).toBeUndefined();
  });

  test("no gates at all is a pass — a project that declared none asked for none", () => {
    expect(decideAfterGates([], []).outcome).toBe("pass");
  });

  test("fail outranks unknown regardless of order", () => {
    expect(decideAfterGates([result("unknown"), result("fail")], []).outcome).toBe("fail");
    expect(decideAfterGates([result("fail"), result("unknown")], []).outcome).toBe("fail");
  });
});

describe("shouldPublish is the only yes/no, and it needs the policy", () => {
  test("pass publishes and fail does not, whatever the policy says", () => {
    expect(shouldPublish("pass", "hold")).toBe(true);
    expect(shouldPublish("pass", "publish")).toBe(true);
    expect(shouldPublish("fail", "hold")).toBe(false);
    expect(shouldPublish("fail", "publish")).toBe(false);
  });

  test("unknown is decided by the Program, because it cannot be inferred", () => {
    expect(shouldPublish("unknown", "hold")).toBe(false);
    expect(shouldPublish("unknown", "publish")).toBe(true);
  });
});

describe("suiteUnknownPolicy", () => {
  test("one gate asking to hold holds the whole suite", () => {
    expect(suiteUnknownPolicy([gate({}, "publish"), gate({}, "hold")])).toBe("hold");
  });

  test("only an all-publish suite publishes on unknown", () => {
    expect(suiteUnknownPolicy([gate({}, "publish"), gate({}, "publish")])).toBe("publish");
  });

  test("no gates holds", () => {
    expect(suiteUnknownPolicy([])).toBe("hold");
  });
});
