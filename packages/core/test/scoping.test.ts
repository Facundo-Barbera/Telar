import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Charter, ProjectManifest, ProofStrategy, SubGoal } from "../src/schemas";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-scoping-"));
process.env.TELAR_HOME = home;
// bun test runs all files in one process — re-pin the env before every test
beforeEach(() => {
  process.env.TELAR_HOME = home;
});

const { needsScoping, validateCharter, draftCharter } = await import("../src/scoping");
const { PROOF_TEMPLATES, proofTemplate } = await import("../src/proof-templates");
const { createProject } = await import("../src/manifest");
const { createLoom, saveLoom, getLoom } = await import("../src/looms");
const { approveCharter } = await import("../src/dispatcher");

const projRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-scoping-proj-"));

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(projRoot, { recursive: true, force: true });
});

function subGoal(overrides: Partial<SubGoal> = {}): SubGoal {
  return {
    id: overrides.id ?? "s1",
    title: "title",
    detail: "detail",
    proofStrategy: "custom",
    acceptanceCriteria: [],
    dependsOn: [],
    required: true,
    status: "pending",
    ...overrides,
  };
}

function charter(overrides: Partial<Charter> = {}): Charter {
  return {
    objective: "do the thing",
    proofStrategy: "custom",
    scope: { allowedPaths: [], forbiddenPaths: [] },
    budget: { maxParallelThreads: 3, maxAgents: 12 },
    decomposition: [],
    version: 1,
    ...overrides,
  };
}

const fakeManifest: ProjectManifest = {
  name: "p",
  root: "/tmp/telar-scoping-fake-root",
  adapter: "plain",
  account: "personal",
  baseBranch: "main",
  gates: [],
  guardrails: { disallowedTools: [], protectedPaths: [] },
  charterPolicy: "human-required-for-epics",
};

describe("needsScoping (pure)", () => {
  test("acceptanceCriteria present -> false", () => {
    expect(needsScoping({ acceptanceCriteria: ["it works"] })).toBe(false);
  });

  test("charter present -> false", () => {
    expect(needsScoping({ charter: charter() })).toBe(false);
  });

  test("neither acceptanceCriteria nor charter (vague prompt) -> true", () => {
    expect(needsScoping({})).toBe(true);
    expect(needsScoping({ acceptanceCriteria: [] })).toBe(true);
  });
});

describe("validateCharter (pure)", () => {
  test("a woven charter with zero required subgoals -> ok:false (the MOAT GUARD)", () => {
    const c = charter({
      decomposition: [subGoal({ id: "s1", required: false }), subGoal({ id: "s2", required: false })],
    });
    const r = validateCharter(c);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /required/.test(e))).toBe(true);
  });

  test("duplicate subgoal ids -> error", () => {
    const c = charter({
      decomposition: [subGoal({ id: "s1" }), subGoal({ id: "s1" })],
    });
    const r = validateCharter(c);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /duplicate/i.test(e))).toBe(true);
  });

  test("dependsOn referencing a missing subgoal id -> error", () => {
    const c = charter({
      decomposition: [subGoal({ id: "s1", dependsOn: ["nope"] })],
    });
    const r = validateCharter(c);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /unknown/i.test(e))).toBe(true);
  });

  test("a dependency cycle -> error", () => {
    const c = charter({
      decomposition: [
        subGoal({ id: "s1", dependsOn: ["s2"] }),
        subGoal({ id: "s2", dependsOn: ["s1"] }),
      ],
    });
    const r = validateCharter(c);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /cycle/i.test(e))).toBe(true);
  });

  test("a valid woven charter (>=1 required, unique ids, acyclic deps) -> ok:true", () => {
    const c = charter({
      decomposition: [
        subGoal({ id: "s1", required: true }),
        subGoal({ id: "s2", required: false, dependsOn: ["s1"] }),
      ],
    });
    const r = validateCharter(c);
    expect(r).toEqual({ ok: true, errors: [] });
  });

  test("a valid non-weaving charter with empty decomposition -> ok:true", () => {
    const c = charter({ decomposition: [] });
    expect(validateCharter(c)).toEqual({ ok: true, errors: [] });
  });

  test("empty objective -> error", () => {
    const c = charter({ objective: "" });
    const r = validateCharter(c);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /objective/.test(e))).toBe(true);
  });
});

