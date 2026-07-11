// The weave roll-up & the weaver's control loop (docs/loom-orchestrator.md
// §4/§6/§7/§11; vocabulary per docs/loom-model.md §W). A woven root Loom
// never builds anything itself — it only spawns and folds up child Looms
// (threads). rollupWeave is the ONLY completion path: every required
// SubGoal's child must have independently reached "done" via executeLoom's
// decide() (children keep landing on "done" — the woven root is the thing
// the owner accepts, so it rolls up to "ready", never "done" —
// docs/loom-model.md §A). This is the composed moat — do not add another
// branch that returns "ready"/"done" here.
import type { Loom } from "./looms";
import type { Charter, PanelReport, SubGoal, WorkUnitState } from "./schemas";
import { tick, validateDecision, type Decision, type LedgerView, type ThreadView } from "./tick";
import type { BudgetState } from "./budget";
import type { GateResult } from "./gates";

// Pure: no persistence, no agent calls — just fold child states up against
// the decomposition per the required-subgoal contract.
export function rollupWeave(
  children: Loom[],
  decomposition: SubGoal[],
): { state: WorkUnitState; error?: string } {
  const required = decomposition.filter((sg) => sg.required);
  // Defense-in-depth against the M7.1 vacuous-"done" hole: validateCharter
  // (scoping.ts) already rejects a zero-required decomposition before it
  // reaches runWeave via dispatcher.ts, but rollupWeave is exported public
  // API (index.ts) — guard here too so a caller that bypasses
  // validateCharter can't make `required.every(...)` trivially true.
  if (required.length === 0) {
    return { state: "needs-review", error: "decomposition has zero required subgoals (invalid charter)" };
  }
  const childBySubGoal = new Map<string, Loom>();
  for (const c of children) {
    if (c.subGoalId) childBySubGoal.set(c.subGoalId, c);
  }

  const allRequiredDone = required.every((sg) => childBySubGoal.get(sg.id)?.state === "done");
  // §A: the woven root is the thing the owner accepts — it lands "ready",
  // never "done", even though the gate is still every required child === "done".
  if (allRequiredDone) return { state: "ready" };

  const failedRequired = required.find((sg) => childBySubGoal.get(sg.id)?.state === "failed");
  if (failedRequired) return { state: "failed", error: `${failedRequired.id}: failed` };

  const notDoneRequired = required.find((sg) => childBySubGoal.get(sg.id)?.state !== "done");
  if (notDoneRequired) return { state: "needs-review", error: `${notDoneRequired.id}: not done` };

  // Unreachable given the branches above, but keeps the function total.
  return { state: "needs-review", error: "unresolved" };
}

export type RunWeaveDeps = {
  spawnChild: (sg: SubGoal) => Loom;
  runChild: (child: Loom) => Promise<Loom>;
  onState?: (loom: Loom) => void;
  onEvent?: (ev: { type: string } & Record<string, unknown>) => void;
  abort?: AbortController;
  // Injected clock — tick/validateDecision stay pure (no Date.now inside
  // them); runWeave reads `now()` once per tick and passes it through the
  // LedgerView. Defaults to the wall clock outside tests.
  now?: () => number;
  // Unit 6 (docs §8 MVP): end-of-orchestration ALL-scope integration verify
  // PRODUCER. Injected so weave.ts stays pure w.r.t. persistence AND free of
  // any executor import — it only calls this runner and records the result.
  // Returns null when there is no ALL contract to verify (no-op, back-compat).
  // Production wires the exported runIntegrationVerify (executor.ts); tests
  // inject a fake. Pushes an integration AttemptRecord onto the loom before it
  // returns; weave records latestVerdict + emits weave-verify + persists.
  runIntegrationVerify?: (loom: Loom) => Promise<{
    verification: string;
    gatesOk: boolean;
    panelReport?: PanelReport | null;
    gates?: GateResult[];
  } | null>;
};

function childCostUsd(child: Loom): number {
  return child.attempts.reduce((sum, a) => sum + (a.costUsd ?? 0), 0);
}

