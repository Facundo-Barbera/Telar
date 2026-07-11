import { describe, expect, test } from "bun:test";
import { fanoutSize, prioritize, type BudgetState } from "../src/budget";
import { readySubGoals, tick, validateDecision, type LedgerView, type ThreadView } from "../src/tick";
import { runWeave } from "../src/weave";
import type { Charter, SubGoal } from "../src/schemas";
import type { Loom } from "../src/looms";

// ---- shared builders --------------------------------------------------

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

function charter(decomposition: SubGoal[], budgetOverrides: Partial<Charter["budget"]> = {}): Charter {
  return {
    objective: "obj",
    proofStrategy: "custom",
    scope: { allowedPaths: [], forbiddenPaths: [] },
    budget: { maxParallelThreads: 3, maxAgents: 12, ...budgetOverrides },
    decomposition,
    version: 1,
  };
}

function budget(overrides: Partial<BudgetState> = {}): BudgetState {
  return { maxAgents: 12, inFlight: 0, spentUsd: 0, startedAtMs: 0, ...overrides };
}

function view(overrides: Partial<LedgerView> = {}): LedgerView {
  const decomposition = overrides.charter?.decomposition ?? [subGoal({ id: "s1" }), subGoal({ id: "s2" })];
  return {
    charter: overrides.charter ?? charter(decomposition),
    threads: overrides.threads ?? [],
    inFlight: overrides.inFlight ?? 0,
    budget: overrides.budget ?? budget(),
    decisionLogTail: overrides.decisionLogTail ?? [],
    nowMs: overrides.nowMs ?? 0,
  };
}

function thread(overrides: Partial<ThreadView> = {}): ThreadView {
  return { id: overrides.id ?? "t1", subGoalId: overrides.subGoalId ?? "s1", state: overrides.state ?? "running", ...overrides };
}

let fakeN = 0;
function fakeLoom(overrides: Partial<Loom> = {}): Loom {
  fakeN++;
  return {
    id: `fake_${fakeN}`,
    project: "p",
    kind: "custom",
    title: "t",
    prompt: "x",
    account: "personal",
    state: "queued",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    attempts: [],
    error: null,
    ...overrides,
  };
}

// ---- fanoutSize ---------------------------------------------------------

describe("fanoutSize (pure)", () => {
  test("1 piece, pool room, no budget cap -> 1", () => {
    expect(fanoutSize(1, { maxAgents: 12, inFlight: 0, budgetLeftUsd: Infinity, estCostPerAgent: 0.5 })).toBe(1);
  });

  test("5 pieces, maxAgents 3, inFlight 0 -> 3", () => {
    expect(fanoutSize(5, { maxAgents: 3, inFlight: 0, budgetLeftUsd: Infinity, estCostPerAgent: 0.5 })).toBe(3);
  });

  test("5 pieces, maxAgents 12, inFlight 10 -> 2", () => {
    expect(fanoutSize(5, { maxAgents: 12, inFlight: 10, budgetLeftUsd: Infinity, estCostPerAgent: 0.5 })).toBe(2);
  });

  test("5 pieces, budgetLeftUsd 1.2, estCost 0.5 -> 2", () => {
    expect(fanoutSize(5, { maxAgents: 12, inFlight: 0, budgetLeftUsd: 1.2, estCostPerAgent: 0.5 })).toBe(2);
  });

  test("pool full (inFlight == maxAgents) -> 0", () => {
    expect(fanoutSize(5, { maxAgents: 3, inFlight: 3, budgetLeftUsd: Infinity, estCostPerAgent: 0.5 })).toBe(0);
  });

  test("infinite budget -> capped by pool only", () => {
    expect(fanoutSize(100, { maxAgents: 4, inFlight: 1, budgetLeftUsd: Infinity, estCostPerAgent: 0.5 })).toBe(3);
  });
});

// ---- prioritize ---------------------------------------------------------

