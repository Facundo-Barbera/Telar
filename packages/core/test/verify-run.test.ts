import { describe, expect, test } from "bun:test";
import { decideVerifyRun } from "../src/executor";
import { WorkUnit } from "../src/schemas";
import type { Run, RunKind } from "../src/runs";

describe("decideVerifyRun", () => {
  test("pass -> done", () => {
    expect(decideVerifyRun("pass")).toEqual({ state: "done" });
  });

  test("fail -> needs-review 'verification failed'", () => {
    expect(decideVerifyRun("fail")).toEqual({ state: "needs-review", error: "verification failed" });
  });

  test("flaky -> needs-review 'verification flaky'", () => {
    expect(decideVerifyRun("flaky")).toEqual({ state: "needs-review", error: "verification flaky" });
  });

  test("skip -> needs-review 'nothing verified'", () => {
    expect(decideVerifyRun("skip")).toEqual({ state: "needs-review", error: "nothing verified" });
  });
});

describe("verify RunKind", () => {
  test("a run with kind 'verify' is a valid RunKind (type-level)", () => {
    const kind: RunKind = "verify";
    const run: Pick<Run, "kind"> = { kind };
    expect(run.kind).toBe("verify");
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