// Pure w.r.t. persistence — all side effects (spawning/running children,
// persisting the woven root) come through injected deps, mirroring
// executeLoom. INTERNALS ONLY changed from the naive wave scheduler to the
// tick loop (docs/loom-orchestrator.md §6/§7); the exported signature is
// unchanged.
export async function runWeave(loom: Loom, decomposition: SubGoal[], deps: RunWeaveDeps): Promise<Loom> {
  const emit = (ev: { type: string } & Record<string, unknown>) => deps.onEvent?.(ev);
  const setState = (s: WorkUnitState) => {
    loom.state = s;
    emit({ type: "state", state: s });
    deps.onState?.(loom);
  };
  const isAborted = () => deps.abort?.signal.aborted === true;
  const halt = () => {
    setState("halted");
    return loom;
  };
  const now = deps.now ?? (() => Date.now());

  try {
    if (isAborted()) return halt();

    setState("preparing");

    // A LedgerView-shaped charter: decomposition is always the param passed
    // in (mirrors rollupWeave's own signature), other fields come from
    // loom.charter when present, else safe woven-root defaults — tests
    // routinely run a woven Loom with no charter at all.
    const baseCharter = loom.charter;
    const charterView: Charter = {
      objective: baseCharter?.objective ?? loom.title,
      proofStrategy: baseCharter?.proofStrategy ?? "custom",
      scope: baseCharter?.scope ?? { allowedPaths: [], forbiddenPaths: [] },
      budget: baseCharter?.budget ?? { maxParallelThreads: 3, maxAgents: 12, maxCriticAgents: 3 },
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
      emit({ type: "weave-child-spawned", subGoalId: sg.id, childId: child.id });
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
        loom.error = "weaver exceeded its safety iteration bound";
        break;
      }

      const threads: ThreadView[] = [
        ...[...finished.entries()].map(([subGoalId, child]) => ({
          id: child.id,
          subGoalId,
          state: child.state,
          runnerInFlight: false, // settled: its runChild promise resolved → terminal
        })),
        ...[...runningThread.values()].map((t) => ({ ...t, runnerInFlight: true })),
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
          loom.error = "no ready threads and none in flight (blocked)";
          break;
        }
        await Promise.race(running.values());
        continue;
      }

      if (d.action === "finish-loom") {
        break;
      }

      if (d.action === "escalate") {
        loom.error = d.reason ?? "escalated";
        break;
      }

      // "repair" is a directive-path/thread-level action (§9); tick() never
      // emits it for the weaver's own control loop. Escalate defensively
      // rather than loop forever on an unhandled action.
      loom.error = d.action === "repair" ? `unexpected repair decision for thread ${d.threadId}` : "unhandled decision";
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
    const r = rollupWeave(children, decomposition);
    // rollup is authoritative for state: a genuinely "ready" rollup (every
    // required child done) always wins, clearing any stray escalate/
    // iteration-bound error string.
    loom.error = r.state === "ready" ? null : (r.error ?? loom.error ?? null);
    setState(r.state);
    emit({ type: "weave-rollup", state: r.state });

    // Unit 6 (docs §8 MVP): integration verify PRODUCER. Runs strictly AFTER
    // setState(r.state) so the rollup state still wins — this is INFORMATIONAL,
    // it never mutates loom.state or any finish/accept semantics (Unit 7 gates
    // on it). Gated on r.state === "ready" (every required child self-reported
    // done, weave.ts §A): exactly the §2 case where children each self-reported
    // and no ALL verify has ever run — the whole point of catching a broken
    // assembled whole. A failed/needs-review assembly has nothing coherent to
    // integration-verify. A woven root with no ALL contract -> null -> no-op.
    if (r.state === "ready" && deps.runIntegrationVerify) {
      // Best-effort: its OWN try/catch so a throw — a rejecting runner, or a
      // saveLoom/appendEvent disk error inside the block — can NEVER reach the
      // outer catch and demote a correctly-woven "ready" loom to "failed". An
      // informational verify must not change the outcome: record the error and
      // drop it; the authoritative rollup state stands.
      try {
        const iv = await deps.runIntegrationVerify(loom); // null => no ALL contract
        if (iv) {
          loom.latestVerdict = iv.verification;
          emit({ type: "weave-verify", verification: iv.verification, gatesOk: iv.gatesOk });
          // Unit 7 (docs §8): the ALL verdict is AUTHORITATIVE for the terminal
          // state. A REAL red verdict (the ALL verify RAN and did not pass)
          // demotes the self-reported "ready" to "needs-review" — the assembled
          // whole can then only be closed via an AUDITED owner override, never a
          // clean accept. "pass"/"skip" keep "ready". A THROW never reaches here
          // (caught below) — fail-open: a broken checker is not a red verdict, so
          // it must not demote a correctly-woven loom.
          if (iv.verification === "fail" || iv.verification === "flaky") {
            loom.error = `integration verification ${iv.verification}`;
            setState("needs-review"); // emits {type:"state"} + persists via deps.onState
          } else {
            deps.onState?.(loom); // "pass"/"skip": persist the recorded verdict; state unchanged
          }
        }
      } catch (e) {
        try {
          emit({ type: "weave-verify-error", message: e instanceof Error ? e.message : String(e) });
        } catch {
          /* even the error event is best-effort — never let it demote the loom */
        }
      }
    }
    return loom;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      if (isAborted()) return halt();
      emit({ type: "error", message });
      loom.error = message;
      setState("failed");
    } catch {
      loom.state = isAborted() ? "halted" : "failed";
      if (loom.state === "failed") loom.error ??= message;
    }
    return loom;
  }
}
