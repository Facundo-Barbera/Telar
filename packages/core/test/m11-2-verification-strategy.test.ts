// M11.2 — chooseVerificationStrategy (the PURE chooser). Hermetic: signals and
// contracts are constructed in-memory; the chooser does no I/O. Asserts the
// first-match precedence documented in verification-strategy.ts:
//   (1) web shape → server-lane, always (live lane is the substrate)
//   (2) a resolvable servers recipe → server-lane, even over a plannable
//       non-server signal (API/DB boot+hit + the process-standing DS kernel
//       keep today's path verbatim)
//   (3) plannable signal, no server → mapped non-server strategy; test-gate
//       carries the signal's runnable; deferred-gate folds into test-gate
//   (4) not-plannable + all-deterministic contract → artifact-assert
//   (5) every remaining ambiguity → server-lane (today's path verbatim)
import { describe, expect, test } from "bun:test";
import { chooseVerificationStrategy } from "../src/verification-strategy";
import type { DeliverableSignal } from "../src/deliverable-signal";
import type { ContractAssertion } from "../src/schemas";

const cmd = (id: string): ContractAssertion => ({
  id,
  description: "deterministic",
  type: "command",
  expected: "bun test",
  blocker: true,
});
const live = (id: string): ContractAssertion => ({
  id,
  description: "agent-judged",
  type: "live-critic",
  observable: "the page renders",
  blocker: true,
});

const libSignal: DeliverableSignal = {
  plannable: true,
  shape: "library",
  strategy: "test-gate",
  run: "bun run test",
  reason: "package.json declares a test script",
};
const deferredSignal: DeliverableSignal = {
  plannable: true,
  shape: "library",
  strategy: "deferred-gate",
  reason: "charter proof intent is a gate",
};
const cliSignal: DeliverableSignal = {
  plannable: true,
  shape: "cli",
  strategy: "cli-harness",
  reason: "package.json declares a bin",
};
const dsSignal: DeliverableSignal = {
  plannable: true,
  shape: "data-science",
  strategy: "sandbox-eval",
  reason: "notebook marker at root",
};
const webSignal: DeliverableSignal = { plannable: false, shape: "web", reason: "dev script" };
const unknownSignal: DeliverableSignal = { plannable: false, shape: "unknown", reason: "no signal" };

describe("(1) web shape → server-lane, always", () => {
  test("web signal wins over deterministic assertions and absent server config", () => {
    expect(chooseVerificationStrategy(webSignal, [cmd("a")]).kind).toBe("server-lane");
    expect(chooseVerificationStrategy(webSignal, [cmd("a")], { serverConfigured: false }).kind).toBe("server-lane");
    expect(chooseVerificationStrategy(webSignal, [], { serverConfigured: true }).kind).toBe("server-lane");
  });
});

describe("(2) a resolvable servers recipe → server-lane (M10 path verbatim)", () => {
  test("serverConfigured outranks a plannable non-server signal — API/DB and the DS kernel keep boot+hit", () => {
    // A library-looking repo that ALSO resolves a servers recipe: the live
    // assertions need the lane, and skipping bring-up could only redden gates
    // that hit the stood-up services — so the chooser never skips it.
    expect(chooseVerificationStrategy(libSignal, [live("l1")], { serverConfigured: true }).kind).toBe("server-lane");
    expect(chooseVerificationStrategy(dsSignal, [cmd("c1")], { serverConfigured: true }).kind).toBe("server-lane");
    expect(chooseVerificationStrategy(unknownSignal, [cmd("c1")], { serverConfigured: true }).kind).toBe(
      "server-lane",
    );
  });
});

