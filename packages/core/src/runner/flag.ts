// The two flags that remain here are A2-scoped (deleted in the next de-flag
// round), each a manifest boolean (default false) OR-ed with a TELAR_*=1 env
// override so flag-off every code path is byte-identical to today. Every other
// M5-M11 flag has been collapsed to the sole engine path (see the note at the
// bottom of this file); their helpers and OFF branches are gone.

// Own loom execution in a standalone telar-runner process (out-of-process
// dispatch). Flag-off, dispatch stays in the calling (web) process.
export function runnerEnabled(manifest: { outOfProcessRunner?: boolean }): boolean {
  return manifest.outOfProcessRunner === true || process.env.TELAR_RUNNER === "1";
}

// M7 — divert a live-critic loom with no target + no server recipe to the
// `env-review` gate (a PROPOSED servers.yaml the human accepts) instead of
// skipping to needs-review. Flag-off, the divert never fires and every path is
// byte-identical to today. Honored via TELAR_ENV_REVIEW=1 for live-validation.
export function envReviewEnabled(manifest: { envReview?: boolean }): boolean {
  return manifest.envReview === true || process.env.TELAR_ENV_REVIEW === "1";
}

// M9/M9.3/M9.4 — the thread inner loop is UNCONDITIONAL, the sole engine path:
// every thread's build runs as an N-step DAG (runThreadWorkflow), authored by
// the LLM planner (degrading to the deterministic template library), with
// Step.check consumed as the optional per-step verify-lens. There is no flag;
// collapsed at their callsites (executor.ts). The former threadWorkflow /
// threadPlanner / stepChecks helpers are gone with their OFF branches.

// M10.1/M10.3/M10.4 — the orchestrator top gate (whole-verification over the
// composed whole), its supervised verification lane, and the pre-flight
// lane-viability gate are UNCONDITIONAL, the sole engine path. There is no flag:
// every woven root pays the fail-closed frozen-lane verify, stands a supervised
// repairable lane up for it, and pre-flight-parks `blocked` when no verification
// plan can be formed. Collapsed at their callsites (dispatcher.ts, executor.ts).
