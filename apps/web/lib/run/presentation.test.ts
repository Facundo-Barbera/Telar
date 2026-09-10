/**
 * The folds that decide what a human is told and what pressing the button does.
 * Every test here is about a wrong answer that would cost something real: a
 * silent takeover, a green dot over an unattributable check, a password typed
 * into a field that will refuse it only after the round trip.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  appendOutput,
  draftProblems,
  describeReadiness,
  droppedNotice,
  emptyOutput,
  recentRuns,
  runAction,
  statusDetail,
  statusLabel,
  statusTone,
  worktreeLabel,
  worktreeMismatch,
} from "./presentation";
import type { RunConfigurationDraft, RunStatusAnswer, RunView } from "./types";

function run(overrides: Partial<RunView> = {}): RunView {
  return {
    runId: "run_1",
    projectId: "proj_1",
    configId: "cfg_1",
    configName: "web dev",
    command: "bun run dev",
    worktreePath: "/trees/main",
    cwd: "/trees/main",
    startedAt: 1000,
    status: "running",
    readiness: { kind: "none" },
    ...overrides,
  };
}

const answer = (overrides: Partial<RunStatusAnswer> = {}): RunStatusAnswer => ({ history: [], ...overrides });

describe("runAction", () => {
  test("an idle project offers a plain start", () => {
    expect(runAction(answer())).toEqual({ kind: "start" });
  });

  test("a deployment from ANOTHER tree is a switch, never a quiet replace", () => {
    // The thing being replaced is somebody else's working state. Labelling this
    // "Start" would let one session stop another's server by pressing play.
    const active = run({ worktreePath: "/trees/feature" });
    const action = runAction(answer({ active, sessionWorktreePath: "/trees/main" }));
    expect(action).toEqual({ kind: "switch", active, from: "/trees/feature" });
    expect(worktreeMismatch(answer({ active, sessionWorktreePath: "/trees/main" }))).toBe(true);
  });

  test("a deployment from THIS tree is an ordinary replace", () => {
    const active = run();
    expect(runAction(answer({ active, sessionWorktreePath: "/trees/main" }))).toEqual({ kind: "replace", active });
    expect(worktreeMismatch(answer({ active, sessionWorktreePath: "/trees/main" }))).toBe(false);
  });

  test("a run Telar lost contact with offers release and nothing else", () => {
    // Not stop, not restart: there is nothing safe to signal. The only move is
    // a human saying "I checked, it is gone".
    const active = run({ status: "unknown", error: "still alive in its process group (4242)" });
    expect(runAction(answer({ active, sessionWorktreePath: "/trees/main" }))).toEqual({ kind: "release", active });
  });

  test("a run that is still starting is waited on, not replaced", () => {
    const active = run({ status: "starting" });
    expect(runAction(answer({ active, sessionWorktreePath: "/trees/main" })).kind).toBe("wait");
  });

  test("with no session worktree known, a live run is a replace rather than a switch", () => {
    // Claiming a mismatch we cannot establish would put a scary confirmation in
    // front of the ordinary case.
    const active = run({ worktreePath: "/trees/feature" });
    expect(runAction(answer({ active })).kind).toBe("replace");
  });
});

describe("status", () => {
  test("tone separates lost from failed", () => {
    // They render differently because they mean different things: one exited,
    // the other may still be holding the port.
    expect(statusTone("unknown")).toBe("lost");
    expect(statusTone("failed")).toBe("bad");
    expect(statusTone("ready")).toBe("good");
    expect(statusTone("exited")).toBe("idle");
  });

  test("a finished run is never labelled as still running", () => {
    expect(statusLabel(run({ status: "exited", exitCode: 0 }))).toBe("Exited");
    expect(statusLabel(run({ status: "exited", exitCode: 3 }))).toBe("Exited (3)");
    expect(statusLabel(run({ status: "unknown" }))).toBe("Lost contact");
  });

  test("the engine's error is shown as-is — it arrives already redacted", () => {
    expect(statusDetail(run({ status: "failed", error: "spawn failed: «redacted»" }))).toBe("spawn failed: «redacted»");
    expect(statusDetail(run({ status: "exited", signal: "SIGTERM" }))).toBe("Stopped by SIGTERM.");
    expect(statusDetail(run())).toBeUndefined();
  });
});

describe("describeReadiness", () => {
  test("an unattributable check explains itself instead of showing a dot", () => {
    const reason = "http://localhost:3000 was already answering before this run started.";
    expect(describeReadiness({ kind: "unattributable", reason }, "http://localhost:3000")).toBe(reason);
  });

  test("no check configured says nothing at all", () => {
    expect(describeReadiness({ kind: "none" })).toBeUndefined();
  });

  test("pending names the address being waited on", () => {
    expect(describeReadiness({ kind: "pending" }, "http://localhost:3000")).toContain("localhost:3000");
  });
});

describe("draftProblems", () => {
  const draft = (overrides: Partial<RunConfigurationDraft> = {}): RunConfigurationDraft => ({
    name: "web dev",
    command: "bun run dev",
    ...overrides,
  });

  test("a savable draft has nothing to say", () => {
    expect(draftProblems(draft())).toEqual([]);
  });

  test("a secret shorter than four characters is refused with the reason", () => {
    // Same rule as the engine: a two-character value cannot be scrubbed out of
    // captured output without mangling unrelated text.
    const problems = draftProblems(draft({ env: [{ key: "TOKEN", value: "ab", secret: true }] }));
    expect(problems).toHaveLength(1);
    expect(problems[0]!.field).toBe("env");
    expect(problems[0]!.message).toContain("4 characters");
  });

  test("the same short value is fine when it is not marked secret", () => {
    expect(draftProblems(draft({ env: [{ key: "MODE", value: "ab" }] }))).toEqual([]);
  });

  test("a multi-line secret is refused", () => {
    const problems = draftProblems(draft({ env: [{ key: "KEY", value: "line one\nline two", secret: true }] }));
    expect(problems.some((problem) => problem.message.includes("line break"))).toBe(true);
  });

  test("a readiness check must be http(s), and an absolute cwd is not relative", () => {
    expect(draftProblems(draft({ readinessUrl: "ftp://localhost" }))[0]!.field).toBe("readinessUrl");
    expect(draftProblems(draft({ readinessUrl: "http://localhost:3000" }))).toEqual([]);
    expect(draftProblems(draft({ cwd: "/etc" }))[0]!.field).toBe("cwd");
    expect(draftProblems(draft({ cwd: "apps/web" }))).toEqual([]);
  });

  test("an unnamed configuration, an empty command and a duplicate variable are all caught", () => {
    expect(draftProblems(draft({ name: "  " }))[0]!.field).toBe("name");
    expect(draftProblems(draft({ command: "" }))[0]!.field).toBe("command");
    const dupes = draftProblems(draft({ env: [{ key: "A", value: "1" }, { key: "A", value: "2" }] }));
    expect(dupes.some((problem) => problem.message.includes("twice"))).toBe(true);
  });
});

describe("appendOutput", () => {
  const line = (text: string) => ({ at: 1, stream: "stdout" as const, text });

  test("polls append, and the cursor is what the next poll asks from", () => {
    const first = appendOutput(emptyOutput, { lines: [line("a")], cursor: 1, dropped: 0 });
    const second = appendOutput(first, { lines: [line("b")], cursor: 2, dropped: 0 });
    expect(second.lines.map((entry) => entry.text)).toEqual(["a", "b"]);
    expect(second.cursor).toBe(2);
  });

  test("a cursor that went backwards is a NEW run, so the old log is replaced", () => {
    // A restart mints a new run whose output starts at zero. Appending would
    // show two servers' logs as one continuous one.
    const before = appendOutput(emptyOutput, { lines: [line("old-1"), line("old-2")], cursor: 2, dropped: 0 });
    const after = appendOutput(before, { lines: [line("new-1")], cursor: 1, dropped: 0 });
    expect(after.lines.map((entry) => entry.text)).toEqual(["new-1"]);
  });

  test("the buffer is bounded and the drop is reported rather than hidden", () => {
    const many = Array.from({ length: 12 }, (_, index) => line(`line-${index}`));
    const buffer = appendOutput(emptyOutput, { lines: many, cursor: 12, dropped: 30 }, 5);
    expect(buffer.lines).toHaveLength(5);
    expect(buffer.lines.at(-1)!.text).toBe("line-11");
    expect(droppedNotice(buffer)).toContain("30");
    expect(droppedNotice(emptyOutput)).toBeUndefined();
  });

  test("dropped is carried, not accumulated — the engine reports a total", () => {
    const first = appendOutput(emptyOutput, { lines: [], cursor: 1, dropped: 10 });
    expect(appendOutput(first, { lines: [], cursor: 2, dropped: 12 }).dropped).toBe(12);
  });
});

describe("history", () => {
  test("recent runs are newest first, whatever order they arrived in", () => {
    const answered = answer({
      history: [run({ runId: "run_old", startedAt: 1 }), run({ runId: "run_new", startedAt: 9 })],
    });
    expect(recentRuns(answered).map((entry) => entry.runId)).toEqual(["run_new", "run_old"]);
    expect(recentRuns(answered, 1)).toHaveLength(1);
  });

  test("the worktree label names the tree and its branch", () => {
    expect(worktreeLabel("/trees/feature-a/", "feat/x")).toBe("feature-a (feat/x)");
    expect(worktreeLabel("/trees/main")).toBe("main");
  });
});
