/**
 * Loom wire types.
 *
 * Same standard as `protocol.test.ts`: a schema typechecks whether or not it is
 * correct, so what is asserted here is that these shapes DISCRIMINATE. The ones
 * that matter most are the two that encode the design rather than the data —
 * `GateOutcome` has three values and no boolean anywhere near it, and
 * `LoomState` is a closed set that a typo cannot join.
 */
import { describe, expect, test } from "bun:test";
import {
  Classification,
  Fingerprint,
  GateOutcome,
  LedgerEntry,
  Loom,
  LoomGate,
  LoomGateResult,
  LoomOverview,
  LoomProgram,
  LoomProgramDoc,
  LoomProjectSummary,
  LoomRun,
  LoomState,
  LoomWatch,
  LoomWatchPolicy,
  Rung,
  TickDecision,
  TriageEntry,
} from "../src/protocol";

const at = 1_700_000_000_000;

const loom = {
  id: "loom_1",
  projectId: "proj_1",
  item: "#457",
  title: "los puntos 2 y 3",
  state: "queued" as const,
  attempts: 0,
  ladderRung: 0,
  createdAt: at,
  updatedAt: at,
};

describe("gates are tri-state", () => {
  test("the outcome has exactly three values and none of them is a boolean", () => {
    expect(GateOutcome.options).toEqual(["pass", "fail", "unknown"]);
    expect(GateOutcome.safeParse(true).success).toBe(false);
    expect(GateOutcome.safeParse("ok").success).toBe(false);
    expect(GateOutcome.safeParse("skipped").success).toBe(false);
  });

  test("a gate's exit table is keyed by integer exit codes, sparsely", () => {
    const parsed = LoomGate.parse({ command: "bun run ci", exits: { "0": "pass", "2": "unknown" } });
    // Keys arrive as strings on the wire and are integers in the type.
    expect(parsed.exits[0]).toBe("pass");
    expect(parsed.exits[2]).toBe("unknown");
    // 1 is simply not declared, and that is legal — the classifier turns the
    // absence into `unknown`, which is the whole point of a sparse table.
    expect(parsed.exits[1]).toBeUndefined();
    expect(parsed.onUnknown).toBe("hold");
  });

  test("a non-integer exit code is not an exit code", () => {
    expect(LoomGate.safeParse({ command: "x", exits: { "1.5": "fail" } }).success).toBe(false);
    expect(LoomGate.safeParse({ command: "x", exits: { flaky: "fail" } }).success).toBe(false);
  });

  test("onUnknown is a closed policy and defaults to holding", () => {
    expect(LoomGate.parse({ command: "x" }).onUnknown).toBe("hold");
    expect(LoomGate.safeParse({ command: "x", onUnknown: "maybe" }).success).toBe(false);
  });

  test("a gate result can have no exit code at all — killed is not failed", () => {
    const killed = LoomGateResult.parse({ command: "x", exitCode: null, outcome: "unknown" });
    expect(killed.exitCode).toBeNull();
    expect(LoomGateResult.safeParse({ command: "x", exitCode: 1, outcome: false }).success).toBe(false);
  });
});

