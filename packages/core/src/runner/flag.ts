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

// M9.4 — consume Step.check as an optional, informational per-step verify-lens
// (read-only; bounded step-local repair; fail-closed). Only meaningful when
// threadWorkflow is on (the check runs inside runThreadWorkflow's per-step path,
// unreachable when threadWorkflow off). Flag-off, Step.check is ignored — no
// read-only check, no repair, byte-identical.
export function stepChecksEnabled(manifest: { stepChecks?: boolean }): boolean {
  return manifest.stepChecks === true || process.env.TELAR_STEP_CHECKS === "1";
}

// M10.1 — add ONE authoritative whole-verification gate that runs once over the
// COMPOSED WHOLE after weave rollup: (1) regression (did we break anything the
// user already had?) and (2) completeness (did we fill EVERY criterion of the
// FULL contract?). Fail-closed. It ADDS the top gate; it changes NO thread
// behavior (thread demotion is M10.2). Flag-off, producer selection + fork ref
// + verdict are byte-identical to today. A TOP-LEVEL flag (no parent guard,
// unlike threadPlanner/stepChecks). Honored via TELAR_ORCHESTRATOR_VERIFY=1.
export function orchestratorVerifyEnabled(manifest: { orchestratorVerify?: boolean }): boolean {
  return manifest.orchestratorVerify === true || process.env.TELAR_ORCHESTRATOR_VERIFY === "1";
}

// M10.3 — PROACTIVELY stand a supervised verification LANE up for the top-gate
// pass so the whole-verify panel gets a REAL target (a live server/db/multi-
// service substrate) instead of M10.1's `if(!target)` fail-closed skip, and
// REPAIR (bounded restart) a service that dies mid-verify. A PEER of
// orchestratorVerify but only MEANINGFUL when it (or autoRepair) is on — the
// lane is stood up ONLY inside frozenLaneVerify, reached only via those
// producer overrides. Modeled like threadPlanner/stepChecks (children of
// threadWorkflow). Flag-off ⇒ frozenLaneVerify keeps today's one-shot startLane
// (no supervisor, no captureLogs) and a bring-up throw propagates to weave's
// fail-open catch verbatim — byte-identical. Honored via TELAR_VERIFY_LANE=1.
export function verifyLaneEnabled(manifest: { verifyLane?: boolean }): boolean {
  return manifest.verifyLane === true || process.env.TELAR_VERIFY_LANE === "1";
}
