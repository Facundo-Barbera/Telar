// M9.3 — the deterministic template library + selection heuristic + graph
// validator for the per-thread planner. Pure/deterministic: makes no agent/
// engine call of its own; the only IO is a read-only readContract disk read
// in the heuristic (findCycle, imported below, is a pure DFS helper with no
// side effects, so this module still never touches the network/model).
// This is tier 1 of planThreadWorkflow (executor.ts) and the degrade target for
// the LLM planner (SLICE-B) — given the same loom it returns identical objects.
import type { Loom } from "./looms";
import type { ThreadWorkflow, Step } from "./schemas";
import { readContract } from "./bundle";
import { isWritingKind } from "./build-fanout";
import { findCycle } from "./scoping";

// The conservative default: today's 1-step build template. RE-ENTERS executeLoom
// via the runner's build-delegate, so it is behaviorally identical to M9.2.
export function singleBuildTemplate(loom: Loom): ThreadWorkflow {
  return { version: 1, steps: [{ id: "build", goal: loom.prompt, kind: "build", agents: [], partition: "free", dependsOn: [] }] };
}

// Escalation template for complex threads: research → build → check, strictly
// sequential (each dependsOn the prior). Agents are LEFT EMPTY on purpose (see
// NOTE): the deterministic template authors the DAG SHAPE only; the `implement`
// step does the real work by delegating to executeLoom exactly like single-build.
//
// NOTE (load-bearing — do not add agents): in M9.2 there is no inter-step data
// flow — a research/check step's agent output is not injected into a later step;
// it only yields a pass/fail scheduling signal. Deterministic research/check
// agents would spend read-only budget and add false-negative risk with zero
// benefit. Empty agents make understand/check vacuous read-only scheduling
// bookends (runFreeStepFanout returns {ok:true,state:"ready"} for agents:[], loom
// NOT promoted) and make implement (kind:"build", agents:[]) delegate to
// executeLoom byte-identically to single-build's build step. The agent slots are
// the scaffold the LLM planner (SLICE-B) and M9.4 populate.
export function understandImplementCheckTemplate(loom: Loom): ThreadWorkflow {
  return {
    version: 1,
    steps: [
      { id: "understand", goal: `Understand: ${loom.prompt}`, kind: "research", agents: [], partition: "free",            dependsOn: [] },
      { id: "implement",  goal: loom.prompt,                   kind: "build",    agents: [], partition: "disjoint-writer", dependsOn: ["understand"] },
      { id: "check",      goal: `Check: ${loom.prompt}`,       kind: "check",    agents: [], partition: "free",            dependsOn: ["implement"] },
    ],
  };
}

export const COMPLEXITY_THRESHOLD = 3;

// PURE: the escalation decision, given a blocker-assertion count. Escalate only on
// a clear multi-proof scope (>= 3). 0/1/2 ⇒ single-build (2-criterion threads stay
// conservative). Unit-testable with no disk.
export function pickTemplate(loom: Loom, blockerCount: number): ThreadWorkflow {
  return blockerCount >= COMPLEXITY_THRESHOLD
    ? understandImplementCheckTemplate(loom)
    : singleBuildTemplate(loom);
}

// The thread's own contract slice (always present — M1 invariant). Missing/invalid/
// unfalsifiable contract (readContract returns contract:null) ⇒ 1 ⇒ single-build.
export function blockerAssertionCount(loomId: string): number {
  const { contract } = readContract(loomId);
  return contract?.assertions.filter((a) => a.blocker).length ?? 1;
}

// The deterministic template selector (tier 1 + the degrade target for tiers 2-3).
export function selectTemplate(loom: Loom): ThreadWorkflow {
  return pickTemplate(loom, blockerAssertionCount(loom.id));
}

// Semantic well-formedness (zod already guarantees shape + valid StepKind via the
// ThreadWorkflow parse). Returns false ⇒ caller degrades to the template.
export function validateWorkflow(wf: ThreadWorkflow): boolean {
  const steps = wf.steps;
  if (!steps || steps.length === 0) return false;                       // non-empty
  const ids = steps.map((s) => s.id);
  if (new Set(ids).size !== ids.length) return false;                    // unique ids
  const idSet = new Set(ids);
  for (const s of steps) for (const d of s.dependsOn) if (!idSet.has(d)) return false; // deps exist
  if (findCycle(steps.map((s) => [s.id, s.dependsOn] as const)) !== null) return false; // acyclic
  if (!steps.some((s) => isWritingKind(s.kind))) return false;           // >= 1 writing step
  return true;
}
