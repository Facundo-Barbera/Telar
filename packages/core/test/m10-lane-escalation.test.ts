// M10.4 — the PRE-FLIGHT lane-viability gate (UNCONDITIONAL) + bounded
// ask-once-persist human escalation (CORE slice). Fakes only: no live agent, no
// live server, tmp dirs fs-removed. Proves, end to end:
//   B. an unviable lane → PARKS `blocked` with a concrete question, spawns
//      ZERO children (the moat: park before any spend)
//   C. achievable lanes proceed (all-deterministic / devCommand / servers tier)
//   D. answer-and-resume: a non-blank `by` persists the recipe/runbook + promotes
//      devCommand, re-dispatches, and a green re-verify lands `ready` NEVER `done`
//   E. the persisted lane is reused by the NEXT loom without re-asking
//   F. by required; empty answer refused; from non-blocked → false
//   G. runbook tier + precedence
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m104-home-"));
process.env.TELAR_HOME = home;
beforeEach(() => {
  process.env.TELAR_HOME = home;
});
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const { answerBlocked } = await import("../src/dispatcher");
const { isLaneViable, runVerification } = await import("../src/executor");
const { VERIFIER_TOOLS } = await import("../src/verifier");
const { resolveServersConfig, resolveRunbook, writeAcceptedRunbook } = await import("../src/servers");
const { reconcileState } = await import("../src/runner/recover");
const { createLoom, getLoom, readEvents, saveLoom, acceptLoom, listChildLooms } = await import("../src/looms");
const { writeContract } = await import("../src/bundle");
const { createProject, getProject } = await import("../src/manifest");
const { ProjectManifest } = await import("../src/schemas");
import type { Loom } from "../src/looms";
import type { ServersConfig, VerificationContract } from "../src/schemas";

// The two dispatcher entry points under test are internal to the module; drive
// the pre-flight gate through the exported startLoom (a plain custom loom becomes
// a weave-of-one, contract synthesized from acceptanceCriteria → runWeaveWiring).
const { startLoom } = await import("../src/dispatcher");

let n = 0;
// A real on-disk project root. The pre-flight gate is unconditional.
function makeProject(partial: Record<string, unknown> = {}) {
  n++;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `telar-m104-proj-${n}-`));
  const m = createProject(root, { name: `m104-${n}`, ...partial });
  return { name: m.name, root, manifest: m };
}

// An AUTHORED contract with a live-critic assertion (agentJudged non-empty ⇒ a
// live target is needed ⇒ the lane must be viable). Written to the loom BEFORE
// dispatch so runWeaveWiring's readContract is non-null (never re-synthesized).
const liveCriticContract: VerificationContract = {
  version: 1,
  assertions: [
    // a passing deterministic gate (writeContract requires ≥1 hard-gate) + a
    // live-critic (agentJudged non-empty ⇒ a live target is needed).
    { id: "g", subGoalId: "ALL", description: "cmd", type: "command", expected: "echo ok", blocker: true },
    { id: "lc", subGoalId: "ALL", description: "flow", type: "live-critic", observable: "flow works", blocker: true },
  ],
};

// An all-deterministic contract: a runnable command gate only, NO agent-judged
// assertion — no live lane is ever needed.
const deterministicContract: VerificationContract = {
  version: 1,
  assertions: [
    { id: "g", subGoalId: "ALL", description: "cmd", type: "command", expected: "echo ok", blocker: true },
  ],
};

const laneCfg: ServersConfig = {
  version: 1,
  driver: "host-process",
  services: {
    web: {
      command: "bun dev",
      portStrategy: "fixed",
      port: 3000,
      env: {},
      dependsOn: [],
      readyCheck: { kind: "http", path: "/", status: 200 },
    },
  },
};

// A fake runLoomFn: records calls and lands the child `ready` (a green verify),
// so the weave rolls the root up to `ready`. dispatchExecution runs runLoomFn
// synchronously up to its first await, so `calls` is observable after start.
function fakeDeps() {
  let calls = 0;
  const runLoomFn = async (l: Loom) => {
    calls++;
    l.state = "ready";
    return l;
  };
  return { deps: { accounts: {}, runLoomFn } as any, get calls() { return calls; } };
}