describe("prioritize (pure, critical-path-first)", () => {
  test("a subgoal many others depend on ranks before a leaf subgoal", () => {
    // hub unblocks b and c (transitively); leaf unblocks nothing.
    const decomposition = [
      subGoal({ id: "hub" }),
      subGoal({ id: "b", dependsOn: ["hub"] }),
      subGoal({ id: "c", dependsOn: ["hub"] }),
      subGoal({ id: "leaf" }),
    ];
    const result = prioritize(["leaf", "hub"], decomposition);
    expect(result).toEqual(["hub", "leaf"]);
  });

  test("deterministic tie-break by id ascending when scores are equal", () => {
    const decomposition = [subGoal({ id: "z" }), subGoal({ id: "a" }), subGoal({ id: "m" })];
    expect(prioritize(["z", "a", "m"], decomposition)).toEqual(["a", "m", "z"]);
  });

  test("transitive dependents count, not just direct", () => {
    // a <- b <- c: a unblocks b and (transitively) c => score 2; b unblocks c => score 1.
    const decomposition = [subGoal({ id: "a" }), subGoal({ id: "b", dependsOn: ["a"] }), subGoal({ id: "c", dependsOn: ["b"] })];
    expect(prioritize(["b", "a"], decomposition)).toEqual(["a", "b"]);
  });
});

// ---- validateDecision -----------------------------------------------------

describe("validateDecision (pure)", () => {
  test("finish-loom rejected when a required thread is not done", () => {
    const v = view({ threads: [thread({ subGoalId: "s1", state: "done" })] }); // s2 has no thread
    const r = validateDecision({ action: "finish-loom" }, v);
    expect(r.ok).toBe(false);
  });

  test("finish-loom accepted when all required threads are done", () => {
    const v = view({
      threads: [thread({ subGoalId: "s1", state: "done" }), thread({ subGoalId: "s2", state: "done" })],
    });
    const r = validateDecision({ action: "finish-loom" }, v);
    expect(r.ok).toBe(true);
  });

  test("schedule rejected when agents would exceed the pool", () => {
    const v = view({ inFlight: 11, budget: budget({ maxAgents: 12, inFlight: 11 }) });
    const r = validateDecision({ action: "schedule", subGoalIds: ["s1"], agents: 2 }, v);
    expect(r.ok).toBe(false);
  });

  test("schedule rejected when a subGoalId isn't ready (unmet dependency)", () => {
    const decomposition = [subGoal({ id: "a" }), subGoal({ id: "b", dependsOn: ["a"] })];
    const v = view({ charter: charter(decomposition) });
    const r = validateDecision({ action: "schedule", subGoalIds: ["b"], agents: 1 }, v);
    expect(r.ok).toBe(false);
  });

  test("schedule accepted for a ready subgoal within pool room", () => {
    const v = view();
    const r = validateDecision({ action: "schedule", subGoalIds: ["s1"], agents: 1 }, v);
    expect(r.ok).toBe(true);
  });
});

// ---- tick -----------------------------------------------------------------

