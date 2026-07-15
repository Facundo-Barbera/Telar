// M3 — landWorkingTree becomes branch-aware (via acceptLoom, the human-accept-
// only path). Uses an INJECTABLE scripted git runner so no real git runs and no
// tree is touched. Locks in: no consolidationBranch => identical add -A path;
// with a branch => --no-ff merge sets loom.commit; a failure is returned as a
// LandResult (never thrown); the land=false no-sweep guard short-circuits
// before any git call.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-landing-"));
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `telar-landing-proj-${projN}-`));
  return createProject(root, { name: `landing-${projN}` });
}

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

function builderAttempt(n = 1) {
  return { n, role: "dev", model: "m", startedAt: Date.now() };
}

describe("landWorkingTree is branch-aware (via acceptLoom)", () => {
  test("with consolidationBranch -> merges the branch --no-ff and records the merge sha", () => {
    const m = makeProject();
    const loom = createLoom({ project: m.name, kind: "custom", title: "woven root", prompt: "x", account: "personal" });
    loom.state = "ready";
    loom.consolidationBranch = `telar/${loom.id}`;
    saveLoom(loom);

    const { runner, calls } = scriptedGit({
      "rev-parse --is-inside-work-tree": { status: 0, stdout: "true", stderr: "" },
      "rev-list --count": { status: 0, stdout: "2", stderr: "" },
      "merge --no-ff": { status: 0, stdout: "", stderr: "" },
      "rev-parse HEAD": { status: 0, stdout: "mergesha123", stderr: "" },
    });

    const accepted = acceptLoom(loom.id, "alice", { git: runner });
    expect(accepted.state).toBe("done");
    expect(accepted.commit).toBe("mergesha123");

    // It merged the review branch — not `git add -A` of the shared tree.
    const merge = calls.find((c) => c.args[0] === "merge");
    expect(merge).toBeDefined();
    expect(merge!.args).toContain("--no-ff");
    expect(merge!.args).toContain(loom.consolidationBranch);
    expect(calls.some((c) => c.args[0] === "add")).toBe(false);
    expect(calls.some((c) => c.args[0] === "status")).toBe(false);

    const evs = readEvents(loom.id).events;
    expect(evs.some((e) => e.type === "committed" && (e as { sha?: string }).sha === "mergesha123")).toBe(true);
  });

  // L2 (contract v0.8) reverses the old "never thrown; loom still reaches
  // done" contract: a merge conflict means the accept produced no landing
  // evidence — it ABORTS loudly instead of silently reaching `done`.
  test("a merge conflict ABORTS the accept (L2) — thrown, no state change, accept-aborted recorded", () => {
    const m = makeProject();
    const loom = createLoom({ project: m.name, kind: "custom", title: "woven root", prompt: "x", account: "personal" });
    loom.state = "ready";
    loom.consolidationBranch = `telar/${loom.id}`;
    saveLoom(loom);

    const { runner } = scriptedGit({
      "rev-parse --is-inside-work-tree": { status: 0, stdout: "true", stderr: "" },
      "rev-list --count": { status: 0, stdout: "2", stderr: "" },
      "merge --no-ff": { status: 1, stdout: "", stderr: "CONFLICT (content): merge conflict" },
    });

    expect(() => acceptLoom(loom.id, "alice", { git: runner })).toThrow();
    expect(getLoom(loom.id)!.state).toBe("ready");
    expect(getLoom(loom.id)!.commit).toBeUndefined(); // no sha recorded
    const evs = readEvents(loom.id).events;
    expect(evs.some((e) => e.type === "accept-aborted")).toBe(true);
    expect(evs.some((e) => e.type === "commit-failed")).toBe(false);
  });

  test("regression: NO consolidationBranch -> the identical add -A + commit path", () => {
    const m = makeProject();
    const loom = createLoom({ project: m.name, kind: "custom", title: "plain", prompt: "x", account: "personal" });
    loom.state = "ready";
    loom.attempts = [builderAttempt()]; // produced build output
    saveLoom(loom);

    const { runner, calls } = scriptedGit({
      "rev-parse --is-inside-work-tree": { status: 0, stdout: "true", stderr: "" },
      "status --porcelain": { status: 0, stdout: " M a.txt", stderr: "" },
      "rev-parse HEAD": { status: 0, stdout: "plainsha", stderr: "" },
    });

    const accepted = acceptLoom(loom.id, "bob", { git: runner });
    expect(accepted.commit).toBe("plainsha");
    expect(calls.some((c) => c.args[0] === "add" && c.args[1] === "-A")).toBe(true);
    expect(calls.some((c) => c.args[0] === "merge")).toBe(false);
  });

  // L3 (contract v0.8) — a bare accept on a non-ready loom now throws; a
  // stranded loom is closed via a deliberate override naming what's missing.
  test("no-sweep: a stranded loom (no build output, no branch), override accept, makes NO git call", () => {
    const m = makeProject();
    const loom = createLoom({ project: m.name, kind: "custom", title: "stranded", prompt: "x", account: "personal" });
    loom.state = "queued"; // never built, no consolidationBranch
    saveLoom(loom);

    const { runner, calls } = scriptedGit({});
    const accepted = acceptLoom(loom.id, "carol", { override: true, missing: "never built", git: runner });
    expect(accepted.state).toBe("done"); // audited override close
    expect(accepted.acceptedOverride).toBe(true);
    expect(calls.length).toBe(0); // no-sweep guard short-circuited before any git call
    const evs = readEvents(loom.id).events;
    expect(evs.some((e) => e.type === "commit-skipped")).toBe(true);
  });
});
