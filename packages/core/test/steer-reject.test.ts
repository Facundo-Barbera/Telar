// docs/loom-model.md §A — from `ready` the owner may STEER or REJECT; both
// re-enter the verified loop and never auto-promote to `done`. A fake
// runLoomFn stands in for the executor so no real agent runs.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-steer-reject-"));
process.env.TELAR_HOME = home;
beforeEach(() => {
  process.env.TELAR_HOME = home;
});

const { rejectLoom, steerLoom } = await import("../src/dispatcher");
const { createLoom, getLoom, readEvents, saveLoom } = await import("../src/looms");
const { readBundleFile } = await import("../src/bundle");
const { createProject } = await import("../src/manifest");
import type { Loom } from "../src/looms";

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

let n = 0;
function makeProject() {
  n++;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `telar-steer-reject-proj-${n}-`));
  return createProject(root, { name: `steer-reject-${n}` });
}

function loomInState(project: string, state: Loom["state"]) {
  const loom = createLoom({ project, kind: "custom", title: "t", prompt: "base prompt", account: "personal" });
  loom.state = state;
  saveLoom(loom);
  return loom;
}

// dispatchExecution invokes runLoomFn synchronously (its async body runs up to
// the first await immediately), so `calls` is incremented before steer/reject
// returns — the re-dispatch is observable without awaiting the background chain.
function fakeDeps() {
  let calls = 0;
  const runLoomFn = async (l: Loom) => {
    calls++;
    l.state = "ready"; // simulate the verified loop re-landing at ready
    return l;
  };
  return { deps: { accounts: {}, runLoomFn } as any, get calls() { return calls; } };
}

describe("steerLoom (§A)", () => {
  test("from ready: records directive, re-dispatches, re-enters the loop, never done", async () => {
    const m = makeProject();
    const loom = loomInState(m.name, "ready");
    const f = fakeDeps();

    const out = await steerLoom(loom.id, "focus on error handling", "you", f.deps);

    expect(f.calls).toBe(1);
    expect(out.state).not.toBe("done");
    expect(out.prompt).toContain("Steering directive");
    expect(out.prompt).toContain("focus on error handling");

    const { events } = readEvents(loom.id);
    const steered = events.filter((e) => e.type === "steered");
    expect(steered.length).toBe(1);
    expect(steered[0]!.directive).toBe("focus on error handling");
    expect(steered[0]!.by).toBe("you");

    expect(readBundleFile(loom.id, "steering.md")).toContain("focus on error handling");
  });

  test("also valid from needs-review (answer & resume, re-verifies)", async () => {
    const m = makeProject();
    const loom = loomInState(m.name, "needs-review");
    const f = fakeDeps();
    const out = await steerLoom(loom.id, "the answer is: use utf-8", "you", f.deps);
    expect(f.calls).toBe(1); // re-dispatched into the verified loop
    expect(out.state).not.toBe("done");
    expect(out.prompt).toContain("the answer is: use utf-8");
    const { events } = readEvents(loom.id);
    expect(events.filter((e) => e.type === "steered").length).toBe(1);
  });

  test("invalid from states other than ready / needs-review", async () => {
    const m = makeProject();
    for (const state of ["running", "queued", "done", "blocked"] as const) {
      const loom = loomInState(m.name, state);
      await expect(steerLoom(loom.id, "d", "you", fakeDeps().deps)).rejects.toThrow(/only valid from 'ready' or 'needs-review'/);
      expect(getLoom(loom.id)!.state).toBe(state);
    }
  });

  test("blank directive / blank by rejected", async () => {
    const m = makeProject();
    const loom = loomInState(m.name, "ready");
    await expect(steerLoom(loom.id, "  ", "you", fakeDeps().deps)).rejects.toThrow(/directive/);
    await expect(steerLoom(loom.id, "d", "  ", fakeDeps().deps)).rejects.toThrow(/non-blank/);
  });

  test("missing loom throws", async () => {
    await expect(steerLoom("loom_nope", "d", "you", fakeDeps().deps)).rejects.toThrow(/not found/);
  });
});

describe("rejectLoom (§A)", () => {
  test("from ready: records feedback, re-dispatches, never done", async () => {
    const m = makeProject();
    const loom = loomInState(m.name, "ready");
    const f = fakeDeps();

    const out = await rejectLoom(loom.id, "the empty state is missing", "you", f.deps);

    expect(f.calls).toBe(1);
    expect(out.state).not.toBe("done");
    expect(out.prompt).toContain("Rejection feedback");

    const { events } = readEvents(loom.id);
    const rejected = events.filter((e) => e.type === "rejected");
    expect(rejected.length).toBe(1);
    expect(rejected[0]!.feedback).toBe("the empty state is missing");
    expect(rejected[0]!.by).toBe("you");
    expect(readBundleFile(loom.id, "steering.md")).toContain("the empty state is missing");
  });

  test("also valid from blocked", async () => {
    const m = makeProject();
    const loom = loomInState(m.name, "blocked");
    const f = fakeDeps();
    const out = await rejectLoom(loom.id, "unblock: use the staging db", "you", f.deps);
    expect(f.calls).toBe(1);
    expect(out.state).not.toBe("done");
  });

  test("also valid from needs-review (reject unverified work, re-verifies)", async () => {
    const m = makeProject();
    const loom = loomInState(m.name, "needs-review");
    const f = fakeDeps();
    const out = await rejectLoom(loom.id, "wrong approach, redo it", "you", f.deps);
    expect(f.calls).toBe(1);
    expect(out.state).not.toBe("done");
    expect(out.prompt).toContain("wrong approach, redo it");
    const { events } = readEvents(loom.id);
    expect(events.filter((e) => e.type === "rejected").length).toBe(1);
  });

  test("invalid from other states", async () => {
    const m = makeProject();
    for (const state of ["running", "queued", "done"] as const) {
      const loom = loomInState(m.name, state);
      await expect(rejectLoom(loom.id, "f", "you", fakeDeps().deps)).rejects.toThrow(/only valid from 'ready', 'blocked', or 'needs-review'/);
    }
  });

  test("blank feedback rejected", async () => {
    const m = makeProject();
    const loom = loomInState(m.name, "ready");
    await expect(rejectLoom(loom.id, "   ", "you", fakeDeps().deps)).rejects.toThrow(/feedback/);
  });
});