describe("draftCharter (injected fake agent, no live model)", () => {
  test("returns the canned charter, calls the agent read-only, and includes proof-template guidance", async () => {
    const canned = charter({
      proofStrategy: "bmad-story",
      decomposition: [subGoal({ id: "s1", required: true, proofStrategy: "bmad-story" })],
    });

    let captured: { prompt: string; opts: any } | null = null;
    const fakeAgent = (async (promptText: string, opts: any) => {
      captured = { prompt: promptText, opts };
      return canned;
    }) as unknown as typeof import("../src/engine").agent;

    const result = await draftCharter(
      { prompt: "build a login flow", manifest: fakeManifest, proofStrategy: "bmad-story" },
      { agent: fakeAgent },
    );

    expect(result).toEqual(canned);
    expect(captured).not.toBeNull();
    expect(captured!.opts.restrictTools).toBe(true);
    expect(captured!.opts.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(captured!.opts.tools).not.toContain("Write");
    expect(captured!.opts.tools).not.toContain("Edit");
    expect(captured!.opts.tools).not.toContain("Bash");
    expect(captured!.opts.disallowedTools).toContain("Write");
    expect(captured!.opts.disallowedTools).toContain("Edit");
    expect(captured!.opts.disallowedTools).toContain("Bash");
    // Lock the read-only guarantee's last leak: settingSources:[] stops the
    // target repo's own .claude hooks (shell commands, outside restrictTools)
    // from running during the supposedly read-only scoping pass.
    expect(captured!.opts.settingSources).toEqual([]);
    expect(captured!.prompt).toContain(PROOF_TEMPLATES["bmad-story"].guidance);
  });

  test("never mutates the repo — cwd is the manifest root, no write-capable tools requested", async () => {
    const canned = charter();
    let captured: any = null;
    const fakeAgent = (async (promptText: string, opts: any) => {
      captured = opts;
      return canned;
    }) as unknown as typeof import("../src/engine").agent;

    await draftCharter({ prompt: "x", manifest: fakeManifest }, { agent: fakeAgent });
    expect(captured.cwd).toBe(fakeManifest.root);
  });
});

describe("proofTemplate", () => {
  test("returns the matching template for each ProofStrategy", () => {
    const strategies: ProofStrategy[] = ["quickfix", "bmad-story", "verifier-criteria", "custom"];
    for (const s of strategies) {
      expect(proofTemplate(s)).toBe(PROOF_TEMPLATES[s]);
      expect(proofTemplate(s).strategy).toBe(s);
    }
  });
});

describe("approveCharter (real TELAR_HOME, fake execution)", () => {
  test("stamps approvedBy and dispatches when the loom is in charter-review", async () => {
    const manifest = createProject(projRoot, { name: "scoping-approve-proj" });
    const loom = createLoom({
      project: manifest.name,
      kind: "custom",
      title: "t",
      prompt: "do it",
      account: manifest.account,
    });
    loom.state = "charter-review";
    loom.charter = charter({ decomposition: [] });
    saveLoom(loom);

    const fakeRunLoom = async (l: any) => {
      l.state = "done";
      return l;
    };
    const ok = await approveCharter(loom.id, "alice", {
      accounts: {},
      runLoomFn: fakeRunLoom as any,
      draftCharterFn: (async () => charter()) as any,
    });

    expect(ok).toBe(true);
    const reloaded = getLoom(loom.id)!;
    expect(reloaded.charter!.approvedBy).toBe("alice");
  });

  test("returns false for a loom not in charter-review", async () => {
    const manifest = createProject(fs.mkdtempSync(path.join(os.tmpdir(), "telar-scoping-proj2-")), {
      name: "scoping-approve-proj2",
    });
    const loom = createLoom({
      project: manifest.name,
      kind: "custom",
      title: "t2",
      prompt: "x",
      account: manifest.account,
    });
    // still "queued" — never entered charter-review
    const ok = await approveCharter(loom.id, "alice", { accounts: {} });
    expect(ok).toBe(false);
  });

  test("returns false for an unknown loom id", async () => {
    const ok = await approveCharter("loom_nope", "alice", { accounts: {} });
    expect(ok).toBe(false);
  });
});
