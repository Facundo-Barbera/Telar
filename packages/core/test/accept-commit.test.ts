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

function readyLoom(project: string, title = "land it") {
  const loom = createLoom({ project, kind: "custom", title, prompt: "x", account: "personal" });
  loom.state = "ready";
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

  test("override accept (non-ready) also lands the work", () => {
    const m = makeProject();
    const loom = createLoom({ project: m.name, kind: "custom", title: "red land", prompt: "x", account: "personal" });
    loom.state = "needs-review";
    saveLoom(loom);
    const { runner } = scriptedGit({
      "rev-parse --is-inside-work-tree": { status: 0, stdout: "true\n", stderr: "" },
      "status --porcelain": { status: 0, stdout: " M a\n", stderr: "" },
      "rev-parse HEAD": { status: 0, stdout: "deadbeef\n", stderr: "" },
    });

    const accepted = acceptLoom(loom.id, "alice", { override: true, cosignedBy: "bob", git: runner });
    expect(accepted.state).toBe("done");
    expect(accepted.commit).toBe("deadbeef");
  });

  // §A moat invariant: `done` is reachable ONLY via acceptLoom, and only from
  // ready (or override+cosign). Landing the work must not weaken that gate.
  test("a non-ready loom without a co-sign still cannot reach done (no commit attempted)", () => {
    const m = makeProject();
    const loom = createLoom({ project: m.name, kind: "custom", title: "t", prompt: "x", account: "personal" });
    loom.state = "needs-review";
    saveLoom(loom);
    const { runner, calls } = scriptedGit({});
    expect(() => acceptLoom(loom.id, "alice", { git: runner })).toThrow(/override co-sign/);
    expect(getLoom(loom.id)!.state).toBe("needs-review");
    expect(calls.length).toBe(0);
  });
});