describe("the Program", () => {
  test("an empty object is a whole Program — every slot has a default", () => {
    const p = LoomProgram.parse({});
    expect(p.version).toBe(1);
    expect(p.commands).toEqual({});
    expect(p.gates).toEqual([]);
    expect(p.work).toEqual({ base: "main", branchPrefix: "t3code/", concurrency: 4 });
    expect(p.watch).toEqual({ intervalSec: 300, backoffMaxSec: 3600 });
    expect(p.ladder).toEqual([]);
    expect(p.notes).toBe("");
  });

  test("a missing probe is legal — the sentinel is optional, the system is not", () => {
    expect(LoomProgram.parse({ commands: { list: "cat inbox.md" } }).commands.probe).toBeUndefined();
  });

  test("an empty command string is not a command", () => {
    expect(LoomProgram.safeParse({ commands: { probe: "" } }).success).toBe(false);
  });

  test("concurrency may be 0 (paused) but never negative or fractional", () => {
    expect(LoomProgram.parse({ work: { concurrency: 0 } }).work.concurrency).toBe(0);
    expect(LoomProgram.safeParse({ work: { concurrency: -1 } }).success).toBe(false);
    expect(LoomProgram.safeParse({ work: { concurrency: 2.5 } }).success).toBe(false);
  });

  test("the watch POLICY is the Program's, and is not the runtime watch record", () => {
    // Two different things that used to want one name. The policy says what the
    // schedule should be; LoomWatch says what it is doing.
    expect(LoomWatchPolicy.parse({}).intervalSec).toBe(300);
    expect(LoomWatchPolicy.safeParse({ intervalSec: 0 }).success).toBe(false);
    expect(LoomWatch.safeParse({ projectId: "p", running: true, intervalSec: 300 }).success).toBe(true);
    // The runtime record carries state the policy has no business holding.
    expect(LoomWatch.parse({ projectId: "p", running: false, intervalSec: 300 }).quietChecks).toBe(0);
  });

  test("`worldUnreadable` is a sentence and a separate field from `lastError`", () => {
    // A FLAG WOULD NOT BE ACTIONABLE and a shared field would not be true. The
    // deck's line is `lastError`, which every writer overwrites; this one says
    // that the project's own `list` is still broken, which is what stops a pass
    // finding nothing from being spent as evidence of a quiet night.
    const watch = LoomWatch.parse({
      projectId: "p",
      running: true,
      intervalSec: 300,
      lastError: "probe exited 1: gh not found",
      worldUnreadable: "`gh issue list` exited 1: not authenticated",
    });
    expect(watch.worldUnreadable).toContain("not authenticated");
    expect(watch.lastError).toContain("probe exited 1");
    // Absent is the ordinary state — a project whose world reads fine.
    expect(LoomWatch.parse({ projectId: "p", running: true, intervalSec: 300 }).worldUnreadable).toBeUndefined();
    expect(LoomWatch.safeParse({ projectId: "p", running: true, intervalSec: 300, worldUnreadable: true }).success).toBe(false);
  });

  test("a rung is numbered from 1, so that 0 can mean 'nothing tried yet'", () => {
    expect(Rung.parse({ n: 1, label: "re-read it" })).toEqual({
      n: 1,
      label: "re-read it",
      enabled: true,
      absorbed: 0,
    });
    expect(Rung.safeParse({ n: 0, label: "x" }).success).toBe(false);
    expect(Rung.safeParse({ n: 1, label: "x", absorbed: -1 }).success).toBe(false);
  });
});

describe("the Loom record", () => {
  test("a state outside the closed set does not parse", () => {
    expect(Loom.safeParse(loom).success).toBe(true);
    expect(Loom.safeParse({ ...loom, state: "running" }).success).toBe(false);
    expect(Loom.safeParse({ ...loom, state: "done" }).success).toBe(false);
    expect(Loom.safeParse({ ...loom, state: "" }).success).toBe(false);
  });

  test("the nine states are exactly these nine", () => {
    expect(LoomState.options).toEqual([
      "queued",
      "working",
      "gating",
      "publishing",
      "published",
      "stuck",
      "parked",
      "asking",
      "cancelled",
    ]);
  });

  test("attempts and ladderRung default to zero rather than being demanded", () => {
    const { attempts: _a, ladderRung: _l, ...bare } = loom;
    const parsed = Loom.parse(bare);
    expect(parsed.attempts).toBe(0);
    expect(parsed.ladderRung).toBe(0);
  });

  test("liveness evidence must be plausible — pid 0 is not a process", () => {
    expect(Loom.safeParse({ ...loom, pid: 0 }).success).toBe(false);
    expect(Loom.safeParse({ ...loom, pid: 4321 }).success).toBe(true);
    expect(Loom.safeParse({ ...loom, sessionId: "" }).success).toBe(false);
  });

  test("an item ref is required — a loom about nothing is not a loom", () => {
    expect(Loom.safeParse({ ...loom, item: "" }).success).toBe(false);
  });
});

