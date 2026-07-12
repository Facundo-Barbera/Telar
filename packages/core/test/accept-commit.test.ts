// docs/loom-model.md §A — acceptance LANDS the work: on ready->done acceptLoom
// commits the project working tree. Uses an INJECTABLE git runner so no real
// git process runs and no working tree is touched.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-accept-commit-"));
process.env.TELAR_HOME = home;
beforeEach(() => {
  process.env.TELAR_HOME = home;
});

const { acceptLoom, createLoom, getLoom, readEvents, saveLoom } = await import("../src/looms");
import type { GitRunner, GitRunResult } from "../src/looms";
const { createProject } = await import("../src/manifest");

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

let projN = 0;
function makeProject() {
  projN++;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `telar-accept-commit-proj-${projN}-`));
  const m = createProject(root, { name: `accept-commit-${projN}` });
  return m;
}

// A builder attempt — the thing that actually writes the shared project tree.
// A loom with one PRODUCED build output, so landWorkingTree runs `add -A`/commit.
function builderAttempt(n = 1) {
  return { n, role: "dev", model: "m", startedAt: Date.now() };
}

function readyLoom(project: string, title = "land it") {
  const loom = createLoom({ project, kind: "custom", title, prompt: "x", account: "personal" });
  loom.state = "ready";
  loom.attempts = [builderAttempt()]; // a real green loom built before it went ready
  saveLoom(loom);
  return loom;
}

