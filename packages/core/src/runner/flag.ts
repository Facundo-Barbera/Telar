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

// M10.4 — a PRE-FLIGHT lane-viability gate: before spending on the build (before
// children spawn) check the verification lane is achievable; if it is NOT and
// cannot be auto-provisioned, PARK the loom in `blocked` with a narrative
// question (a bounded ask-once-persist human escalation) instead of spawning
// threads that then strand. A TOP-LEVEL flag (no parent guard, like
// orchestratorVerify) since the pre-flight runs in dispatchExecution before any
// thread flag matters. Flag-off ⇒ the pre-flight park never fires and dispatch is
// byte-identical to today. Honored via TELAR_LANE_ESCALATION=1.
export function laneEscalationEnabled(manifest: { laneEscalation?: boolean }): boolean {
  return manifest.laneEscalation === true || process.env.TELAR_LANE_ESCALATION === "1";
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

// M10.5 — route criteria by objective-vs-subjective. Objective/machine-verifiable
// criteria keep flowing to the fail-closed autonomous gates + panel (unchanged);
// an EXPLICITLY subjective-marked criterion (ContractAssertion.subjective===true)
// is pulled OUT of the blocking panel into a `humanJudged` bucket carried to the
// human accept (never faked into a machine check), and an OPTIONAL non-blocking
// aesthetic critic (class:"aesthetic", blocker:false) can nudge but never gate.
// A TOP-LEVEL flag (no parent guard, like orchestratorVerify/laneEscalation).
// Flag-off ⇒ routeAssertions returns humanJudged:[] over the UNCHANGED
// partitionAssertions, no aesthetic lens is sized, and synthesizeContract's
// structural routing is skipped — every path is byte-identical to today.
// Honored via TELAR_SUBJECTIVE_ROUTING=1 for live-validation.
export function subjectiveRoutingEnabled(manifest: { subjectiveRouting?: boolean }): boolean {
  return manifest.subjectiveRouting === true || process.env.TELAR_SUBJECTIVE_ROUTING === "1";
}

// M11.1 — modality derivation (docs/adaptive-verification.md §3.1, §7). When on,
// synthesizeContract DERIVES each synthesized criterion's assertion type from the
// deliverable (the pure deliverable signal + the charter's proof intent) instead
// of the blanket live-critic: under an explicit SANCTION (prompt-fallback
// criteria — the greenfield synth-0 shape — or a gate-mechanism charter) a
// test-gate deliverable's criteria become fail-closed `command` assertions
// (expected = the lockfile-aware test runnable), and a charter-authored
// per-criterion proofHint becomes command+expected — the derivation only
// TIGHTENS (live-critic → gate/command, the one direction contractLoosenings
// never flags); a criterion with no runnable — or authored prose nobody
// declared provable-by-suite — STAYS live-critic, and draftCharter's prompt
// gains the proof-hint authoring guidance.
// A TOP-LEVEL flag (no parent guard, like subjectiveRouting/laneEscalation).
// Flag-off ⇒ synthesizeContract maps every criterion live-critic/ALL exactly as
// today (weave-contracts.ts) and the drafting prompt is byte-identical — no
// filesystem signal is even derived. Honored via TELAR_ADAPTIVE_VERIFY=1 for
// live-validation.
export function adaptiveVerificationEnabled(manifest: { adaptiveVerification?: boolean }): boolean {
  return manifest.adaptiveVerification === true || process.env.TELAR_ADAPTIVE_VERIFY === "1";
}