describe("ledger, triage, sentinel", () => {
  test("the ledger's kinds are closed", () => {
    expect(LedgerEntry.safeParse({ at, kind: "tick", summary: "quiet" }).success).toBe(true);
    expect(LedgerEntry.safeParse({ at, kind: "shrug", summary: "x" }).success).toBe(false);
  });

  test("triage carries the tracker's opaque revision token, not a date", () => {
    const entry = {
      item: "#409",
      updatedAt: "2026-08-19T22:01:00Z",
      classification: "needs-split" as const,
      reason: "absorbs #352, five comments deep",
      ask: "split the identity backbone first",
      at,
    };
    expect(TriageEntry.safeParse(entry).success).toBe(true);
    // Opaque means opaque: a sha or an mtime is just as valid a token.
    expect(TriageEntry.safeParse({ ...entry, updatedAt: "9f8c1a2" }).success).toBe(true);
    expect(TriageEntry.safeParse({ ...entry, classification: "blocked" }).success).toBe(false);
  });

  test("the six classifications are the ones the backlog finding named", () => {
    expect(Classification.options).toEqual([
      "dispatchable",
      "needs-decision",
      "needs-credentials",
      "needs-split",
      "never",
      "done",
    ]);
  });

  test("a fingerprint always has a hash — an empty one would compare equal to everything", () => {
    expect(Fingerprint.safeParse({ hash: "0f1e2d3c", at, probe: "abc" }).success).toBe(true);
    expect(Fingerprint.safeParse({ hash: "", at, probe: "abc" }).success).toBe(false);
  });
});

describe("the tick's output", () => {
  test("an empty decision is a valid decision — a tick may legitimately do nothing", () => {
    expect(TickDecision.parse({})).toEqual({ triage: [], dispatch: [], park: [], ask: [], note: "" });
  });

  test("an ask needs neither a loom nor an item — the best questions have neither", () => {
    expect(TickDecision.safeParse({ ask: [{ question: "which base branch?" }] }).success).toBe(true);
  });

  test("a park without a loom id is not a park", () => {
    expect(TickDecision.safeParse({ park: [{ reason: "conflicts" }] }).success).toBe(false);
  });
});

describe("the seam", () => {
  test("a project with no Program is an ordinary state, not an error", () => {
    const doc = LoomProgramDoc.parse({
      projectId: "p",
      path: "/repo/.telar/loom.md",
      exists: false,
      markdown: "",
      program: null,
    });
    expect(doc.program).toBeNull();
    expect(doc.warnings).toEqual([]);
  });

  test("a project summary's counts are exhaustive — every state, zero included", () => {
    const watch = { projectId: "p", running: true, intervalSec: 300, quietChecks: 0 };
    const full = Object.fromEntries(LoomState.options.map((s) => [s, 0]));
    const summary = {
      projectId: "p",
      name: "ozom-gv",
      root: "/repo",
      hasProgram: true,
      programPath: "/repo/.telar/loom.md",
      watch,
      counts: full,
      assumed: [],
      warnings: [],
    };
    expect(LoomProjectSummary.safeParse(summary).success).toBe(true);
    // A sparse count object is rejected, so no client has to write `?? 0`.
    expect(LoomProjectSummary.safeParse({ ...summary, counts: { queued: 1 } }).success).toBe(false);
    // The cockpit pointer is optional: absent means "run setup", not "broken".
    expect(LoomProjectSummary.parse(summary).orchestratorSessionId).toBeUndefined();
  });

  test("a run distinguishes what was proposed from what was actually dispatched", () => {
    const run = LoomRun.parse({
      id: "run_1",
      projectId: "p",
      kind: "dry-run",
      state: "done",
      startedAt: at,
      decision: { dispatch: [{ item: "#1", title: "t" }] },
    });
    expect(run.decision?.dispatch).toHaveLength(1);
    expect(run.dispatched).toEqual([]); // a dry run dispatches nothing, by definition
    expect(LoomRun.safeParse({ id: "r", projectId: "p", kind: "preview", state: "done", startedAt: at }).success).toBe(false);
  });

  test("the overview is one snapshot, and every list of it defaults to empty", () => {
    expect(LoomOverview.parse({})).toEqual({
      projects: [],
      looms: [],
      triage: [],
      runs: [],
      unreadable: [],
    });
  });
});
