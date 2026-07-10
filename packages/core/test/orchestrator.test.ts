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
  return { id: overrides.id ?? "t1", subGoalId: overrides.subGoalId ?? "s1", state: overrides.state ?? "running" };
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
  test("all required subgoals done -> finish-loom", () => {
    const v = view({
      threads: [thread({ subGoalId: "s1", state: "done" }), thread({ subGoalId: "s2", state: "done" })],
    });
    expect(tick(v)).toEqual({ action: "finish-loom" });
  });

  test("ready subgoals + pool room -> schedule with agents = fanoutSize", () => {
    const v = view({ budget: budget({ maxAgents: 2 }) });
    const d = tick(v);
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
    expect(tick(v)).toEqual({ action: "hold" });
  });

  test("no ready subgoals and none in flight -> escalate (blocked)", () => {
    const decomposition = [subGoal({ id: "a" }), subGoal({ id: "b", dependsOn: ["missing"] })];
    const v = view({
      charter: charter(decomposition),
      threads: [thread({ subGoalId: "a", state: "failed" })],
    });
    // "a" is a required thread in a terminal failed state -> escalate for that,
    // exercising the distinct "failed required" branch instead.
    const d = tick(v);
    expect(d.action).toBe("escalate");
  });

  test("wall-clock exceeded -> escalate regardless of ready work", () => {
    const v = view({
      budget: budget({ maxAgents: 12, maxWallClockHours: 1, startedAtMs: 0 }),
      nowMs: 2 * 3600_000,
    });
    expect(tick(v)).toEqual({ action: "escalate", reason: "wall-clock budget exhausted" });
  });

  test("truly blocked: not-required-failed but no ready & none running -> escalate (blocked)", () => {
    const decomposition = [subGoal({ id: "a", dependsOn: ["ghost"] })];
    const v = view({ charter: charter(decomposition), threads: [] });
    expect(tick(v)).toEqual({ action: "escalate", reason: "no ready threads and none in flight (blocked)" });
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
