// M11.2 (docs/adaptive-verification.md §3.3, §3.4) — the VerificationStrategy
// union + the PURE chooser that generalizes the verification lane beyond
// "stand up a URL".
//
// The union lives HERE (its own leaf module), NOT in schemas.ts: a strategy is
// an ORCHESTRATION decision (how frozenLaneVerify establishes evidence inside
// the frozen worktree), never a persisted contract shape — nothing about it may
// leak into ContractAssertion validation semantics. The chooser is PURE over
// already-derived inputs (the deliverable signal + the contract's assertions +
// one precomputed boolean); it does no I/O of its own, so the caller decides
// where/when the signal is derived (frozenLaneVerify re-derives it against the
// frozen worktree `wt` — the artifact-time re-derivation the deferred-gate plan
// promised).
//
// THE VERDICT FLOOR IS NOT HERE (doc §4). A strategy only ever picks the METHOD
// evidence is gathered by; every verdict path is unchanged: a mis-chosen
// strategy's worst case is NO evidence — target=undefined → runPanelVerification
// no-target skip (executor.ts:552-566) → the M10.1 fullContract coercion
// (executor.ts:1157-1160) demotes. An honest "could not prove it", never a
// rubber-stamp.
import type { ContractAssertion } from "./schemas";
import type { DeliverableSignal } from "./deliverable-signal";
import { partitionAssertions } from "./executor";

// The strategy set (doc §3.4 taxonomy). Every member carries a human-readable
// `reason` (evidence for events/escalation copy). Only "test-gate" carries a
// runnable — the lockfile-aware invocation the signal derived, or the
// human-answered manifest verifyCommand. The runnable is LOAD-BEARING:
// frozenLaneVerify hands it to runIntegrationVerify as `establishRun`, where a
// SANCTIONED synthesized all-live-critic contract is tightened in memory to
// command gates that execute it — the artifact-time establishment the
// deferred-gate plan promised. For a contract that already carries its own
// deterministic assertions, those run as-is and the runnable is unused.
export type VerificationStrategy =
  | { kind: "server-lane"; reason: string } // today's resolveServersConfig → startLane → laneTarget URL, verbatim
  | { kind: "test-gate"; run?: string; reason: string } // library: deterministic gates against wt, no URL
  | { kind: "cli-harness"; reason: string } // CLI: run + assert exit/output against wt, no URL
  | { kind: "sandbox-eval"; reason: string } // DS: harness commands whose exit code encodes the assertion, no URL
  | { kind: "artifact-assert"; reason: string }; // contract-content selection: deterministic assertions over build artifacts

// Choose the strategy for one frozen-lane verify pass. First match wins; every
// ambiguity resolves toward "server-lane" — today's path VERBATIM — so a wrong
// guess can only preserve current behavior or fail-closed-tighten, never widen.
//
//   1. WEB SHAPE → server-lane. A dev/start script means a live lane is the
//      right substrate (the same short-circuit the signal module encodes); the
//      live-critic panel needs laneTarget/manifest.urls.dev exactly as today.
//   2. A RESOLVABLE SERVERS RECIPE → server-lane. A repo servers.yaml (or the
//      accepted .telar tier) is the strongest "this deliverable stands up"
//      evidence — API/DB (boot + hit endpoints, doc §3.4) stays unchanged from
//      M10, and the PROCESS-STANDING DS case (a kernel declared as a service)
//      rides this same path: the dispatcher's verifyLane injection makes the
//      bring-up superviseStartLane (verify-lane.ts:48-86), so the kernel stands
//      behind the executor/setup wall with restart-on-death + teardown-in-
//      finally, and the judge still only ever RECEIVES the resolved target.
//      This also protects deterministic gates that hit the stood-up services
//      (a `command` curling a lane URL) — skipping bring-up could only redden
//      them, so we don't.
//   3. A HUMAN-ANSWERED verifyCommand → test-gate carrying it. The strategy
//      answer answerBlocked persisted to telar.yaml ("what command proves this
//      package?") — the strongest non-server evidence there is (a human
//      declared it), so it outranks the derived signal and supplies the
//      establishment runnable even when the repo itself yields no signal.
//   4. A PLANNABLE NON-SERVER SIGNAL → its strategy. Only reachable with
//      driver==="none" (rules 1-2), where today's path stands nothing up anyway
//      (the empty-lane short-circuit, run-server.ts:516) — the delta vs today:
//      the panel is handed NO target (frozenLaneVerify threads the explicit
//      `noTarget` marker through runIntegrationVerify so the stale
//      manifest.urls.dev fallback is WITHHELD, not merely un-supplied — a
//      library/CLI/DS deliverable is never judged against a stale URL), and a
//      test-gate's runnable feeds the sanctioned artifact-time establishment.
//      "deferred-gate" folds into "test-gate": at verify time the artifact
//      EXISTS, so the wt re-derivation normally answers concretely; a
//      still-deferred plan (charter intent only) runs whatever deterministic
//      assertions the contract carries, and an all-live-critic remainder lands
//      the no-target fail-closed floor — honest, never green.
//   5. CONTRACT-CONTENT selection → artifact-assert. No signal producer exists
//      for this member (frozen deliverable-signal API): it is chosen when the
//      contract ITSELF is the plan — every assertion deterministic (runnables
//      asserting on build artifacts: exit codes over files/metrics/schemas) and
//      at least one exists. agentJudged must be EMPTY: a mixed contract falls
//      through to rule 6 so its live slice keeps today's exact target fallback.
//   6. DEFAULT → server-lane (today's path verbatim).
export function chooseVerificationStrategy(
  signal: DeliverableSignal,
  assertions: ContractAssertion[],
  opts: { serverConfigured?: boolean; verifyCommand?: string } = {},
): VerificationStrategy {
  const { deterministic, agentJudged } = partitionAssertions(assertions);

  if (signal.shape === "web") {
    return { kind: "server-lane", reason: "web-shaped deliverable — a live lane is the verification substrate" };
  }
  if (opts.serverConfigured === true) {
    return {
      kind: "server-lane",
      reason: "a servers recipe resolves — stand the lane up (boot + hit / process-standing), unchanged from M10",
    };
  }
  if (opts.verifyCommand?.trim()) {
    return {
      kind: "test-gate",
      run: opts.verifyCommand.trim(),
      reason:
        "a human-answered verification command is persisted on the manifest (telar.yaml verifyCommand) — " +
        "its exit code is the fail-closed gate",
    };
  }
  if (signal.plannable) {
    switch (signal.strategy) {
      case "test-gate":
      case "deferred-gate":
        return { kind: "test-gate", ...(signal.run ? { run: signal.run } : {}), reason: signal.reason };
      case "cli-harness":
        return { kind: "cli-harness", reason: signal.reason };
      case "sandbox-eval":
        return { kind: "sandbox-eval", reason: signal.reason };
    }
  }
  if (deterministic.length > 0 && agentJudged.length === 0) {
    return {
      kind: "artifact-assert",
      reason:
        "the contract itself is the plan — every assertion is a deterministic runnable over the frozen worktree's artifacts",
    };
  }
  return { kind: "server-lane", reason: "no non-server strategy applies — today's path verbatim" };
}