describe("tick (pure scheduler) — scenario table", () => {
  // Phase 2 shape change: tick now returns { decision, rationale } (rationale is
  // more PURE computed output). These decision-shape tests read the .decision;
  // the rationale is asserted separately below.
  const decide = (v: LedgerView) => tick(v).decision;

  test("all required subgoals done -> finish-loom", () => {
    const v = view({
      threads: [thread({ subGoalId: "s1", state: "done" }), thread({ subGoalId: "s2", state: "done" })],
    });
    expect(decide(v)).toEqual({ action: "finish-loom" });
  });

  test("ready subgoals + pool room -> schedule with agents = fanoutSize", () => {
    const v = view({ budget: budget({ maxAgents: 2 }) });
    const d = decide(v);
    expect(d.action).toBe("schedule");
    if (d.action === "schedule") {
      expect(d.subGoalIds.sort()).toEqual(["s1", "s2"]);
      expect(d.agents).toBe(2);
    }
  });

  test("pool full but threads running -> hold", () => {
    const v = view({
      threads: [thread({ subGoalId: "s1", state: "running" }), thread({ subGoalId: "s2", state: "running" })],
      inFlight: 2,
      budget: budget({ maxAgents: 2, inFlight: 2 }),
    });
    expect(decide(v)).toEqual({ action: "hold" });
  });

  test("no ready subgoals and none in flight -> escalate (blocked)", () => {
    const decomposition = [subGoal({ id: "a" }), subGoal({ id: "b", dependsOn: ["missing"] })];
    const v = view({
      charter: charter(decomposition),
      threads: [thread({ subGoalId: "a", state: "failed" })],
    });
    // "a" is a required thread in a terminal failed state -> escalate for that,
    // exercising the distinct "failed required" branch instead.
    const d = decide(v);
    expect(d.action).toBe("escalate");
  });

  test("wall-clock exceeded -> escalate regardless of ready work", () => {
    const v = view({
      budget: budget({ maxAgents: 12, maxWallClockHours: 1, startedAtMs: 0 }),
      nowMs: 2 * 3600_000,
    });
    expect(decide(v)).toEqual({ action: "escalate", reason: "wall-clock budget exhausted" });
  });

  test("truly blocked: not-required-failed but no ready & none running -> escalate (blocked)", () => {
    const decomposition = [subGoal({ id: "a", dependsOn: ["ghost"] })];
    const v = view({ charter: charter(decomposition), threads: [] });
    expect(decide(v)).toEqual({ action: "escalate", reason: "no ready threads and none in flight (blocked)" });
  });

  test("terminally-failed required subgoal (runnerInFlight false) -> escalate with reason", () => {
    const v = view({
      threads: [thread({ subGoalId: "s1", state: "failed", runnerInFlight: false }), thread({ subGoalId: "s2", state: "done" })],
      inFlight: 0,
    });
    expect(decide(v)).toEqual({ action: "escalate", reason: "s1 failed" });
  });

  test("terminally-failed required subgoal (field absent) -> escalate (back-compat)", () => {
    // No runnerInFlight field at all: reads as terminal, byte-identical to today.
    const v = view({
      threads: [thread({ subGoalId: "s1", state: "failed" }), thread({ subGoalId: "s2", state: "done" })],
      inFlight: 0,
    });
    expect(decide(v)).toEqual({ action: "escalate", reason: "s1 failed" });
  });

  test("transiently-failed required subgoal (runnerInFlight true) -> hold, NOT escalate", () => {
    // A live runner still owns s1's thread -> its "failed" is mid-retry.
    // runnerInFlight true ⟹ inFlight >= 1, so control routes to hold ("keep sampling").
    const v = view({
      threads: [thread({ subGoalId: "s1", state: "failed", runnerInFlight: true }), thread({ subGoalId: "s2", state: "running", runnerInFlight: true })],
      inFlight: 2,
      budget: budget({ maxAgents: 2, inFlight: 2 }),
    });
    expect(decide(v)).toEqual({ action: "hold" });
  });

  test("transiently-failed required subgoal + ready sibling -> schedule other work, NOT escalate", () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" })];
    const v = view({
      charter: charter(decomposition),
      threads: [thread({ subGoalId: "s1", state: "failed", runnerInFlight: true })],
      inFlight: 1,
      budget: budget({ maxAgents: 4, inFlight: 1 }),
    });
    const d = decide(v);
    expect(d.action).toBe("schedule");
    if (d.action === "schedule") expect(d.subGoalIds).toEqual(["s2"]);
  });

  test("hang guard: a transient failure that becomes terminal escalates on the next tick", () => {
    // Tick 1: runner still in flight -> transient -> hold (keep sampling).
    const transient = view({
      threads: [thread({ subGoalId: "s1", state: "failed", runnerInFlight: true }), thread({ subGoalId: "s2", state: "running", runnerInFlight: true })],
      inFlight: 2,
      budget: budget({ maxAgents: 2, inFlight: 2 }),
    });
    expect(decide(transient).action).toBe("hold");

    // Tick 2: runner settled (retries exhausted) -> runnerInFlight false -> TERMINAL -> escalate.
    const terminal = view({
      threads: [thread({ subGoalId: "s1", state: "failed", runnerInFlight: false }), thread({ subGoalId: "s2", state: "done", runnerInFlight: false })],
      inFlight: 0,
    });
    expect(decide(terminal)).toEqual({ action: "escalate", reason: "s1 failed" });
  });
});

