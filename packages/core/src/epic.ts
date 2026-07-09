// Epic roll-up & the orchestrator control loop (docs/loom-orchestrator.md
// §4/§6/§7/§11). An epic Loom never builds anything itself — it only spawns
// and folds up child Looms. rollupEpic is the ONLY completion path: every
// required SubGoal's child must have independently reached "done" via
// executeLoom's decide() (children keep landing on "done" — the epic is the
// root the owner accepts, so the epic itself rolls up to "ready", never
// "done" — docs/loom-model.md §A). This is the composed moat — do not add
// another branch that returns "ready"/"done" here.
import type { Loom } from "./looms";
import type { Charter, SubGoal, WorkUnitState } from "./schemas";
import { tick, validateDecision, type Decision, type LedgerView, type ThreadView } from "./tick";
import type { BudgetState } from "./budget";

// Pure: no persistence, no agent calls — just fold child states up against
// the decomposition per the required-subgoal contract.
export function rollupEpic(
  children: Loom[],
  decomposition: SubGoal[],
): { state: WorkUnitState; error?: string } {
  const required = decomposition.filter((sg) => sg.required);
  // Defense-in-depth against the M7.1 vacuous-"done" hole: validateCharter
  // (scoping.ts) already rejects a zero-required decomposition before it
  // reaches runEpic via dispatcher.ts, but rollupEpic is exported public API
  // (index.ts) — guard here too so a caller that bypasses validateCharter
  // can't make `required.every(...)` trivially true.
  if (required.length === 0) {
    return { state: "needs-review", error: "decomposition has zero required subgoals (invalid charter)" };
  }
  const childBySubGoal = new Map<string, Loom>();
  for (const c of children) {
    if (c.subGoalId) childBySubGoal.set(c.subGoalId, c);
  }

  const allRequiredDone = required.every((sg) => childBySubGoal.get(sg.id)?.state === "done");
  // §A: the epic is the root the owner accepts — it lands "ready", never
  // "done", even though the gate is still every required child === "done".
  if (allRequiredDone) return { state: "ready" };

  const failedRequired = required.find((sg) => childBySubGoal.get(sg.id)?.state === "failed");
  if (failedRequired) return { state: "failed", error: `${failedRequired.id}: failed` };

  const notDoneRequired = required.find((sg) => childBySubGoal.get(sg.id)?.state !== "done");
  if (notDoneRequired) return { state: "needs-review", error: `${notDoneRequired.id}: not done` };

  // Unreachable given the branches above, but keeps the function total.
  return { state: "needs-review", error: "unresolved" };
}

export type RunEpicDeps = {
  spawnChild: (sg: SubGoal) => Loom;
  runChild: (child: Loom) => Promise<Loom>;
  onState?: (epic: Loom) => void;
  onEvent?: (ev: { type: string } & Record<string, unknown>) => void;
  abort?: AbortController;
  // Injected clock — tick/validateDecision stay pure (no Date.now inside
  // them); runEpic reads `now()` once per tick and passes it through the
  // LedgerView. Defaults to the wall clock outside tests.
  now?: () => number;
};

function childCostUsd(child: Loom): number {
  return child.attempts.reduce((sum, a) => sum + (a.costUsd ?? 0), 0);
}