describe("(2.5) a human-answered verifyCommand → test-gate carrying it (chooser rule 3)", () => {
  test("outranks the derived signal's runnable and works with NO signal at all", () => {
    // The strategy answer answerBlocked persisted to telar.yaml: the human
    // declared THIS command the proof, so it supplies the establishment
    // runnable even when the repo yields no signal — and wins over a derived
    // test-gate run when both exist.
    const answered = chooseVerificationStrategy(unknownSignal, [live("l1")], { verifyCommand: "bun run check" });
    expect(answered.kind).toBe("test-gate");
    expect(answered.kind === "test-gate" && answered.run).toBe("bun run check");
    const both = chooseVerificationStrategy(libSignal, [live("l1")], { verifyCommand: "bun run check" });
    expect(both.kind === "test-gate" && both.run).toBe("bun run check");
  });
  test("never outranks the web shape or a resolvable servers recipe (rules 1-2 stay first)", () => {
    expect(chooseVerificationStrategy(webSignal, [live("l1")], { verifyCommand: "bun run check" }).kind).toBe(
      "server-lane",
    );
    expect(
      chooseVerificationStrategy(unknownSignal, [live("l1")], { serverConfigured: true, verifyCommand: "bun run check" })
        .kind,
    ).toBe("server-lane");
  });
  test("a blank verifyCommand is inert", () => {
    expect(chooseVerificationStrategy(unknownSignal, [live("l1")], { verifyCommand: "   " }).kind).toBe("server-lane");
  });
});

describe("(3) plannable non-server signal, no server → the mapped strategy", () => {
  test("test-gate carries the signal's lockfile-aware runnable", () => {
    const s = chooseVerificationStrategy(libSignal, [cmd("c1")]);
    expect(s.kind).toBe("test-gate");
    expect(s.kind === "test-gate" && s.run).toBe("bun run test");
    expect(s.reason).toBe(libSignal.reason);
  });
  test("deferred-gate folds into test-gate with no runnable (artifact-time re-derivation answers concretely)", () => {
    const s = chooseVerificationStrategy(deferredSignal, [cmd("c1")]);
    expect(s.kind).toBe("test-gate");
    expect(s.kind === "test-gate" && s.run).toBeUndefined();
  });
  test("cli-harness and sandbox-eval map 1:1", () => {
    expect(chooseVerificationStrategy(cliSignal, [cmd("c1")]).kind).toBe("cli-harness");
    expect(chooseVerificationStrategy(dsSignal, [cmd("c1")]).kind).toBe("sandbox-eval");
  });
  test("a live-critic leftover does NOT flip the pick — it fail-closes downstream (no-target floor), never a stale URL", () => {
    // Proceed on the non-server plan; the agent-judged slice gets target=
    // undefined in frozenLaneVerify → panelRequired skip → M10.1 demote.
    expect(chooseVerificationStrategy(libSignal, [cmd("c1"), live("l1")]).kind).toBe("test-gate");
  });
});

describe("(4) contract-content selection → artifact-assert", () => {
  test("not-plannable + ALL-deterministic contract → the contract itself is the plan", () => {
    expect(chooseVerificationStrategy(unknownSignal, [cmd("c1"), cmd("c2")]).kind).toBe("artifact-assert");
  });
  test("a mixed contract (any agent-judged assertion) falls through to server-lane — today's target fallback preserved", () => {
    expect(chooseVerificationStrategy(unknownSignal, [cmd("c1"), live("l1")]).kind).toBe("server-lane");
  });
});

describe("(5) default → server-lane (today's path verbatim)", () => {
  test("no signal, no assertions → server-lane", () => {
    expect(chooseVerificationStrategy(unknownSignal, []).kind).toBe("server-lane");
  });
  test("an assertion without a runnable is NOT deterministic — no artifact-assert from an empty plan", () => {
    // command with no `expected` is agent-judged per partitionAssertions; the
    // chooser must not treat it as runnable evidence.
    const bare: ContractAssertion = { id: "b", description: "d", type: "command", blocker: true };
    expect(chooseVerificationStrategy(unknownSignal, [bare]).kind).toBe("server-lane");
  });
});