// ---- tick rationale (Unit 2 — pure computed WHY) --------------------------

describe("tick rationale (pure, deterministic scheduler policy)", () => {
  test("schedule rationale carries priority scores, the head, and the binding fanout term", () => {
    // hub unblocks a and b (score 2); leaf unblocks nothing (score 0). Pool of 2
    // < 3 ready pieces, so the AGENT POOL is the binding clamp term.
    const decomposition = [
      subGoal({ id: "hub" }),
      subGoal({ id: "a", dependsOn: ["hub"] }),
      subGoal({ id: "b", dependsOn: ["hub"] }),
      subGoal({ id: "leaf" }),
    ];
    const v = view({ charter: charter(decomposition) }); // default pool 12 fits both ready pieces
    const { decision, rationale } = tick(v);

    expect(decision.action).toBe("schedule");
    // (a) prioritize ranking + scores: hub (2) before leaf (0), critical-path-first.
    expect(rationale.ranked).toEqual([
      { id: "hub", score: 2 },
      { id: "leaf", score: 0 },
    ]);
    // (b) fanout clamp breakdown + binding term: 2 ready pieces (hub, leaf) both
    // fit the pool + budget -> demand ("pieces") is the binding term.
    expect(rationale.fanout).toMatchObject({ pieces: 2, chosen: 2, binding: "pieces" });
    // The head appears in the summary with its downstream count.
    expect(rationale.summary).toContain("hub first (unblocks 2 downstream)");
  });

  test("fanout binding term is 'pool' when the agent pool is the smallest cap", () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" }), subGoal({ id: "s3" })];
    const v = view({ charter: charter(decomposition), budget: budget({ maxAgents: 2 }) }); // 3 ready, pool 2
    const { decision, rationale } = tick(v);
    expect(decision).toEqual({ action: "schedule", subGoalIds: ["s1", "s2"], agents: 2 });
    expect(rationale.fanout).toMatchObject({ pieces: 3, capByPool: 2, chosen: 2, binding: "pool" });
  });

  test("fanout binding term is 'budget' when the cost budget is the smallest cap", () => {
    // 3 ready pieces, pool 12, but budgetLeft 1.2 / 0.5 = floor 2 -> budget binds.
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" }), subGoal({ id: "s3" })];
    const v = view({
      charter: charter(decomposition, { maxAgents: 12 }),
      budget: budget({ maxAgents: 12, maxCostUsd: 1.2, spentUsd: 0 }),
    });
    const { decision, rationale } = tick(v);
    expect(decision.action).toBe("schedule");
    if (decision.action === "schedule") expect(decision.agents).toBe(2);
    expect(rationale.fanout).toMatchObject({ capByBudget: 2, chosen: 2, binding: "budget" });
  });

  test("the budget/clock snapshot rides on every decision (here: finish-loom)", () => {
    const v = view({
      threads: [thread({ subGoalId: "s1", state: "done" }), thread({ subGoalId: "s2", state: "done" })],
      budget: budget({ maxAgents: 12, maxCostUsd: 10, spentUsd: 3, maxWallClockHours: 2, startedAtMs: 0 }),
      inFlight: 0,
      nowMs: 3600_000, // 1h elapsed of a 2h wall clock
    });
    const { decision, rationale } = tick(v);
    expect(decision).toEqual({ action: "finish-loom" });
    expect(rationale.budget).toEqual({
      spentUsd: 3,
      inFlight: 0,
      maxCostUsd: 10,
      budgetLeftUsd: 7,
      wallClockRemainingMs: 3600_000, // 2h - 1h
    });
  });

  test("wall-clock exhausted still returns a rationale with the snapshot (no ranked)", () => {
    const v = view({
      budget: budget({ maxAgents: 12, maxWallClockHours: 1, startedAtMs: 0 }),
      nowMs: 2 * 3600_000,
    });
    const { decision, rationale } = tick(v);
    expect(decision.action).toBe("escalate");
    expect(rationale.budget.wallClockRemainingMs).toBeLessThan(0);
    expect(rationale.ranked).toBeUndefined();
    expect(rationale.summary).toContain("wall-clock");
  });
});

