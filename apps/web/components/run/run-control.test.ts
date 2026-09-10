/**
 * The button's meaning, which is the part of it that can be dangerous. There is
 * no DOM harness in this app, so what is pinned here is the decision the
 * component renders rather than the pixels: which verb, and which sentence a
 * human has to agree to before something already deployed is stopped.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { runAction } from "@/lib/run/presentation";
import type { RunStatusAnswer, RunView } from "@/lib/run/types";
import { actionLabel, confirmation } from "./run-control";

function view(overrides: Partial<RunView> = {}): RunView {
  return {
    runId: "run_1",
    projectId: "proj_1",
    configId: "cfg_1",
    configName: "web dev",
    command: "bun run dev",
    worktreePath: "/trees/main",
    cwd: "/trees/main",
    startedAt: 1,
    status: "running",
    readiness: { kind: "none" },
    ...overrides,
  };
}

const answer = (overrides: Partial<RunStatusAnswer>): RunStatusAnswer => ({ history: [], ...overrides });

describe("actionLabel", () => {
  test("never says Start when something would be stopped", () => {
    // The whole guard: the verb has to match the consequence.
    expect(actionLabel(runAction(answer({})))).toBe("Start");
    expect(actionLabel(runAction(answer({ active: view(), sessionWorktreePath: "/trees/main" })))).toBe("Replace");
    expect(
      actionLabel(runAction(answer({ active: view({ worktreePath: "/trees/other" }), sessionWorktreePath: "/trees/main" }))),
    ).toBe("Switch to this tree");
    expect(actionLabel(runAction(answer({ active: view({ status: "unknown" }) })))).toBe("Release");
  });
});

describe("confirmation", () => {
  test("a first start asks nothing", () => {
    expect(confirmation(runAction(answer({})), "web dev")).toBeUndefined();
  });

  test("a takeover names both the run being stopped and the one replacing it", () => {
    const text = confirmation(runAction(answer({ active: view(), sessionWorktreePath: "/trees/main" })), "api");
    expect(text).toContain("web dev");
    expect(text).toContain("api");
  });

  test("a cross-worktree switch says which tree the running one came from", () => {
    // Without this sentence, "Switch" looks like restarting your own server.
    const text = confirmation(
      runAction(
        answer({
          active: view({ worktreePath: "/trees/feature-a", worktreeBranch: "feat/a" }),
          sessionWorktreePath: "/trees/main",
        }),
      ),
      "web dev",
    );
    expect(text).toContain("feature-a (feat/a)");
    expect(text).toContain("not this session's tree");
  });

  test("releasing says Telar will not signal it, and that the human must check", () => {
    // Release frees a slot and kills nothing. Someone who reads this as "stop"
    // will leave a server holding the port and blame Telar for the collision.
    const text = confirmation(runAction(answer({ active: view({ status: "unknown" }) })), "web dev");
    expect(text).toContain("will not signal");
    expect(text).toContain("checked");
  });
});
