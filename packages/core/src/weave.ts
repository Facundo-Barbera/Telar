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
import { MEDIATION_BUDGET, readySubGoals, tick, validateDecision, type Decision, type LedgerView, type ThreadView } from "./tick";
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

  // A required child is "met" at "done" (terminalStateForCompletedLoom always
  // returns "done" for a loom with parentLoomId set — §A). "ready" is included
  // too: it is the SAME "verified" terminal per the WorkUnitState enum
  // ("ready, // verified, awaiting owner acceptance") — a child never lands
  // there in production (only a root/verify-root does), so this widens nothing
  // reachable from executeLoom; it only keeps rollupWeave honest for callers
  // (fakes/harnesses) that hand it an already-verified child stamped "ready".
  const isMet = (state: WorkUnitState | undefined) => state === "done" || state === "ready";
  const allRequiredDone = required.every((sg) => isMet(childBySubGoal.get(sg.id)?.state));
  // §A: the woven root is the thing the owner accepts — it lands "ready",
  // never "done", even though the gate is still every required child === "done".
  if (allRequiredDone) return { state: "ready" };

  const failedRequired = required.find((sg) => childBySubGoal.get(sg.id)?.state === "failed");
  if (failedRequired) return { state: "failed", error: `${failedRequired.id}: failed` };

  // FINDING 8 — a required child that PARKED `blocked` (the breaker fired on an
  // unfixable gate, or the pre-flight lane-viability floor) is AWAITING A HUMAN,
  // not failed. Lift it as `blocked` so the root parks carrying the child's
  // answerable question (runWeave lifts blockedReason/blockedQuestion below) —
  // rather than the generic needs-review fallthrough burying the ask (run #3's
  // swallow). Ordered AFTER failedRequired (a genuinely failed child STILL fails
  // the weave), BEFORE the needs-review fallthrough. A child reaches `blocked`
  // when its verification lane is unviable (the pre-flight park); surfacing it
  // here lifts that block up to the root instead of masking it as needs-review.
  const blockedChild = required.find((sg) => childBySubGoal.get(sg.id)?.state === "blocked");
  if (blockedChild) return { state: "blocked", error: `${blockedChild.id}: blocked` };

  // L1/L6 (contract mandate 4) — the remaining required subgoals are unmet for a
  // reason OTHER than a failed/blocked child: they were either NEVER SPAWNED (the
  // weave loop exhausted — wall-clock / pool / iteration bound — before scheduling
  // them) or spawned and settled in a non-done, non-failed, non-blocked state. A root
  // with unbuilt/unproven required work NEVER settles into a state that presents an
  // accept affordance: it lands `blocked` (root escalation to the human) carrying a
  // COMPLETE reason that enumerates EVERY unmet required subgoal and distinguishes
  // `unspawned` from `spawned-but-not-done` — never the old single-id `${id}: not
  // done` needs-review (run #3's "F: not done" while 4/6 subgoals were never spawned).
  // `needs-review` for a ROOT is reserved for the composed-proof demote (a fully-built
  // weave whose ALL verify is in question — runWeave's integration-verify block below),
  // never for missing work.
  const unmet = required.filter((sg) => !isMet(childBySubGoal.get(sg.id)?.state));
  const detail = unmet
    .map((sg) =>
      childBySubGoal.has(sg.id) ? `${sg.id}: not done (${childBySubGoal.get(sg.id)!.state})` : `${sg.id}: unspawned`,
    )
    .join("; ");
  return { state: "blocked", error: `required subgoals unmet — ${detail}` };
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
  // M4 (auto-repair) — REPLACES runIntegrationVerify at the
  // terminal hook. Runs the frozen-lane read-only verify and, on a red ALL
  // verdict, a bounded provably-terminating repair loop (repair-guard.ts).
  // Returns the FINAL verify result: converged ⇒ pass/skip keeps "ready"
  // (never "done"); escalate ⇒ fail/flaky demotes ready→needs-review carrying
  // the guard reason on loom.error (which this dep sets). Absent (not injected,
  // e.g. in a test) ⇒ the runIntegrationVerify path above runs instead.
  runAutoRepair?: (loom: Loom) => Promise<{
    verification: string;
    gatesOk: boolean;
    panelReport?: PanelReport | null;
    gates?: GateResult[];
  } | null>;
  // M4 checkpoint — a BEST-EFFORT per-subGoal integration verify fired when a
  // child folds. Informational + non-blocking: it never gates the weave, never
  // mutates root state, and is pool-gated / slice-gated inside the dep itself
  // (skipped when there is no room or no assertions). Absent flag-off.
  runCheckpoint?: (child: Loom) => Promise<void>;
  // M5 — pre-build environment bring-up (the setup agent). Runs in the
  // `preparing` window, immediately after setState("preparing") and BEFORE the
  // first build child spawns. Absent flag-off, so the preparing→running
  // transition is byte-identical to today. On { ready:false } the weave does
  // NOT proceed to spawn children: the root lands needs-review (never done).
  runSetup?: (loom: Loom) => Promise<{ ready: boolean; wroteServersYaml?: boolean; error?: string }>;
  // B2 (§22-24,§62) — THE ORCHESTRATOR-MEDIATION LEG. Given a settled non-done
  // required child (failed / blocked / needs-review) that tick chose to `repair`,
  // produce a REMEDIATED child: re-derive / reassign / repair the thread. The
  // per-thread budget is enforced by the tick kernel (MEDIATION_BUDGET) — this
  // dep performs ONE bounded correction attempt and returns the new child state.
  // Absent (not injected, e.g. in a test) ⇒ mediation degrades to a fresh
  // REASSIGNMENT via the existing spawnChild/runChild seam: a clean re-attempt of
  // the subgoal (its own inner loop re-plans/re-verifies). Production (B2 step 2)
  // wires the richer runRepairThread / spawnChild-reuse / re-plan path here.
  mediateThread?: (child: Loom, sg: SubGoal) => Promise<Loom>;
};

