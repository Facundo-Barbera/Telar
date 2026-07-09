import { describe, expect, test } from "bun:test";
import { decideVerifyLoom } from "../src/executor";
import { WorkUnit } from "../src/schemas";
import type { Loom, LoomKind } from "../src/looms";

describe("decideVerifyLoom", () => {
  // §A: every verify loom in production is a ROOT loom (nothing spawns one as
  // a child) — "pass" must land "ready" (awaiting acceptLoom), never
  // self-promote straight to "done".
  test("pass on a ROOT verify loom (no parentLoomId) -> ready, not done", () => {
    expect(decideVerifyLoom("pass", {})).toEqual({ state: "ready" });
  });

  test("pass on a CHILD verify loom (has parentLoomId) -> done", () => {
    expect(decideVerifyLoom("pass", { parentLoomId: "epic_1" })).toEqual({ state: "done" });
  });

  test("fail -> needs-review 'verification failed'", () => {
    expect(decideVerifyLoom("fail", {})).toEqual({ state: "needs-review", error: "verification failed" });
  });

  test("flaky -> needs-review 'verification flaky'", () => {
    expect(decideVerifyLoom("flaky", {})).toEqual({ state: "needs-review", error: "verification flaky" });
  });

  test("skip -> needs-review 'nothing verified'", () => {
    expect(decideVerifyLoom("skip", {})).toEqual({ state: "needs-review", error: "nothing verified" });
  });
});

describe("verify LoomKind", () => {
  test("a loom with kind 'verify' is a valid LoomKind (type-level)", () => {
    const kind: LoomKind = "verify";
    const loom: Pick<Loom, "kind"> = { kind };
    expect(loom.kind).toBe("verify");
  });

  test("WorkUnit.parse with kind 'verify' succeeds", () => {
    const unit = WorkUnit.parse({
      id: "u1",
      kind: "verify",
      project: "p",
      title: "t",
      prompt: "check it",
    });
    expect(unit.kind).toBe("verify");
  });
});
