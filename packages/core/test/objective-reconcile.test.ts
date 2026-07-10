import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-objective-reconcile-"));
process.env.TELAR_HOME = home;
// bun test runs all files in one process — re-pin the env before every test
beforeEach(() => {
  process.env.TELAR_HOME = home;
});

const { createDraftLoom, startLoomFromBundle, updateDraftObjectiveFromBundle } = await import("../src/dispatcher");
const { getLoom, saveLoom } = await import("../src/looms");
const { writeBundleFile, quickBundle, specDir } = await import("../src/bundle");
const { createProject } = await import("../src/manifest");

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function makeProject(name: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `telar-objective-reconcile-${name}-`));
  return createProject(root, { name });
}

const fakeRunLoom = async (l: any) => {
  l.state = "done";
  return l;
};

// startLoomFromBundle now runs the AI weave-planner before dispatch; inject a
// fake that returns a NON-weaving charter so these gate tests stay on the
// single-builder path (and never touch a live model).
const fakePlanNonWoven = (async () => ({
  objective: "x",
  proofStrategy: "verifier-criteria",
  scope: { allowedPaths: [], forbiddenPaths: [] },
  budget: { maxParallelThreads: 3, maxAgents: 12, maxCriticAgents: 3 },
  decomposition: [],
  version: 1,
})) as any;

describe("updateDraftObjectiveFromBundle", () => {
  test("overwrites the provisional seed prompt/title from objective.md", () => {
    const manifest = makeProject("reconcile-basic");
    const loom = createDraftLoom({
      project: manifest.name,
      title: "lets work on #109, please draft the loom",
      objective: "lets work on #109, please draft the loom",
    });

    writeBundleFile(
      loom.id,
      "objective.md",
      "# Add rate limiting to the public API\n\nReject requests over 100/min per IP with a 429 and a Retry-After header.",
    );
    updateDraftObjectiveFromBundle(loom.id);

    const reloaded = getLoom(loom.id)!;
    expect(reloaded.prompt).toContain("Reject requests over 100/min");
    // Title comes from the first heading, trimmed.
    expect(reloaded.title).toBe("Add rate limiting to the public API");
  });

  test("no-op when objective.md is absent (seed preserved)", () => {
    const manifest = makeProject("reconcile-absent");
    const loom = createDraftLoom({ project: manifest.name, title: "seed", objective: "seed objective" });
    updateDraftObjectiveFromBundle(loom.id);
    expect(getLoom(loom.id)!.prompt).toBe("seed objective");
  });

  test("no-op when objective.md is only whitespace", () => {
    const manifest = makeProject("reconcile-blank");
    const loom = createDraftLoom({ project: manifest.name, title: "seed", objective: "seed objective" });
    writeBundleFile(loom.id, "objective.md", "   \n  \n");
    updateDraftObjectiveFromBundle(loom.id);
    expect(getLoom(loom.id)!.prompt).toBe("seed objective");
  });

  test("no-op on a non-draft loom", () => {
    const manifest = makeProject("reconcile-nondraft");
    const loom = createDraftLoom({ project: manifest.name, title: "seed", objective: "seed objective" });
    loom.draft = false;
    saveLoom(loom);
    writeBundleFile(loom.id, "objective.md", "A real distilled objective that should not apply here.");
    updateDraftObjectiveFromBundle(loom.id);
    expect(getLoom(loom.id)!.prompt).toBe("seed objective");
  });
});

describe("startLoomFromBundle objective gate", () => {
  function bundleWithObjective(projectName: string, objective: string) {
    const manifest = makeProject(projectName);
    const loom = createDraftLoom({
      project: manifest.name,
      title: "lets work on #109, please draft the loom",
      objective: "lets work on #109, please draft the loom",
    });
    quickBundle(loom.id, {
      objective,
      assertions: [{ id: "a1", description: "checks x", type: "contains", expected: "hi", blocker: true }],
      provenance: { approvedBy: "planner-session", humanApprovedAt: Date.now() },
    });
    return loom;
  }

  test("rejects a meta-request objective ('draft the loom')", async () => {
    const loom = bundleWithObjective("gate-meta", "draft the loom");
    await expect(
      startLoomFromBundle(loom.id, "alice", { accounts: {}, runLoomFn: fakeRunLoom as any }),
    ).rejects.toThrow(/concrete objective describing the change/);
  });

  test("rejects a pointer restatement ('lets work on #109, please draft the loom')", async () => {
    const loom = bundleWithObjective("gate-pointer", "lets work on #109, please draft the loom");
    await expect(
      startLoomFromBundle(loom.id, "alice", { accounts: {}, runLoomFn: fakeRunLoom as any }),
    ).rejects.toThrow(/concrete objective describing the change/);
  });

  test("rejects an empty/whitespace-only objective.md (seed never leaks through)", async () => {
    // quickBundle established a valid contract + provenance; blank the objective
    // so the only thing left is the raw chat seed the reconcile refuses to apply.
    const loom = bundleWithObjective("gate-empty", "Add a dark-mode toggle to the settings page.");
    writeBundleFile(loom.id, "objective.md", "   \n\t\n");
    await expect(
      startLoomFromBundle(loom.id, "alice", { accounts: {}, runLoomFn: fakeRunLoom as any }),
    ).rejects.toThrow(/concrete objective describing the change/);
    expect(getLoom(loom.id)!.draft).toBe(true); // never flipped to started
  });

  test("rejects a missing objective.md entirely", async () => {
    const loom = bundleWithObjective("gate-missing", "Add a dark-mode toggle to the settings page.");
    fs.rmSync(path.join(specDir(loom.id), "objective.md"), { force: true });
    await expect(
      startLoomFromBundle(loom.id, "alice", { accounts: {}, runLoomFn: fakeRunLoom as any }),
    ).rejects.toThrow(/concrete objective describing the change/);
    expect(getLoom(loom.id)!.draft).toBe(true);
  });

  test("allows a real objective that merely mentions building in passing", async () => {
    const loom = bundleWithObjective(
      "gate-real",
      "Add a Retry-After header to every 429 response from the public API rate limiter and cover it with an integration test.",
    );
    const started = await startLoomFromBundle(loom.id, "alice", {
      accounts: {},
      planWeaveFn: fakePlanNonWoven,
      runLoomFn: fakeRunLoom as any,
    });
    expect(started.draft).toBe(false);
    // The reconcile made objective.md win over the raw seed.
    expect(started.prompt).toContain("Retry-After header");
  });

  test("allows a short-but-real, non-meta objective", async () => {
    const loom = bundleWithObjective("gate-short", "Add a dark-mode toggle to the settings page.");
    const started = await startLoomFromBundle(loom.id, "alice", {
      accounts: {},
      planWeaveFn: fakePlanNonWoven,
      runLoomFn: fakeRunLoom as any,
    });
    expect(started.draft).toBe(false);
  });
});