// ── isLaneViable (PURE) ──────────────────────────────────────────────────────
describe("isLaneViable (pure predicate)", () => {
  test("all-deterministic contract → viable even with no recipe", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m104-v1-"));
    const manifest = ProjectManifest.parse({ name: "v", root });
    expect(isLaneViable(manifest, deterministicContract.assertions)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("live-critic + devCommand set → viable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m104-v2-"));
    const manifest = ProjectManifest.parse({ name: "v", root, devCommand: "bun run dev" });
    expect(isLaneViable(manifest, liveCriticContract.assertions)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("live-critic + accepted .telar servers tier → viable", () => {
    const { root, manifest } = makeProject();
    const { writeAcceptedServersConfig } = require("../src/servers");
    writeAcceptedServersConfig(root, laneCfg);
    expect(resolveServersConfig(root).driver).toBe("host-process");
    expect(isLaneViable(manifest, liveCriticContract.assertions)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("live-critic + no devCommand + no recipe → NOT viable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m104-v3-"));
    const manifest = ProjectManifest.parse({ name: "v", root });
    expect(isLaneViable(manifest, liveCriticContract.assertions)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ── A/B. pre-flight park ─────────────────────────────────────────────────────
describe("pre-flight lane-viability gate", () => {
  // startLoom fires the weave fire-and-forget; a plain custom loom becomes a
  // weave-of-one whose contract is synthesized from the prose acceptanceCriteria
  // into a live-critic assertion (agentJudged non-empty ⇒ a live target needed).
  // With no devCommand/recipe, the pre-flight gate parks it. Poll the loom on
  // disk after the synchronous dispatch prefix + a short tick.

  test("unviable lane PARKS `blocked` with a concrete question and spawns ZERO children", async () => {
    const { name } = makeProject();
    const f = fakeDeps();
    const loom = startLoom(
      { project: name, kind: "custom", title: "t", prompt: "x", acceptanceCriteria: ["the login flow works end to end"] },
      f.deps,
    );
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 20));
    const after = getLoom(loom.id)!;
    expect(after.state).toBe("blocked");
    expect(after.blockedQuestion).toBeTruthy();
    expect(after.blockedQuestion!.length).toBeGreaterThan(10);
    expect(after.blockedReason).toBeTruthy();
    expect(after.state).not.toBe("done");
    // The moat: NO child forked, NO builder ran, NO spend.
    expect(f.calls).toBe(0);
    expect(listChildLooms(loom.id).length).toBe(0);
    const { events } = readEvents(loom.id);
    expect(events.filter((e) => e.type === "lane-escalation").length).toBe(1);
    expect(events.find((e) => e.type === "lane-escalation")!.by).toBe("telar");
  });

  test("all-deterministic contract → never parks (spawns children)", async () => {
    // No acceptanceCriteria that reads live-critic-ish; a deterministic-only
    // synthesized contract has agentJudged empty. We assert via the loom NOT
    // reaching blocked. (synthesizeContract yields a live-critic for prose ACs,
    // so drive isLaneViable directly for the deterministic path — covered above —
    // and here assert devCommand short-circuits the same start.)
    const { name } = makeProject({ devCommand: "bun run dev" });
    const f = fakeDeps();
    const loom = startLoom(
      { project: name, kind: "custom", title: "t", prompt: "x", acceptanceCriteria: ["the login flow works end to end"] },
      f.deps,
    );
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 20));
    const after = getLoom(loom.id)!;
    expect(after.state).not.toBe("blocked"); // devCommand makes the lane viable
    expect(f.calls).toBeGreaterThanOrEqual(1);
  });

  test("accepted .telar servers tier → never parks (recipe reused)", async () => {
    const { name, root } = makeProject();
    const { writeAcceptedServersConfig } = require("../src/servers");
    writeAcceptedServersConfig(root, laneCfg);
    const f = fakeDeps();
    const loom = startLoom(
      { project: name, kind: "custom", title: "t", prompt: "x", acceptanceCriteria: ["the login flow works end to end"] },
      f.deps,
    );
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 20));
    const after = getLoom(loom.id)!;
    expect(after.state).not.toBe("blocked");
    expect(f.calls).toBeGreaterThanOrEqual(1);
  });
});

// ── D/E/F. answerBlocked ─────────────────────────────────────────────────────
describe("answerBlocked (human gate + persist + re-dispatch)", () => {
  // Directly seed a `blocked` loom (the pre-flight already proven above), then
  // exercise the answer path in isolation.
  function blockedLoom(project: string) {
    const loom = createLoom({ project, kind: "custom", title: "t", prompt: "x", account: "personal" });
    writeContract(loom.id, liveCriticContract);
    loom.state = "blocked";
    loom.blockedReason = "lane unviable";
    loom.blockedQuestion = "how do I run this app?";
    saveLoom(loom);
    return loom;
  }

  test("blank `by` throws (moat — never autonomous), no persist, no re-dispatch", async () => {
    const { name, root } = makeProject();
    const loom = blockedLoom(name);
    const f = fakeDeps();
    await expect(answerBlocked(loom.id, "  ", { devCommand: "bun run dev" }, f.deps)).rejects.toThrow(/non-blank/);
    expect(f.calls).toBe(0);
    expect(fs.existsSync(path.join(root, ".telar", "runbook.md"))).toBe(false);
  });

  test("empty answer payload → false, no write, no dispatch", async () => {
    const { name } = makeProject();
    const loom = blockedLoom(name);
    const f = fakeDeps();
    const ok = await answerBlocked(loom.id, "you", {}, f.deps);
    expect(ok).toBe(false);
    expect(f.calls).toBe(0);
  });

  // FIX 1 — the accept-guard must be CONSISTENT with isLaneViable: a runbook does
  // NOT make the lane viable (isLaneViable never consults it), so a runbook-ONLY
  // answer must be rejected exactly like an empty one. Otherwise it would persist
  // the runbook, clear the draft, re-dispatch, and the pre-flight would RE-PARK.
  test("FIX 1: runbook-ONLY answer → false; loom stays `blocked` with its draft intact, nothing persisted, no re-dispatch", async () => {
    const { name, root } = makeProject();
    const loom = blockedLoom(name);
    const f = fakeDeps();

    const ok = await answerBlocked(loom.id, "you", { runbook: "log in, go to /dashboard" }, f.deps);
    expect(ok).toBe(false);

    // No re-dispatch, nothing written to either tier.
    expect(f.calls).toBe(0);
    expect(fs.existsSync(path.join(root, ".telar", "runbook.md"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".telar", "servers.yaml"))).toBe(false);
    expect(getProject(name).manifest.devCommand).toBeUndefined();

    // The loom is untouched — still `blocked`, draft intact (the human can still
    // answer with a real viability-making recipe).
    const after = getLoom(loom.id)!;
    expect(after.state).toBe("blocked");
    expect(after.blockedReason).toBe("lane unviable");
    expect(after.blockedQuestion).toBe("how do I run this app?");
    const { events } = readEvents(loom.id);
    expect(events.filter((e) => e.type === "lane-answered").length).toBe(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  // FIX 1 — a devCommand carries viability; a runbook alongside it is the OPTIONAL
  // narrative. Both must persist (devCommand promoted + runbook written).
  test("FIX 1: devCommand + runbook answer STILL succeeds and persists BOTH", async () => {
    const { name, root } = makeProject();
    const loom = blockedLoom(name);
    const f = fakeDeps();

    const ok = await answerBlocked(loom.id, "you", { devCommand: "bun run dev", runbook: "drive: /reports" }, f.deps);
    expect(ok).toBe(true);
    expect(f.calls).toBe(1); // re-dispatched

    expect(getProject(name).manifest.devCommand).toBe("bun run dev"); // promoted
    expect(resolveRunbook(root)).toBe("drive: /reports"); // narrative persisted
    const after = getLoom(loom.id)!;
    expect(after.blockedReason).toBeUndefined(); // draft cleared on a real accept
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("from a non-blocked state → false, no write, no dispatch", async () => {
    const { name, root } = makeProject();
    const loom = createLoom({ project: name, kind: "custom", title: "t", prompt: "x", account: "personal" });
    loom.state = "ready";
    saveLoom(loom);
    const f = fakeDeps();
    const ok = await answerBlocked(loom.id, "you", { devCommand: "bun run dev" }, f.deps);
    expect(ok).toBe(false);
    expect(f.calls).toBe(0);
    expect(fs.existsSync(path.join(root, ".telar"))).toBe(false);
  });

  test("answer-and-resume: persists servers + runbook, promotes devCommand, clears draft, re-dispatches; a green re-verify lands `ready` NEVER `done`", async () => {
    const { name, root } = makeProject();
    const loom = blockedLoom(name);
    const f = fakeDeps();

    const ok = await answerBlocked(
      loom.id,
      "you",
      { devCommand: "bun run dev", servers: laneCfg, runbook: "log in, go to /dashboard, click New" },
      f.deps,
    );
    expect(ok).toBe(true);
    expect(f.calls).toBe(1); // re-dispatched

    // Tier 1 — gitignored .telar recipe + runbook.
    expect(resolveServersConfig(root).driver).toBe("host-process");
    expect(fs.existsSync(path.join(root, ".telar", "servers.yaml"))).toBe(true);
    expect(resolveRunbook(root)).toBe("log in, go to /dashboard, click New");

    // Tier 2 — committable manifest promotion.
    expect(getProject(name).manifest.devCommand).toBe("bun run dev");

    // Draft cleared, event recorded with the human `by`.
    const after = getLoom(loom.id)!;
    expect(after.blockedReason).toBeUndefined();
    expect(after.blockedQuestion).toBeUndefined();
    const { events } = readEvents(loom.id);
    expect(events.filter((e) => e.type === "lane-answered").length).toBe(1);
    expect(events.find((e) => e.type === "lane-answered")!.by).toBe("you");

    // The moat: the re-dispatched loom re-verifies and lands `ready` at most —
    // NEVER `done`. Only acceptLoom + a human `by` promotes.
    await new Promise((r) => setTimeout(r, 20));
    const settled = getLoom(loom.id)!;
    expect(settled.state).not.toBe("done");
    // A green verify routes the root to `ready`; accept then promotes to done.
    const done = acceptLoom(loom.id, "you");
    expect(done.state).toBe("done");
  });

  test("the persisted lane is reused by the NEXT loom without re-asking (pre-flight sees the promoted devCommand)", async () => {
    const { name, root } = makeProject();
    const first = blockedLoom(name);
    const f = fakeDeps();
    await answerBlocked(first.id, "you", { devCommand: "bun run dev", runbook: "drive it" }, f.deps);
    expect(getProject(name).manifest.devCommand).toBe("bun run dev");

    // A SECOND loom, same project, same unviable-shape contract, does NOT park —
    // the pre-flight reads the promoted devCommand and proceeds.
    const f2 = fakeDeps();
    const second = startLoom(
      { project: name, kind: "custom", title: "t2", prompt: "x", acceptanceCriteria: ["the login flow works end to end"] },
      f2.deps,
    );
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 20));
    const after = getLoom(second.id)!;
    expect(after.state).not.toBe("blocked"); // never re-asks
    expect(f2.calls).toBeGreaterThanOrEqual(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("servers-only answer persists the .telar tier and makes the next loom viable (no devCommand promotion)", async () => {
    const { name, root } = makeProject();
    const loom = blockedLoom(name);
    const f = fakeDeps();
    const ok = await answerBlocked(loom.id, "you", { servers: laneCfg }, f.deps);
    expect(ok).toBe(true);
    expect(resolveServersConfig(root).driver).toBe("host-process");
    // No devCommand was learned, so the manifest is untouched on that field.
    expect(getProject(name).manifest.devCommand).toBeUndefined();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ── G. runbook tier + precedence ─────────────────────────────────────────────
describe("runbook tier + precedence", () => {
  test("resolveRunbook: null when absent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m104-rb1-"));
    expect(resolveRunbook(root)).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("resolveRunbook: .telar/runbook.md wins over root/runbook.md", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m104-rb2-"));
    fs.writeFileSync(path.join(root, "runbook.md"), "repo runbook");
    writeAcceptedRunbook(root, "accepted runbook");
    expect(resolveRunbook(root)).toBe("accepted runbook");
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("resolveRunbook: falls through to repo runbook.md when no accepted tier", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m104-rb3-"));
    fs.writeFileSync(path.join(root, "runbook.md"), "repo runbook");
    expect(resolveRunbook(root)).toBe("repo runbook");
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("writeAcceptedRunbook round-trips via atomicWrite; frozen-worktree caveat (acceptedRoot)", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m104-rb4-"));
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m104-rb4wt-")); // a distinct dir, no .telar
    writeAcceptedRunbook(rootDir, "narrative");
    expect(resolveRunbook(wt, rootDir)).toBe("narrative"); // acceptedRoot = manifest.root
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });
});

// ── FIX 2. the accepted runbook is READ and reaches the live-critic DRIVE ──────
// context — resolveRunbook gains a real production consumer (was write-only). The
// judge's read-only tool wall stays byte-for-byte unchanged (prompt CONTEXT only).
describe("FIX 2: accepted runbook feeds the live-critic drive context", () => {
  const RUNBOOK = "DRIVE_NARRATIVE: log in as tester@example.com, open /reports, click Export, wait for the toast";

  // An authored live-critic loom (agentJudged non-empty ⇒ the panel runs) with a
  // builder attempt, contract on disk. A `url` target is passed to runVerification
  // so it drives straight to the panel (no server/lane spin-up).
  function authoredLoom(project: string): Loom {
    const loom = createLoom({ project, kind: "custom", title: "t", prompt: "verify the flow", account: "personal" });
    writeContract(loom.id, liveCriticContract);
    loom.attempts.push({ n: 1, role: "dev", model: "sonnet", startedAt: Date.now() } as any);
    saveLoom(loom);
    return loom;
  }

  // A capturing panel `run`: records (task, opts) per lens and returns a clean
  // CriticVerdict (classifyPanel → pass). No live agent, no browser.
  function capturingRun() {
    const calls: { task: string; opts: any }[] = [];
    const run = (async (task: string, opts: any) => {
      calls.push({ task, opts });
      const m = task.match(/--- Your lens: (.+?) \(/);
      return { lens: m ? m[1]! : "unknown", ok: true, summary: "clean", findings: [], evidence: [] };
    }) as any;
    return { run, calls };
  }

  test("accepted runbook → its narrative reaches EVERY critic prompt; tool wall unchanged", async () => {
    const { name, root, manifest } = makeProject();
    writeAcceptedRunbook(root, RUNBOOK);
    const loom = authoredLoom(name);
    const cap = capturingRun();

    const res = await runVerification(loom, manifest, loom.attempts[0]!, () => {}, undefined, "http://localhost:9999", {
      run: cap.run,
    });

    expect(cap.calls.length).toBeGreaterThanOrEqual(1); // the panel actually ran
    // resolveRunbook was READ and the narrative reached the DRIVE context of every
    // lens' prompt — under a "Drive notes" header, NOT the verdict framing.
    for (const c of cap.calls) {
      expect(c.task).toContain(RUNBOOK);
      expect(c.task).toContain("Drive notes");
      // MOAT — the read-only judge tool wall is byte-for-byte unchanged: the
      // runbook is prompt CONTEXT only, never a new capability.
      expect(c.opts.restrictTools).toBe(true);
      expect(c.opts.tools).toEqual(VERIFIER_TOOLS);
      expect(c.opts.disallowedTools).toEqual(["Write", "Edit", "MultiEdit", "Bash", "NotebookEdit", "Agent"]);
    }
    expect(res.panelRequired).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("NO accepted runbook → driveContext unset; prompt has no drive block", async () => {
    const { name, root, manifest } = makeProject();
    const loom = authoredLoom(name);
    const cap = capturingRun();

    await runVerification(loom, manifest, loom.attempts[0]!, () => {}, undefined, "http://localhost:9999", {
      run: cap.run,
    });

    for (const c of cap.calls) {
      expect(c.task).not.toContain("Drive notes"); // resolveRunbook → null ⇒ no block
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ── H. exhaustiveness smoke ──────────────────────────────────────────────────
describe("exhaustiveness", () => {
  test("reconcileState('blocked') === 'leave' (awaiting a human, no runner expected)", () => {
    expect(reconcileState("blocked")).toBe("leave");
  });
});