function childCostUsd(child: Loom): number {
  return child.attempts.reduce((sum, a) => sum + (a.costUsd ?? 0), 0);
}

// L13 (contract mandate 5) — the minimal honest projection of a settled child's
// WorkUnitState onto the SubGoal.status enum (pending/ready/active/done/blocked/
// failed). done⇒done, a terminal failure⇒failed, an awaiting-orchestrator park⇒
// blocked, anything still moving⇒active. NOT authoritative — a sync of child state
// for the record/UI (tick.ts derives scheduling from live child state, never this).
function subGoalStatusFor(childState: WorkUnitState): SubGoal["status"] {
  switch (childState) {
    case "done":
      return "done";
    case "failed":
    case "halted":
      return "failed";
    case "blocked":
    case "needs-review":
      return "blocked";
    default:
      return "active";
  }
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
  // L13 (contract mandate 5) — persist SubGoal.status at the REAL transition so
  // loom.json reads truthfully WITHOUT cross-joining every child loom. A SYNC of
  // authoritative child state onto the charter record: saveLoom (via deps.onState)
  // writes the whole loom, charter included. `sg` is an element of `decomposition`
  // (= loom.charter.decomposition), so the mutation reaches disk.
  const syncSubGoalStatus = (sg: SubGoal, status: SubGoal["status"]) => {
    if (sg.status === status) return;
    sg.status = status;
    deps.onState?.(loom);
  };

  try {
    if (isAborted()) return halt();

    setState("preparing");

    // M5 setup agent (flag-on only): bring the env lane up / author a missing
    // servers.yaml before ANY build child spawns. Absent flag-off (dep
    // undefined) this whole block is skipped, so preparing→running is
    // byte-identical to today. On { ready:false } the weave STOPS here without
    // spawning children — the root lands needs-review carrying the setup error.
    // MOAT: never `done`; awaiting-human by design. An aborted setup halts.
    if (deps.runSetup) {
      const setup = await deps.runSetup(loom);
      if (isAborted()) return halt();
      if (!setup.ready) {
        loom.error = setup.error ?? "setup: environment not ready";
        emit({ type: "setup-failed", message: loom.error });
        setState("needs-review");
        return loom;
      }
      emit({ type: "setup-ready", wroteServersYaml: setup.wroteServersYaml === true });
    }

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
    // B2 — orchestrator-mediation attempts spent per subgoal. Feeds the tick
    // kernel (via currentThreads) so it emits `repair` only while a thread's
    // count is < MEDIATION_BUDGET, then escalates (the human park). Strictly
    // increments on each mediation ⇒ the rung is provably terminating.
    const mediationAttempts = new Map<string, number>(); // subGoalId -> mediations spent
    // M4: in-flight best-effort checkpoint verifies (never awaited inline so
    // they don't block the weave; drained before rollup so none detaches).
    const checkpoints: Promise<void>[] = [];
    const decisionLog: Decision[] = [];
    let spentUsd = 0;
    let startedRunning = false;

    // The live thread set (finished + in-flight), in the exact shape tick reads.
    // Shared by the loop body and the observe-delta so both see one truth.
    const currentThreads = (): ThreadView[] => [
      ...[...finished.entries()].map(([subGoalId, child]) => ({
        id: child.id,
        subGoalId,
        state: child.state,
        runnerInFlight: false, // settled: its runChild promise resolved → terminal
        mediationAttempts: mediationAttempts.get(subGoalId) ?? 0, // B2: mediations spent
      })),
      ...[...runningThread.values()].map((t) => ({ ...t, runnerInFlight: true })),
    ];
    // The ready subgoal set right now, via the pure scheduler primitive — so the
    // observe event's "unblocked" delta matches tick's own readiness definition.
    const readyIdsNow = (): string[] =>
      readySubGoals({
        charter: charterView,
        threads: currentThreads(),
        inFlight: running.size,
        budget: { maxAgents, inFlight: running.size, spentUsd, startedAtMs, maxCostUsd, maxWallClockHours },
        decisionLogTail: [],
        nowMs: now(),
      });

    // Unit 3 — PLAN event at weave start: the decomposition graph + the one
    // genuinely LLM-authored rationale (Charter.rationale). For a synthesized
    // weave-of-one (charterView drops `singleThread`, so read it off baseCharter)
    // an honest deterministic string stands in.
    emit({
      type: "plan",
      decomposition: decomposition.map((sg) => ({
        id: sg.id,
        title: sg.title,
        dependsOn: sg.dependsOn,
        required: sg.required,
      })),
      rationale:
        charterView.rationale ??
        (baseCharter?.singleThread ? "single thread by construction — no decomposition requested" : null),
    });

    const spawn = (sg: SubGoal) => {
      const child = deps.spawnChild(sg);
      emit({ type: "weave-child-spawned", subGoalId: sg.id, childId: child.id });
      syncSubGoalStatus(sg, "active"); // L13 — the subgoal is now being built
      runningThread.set(sg.id, { id: child.id, subGoalId: sg.id, state: "running" });
      // Attach the recording .then BEFORE this promise is placed into
      // `running` — since it always runs strictly before the wrapper
      // promise settles, every await on Promise.race(running.values())
      // below is guaranteed to observe the completed thread already moved
      // out of `running`/`runningThread` and into `finished`.
      const settle = deps.runChild(child).then((result) => {
        // Ready set BEFORE recording the settle (child still counts as running).
        const readyBefore = new Set(readyIdsNow());
        finished.set(sg.id, result);
        syncSubGoalStatus(sg, subGoalStatusFor(result.state)); // L13 — settled: done/failed/blocked
        spentUsd += childCostUsd(result);
        runningThread.delete(sg.id);
        running.delete(sg.id);
        // Unit 4 — OBSERVE event: which child settled, its rollup state, and the
        // subgoals THIS settle newly unblocked (ready now, not ready a moment ago).
        const unblocked = readyIdsNow().filter((id) => !readyBefore.has(id));
        emit({ type: "observe", subGoalId: sg.id, childId: result.id, state: result.state, unblocked });
        // M4 checkpoint (flag-on only): a best-effort per-subGoal integration
        // verify against the assembled-so-far whole, the moment this child
        // folds "done". Non-blocking (not awaited here) + informational: the
        // dep is pool-gated and never mutates root state. A "done" child is the
        // only one with a coherent contribution to check.
        if (deps.runCheckpoint && result.state === "done") {
          checkpoints.push(
            deps.runCheckpoint(result).catch((e) => {
              try {
                emit({ type: "weave-verify-error", message: e instanceof Error ? e.message : String(e) });
              } catch {
                /* best-effort */
              }
            }),
          );
        }
      });
      running.set(sg.id, settle);
    };

    // Base scheduling headroom (4 ticks/subgoal + slack) PLUS the B2 mediation
    // budget: each subgoal may be re-derived up to MEDIATION_BUDGET times, and
    // every mediation costs one repair-tick plus one re-observe tick — 2 per
    // attempt. Without this the safety bound would trip mid-mediation (still
    // safe — it escalates — but this keeps the bound honest w.r.t. the rung).
    const maxIterations = decomposition.length * (4 + 2 * MEDIATION_BUDGET) + 8;
    let iterations = 0;

    while (true) {
      if (isAborted()) return halt();

      iterations++;
      if (iterations > maxIterations) {
        loom.error = "weaver exceeded its safety iteration bound";
        break;
      }

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
        threads: currentThreads(),
        inFlight: running.size,
        budget,
        decisionLogTail: decisionLog.slice(-8),
        nowMs: now(),
      };

      // Unit 2 — the rationale rides alongside the decision. tick computes it
      // purely from `view`; the loop folds in only validateDecision's reason,
      // which is otherwise thrown away when an invalid decision is downgraded.
      const { decision, rationale } = tick(view);
      let d: Decision = decision;
      const v = validateDecision(d, view);
      if (!v.ok) {
        d = { action: "hold" }; // never apply an invalid decision
        rationale.rejected = v.reason; // (d) the reason the original decision was rejected
      }

      decisionLog.push(d);
      emit({ type: "decision", decision: d, rationale });

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

      // B2 (§22-24,§62) — THE ORCHESTRATOR-MEDIATION HANDLER. tick emits `repair`
      // for a settled non-done required thread while its per-thread budget
      // remains (see tick.ts). MEDIATE FIRST: re-derive / reassign the thread and
      // fold the remediated child back in, then re-tick. The tick kernel bounds
      // the loop — it stops emitting `repair` and escalates once mediationAttempts
      // reaches MEDIATION_BUDGET — so this can never spin. On exhaustion the
      // human parks stay the final valve (§73-74): the rollup below lifts a
      // still-blocked child's question up to the root.
      if (d.action === "repair") {
        // Resolve the settled child this directive targets (tick only emits
        // `repair` for a finished thread, so it lives in `finished`).
        let targetSubGoalId: string | undefined;
        let targetChild: Loom | undefined;
        for (const [sgId, c] of finished.entries()) {
          if (c.id === d.threadId) {
            targetSubGoalId = sgId;
            targetChild = c;
            break;
          }
        }
        const sg = targetSubGoalId ? decomposition.find((s) => s.id === targetSubGoalId) : undefined;
        if (!sg || !targetChild) {
          // Defensive: an unknown/absent mediation target — do not spin.
          loom.error = `mediation target ${d.threadId} not found`;
          break;
        }
        const attempt = (mediationAttempts.get(sg.id) ?? 0) + 1;
        mediationAttempts.set(sg.id, attempt);
        emit({
          type: "mediate",
          subGoalId: sg.id,
          childId: targetChild.id,
          attempt,
          priorState: targetChild.state,
        });
        // ONE bounded correction attempt: the richer re-derive/repair when
        // wired, else a fresh reassignment via the spawnChild/runChild seam.
        syncSubGoalStatus(sg, "active"); // L13 — the subgoal is being re-attempted (mediation re-dispatch)
        const remediated = deps.mediateThread
          ? await deps.mediateThread(targetChild, sg)
          : await deps.runChild(deps.spawnChild(sg));
        if (isAborted()) return halt();
        finished.set(sg.id, remediated);
        syncSubGoalStatus(sg, subGoalStatusFor(remediated.state)); // L13 — remediated child resettled
        spentUsd += childCostUsd(remediated); // account the remediation's spend
        emit({
          type: "mediate-result",
          subGoalId: sg.id,
          childId: remediated.id,
          state: remediated.state,
          attempt,
        });
        continue; // re-tick: converged ⇒ progress, still non-done ⇒ mediate again or park
      }

      // Any other unexpected action — escalate defensively rather than loop.
      loom.error = "unhandled decision";
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
    // M4: drain any best-effort checkpoint verifies so none detaches past the
    // weave's lifetime. Each already carries its own catch — informational.
    if (checkpoints.length > 0) {
      await Promise.allSettled(checkpoints);
    }

    const children = [...finished.values()];
    const r = rollupWeave(children, decomposition);
    // rollup is authoritative for state: a genuinely "ready" rollup (every
    // required child done) always wins, clearing any stray escalate/
    // iteration-bound error string.
    loom.error = r.state === "ready" ? null : (r.error ?? loom.error ?? null);
    // FINDING 8 — carry a `blocked` rollup's
    // parked child's HUMAN-facing question (blockedReason/blockedQuestion) up onto
    // the ROOT before setState so the existing blocked cockpit (form + Discuss)
    // renders the ask on the thing the human interacts with, and record WHICH child
    // /subgoal it came from (lane-escalation) for the event stream. The
    // integration-verify block below is gated r.state === "ready", so blocked
    // correctly skips it (nothing to verify on an awaiting-human park).
    if (r.state === "blocked") {
      // Scoped to REQUIRED subgoals to match rollupWeave's own blocked branch
      // (branch 4, above): that branch fires ONLY when a required child parked
      // blocked, and is mutually exclusive with the enumerate branch (unmet
      // required work that never spawned/settled). An unscoped find() here would
      // wrongly pick up an OPTIONAL child's blocked state — and its unrelated
      // question — while the else-branch's complete enumerated reason (r.error)
      // for the missing required work gets silently discarded.
      const requiredIds = new Set(decomposition.filter((sg) => sg.required).map((sg) => sg.id));
      const bChild = children.find((c) => c.state === "blocked" && !!c.subGoalId && requiredIds.has(c.subGoalId));
      if (bChild) {
        // A required child PARKED blocked — lift its answerable question to the root.
        loom.blockedReason = bChild.blockedReason;
        loom.blockedQuestion = bChild.blockedQuestion;
        emit({ type: "lane-escalation", by: "telar", childId: bChild.id, subGoalId: bChild.subGoalId });
      } else {
        // L1/L6 (contract mandate 4) — the root parks blocked because required work
        // is UNBUILT/UNPROVEN (unspawned or spawned-but-not-done), not because a child
        // asked a question. Surface the COMPLETE enumerated reason (rollupWeave's
        // r.error) as the root's human-facing ask so the cockpit shows exactly which
        // required subgoals are missing — never a bare accept affordance.
        loom.blockedReason = r.error ?? "required subgoals unmet";
        loom.blockedQuestion =
          "Required subgoals are unbuilt or unproven. Re-plan or reassign the missing threads, or override with a named justification.";
        emit({ type: "lane-escalation", by: "telar", reason: "required-subgoals-unmet", subGoalId: loom.subGoalId });
      }
    }
    setState(r.state);
    // L6 (contract mandate 4) — account for EVERY spawned child (required AND
    // non-required) in the record so a failed optional child never silently vanishes:
    // the rollup event carries each subgoal's final child state and whether it was
    // required. `children` is one settled child per subgoal (finished, drained above).
    emit({
      type: "weave-rollup",
      state: r.state,
      children: children.map((c) => ({
        subGoalId: c.subGoalId,
        state: c.state,
        required: decomposition.find((sg) => sg.id === c.subGoalId)?.required ?? false,
      })),
    });

    // Unit 6 (docs §8 MVP): integration verify PRODUCER. Runs strictly AFTER
    // setState(r.state) so the rollup state still wins — this is INFORMATIONAL,
    // it never mutates loom.state or any finish/accept semantics (Unit 7 gates
    // on it). Gated on r.state === "ready" (every required child self-reported
    // done, weave.ts §A): exactly the §2 case where children each self-reported
    // and no ALL verify has ever run — the whole point of catching a broken
    // assembled whole. A failed/needs-review assembly has nothing coherent to
    // integration-verify. A woven root with no ALL contract -> null -> no-op.
    // M4 (auto-repair): runAutoRepair REPLACES the plain
    // producer — it drives the frozen-lane verify and, on a red ALL verdict,
    // the bounded guarded repair loop, then returns the FINAL verdict. When
    // runAutoRepair is absent (not injected) the runIntegrationVerify path runs
    // instead. Either way the demote/keep semantics below are unchanged.
    const verifyProducer = deps.runAutoRepair ?? deps.runIntegrationVerify;
    if (r.state === "ready" && verifyProducer) {
      // Best-effort: its OWN try/catch so a throw — a rejecting runner, or a
      // saveLoom/appendEvent disk error inside the block — can NEVER reach the
      // outer catch and demote a correctly-woven "ready" loom to "failed". An
      // informational verify must not change the outcome: record the error and
      // drop it; the authoritative rollup state stands.
      try {
        const iv = await verifyProducer(loom); // null => no ALL contract
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
            // M4: runAutoRepair may already have set loom.error to the guard's
            // escalate reason ("no progress" / "regression: …" / "max repair
            // iterations" / budget). Preserve it; fall back to the generic
            // string flag-off (where loom.error is null after a ready rollup, so
            // this is byte-identical to the pre-M4 assignment).
            loom.error = loom.error ?? `integration verification ${iv.verification}`;
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
