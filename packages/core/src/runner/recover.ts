// M5 recovery — the pure per-state reconciler, reviewed BEFORE any execution
// relocates. This is the single change that could silently violate the moat
// ("never auto-fail/auto-complete a live loom"), so it is pure logic with an
// exhaustive, test-locked table.
//
// MOAT: no branch here can return a terminal-SUCCESS. reconcileState only ever
// yields resume / queued / halt / leave / skip — never `done`. A stranded
// in-flight loom is at worst marked failed/halted (both human-resumable), never
// completed. The verifier is untouched; recovery is a separate concern.
import type { WorkUnitState } from "../schemas";
import type { Loom } from "../looms";
import type { Liveness } from "./liveness";

// The action recovery takes for an in-flight loom judged NOT live by the oracle.
//   resume — re-enqueue (no repo side effects yet; safe to re-run clean)
//   queued — drop the dead run, re-enter as queued (re-scope/re-plan clean)
//   halt   — → halted (resumable): live side effects possible, human `resume`s
//   leave  — awaiting a human by design; no runner was expected
//   skip   — terminal (done/failed/skipped/halted): nothing to do
export type RecoverAction = "resume" | "queued" | "halt" | "leave" | "skip";

// docs/phase-2-runner-plan.md boot-recovery table (finer than the web's
// conservative all-failed sweep). Pure function of state ONLY — the liveness
// judgement and the parent-skip invariant live in `sweep`. Exhaustive over
// WorkUnitState so a new state is a compile error, never a silent `leave`.
export function reconcileState(state: WorkUnitState): RecoverAction {
  switch (state) {
    case "queued":
      return "resume"; // no repo side effects yet
    case "scoping":
      return "queued"; // drop the dead scoping run, re-scope clean
    case "preparing":
      return "resume"; // setup agent interrupted; re-runnable
    case "running":
      return "halt"; // live side effects possible; human `resume`
    case "verifying":
      return "halt"; // verifier is read-only; safe to re-run
    case "charter-review":
    case "ready":
    case "blocked":
    case "needs-review":
      return "leave"; // awaiting a human by design, no runner expected
    case "done":
    case "failed":
    case "skipped":
    case "halted":
      return "skip"; // terminal
  }
}

// The effects `sweep` applies for each non-leave/non-skip action. Injected so
// the reconciler stays pure and unit tests never touch disk / re-dispatch.
export type SweepActions = {
  resume: (loom: Loom) => void; // re-enqueue for a fresh run
  queued: (loom: Loom) => void; // re-enter as queued
  halt: (loom: Loom) => void; // → halted (resumable)
};

export type SweepEntry = { id: string; from: WorkUnitState; action: RecoverAction };

// The runner's (re)start reconciler. For each loom:
//   - a CHILD (parentLoomId) is skipped — children recover only via their
//     root's re-weave (spawnChild reuse), never independently (dispatcher.ts
//     invariant, preserved verbatim);
//   - a loom the oracle judges LIVE (fresh lease OR in the runner's /active) is
//     left untouched — this is what stops recovery from stranding a loom that a
//     still-running runner owns;
//   - otherwise the pure table decides. leave/skip are no-ops.
// Returns the applied entries for logging. Never writes `done`.
export function sweep(looms: Loom[], liveness: Liveness, actions: SweepActions): SweepEntry[] {
  const applied: SweepEntry[] = [];
  for (const loom of looms) {
    if (loom.parentLoomId) continue; // children recover via the root's re-weave
    if (liveness(loom.id)) continue; // a live loom is never touched
    const action = reconcileState(loom.state);
    if (action === "leave" || action === "skip") continue;
    const from = loom.state;
    if (action === "resume") actions.resume(loom);
    else if (action === "queued") actions.queued(loom);
    else actions.halt(loom);
    applied.push({ id: loom.id, from, action });
  }
  return applied;
}
