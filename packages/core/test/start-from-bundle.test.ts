import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-start-from-bundle-"));
process.env.TELAR_HOME = home;
// bun test runs all files in one process — re-pin the env before every test
beforeEach(() => {
  process.env.TELAR_HOME = home;
});

const { createDraftLoom, startLoomFromBundle } = await import("../src/dispatcher");
const { getLoom, isListableLoom, readEvents, saveLoom } = await import("../src/looms");
const { quickBundle, readProvenance, writeBundleFile } = await import("../src/bundle");
const { createProject } = await import("../src/manifest");

const projRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-start-from-bundle-proj-"));

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(projRoot, { recursive: true, force: true });
});

function makeProject(name: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `telar-start-from-bundle-${name}-`));
  // devCommand keeps the lane viable past the now-unconditional pre-flight gate
  // so dispatch proceeds; these tests exercise the bundle/weave path, not the
  // no-target floor.
  return createProject(root, { name, devCommand: "bun run dev" });
}

// startLoomFromBundle now runs the AI weave-planner before dispatch, so the
// dispatch is deferred behind an await. Every test injects a fake planWeaveFn
// (no live model) that returns a NON-weaving charter, so behavior stays on the
// single-builder path these tests already exercised.
const fakePlanNonWoven = (async () => ({
  objective: "x",
  proofStrategy: "verifier-criteria",
  scope: { allowedPaths: [], forbiddenPaths: [] },
  budget: { maxParallelThreads: 3, maxAgents: 12, maxCriticAgents: 3 },
  decomposition: [],
  version: 1,
})) as any;

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!pred() && Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("createDraftLoom", () => {
  test("yields a draft loom that is queued, not dispatched, and unlisted", () => {
    const manifest = makeProject("draft-basic");
    const loom = createDraftLoom({ project: manifest.name, title: "t", objective: "do the thing" });

    expect(loom.draft).toBe(true);
    expect(loom.state).toBe("queued");
    expect(loom.prompt).toBe("do the thing");
    expect(isListableLoom(loom)).toBe(false);

    const reloaded = getLoom(loom.id)!;
    expect(reloaded.draft).toBe(true);
  });
});

describe("startLoomFromBundle", () => {
  test("throws on a missing loom", async () => {
    await expect(startLoomFromBundle("loom_nope", "alice", { accounts: {} })).rejects.toThrow();
  });

  test("throws on a non-draft loom", async () => {
    const manifest = makeProject("not-draft");
    const loom = createDraftLoom({ project: manifest.name, title: "t", objective: "obj" });
    loom.draft = false;
    saveLoom(loom);

    await expect(startLoomFromBundle(loom.id, "alice", { accounts: {} })).rejects.toThrow(
      /not a draft awaiting start/,
    );
  });

  test("throws when the bundle has no contract", async () => {
    const manifest = makeProject("no-contract");
    const loom = createDraftLoom({ project: manifest.name, title: "t", objective: "obj" });

    await expect(startLoomFromBundle(loom.id, "alice", { accounts: {} })).rejects.toThrow(
      /no valid verification contract/,
    );
  });

  test("throws when the bundle has a prose-only (invalid) contract", async () => {
    const manifest = makeProject("prose-contract");
    const loom = createDraftLoom({ project: manifest.name, title: "t", objective: "obj" });
    writeBundleFile(
      loom.id,
      "contract.json",
      JSON.stringify({
        version: 1,
        assertions: [{ id: "a1", description: "should work", type: "value-equality", blocker: true }],
      }),
    );

    await expect(startLoomFromBundle(loom.id, "alice", { accounts: {} })).rejects.toThrow(
      /no valid verification contract/,
    );
  });

  test("throws when `by` is blank (provenance gate)", async () => {
    const manifest = makeProject("blank-by");
    const loom = createDraftLoom({ project: manifest.name, title: "t", objective: "obj" });
    quickBundle(loom.id, {
      objective: "obj",
      assertions: [{ id: "a1", description: "checks x", type: "contains", expected: "hi", blocker: true }],
      provenance: { approvedBy: "planner-session", humanApprovedAt: Date.now() },
    });

    await expect(startLoomFromBundle(loom.id, "  ", { accounts: {} })).rejects.toThrow();
  });

  test("valid draft: writes provenance, flips draft off, appends started, dispatches once", async () => {
    const manifest = makeProject("valid-start");
    const loom = createDraftLoom({ project: manifest.name, title: "t", objective: "fix the thing" });
    quickBundle(loom.id, {
      objective: "fix the thing",
      assertions: [{ id: "a1", description: "checks x", type: "contains", expected: "hi", blocker: true }],
      provenance: { approvedBy: "planner-session", humanApprovedAt: Date.now() },
    });

    let calls = 0;
    const fakeRunLoom = async (l: any) => {
      calls++;
      l.state = "done";
      return l;
    };

    const started = await startLoomFromBundle(loom.id, "alice", {
      accounts: {},
      planWeaveFn: fakePlanNonWoven,
      runLoomFn: fakeRunLoom as any,
    });
    // Dispatch is deferred behind the (fake) weave-planner — wait for it.
    await waitFor(() => calls === 1);

    expect(started.draft).toBe(false);
    expect(calls).toBe(1);
    // §M.1/§M.2: sticky once the CONTRACT GATE passes, so a contract that
    // later goes missing/invalid is a hard failure, never a silent fallback
    // to the legacy no-panel path (see executor.ts's runVerification).
    expect(started.contractRequired).toBe(true);

    const { provenance, errors } = readProvenance(loom.id);
    expect(errors).toEqual([]);
    expect(provenance?.approvedBy).toBe("alice");

    const { events } = readEvents(loom.id);
    expect(events.some((e) => e.type === "started" && e.by === "alice")).toBe(true);

    expect(isListableLoom(started)).toBe(true);
    expect(getLoom(loom.id)!.contractRequired).toBe(true);
  });

  // docs/loom-model.md §M.8: the draft->started flip has no lock/CAS across
  // OS processes — this closes that gap with an O_EXCL sentinel file. Within
  // a single process, startLoomFromBundle has no `await` before the sentinel
  // write, so two real calls can't actually race each other here; this test
  // instead proves the sentinel itself blocks a second start outright, even
  // if a racing reader's stale view of loom.json still says draft:true.
  test("a stale .started sentinel blocks a second start even if draft gets reset back to true (cross-process guard)", async () => {
    const manifest = makeProject("concurrent-start");
    const loom = createDraftLoom({ project: manifest.name, title: "t", objective: "fix the thing" });
    quickBundle(loom.id, {
      objective: "fix the thing",
      assertions: [{ id: "a1", description: "checks x", type: "contains", expected: "hi", blocker: true }],
      provenance: { approvedBy: "planner-session", humanApprovedAt: Date.now() },
    });

    const fakeRunLoom = async (l: any) => {
      l.state = "done";
      return l;
    };

    const started = await startLoomFromBundle(loom.id, "alice", {
      accounts: {},
      planWeaveFn: fakePlanNonWoven,
      runLoomFn: fakeRunLoom as any,
    });
    expect(started.draft).toBe(false);

    // Simulate a second process that read loom.json before the winner's
    // draft:false write landed (or an accidental external reset).
    const stale = getLoom(loom.id)!;
    stale.draft = true;
    saveLoom(stale);

    await expect(
      startLoomFromBundle(loom.id, "bob", {
        accounts: {},
        planWeaveFn: fakePlanNonWoven,
        runLoomFn: fakeRunLoom as any,
      }),
    ).rejects.toThrow(/concurrent start/);
  });
});
