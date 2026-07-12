// M5 flags — mirror isolationEnabled/autoRepairEnabled (vcs.ts) verbatim: a
// manifest boolean (default false) OR-ed with a TELAR_*=1 env override, so
// flag-off every code path is byte-identical to today.

// Own loom execution in a standalone telar-runner process (out-of-process
// dispatch). Flag-off, dispatch stays in the calling (web) process.
export function runnerEnabled(manifest: { outOfProcessRunner?: boolean }): boolean {
  return manifest.outOfProcessRunner === true || process.env.TELAR_RUNNER === "1";
}

// Run the scoped setup agent in the `preparing` window (bring the lane up /
// author a missing servers.yaml). Flag-off, preparing→running is unchanged.
export function setupAgentEnabled(manifest: { setupAgent?: boolean }): boolean {
  return manifest.setupAgent === true || process.env.TELAR_SETUP_AGENT === "1";
}

// M7 — divert a live-critic loom with no target + no server recipe to the
// `env-review` gate (a PROPOSED servers.yaml the human accepts) instead of
// skipping to needs-review. Flag-off, the divert never fires and every path is
// byte-identical to today. Honored via TELAR_ENV_REVIEW=1 for live-validation.
export function envReviewEnabled(manifest: { envReview?: boolean }): boolean {
  return manifest.envReview === true || process.env.TELAR_ENV_REVIEW === "1";
}

// M9 — run a thread's build as an N-step DAG (runThreadWorkflow) instead of the
// executeLoom attempt loop. Flag-off, executeLoom is unchanged and byte-identical.
export function threadWorkflowEnabled(manifest: { threadWorkflow?: boolean }): boolean {
  return manifest.threadWorkflow === true || process.env.TELAR_THREAD_WORKFLOW === "1";
}

// M9.3 — author the thread's step-graph with an LLM planner instead of the
// deterministic template library. Only meaningful when threadWorkflow is on
// (planner runs inside runThreadWorkflow, unreachable when threadWorkflow off).
// Flag-off, template selection stays deterministic — no LLM call, byte-identical.
export function threadPlannerEnabled(manifest: { threadPlanner?: boolean }): boolean {
  return manifest.threadPlanner === true || process.env.TELAR_THREAD_PLANNER === "1";
}