// ---- runWeave + tick loop, with fakes (no disk/agents) ----------------------

describe("runWeave wired to the tick loop (fakes)", () => {
  test("N=5 independent subgoals, maxAgents=2: pool cap holds, peak concurrency <= 2, all 5 run, weave folds to ready (§A)", async () => {
    const decomposition = Array.from({ length: 5 }, (_, i) => subGoal({ id: `s${i + 1}` }));
    const weave = fakeLoom({ charter: charter(decomposition, { maxAgents: 2 }) });

    let concurrent = 0;
    let peak = 0;
    const ran: string[] = [];

    const result = await runWeave(weave, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        // yield a tick so overlapping schedules would actually overlap if the
        // pool cap were violated.
        await new Promise((resolve) => setTimeout(resolve, 0));
        ran.push(child.subGoalId!);
        concurrent--;
        child.state = "done";
        return child;
      },
    });

    expect(peak).toBeLessThanOrEqual(2);
    expect(ran.sort()).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    expect(result.state).toBe("ready");
  });

  test("dependency chain a -> b -> c runs in strict order", async () => {
    const decomposition = [subGoal({ id: "a" }), subGoal({ id: "b", dependsOn: ["a"] }), subGoal({ id: "c", dependsOn: ["b"] })];
    const weave = fakeLoom();
    const order: string[] = [];

    const result = await runWeave(weave, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => {
        order.push(child.subGoalId!);
        child.state = "done";
        return child;
      },
    });

    expect(result.state).toBe("ready");
    expect(order).toEqual(["a", "b", "c"]);
  });

  test("a required subgoal's failure ends the weave failed/needs-review, and finish-loom is never emitted before all required are done", async () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" })];
    const weave = fakeLoom();
    const decisions: unknown[] = [];

    const result = await runWeave(weave, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => {
        child.state = child.subGoalId === "s2" ? "failed" : "done";
        return child;
      },
      onEvent: (ev) => {
        if (ev.type === "decision") decisions.push((ev as { decision: { action: string } }).decision);
      },
    });

    expect(["failed", "needs-review"]).toContain(result.state);
    const finishLoomDecisions = decisions.filter((d) => (d as { action: string }).action === "finish-loom");
    expect(finishLoomDecisions.length).toBe(0);
  });

  test("decision log never contains finish-loom before all required subgoals are done (no tick-vs-tick contradiction)", async () => {
    const decomposition = [subGoal({ id: "a" }), subGoal({ id: "b", dependsOn: ["a"] })];
    const weave = fakeLoom();
    const decisions: { action: string }[] = [];
    let aDone = false;

    await runWeave(weave, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => {
        if (child.subGoalId === "a") aDone = true;
        else expect(aDone).toBe(true); // b must never start before a is truly done
        child.state = "done";
        return child;
      },
      onEvent: (ev) => {
        if (ev.type === "decision") {
          const d = (ev as { decision: { action: string } }).decision;
          decisions.push(d);
          if (d.action === "finish-loom") {
            // At the moment finish-loom is decided, every required subgoal
            // must already be done — verified indirectly via aDone above and
            // by this being the terminal decision (no schedule follows it).
          }
        }
      },
    });

    const finishIndex = decisions.findIndex((d) => d.action === "finish-loom");
    expect(finishIndex).toBeGreaterThanOrEqual(0);
    // Nothing after finish-loom.
    expect(finishIndex).toBe(decisions.length - 1);
  });

  test("pool cap is respected even when charter is absent (default maxAgents=12)", async () => {
    const decomposition = Array.from({ length: 3 }, (_, i) => subGoal({ id: `s${i + 1}` }));
    const weave = fakeLoom(); // no charter
    const spawned: string[] = [];

    const result = await runWeave(weave, decomposition, {
      spawnChild: (sg) => {
        spawned.push(sg.id);
        return fakeLoom({ subGoalId: sg.id, state: "queued" });
      },
      runChild: async (child) => {
        child.state = "done";
        return child;
      },
    });

    expect(spawned.sort()).toEqual(["s1", "s2", "s3"]);
    expect(result.state).toBe("ready");
  });

  test("finish-loom while an optional sibling is still running: runWeave doesn't return until that sibling settles (no orphaned in-flight child)", async () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2", required: false })];
    const weave = fakeLoom();
    let s2Settled = false;

    const result = await runWeave(weave, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => {
        if (child.subGoalId === "s1") {
          child.state = "done"; // required subgoal finishes fast -> finish-loom fires
          return child;
        }
        // s2 (optional) is much slower than s1.
        await new Promise((resolve) => setTimeout(resolve, 20));
        s2Settled = true;
        child.state = "done";
        return child;
      },
    });

    expect(result.state).toBe("ready");
    // The bug: runWeave returned while s2's runChild promise was still in
    // flight, abandoning it to a detached closure. The fix drains `running`
    // before rollup, so by the time runWeave resolves, s2 must have settled.
    expect(s2Settled).toBe(true);
  });

  test("escalate on a required failure still drains a still-running sibling before returning", async () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" })];
    const weave = fakeLoom();
    let s2Settled = false;

    const result = await runWeave(weave, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => {
        if (child.subGoalId === "s1") {
          child.state = "failed"; // required failure -> escalate fires immediately
          return child;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        s2Settled = true;
        child.state = "done";
        return child;
      },
    });

    expect(["failed", "needs-review"]).toContain(result.state);
    expect(s2Settled).toBe(true);
  });
});