// Pure w.r.t. persistence — all side effects (spawning/running children,
// persisting the epic) come through injected deps, mirroring executeLoom.
// INTERNALS ONLY changed from the naive wave scheduler to the tick loop
// (docs/loom-orchestrator.md §6/§7); the exported signature is unchanged.
export async function runEpic(epic: Loom, decomposition: SubGoal[], deps: RunEpicDeps): Promise<Loom> {
  const emit = (ev: { type: string } & Record<string, unknown>) => deps.onEvent?.(ev);
  const setState = (s: WorkUnitState) => {
    epic.state = s;
    emit({ type: "state", state: s });
    deps.onState?.(epic);
  };
  const isAborted = () => deps.abort?.signal.aborted === true;
  const halt = () => {
    setState("halted");
    return epic;
  };
  const now = deps.now ?? (() => Date.now());

  try {
    if (isAborted()) return halt();

    setState("preparing");

    // A LedgerView-shaped charter: decomposition is always the param passed
    // in (mirrors rollupEpic's own signature), other fields come from
    // epic.charter when present, else safe epic-shape defaults — tests
    // routinely run an epic Loom with no charter at all.
    const baseCharter = epic.charter;
    const charterView: Charter = {
      objective: baseCharter?.objective ?? epic.title,
      proofStrategy: baseCharter?.proofStrategy ?? "custom",
      scope: baseCharter?.scope ?? { allowedPaths: [], forbiddenPaths: [] },
      budget: baseCharter?.budget ?? { maxParallelThreads: 3, maxAgents: 12 },
      shape: "epic",
      decomposition,
      version: baseCharter?.version ?? 1,
      approvedBy: baseCharter?.approvedBy,
      scopingSessionId: baseCharter?.scopingSessionId,
      rationale: baseCharter?.rationale,
    };
    const maxAgents = charterView.budget.maxAgents;
    const maxCostUsd = charterView.budget.maxCostUsd;
    const maxWallClockHours = charterView.budget.maxWallClockHours;
    const startedAtMs = now();

    const finished = new Map<string, Loom>(); // subGoalId -> done/terminal child
    const runningThread = new Map<string, ThreadView>(); // subGoalId -> in-flight summary
    const running = new Map<string, Promise<void>>(); // subGoalId -> settlement tracker
    const decisionLog: Decision[] = [];
    let spentUsd = 0;
    let startedRunning = false;

    const spawn = (sg: SubGoal) => {
      const child = deps.spawnChild(sg);
      emit({ type: "epic-child-spawned", subGoalId: sg.id, childId: child.id });
      runningThread.set(sg.id, { id: child.id, subGoalId: sg.id, state: "running" });
      // Attach the recording .then BEFORE this promise is placed into
      // `running` — since it always runs strictly before the wrapper
      // promise settles, every await on Promise.race(running.values())
      // below is guaranteed to observe the completed thread already moved
      // out of `running`/`runningThread` and into `finished`.
      const settle = deps.runChild(child).then((result) => {
        finished.set(sg.id, result);
        spentUsd += childCostUsd(result);
        runningThread.delete(sg.id);
        running.delete(sg.id);
      });
      running.set(sg.id, settle);
    };

    const maxIterations = decomposition.length * 4 + 8;
    let iterations = 0;

    while (true) {
      if (isAborted()) return halt();

      iterations++;
      if (iterations > maxIterations) {
        epic.error = "orchestrator exceeded its safety iteration bound";
        break;
      }

      const threads: ThreadView[] = [
        ...[...finished.entries()].map(([subGoalId, child]) => ({
          id: child.id,
          subGoalId,
          state: child.state,
        })),
        ...runningThread.values(),
      ];
      const budget: BudgetState = {
        maxAgents,
        inFlight: running.size,
        spentUsd,
        startedAtMs,
        maxCostUsd,
        maxWallClockHours,
      };
      const view: LedgerView = {
        charter: charterView,
        threads,
        inFlight: running.size,
        budget,
        decisionLogTail: decisionLog.slice(-8),
        nowMs: now(),
      };

      let d: Decision = tick(view);
      const v = validateDecision(d, view);
      if (!v.ok) d = { action: "hold" }; // never apply an invalid decision

      decisionLog.push(d);
      emit({ type: "decision", decision: d });

      if (d.action === "schedule") {
        if (!startedRunning) {
          setState("running");
          startedRunning = true;
        }
        for (const id of d.subGoalIds) {
          const sg = decomposition.find((s) => s.id === id);
          if (!sg) continue; // defensive: tick only proposes ready decomposition ids
          spawn(sg);
        }
        continue; // do NOT await — re-tick to keep filling the pool
      }

      if (d.action === "hold") {
        if (running.size === 0) {
          epic.error = "no ready threads and none in flight (blocked)";
          break;
        }
        await Promise.race(running.values());
        continue;
      }

      if (d.action === "finish-loom") {
        break;
      }

      if (d.action === "escalate") {
        epic.error = d.reason ?? "escalated";
        break;
      }

      // "repair" is a directive-path/thread-level action (§9); tick() never
      // emits it for an epic's own control loop. Escalate defensively rather
      // than loop forever on an unhandled action.
      epic.error = d.action === "repair" ? `unexpected repair decision for thread ${d.threadId}` : "unhandled decision";
      break;
    }

    // Every break path above (finish-loom / escalate / maxIterations /
    // unhandled) leaves the loop without awaiting whatever is still in
    // `running` — draining here (rather than at each break site) closes that
    // gap once for all of them. deps.runChild's own .then (in spawn(), above)
    // already moves each settling child from running/runningThread into
    // finished as it lands, so this simply lets rollup observe the true final
    // state of every spawned child instead of abandoning in-flight work to a
    // detached promise the caller can no longer see, cancel, or account for.
    if (running.size > 0) {
      await Promise.allSettled([...running.values()]);
    }

    const children = [...finished.values()];
    const r = rollupEpic(children, decomposition);
    // rollup is authoritative for state: a genuinely "ready" rollup (every
    // required child done) always wins, clearing any stray escalate/
    // iteration-bound error string.
    epic.error = r.state === "ready" ? null : (r.error ?? epic.error ?? null);
    setState(r.state);
    emit({ type: "epic-rollup", state: r.state });
    return epic;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      if (isAborted()) return halt();
      emit({ type: "error", message });
      epic.error = message;
      setState("failed");
    } catch {
      epic.state = isAborted() ? "halted" : "failed";
      if (epic.state === "failed") epic.error ??= message;
    }
    return epic;
  }
}