// A scripted git runner: maps the first argv token to a canned result and
// records every invocation for assertions.
function scriptedGit(script: Partial<Record<string, GitRunResult>>) {
  const calls: { root: string; args: string[] }[] = [];
  const runner: GitRunner = (root, args) => {
    calls.push({ root, args });
    const key = args[0]!;
    const sub = args[1];
    return script[`${key} ${sub}`] ?? script[key] ?? { status: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

describe("acceptLoom lands the work (§A)", () => {
  test("git repo WITH changes -> commits, records sha on loom + 'committed' event, no fake author", () => {
    const m = makeProject();
    const loom = readyLoom(m.name);
    const { runner, calls } = scriptedGit({
      "rev-parse --is-inside-work-tree": { status: 0, stdout: "true\n", stderr: "" },
      "status --porcelain": { status: 0, stdout: " M src/foo.ts\n", stderr: "" },
      "rev-parse HEAD": { status: 0, stdout: "abc123def\n", stderr: "" },
    });

    const accepted = acceptLoom(loom.id, "alice", { git: runner });
    expect(accepted.state).toBe("done");
    expect(accepted.commit).toBe("abc123def");
    expect(getLoom(loom.id)!.commit).toBe("abc123def");

    // git add -A then git commit -m <msg>, message carries id/title/by, no --author
    const commitCall = calls.find((c) => c.args[0] === "commit")!;
    expect(calls.some((c) => c.args[0] === "add" && c.args[1] === "-A")).toBe(true);
    expect(commitCall.args).not.toContain("--author");
    const msg = commitCall.args[commitCall.args.indexOf("-m") + 1];
    expect(msg).toContain(`feat(loom): land it`);
    expect(msg).toContain(`Loom: ${loom.id}`);
    expect(msg).toContain(`Accepted-by: alice`);

    const { events } = readEvents(loom.id);
    const committed = events.filter((e) => e.type === "committed");
    expect(committed.length).toBe(1);
    expect(committed[0]!.sha).toBe("abc123def");
  });

  test("a woven root (ready, NO builder attempt) LANDS its consolidationBranch via --no-ff merge", () => {
    const m = makeProject();
    const loom = readyLoom(m.name);
    // A woven root orchestrates children — no builder attempt of its own — but it
    // OWNS a consolidationBranch, which IS its deliverable. Under the E1 clean-
    // accept guard producedBuildOutput is true because of that branch, so it still
    // lands (via the --no-ff merge path, not `git add -A` of the shared tree).
    loom.attempts = [];
    loom.consolidationBranch = `telar/${loom.id}`;
    saveLoom(loom);
    const { runner, calls } = scriptedGit({
      "rev-parse --is-inside-work-tree": { status: 0, stdout: "true\n", stderr: "" },
      "rev-parse HEAD": { status: 0, stdout: "wovensha\n", stderr: "" },
    });

    const accepted = acceptLoom(loom.id, "alice", { git: runner });
    expect(accepted.state).toBe("done");
    expect(accepted.commit).toBe("wovensha");
    const mergeCall = calls.find((c) => c.args[0] === "merge")!;
    expect(mergeCall.args).toContain("--no-ff");
    expect(mergeCall.args).toContain(loom.consolidationBranch);
    // Branch landing never `git add -A`s the shared tree.
    expect(calls.some((c) => c.args[0] === "add")).toBe(false);
  });

  // B1 (blocker) — the DEFAULT flag-off path: a woven ROOT has NO builder
  // attempt of its own (only an ALL-scope integration verify) and, isolation
  // OFF, NO consolidationBranch/worktree — its CHILD built directly into the
  // SHARED tree. Accepting the root is the SOLE landing of that child's work, so
  // producedBuildOutput must recurse into the subtree and land via `git add -A`
  // + commit. (Pre-recursion this returned false and the child's work was never
  // committed on accept — the regression this test pins.)
  test("FLAG-OFF woven root (no builder attempt, no branch) LANDS its done child's shared-tree work via add -A + commit", () => {
    const m = makeProject();
    // ROOT: ready, only a verify-only integration attempt of its own, no branch.
    const root = createLoom({ project: m.name, kind: "custom", title: "woven flag-off", prompt: "x", account: "personal" });
    root.state = "ready";
    root.attempts = [{ n: 1, role: "integration", model: "m", startedAt: Date.now() }];
    saveLoom(root);
    // CHILD: a done thread with a real dev builder attempt that touched the shared tree.
    const child = createLoom({ project: m.name, kind: "custom", title: "child", prompt: "x", account: "personal", parentLoomId: root.id });
    child.state = "done";
    child.attempts = [builderAttempt()];
    saveLoom(child);

    const { runner, calls } = scriptedGit({
      "rev-parse --is-inside-work-tree": { status: 0, stdout: "true\n", stderr: "" },
      "status --porcelain": { status: 0, stdout: " M src/child.ts\n", stderr: "" },
      "rev-parse HEAD": { status: 0, stdout: "childsha\n", stderr: "" },
    });

    const accepted = acceptLoom(root.id, "alice", { git: runner });
    expect(accepted.state).toBe("done");
    // The child's subtree work is committed on the root's accept.
    expect(calls.some((c) => c.args[0] === "add" && c.args[1] === "-A")).toBe(true);
    expect(calls.some((c) => c.args[0] === "commit")).toBe(true);
    expect(accepted.commit).toBe("childsha");
    expect(getLoom(root.id)!.commit).toBe("childsha");
  });

  // E1 clean-accept guard (the clean-path mirror of the override no-sweep cases
  // at 222 & 244): a verify-only / never-built loom that reached `ready` (a green
  // verify with no builder attempt, no consolidationBranch, no worktree) produced
  // NO build output, so a CLEAN accept must land NOTHING — the git runner is never
  // invoked, so `git add -A` can't sweep the user's unrelated dirty files. It
  // still reaches `done` with a commit-skipped record.
  test("a verify-only/never-built ready loom lands NOTHING — git never invoked, still done + commit-skipped", () => {
    const m = makeProject();
    const loom = createLoom({ project: m.name, kind: "custom", title: "t", prompt: "x", account: "personal" });
    loom.state = "ready";
    loom.attempts = [{ n: 1, role: "verifier", model: "m", startedAt: Date.now() }]; // verify-only -> no build output
    saveLoom(loom);
    const { runner, calls } = scriptedGit({});

    const accepted = acceptLoom(loom.id, "alice", { git: runner });
    // A CLEAN accept from `ready` (NOT an audited override), but still no landing.
    expect(accepted.state).toBe("done");
    expect(accepted.acceptedOverride).toBeUndefined();
    expect(accepted.commit).toBeUndefined();
    // producedBuildOutput false -> land=false -> the no-build-output guard short-
    // circuits before ANY git command.
    expect(calls.length).toBe(0);

    const { events } = readEvents(loom.id);
    // clean accept event carries no override flag
    expect(events.some((e) => e.type === "accepted" && !("override" in e))).toBe(true);
    expect(events.some((e) => e.type === "commit-skipped")).toBe(true);
    expect(events.some((e) => e.type === "committed")).toBe(false);
  });

  test("clean tree -> skips commit gracefully, still transitions to done, no commit sha", () => {
    const m = makeProject();
    const loom = readyLoom(m.name);
    const { runner, calls } = scriptedGit({
      "rev-parse --is-inside-work-tree": { status: 0, stdout: "true\n", stderr: "" },
      "status --porcelain": { status: 0, stdout: "\n", stderr: "" },
    });

    const accepted = acceptLoom(loom.id, "alice", { git: runner });
    expect(accepted.state).toBe("done");
    expect(accepted.commit).toBeUndefined();
    expect(calls.some((c) => c.args[0] === "commit")).toBe(false);

    const { events } = readEvents(loom.id);
    expect(events.some((e) => e.type === "commit-skipped")).toBe(true);
    expect(events.some((e) => e.type === "committed")).toBe(false);
  });

  test("not a git repo -> skips gracefully, still done", () => {
    const m = makeProject();
    const loom = readyLoom(m.name);
    const { runner, calls } = scriptedGit({
      "rev-parse --is-inside-work-tree": { status: 128, stdout: "", stderr: "not a git repository" },
    });

    const accepted = acceptLoom(loom.id, "alice", { git: runner });
    expect(accepted.state).toBe("done");
    expect(accepted.commit).toBeUndefined();
    expect(calls.some((c) => c.args[0] === "status")).toBe(false);
  });

  test("commit failure -> recorded on the loom, NEVER thrown, still done", () => {
    const m = makeProject();
    const loom = readyLoom(m.name);
    const { runner } = scriptedGit({
      "rev-parse --is-inside-work-tree": { status: 0, stdout: "true\n", stderr: "" },
      "status --porcelain": { status: 0, stdout: " M a\n", stderr: "" },
      commit: { status: 1, stdout: "", stderr: "nothing to commit / author unknown" },
    });

    let accepted: ReturnType<typeof acceptLoom> | undefined;
    expect(() => {
      accepted = acceptLoom(loom.id, "alice", { git: runner });
    }).not.toThrow();
    expect(accepted!.state).toBe("done");
    expect(accepted!.commit).toBeUndefined();

    const { events } = readEvents(loom.id);
    const failed = events.filter((e) => e.type === "commit-failed");
    expect(failed.length).toBe(1);
    expect(String(failed[0]!.error)).toContain("git commit failed");
  });

  test("a git runner that THROWS never escapes accept", () => {
    const m = makeProject();
    const loom = readyLoom(m.name);
    const runner: GitRunner = () => {
      throw new Error("boom");
    };
    let accepted: ReturnType<typeof acceptLoom> | undefined;
    expect(() => {
      accepted = acceptLoom(loom.id, "alice", { git: runner });
    }).not.toThrow();
    expect(accepted!.state).toBe("done");
    const { events } = readEvents(loom.id);
    expect(events.some((e) => e.type === "commit-failed")).toBe(true);
  });

  test("override accept (explicit cosign, `failed`) also lands the work", () => {
    const m = makeProject();
    const loom = createLoom({ project: m.name, kind: "custom", title: "red land", prompt: "x", account: "personal" });
    loom.state = "failed";
    loom.attempts = [builderAttempt()]; // it BUILT, then failed verification -> has output to land
    saveLoom(loom);
    const { runner } = scriptedGit({
      "rev-parse --is-inside-work-tree": { status: 0, stdout: "true\n", stderr: "" },
      "status --porcelain": { status: 0, stdout: " M a\n", stderr: "" },
      "rev-parse HEAD": { status: 0, stdout: "deadbeef\n", stderr: "" },
    });

    const accepted = acceptLoom(loom.id, "alice", { override: true, cosignedBy: "bob", git: runner });
    expect(accepted.state).toBe("done");
    expect(accepted.acceptedOverride).toBe(true);
    expect(accepted.commit).toBe("deadbeef");
  });

  // P5 (docs/loom-model.md §A/§M): an OWNER OVERRIDE from needs-review still
  // LANDS the work — no cosign required — recording it as an audited override.
  test("owner override accept from `needs-review` lands the work (no cosign)", () => {
    const m = makeProject();
    const loom = createLoom({ project: m.name, kind: "custom", title: "review land", prompt: "x", account: "personal" });
    loom.state = "needs-review";
    loom.attempts = [builderAttempt()]; // it BUILT before verification flagged it -> has output to land
    saveLoom(loom);
    const { runner } = scriptedGit({
      "rev-parse --is-inside-work-tree": { status: 0, stdout: "true\n", stderr: "" },
      "status --porcelain": { status: 0, stdout: " M a\n", stderr: "" },
      "rev-parse HEAD": { status: 0, stdout: "cafef00d\n", stderr: "" },
    });

    const accepted = acceptLoom(loom.id, "alice", { git: runner });
    expect(accepted.state).toBe("done");
    expect(accepted.acceptedOverride).toBe(true);
    expect(accepted.commit).toBe("cafef00d");

    const { events } = readEvents(loom.id);
    expect(events.some((e) => e.type === "accepted" && e.override === true)).toBe(true);
    expect(events.some((e) => e.type === "committed" && e.sha === "cafef00d")).toBe(true);
  });

  // #55 Fix 2 (no-sweep landing): a stranded loom that produced NO build output
  // (no builder attempt) must land NOTHING — the git runner must never see a
  // status/add/commit, so `git add -A` can't sweep the user's unrelated dirty
  // files. It still reaches `done` as an audited override.
  test("a stranded `queued` loom (no build output) lands NOTHING — no git status/add/commit", () => {
    const m = makeProject();
    const loom = createLoom({ project: m.name, kind: "custom", title: "t", prompt: "x", account: "personal" });
    // state stays `queued`; attempts: [] -> produced no build output
    const { runner, calls } = scriptedGit({});

    const accepted = acceptLoom(loom.id, "alice", { git: runner });
    expect(accepted.state).toBe("done");
    expect(accepted.acceptedOverride).toBe(true);
    expect(accepted.commit).toBeUndefined();
    // The git runner is NEVER invoked — the no-build-output guard short-circuits
    // before any git command, so nothing in the shared tree is touched.
    expect(calls.length).toBe(0);

    const { events } = readEvents(loom.id);
    expect(events.some((e) => e.type === "accepted" && e.override === true && e.fromState === "queued")).toBe(true);
    expect(events.some((e) => e.type === "commit-skipped")).toBe(true);
    expect(events.some((e) => e.type === "committed")).toBe(false);
  });

  // A `failed` loom that NEVER built (verify-only / abandoned before any builder
  // attempt) is the same no-sweep case: audited override, but zero git activity.
  test("a `failed` loom with no build output lands NOTHING and reaches done as an audited override", () => {
    const m = makeProject();
    const loom = createLoom({ project: m.name, kind: "custom", title: "t", prompt: "x", account: "personal" });
    loom.state = "failed";
    loom.attempts = [{ n: 1, role: "verifier", model: "m", startedAt: Date.now() }]; // verify-only -> no build output
    saveLoom(loom);
    const { runner, calls } = scriptedGit({});

    const accepted = acceptLoom(loom.id, "alice", { git: runner });
    expect(accepted.state).toBe("done");
    expect(accepted.acceptedOverride).toBe(true);
    expect(calls.length).toBe(0);
    expect(getLoom(loom.id)!.commit).toBeUndefined();
  });

  // CA2 (override no-sweep hole): a kind=verify loom demoted to `needs-review`
  // produced NO build output (a verify-only attempt, no building children). The
  // override accept must NOT re-open the E1 sweep — pre-fix the trailing
  // `fromState === "needs-review"` clause forced land=true and `git add -A`
  // swept the user's unrelated dirty files. With `land = producedBuildOutput`
  // and no building subtree it lands NOTHING: git is never invoked.
  test("verify-only loom in `needs-review` OVERRIDE lands NOTHING — git add -A never runs (CA2)", () => {
    const m = makeProject();
    const loom = createLoom({ project: m.name, kind: "verify", title: "verify demoted", prompt: "x", account: "personal" });
    loom.state = "needs-review";
    loom.attempts = [{ n: 1, role: "verifier", model: "m", startedAt: Date.now() }]; // verify-only -> no build output
    saveLoom(loom);
    // Shared tree is DIRTY, but the guard must short-circuit before any git call.
    const { runner, calls } = scriptedGit({
      "rev-parse --is-inside-work-tree": { status: 0, stdout: "true\n", stderr: "" },
      "status --porcelain": { status: 0, stdout: " M unrelated.ts\n", stderr: "" },
    });

    const accepted = acceptLoom(loom.id, "alice", { git: runner });
    expect(accepted.state).toBe("done");
    expect(accepted.acceptedOverride).toBe(true);
    expect(accepted.commit).toBeUndefined();
    // No git activity at all — no status, no add -A, no commit.
    expect(calls.length).toBe(0);

    const { events } = readEvents(loom.id);
    expect(events.some((e) => e.type === "accepted" && e.override === true && e.fromState === "needs-review")).toBe(true);
    expect(events.some((e) => e.type === "commit-skipped")).toBe(true);
    expect(events.some((e) => e.type === "committed")).toBe(false);
  });
});