// ---- Phase 2 events: plan / observe / decision-rationale ---------------------

describe("runWeave — plan / observe / decision events (fakes)", () => {
  const doneRunner = async (child: Loom) => ((child.state = "done"), child);
  const spawnFake = (sg: SubGoal) => fakeLoom({ subGoalId: sg.id, state: "queued" });

  test("Unit 3: a plan event fires at weave start with the decomposition graph + charter rationale, before any decision", async () => {
    const decomposition = [subGoal({ id: "a" }), subGoal({ id: "b", dependsOn: ["a"] })];
    const weave = fakeLoom({ charter: charter(decomposition) });
    weave.charter!.rationale = "split along the API/DB seam";
    const events: Array<{ type: string } & Record<string, unknown>> = [];

    await runWeave(weave, decomposition, { spawnChild: spawnFake, runChild: doneRunner, onEvent: (ev) => events.push(ev) });

    const plan = events.find((e) => e.type === "plan");
    expect(plan).toBeDefined();
    expect(plan!.rationale).toBe("split along the API/DB seam");
    expect(plan!.decomposition).toEqual([
      { id: "a", title: "title", dependsOn: [], required: true },
      { id: "b", title: "title", dependsOn: ["a"], required: true },
    ]);
    // Plan precedes every scheduling decision — the loop is replayable from it.
    expect(events.findIndex((e) => e.type === "plan")).toBeLessThan(events.findIndex((e) => e.type === "decision"));
  });

  test("Unit 3: singleThread weave-of-one uses the deterministic fallback rationale", async () => {
    const decomposition = [subGoal({ id: "s1" })];
    const weave = fakeLoom({ charter: charter(decomposition) });
    weave.charter!.singleThread = true; // synthesized weave-of-one, no LLM rationale
    const events: Array<{ type: string } & Record<string, unknown>> = [];

    await runWeave(weave, decomposition, { spawnChild: spawnFake, runChild: doneRunner, onEvent: (ev) => events.push(ev) });

    const plan = events.find((e) => e.type === "plan")!;
    expect(plan.rationale).toBe("single thread by construction — no decomposition requested");
  });

  test("Unit 4: an observe event fires when a child settles, carrying its state + the newly-unblocked set", async () => {
    const decomposition = [subGoal({ id: "a" }), subGoal({ id: "b", dependsOn: ["a"] })];
    const weave = fakeLoom();
    const observes: Array<{ type: string } & Record<string, unknown>> = [];

    await runWeave(weave, decomposition, {
      spawnChild: spawnFake,
      runChild: doneRunner,
      onEvent: (ev) => {
        if (ev.type === "observe") observes.push(ev);
      },
    });

    expect(observes.length).toBe(2);
    const aObs = observes.find((o) => o.subGoalId === "a")!;
    expect(aObs.state).toBe("done");
    expect(aObs.childId).toBeTypeOf("string");
    expect(aObs.unblocked).toEqual(["b"]); // a done -> b becomes newly ready
    const bObs = observes.find((o) => o.subGoalId === "b")!;
    expect(bObs.state).toBe("done");
    expect(bObs.unblocked).toEqual([]); // nothing depends on b
  });

  test("Unit 4: a failed child unblocks nothing (state carried honestly)", async () => {
    const decomposition = [subGoal({ id: "a" }), subGoal({ id: "b", dependsOn: ["a"] })];
    const weave = fakeLoom();
    const observes: Array<{ type: string } & Record<string, unknown>> = [];

    await runWeave(weave, decomposition, {
      spawnChild: spawnFake,
      runChild: async (child) => ((child.state = child.subGoalId === "a" ? "failed" : "done"), child),
      onEvent: (ev) => {
        if (ev.type === "observe") observes.push(ev);
      },
    });

    const aObs = observes.find((o) => o.subGoalId === "a")!;
    expect(aObs.state).toBe("failed");
    expect(aObs.unblocked).toEqual([]); // a failed -> b stays blocked
  });

  test("Unit 2: the decision event carries { decision } (back-compat) plus the new rationale", async () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" }), subGoal({ id: "s3" })];
    const weave = fakeLoom({ charter: charter(decomposition, { maxAgents: 2 }) }); // 3 ready, pool 2
    const decisions: Array<{ type: string } & Record<string, unknown>> = [];

    await runWeave(weave, decomposition, {
      spawnChild: spawnFake,
      runChild: doneRunner,
      onEvent: (ev) => {
        if (ev.type === "decision") decisions.push(ev);
      },
    });

    // Every decision keeps the back-compat { decision } AND gains a rationale.
    for (const ev of decisions) {
      expect((ev.decision as { action?: string }).action).toBeTypeOf("string");
      expect((ev.rationale as { summary?: string }).summary).toBeTypeOf("string");
    }
    // The first schedule fanned 3 ready pieces into a pool of 2 -> pool binds.
    const firstSchedule = decisions.find((ev) => (ev.decision as { action?: string }).action === "schedule")!;
    expect((firstSchedule.rationale as { fanout?: { binding?: string } }).fanout?.binding).toBe("pool");
  });
});

// ---- readySubGoals ----------------------------------------------------------

describe("readySubGoals (pure)", () => {
  test("excludes subgoals that already have a thread", () => {
    const v = view({ threads: [thread({ subGoalId: "s1", state: "running" })] });
    expect(readySubGoals(v)).toEqual(["s2"]);
  });

  test("excludes subgoals whose dependency isn't done yet", () => {
    const decomposition = [subGoal({ id: "a" }), subGoal({ id: "b", dependsOn: ["a"] })];
    const v = view({ charter: charter(decomposition), threads: [thread({ subGoalId: "a", state: "running" })] });
    expect(readySubGoals(v)).toEqual([]);
  });

  test("includes a subgoal once its dependency thread is done", () => {
    const decomposition = [subGoal({ id: "a" }), subGoal({ id: "b", dependsOn: ["a"] })];
    const v = view({ charter: charter(decomposition), threads: [thread({ subGoalId: "a", state: "done" })] });
    expect(readySubGoals(v)).toEqual(["b"]);
  });
});
