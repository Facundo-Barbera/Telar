// Executor: the L1 stage loop — attempt, verify with gates, decide, retry.
// Pure w.r.t. persistence: mutates the loom object and emits events; the caller
// persists via onState/onEvent. Retries resume the previous attempt's session.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { agent } from "./engine";
import { refreshProjectMcpAuth, resolveProjectMcpServers } from "./mcp";
import {
  type BuildPiece,
  runBuildFanout,
  isWritingKind,
  agentsToPieces,
  piecesAreDisjoint,
  decideBuildFanout,
  READ_ONLY_TOOLS,
  READ_ONLY_DISALLOWED_TOOLS,
} from "./build-fanout";
import { CONTRACT_FILE, readBundleFile, readContract } from "./bundle";
import { selectTemplate, validateWorkflow } from "./thread-templates";
import { runPanel, type CriticContext, type PanelEvent } from "./critic";
import { classifyPanel, panelReason, type PanelSignals } from "./panel";
import { type Gate, runGate, runGates, type GateResult } from "./gates";
import { getLoom, loomDir, type AttemptRecord, type Loom, type LoomKind } from "./looms";
import { addWorktree, defaultGitRunner, removeWorktree, snapshotWorktreeToBranch, withWorktreeLock } from "./vcs";
import { normalizeGateOutput } from "./repair-guard";
import { isRunnableShape } from "./runnable-shape";
// FINDING 6/7 integration — the shared author-repairable-error predicate. Safe
// circular import: weave-contracts already imports partitionAssertions from here,
// and both are hoisted function declarations used only at runtime (never at module
// load), so ESM live bindings resolve them regardless of evaluation order.
import { contractErrorsRepairable } from "./weave-contracts";
import { foldChildOnDone } from "./consolidate";
import { startProjectServer } from "./run-server";
import { ModelPolicy, ThreadWorkflow, validateContract, Verdict, VerificationContract } from "./schemas";
import type {
  AccountProfile,
  ContractAssertion,
  PanelReport,
  ProjectManifest,
  Roster,
  ServersConfig,
  Step,
  VerifierReport,
  WorkUnitState,
} from "./schemas";
import { verify } from "./verifier";
import { readyItems, EST_COST_PER_AGENT } from "./tick";
import { fanoutSize, prioritizeScored, budgetLeftUsd, DEFAULT_MAX_AGENTS } from "./budget";
import { resolveServersConfig, resolveRunbook } from "./servers";
import { blockedStrategyQuestion, charterHasGateIntent, deriveDeliverableSignal, type CharterProofIntent } from "./deliverable-signal";

export type ExecuteOpts = {
  policy?: ModelPolicy;
  accounts?: Record<string, AccountProfile>;
  maxAttempts?: number;
  abort?: AbortController;
  onEvent?: (ev: { type: string } & Record<string, unknown>) => void;
  onState?: (loom: Loom) => void;
  // OPT-IN intra-thread Build fan-out (docs/loom-orchestrator.md §7). Absent
  // (the default) => the single-builder path below runs byte-identical to
  // pre-M7.3b. When present with >=2 pieces, the build step splits into N
  // git-worktree-isolated builders (build-fanout.ts) whose merged result
  // still goes through the SAME gates + one independent Verifier below — the
  // moat is unaffected by how many builders wove the thread.
  buildFanout?: { pieces: BuildPiece[]; baseRef?: string };
  // Reserved for the caller's scheduler (M7.5) to report agent-pool headroom
  // alongside buildFanout; not read by executeLoom itself in this phase.
  poolRoom?: number;
  // M6 — the curated agent roster (schemas.ts Roster). A build-fanout piece
  // MAY name a preset (BuildPiece.agent); makePieceBuilder merges its
  // model/tools/disallowedTools/promptPrelude over the piece defaults. Absent
  // or {} (the default) ⇒ no preset applied ⇒ byte-identical to today. NEVER
  // consulted by the Verifier/Critic (their AgentOpts are hard-coded constants).
  roster?: Roster;
  // Injectable builder agent (defaults to the real engine `agent`). Mirrors the
  // `run?: typeof agent` seam runVerification/runPanelVerification already
  // expose — lets tests drive the build loop with a fake builder (no live
  // model) without mocking the engine module. Production never sets it.
  run?: typeof agent;
  // M9 — recursion guard: set true when runThreadWorkflow re-enters executeLoom
  // to run the default `build` step. Suppresses the top-of-executeLoom flag
  // branch so the delegated call runs today's unchanged attempt loop instead of
  // recursing. Absent everywhere except that one internal re-entry.
  viaWorkflow?: boolean;
  // M9 — injectable per-step executor for the workflow runner (test seam + the
  // M9.2 fan-out hook). Absent, the built-in executor delegates a `build` step to
  // executeLoom (byte-identical to today) and rejects other kinds. Flag-off this
  // is never consulted.
  runStep?: (step: Step, ctx: WorkflowStepCtx) => Promise<StepResult>;
  // M9.3 — injectable step-planner (test seam, mirrors runStep?). Absent ⇒ the
  // built-in planThreadWorkflow (LLM planner is the norm; deterministic template
  // is the degrade floor). Lets a test inject a canned/invalid/cyclic plan
  // or assert the planner is/isn't invoked, without a live model.
  planWorkflow?: (loom: Loom, manifest: ProjectManifest, opts: ExecuteOpts) => Promise<ThreadWorkflow>;
  // M9.4 — injectable per-step CHECK evaluator (test seam, mirrors runStep?).
  // Absent ⇒ the built-in runStepCheck (partition st.check → deterministic gates
  // + read-only critic panel; no writer spend). Lets a test inject a canned
  // pass/fail without a live model/browser. Flag-off never consulted.
  runStepCheck?: (step: Step, ctx: WorkflowStepCtx) => Promise<"pass" | "fail" | "skip">;
};

const MAX_TURNS: Record<LoomKind, number> = { quickfix: 50, story: 150, custom: 80, verify: 40 };
const BASE_TOOLS = ["Read", "Grep", "Glob", "Write", "Edit", "Bash"];

const tail = (s: string, n: number) => (s.length > n ? s.slice(-n) : s);

// Conservative "is file under any of these path patterns" check — the same
// literal-prefix approximation build-fanout.ts uses for allowedPaths overlap
// (duplicated locally rather than shared, to keep this a same-file, minimal
// change). An unanchored/empty pattern matches everything.
function pathUnderAny(file: string, patterns: string[]): boolean {
  const norm = file.replace(/\\/g, "/");
  return patterns.some((p) => {
    const idx = p.search(/[*?[]/);
    const base = (idx === -1 ? p : p.slice(0, idx)).replace(/\\/g, "/").replace(/\/+$/, "");
    if (!base) return true;
    return norm === base || norm.startsWith(base + "/") || norm.startsWith(base);
  });
}

// M3 — the SINGLE cwd flip point. Flag-off (no worktree) this is
// manifest.root, so every builder/gate/verify/touched-files site that routes
// through it is byte-identical to pre-M3. Flag-on a child thread's build,
// gates, and touched-file measurement all read the SAME isolated worktree the
// builder wrote (coherence — see isolation-risks risk #4).
function buildCwd(loom: Loom, manifest: ProjectManifest): string {
  return loom.worktree ?? manifest.root;
}

// §M.4: an independent (non-self-reported) measurement of which files
// actually changed on disk, via `git status --porcelain` — the same
// primitive build-fanout.ts:mergeDisjoint already uses for the fan-out path.
// Best-effort: a non-git root (e.g. in tests) or any git failure yields []
// rather than throwing, so this can never break a loom that has no git repo.
function gitTouchedFiles(root: string): string[] {
  try {
    const raw = execFileSync("git", ["-c", "core.quotepath=false", "status", "--porcelain"], {
      cwd: root,
    }).toString();
    const files: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const status = line.slice(0, 2);
      let filePath = line.slice(3).replace(/^"|"$/g, "");
      if (status.includes("R")) {
        const parts = filePath.split(" -> ");
        filePath = parts[parts.length - 1]!;
      }
      files.push(filePath);
    }
    return files;
  } catch {
    return [];
  }
}

function firstPrompt(loom: Loom, manifest: ProjectManifest): string {
  const protectedPaths = manifest.guardrails.protectedPaths;
  return [
    `# ${loom.title}`,
    loom.prompt,
    protectedPaths.length
      ? `Guardrails: the following paths are absolutely forbidden to modify: ${protectedPaths.join(", ")}.`
      : "",
    "Make focused changes, verify your own work, and when done call emit_result with your Verdict (ok, summary, files_touched, blocker). Keep summary to a brief 1-3 sentence overview of what changed and why — not an essay or a per-file list.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function retryPrompt(
  failing: GateResult[],
  verdict: Verdict | null,
  verdictWasNull: boolean,
  verifierRepair?: string,
): string {
  const parts: string[] = [];
  if (verifierRepair) {
    parts.push(
      `The independent Verifier drove the running app and found these acceptance criteria NOT met:\n${verifierRepair}\nFix the underlying UI/behavior, then re-verify and call emit_result.`,
    );
  }
  if (failing.length) {
    parts.push("Your previous attempt failed these verification gates:");
    for (const g of failing) {
      parts.push(`## ${g.name} (exit ${g.exitCode ?? (g.timedOut ? "timeout" : "?")})\n${tail(g.output, 2000)}`);
    }
  }
  if (verdict) {
    parts.push(
      `Your previous verdict: ${verdict.summary}${verdict.blocker ? ` (blocker: ${verdict.blocker})` : ""}`,
    );
  }
  if (verdictWasNull) {
    parts.push(
      "Your previous attempt never called emit_result. Finish the work and call emit_result with your Verdict.",
    );
  } else {
    parts.push("Fix the issues above and re-verify, then call emit_result with your Verdict.");
  }
  return parts.join("\n\n");
}

// How the Verifier's loom classifies. "skip" = not run / not applicable / errored;
// callers also pass "skip" when the builder never succeeded (nothing to verify).
export type Verification = "skip" | "pass" | "fail" | "flaky";

export type Decision =
  | { action: "done" }
  | { action: "needs-review"; error?: string }
  | { action: "failed"; error?: string }
  | { action: "retry" };

// Pure: §A (docs/loom-model.md) — a completed ROOT loom (no parentLoomId)
// lands "ready" (verified, awaiting owner acceptance via acceptLoom()), never
// "done". A CHILD thread (has parentLoomId) is a sub-unit the weaver's
// rollupWeave folds up, and that gate still needs "done" from its children.
export function terminalStateForCompletedLoom(loom: Pick<Loom, "parentLoomId">): WorkUnitState {
  return loom.parentLoomId ? "done" : "ready";
}

// Pure outcome function: given the attempt's gate/verdict/verification state,
// decide what to do. No side effects, no persistence. When verification ===
// "skip" the outcome is byte-identical to the pre-M2 behavior, UNLESS
// `panelRequired` is set (a Verification Contract/Critic Panel was mandatory
// for this loom) — in that case a "skip" can never satisfy promotion, no
// matter how green the deterministic gates are: a missing target, a thrown
// exception, or an all-null critic set is a FAILURE to obtain evidence, not
// "nothing to verify" (docs/loom-model.md §4 Layer 3). Legacy/no-contract
// looms never set this, so their behavior is unchanged.
export function decide(input: {
  gatesConfigured: boolean;
  gatesOk: boolean;
  verdict: Verdict | null;
  verification: Verification;
  n: number;
  maxAttempts: number;
  flakyUsed: number;
  maxFlaky: number;
  panelRequired?: boolean;
  // M10.2 — CHILD-scoped, gated on the SAME flag as M10.1's top gate. When true,
  // a `panelRequired` skip (evidence structurally unobtainable at thread altitude)
  // resolves to a GREEN `done` instead of retry/needs-review — the full contract is
  // re-proven fail-closed at the orchestrator top gate over the composed whole.
  // Default undefined/false ⇒ decide() is byte-identical to today (root or flag-off).
  childAdvisory?: boolean;
}): Decision {
  const { gatesConfigured, gatesOk, verdict, verification, n, maxAttempts, flakyUsed, maxFlaky, panelRequired, childAdvisory } =
    input;
  const canRetry = n < maxAttempts;
  const flakyDecision = (): Decision =>
    flakyUsed < maxFlaky && canRetry ? { action: "retry" } : { action: "needs-review", error: "verification flaky" };

  if (gatesConfigured && gatesOk) {
    if (verdict?.ok) {
      // Deterministic gates + agent both green; the Verifier now gates promotion.
      switch (verification) {
        case "skip":
          if (panelRequired) {
            // M10.2: a CHILD (childAdvisory) SHORT-CIRCUITS to a green terminal —
            // retrying cannot obtain evidence the thread altitude
            // structurally cannot reach; the top gate re-proves the full contract
            // over a reachable composed whole (fail-closed). Budget is not burned.
            if (childAdvisory) return { action: "done" };
            return canRetry
              ? { action: "retry" }
              : { action: "needs-review", error: "panel verification required but did not run" };
          }
          return { action: "done" };
        case "pass":
          return { action: "done" };
        case "fail":
          return canRetry ? { action: "retry" } : { action: "needs-review", error: "verification failed" };
        case "flaky":
          return flakyDecision();
      }
    }
    if (verdict) return { action: "needs-review", error: verdict.blocker ?? undefined };
    // Gates pass but the agent never reported.
    return canRetry
      ? { action: "retry" }
      : { action: "needs-review", error: "gates pass but agent never confirmed" };
  }

  if (!gatesConfigured) {
    if (verdict?.ok) {
      // No deterministic gates — the Verifier IS the gate.
      switch (verification) {
        case "skip":
          // Unit 4 (docs §5): mirror the gated branch (187-193). A mandatory
          // panel that never ran deserves the retry a transient skip warrants,
          // then lands needs-review WITH an error — never a silent bare
          // needs-review that drops the required-but-skipped signal.
          if (panelRequired) {
            // M10.2: identical CHILD-advisory relaxation to the gated branch.
            if (childAdvisory) return { action: "done" };
            return canRetry
              ? { action: "retry" }
              : { action: "needs-review", error: "panel verification required but did not run" };
          }
          return { action: "needs-review" }; // no panel required — nothing verified, unchanged
        case "pass":
          return { action: "done" }; // promote
        case "fail":
          return canRetry ? { action: "retry" } : { action: "needs-review", error: "verification failed" };
        case "flaky":
          return flakyDecision();
      }
    }
    // verdict == null || !verdict.ok
    return canRetry ? { action: "retry" } : { action: "failed" };
  }

  // gatesConfigured && !gatesOk
  return canRetry ? { action: "retry" } : { action: "failed" };
}

// Summarize the failing (and flaky) criteria into a repair brief for the builder.
function buildVerifierRepair(report: VerifierReport): string {
  const parts: string[] = [];
  for (const c of report.criteria) {
    if (c.verdict !== "fail" && c.verdict !== "flaky") continue;
    const lines = [`- [${c.verdict}] ${c.criterion}`, `  observed: ${c.observed}`];
    if (c.repro.length) {
      lines.push("  repro:");
      for (const s of c.repro) lines.push(`    - ${s.action} ${s.target}${s.value ? ` = ${s.value}` : ""}`);
    }
    for (const e of c.evidence) {
      if ((e.kind === "console" || e.kind === "network") && e.text) {
        lines.push(`  ${e.kind}: ${tail(e.text, 500)}`);
      }
    }
    parts.push(lines.join("\n"));
  }
  return parts.join("\n");
}

// Classify a report from its per-criterion verdicts — NOT report.ok. The
// Verifier now gates real outcomes, so the classification must derive from the
// evidence, not the agent's own summary boolean (which could contradict its
// criteria). Empty criteria = nothing actually judged -> "skip" (safe: a
// malformed report never auto-promotes to done).
export function classify(report: VerifierReport): Verification {
  if (report.criteria.length === 0) return "skip";
  if (report.criteria.some((c) => c.verdict === "fail")) return "fail";
  if (report.criteria.some((c) => c.verdict === "flaky")) return "flaky";
  return "pass";
}

// Unit 4 (docs §2). PURE. Partitions a contract's assertions by MODALITY, not
// by target:
//   - deterministic: command / gate / db-with-a-runnable-command — settled in
//     the gate/command layer BEFORE the panel, pass/fail by exit code, no LLM.
//   - agentJudged:   live-critic + the four existing value kinds (golden-diff /
//     value-equality / schema-match / contains, already panel-judged today) +
//     any db that needs a LIVE SQL connection (carries an `observable`, Unit 7).
//
// A db is runnable ONLY when it carries a command in `expected` and NO
// `observable` — an `observable` marks the live-SQL variant deferred to the
// panel. command/gate always route deterministic (validateContract already
// guarantees their `expected`). Every EXISTING contract (live-critic +
// value-equality) yields deterministic:[] / agentJudged:[all] — byte-identical
// to pre-Unit-4.
function isDeterministic(a: ContractAssertion): boolean {
  const hasRunnable = !!a.expected && !!a.expected.trim();
  switch (a.type) {
    case "command":
    case "gate":
      return hasRunnable;
    case "db":
      return hasRunnable && !(a.observable && a.observable.trim());
    default:
      return false; // the five existing kinds stay agent-judged
  }
}

export function partitionAssertions(assertions: ContractAssertion[]): {
  deterministic: ContractAssertion[];
  agentJudged: ContractAssertion[];
} {
  const deterministic: ContractAssertion[] = [];
  const agentJudged: ContractAssertion[] = [];
  for (const a of assertions) (isDeterministic(a) ? deterministic : agentJudged).push(a);
  return { deterministic, agentJudged };
}

// Subjective routing. PURE. A THIRD bucket layered OVER partitionAssertions.
// Ordering is load-bearing: it partitions by MODALITY FIRST via the UNCHANGED
// partitionAssertions, then pulls the EXPLICITLY subjective-marked assertions
// (subjective===true) ONLY out of the agent-judged remainder into `humanJudged`
// (carried to the human accept, NEVER a machine gate). The DETERMINISTIC slice is
// NEVER touched by the subjective filter: a deterministic assertion (command/gate/
// runnable-db) ALWAYS gates fail-closed regardless of the marker, so a stray
// subjective:true can never pull an exit-code-checkable criterion out of the gate.
//
// DEFAULT-TO-OBJECTIVE is free: every routing decision keys on the POSITIVE
// subjective===true test, never on its absence. So an UNMARKED criterion (100% of
// existing/unmarked assertions) flows through the exact deterministic/agent-judged
// split and stays fail-closed. A mis-classification can only take the safe form of
// FAILING to mark something subjective (leaving it objective); a missing marker can
// NEVER drop an objective criterion from the gate. Subjective assertions are pulled
// out of agentJudged only, so they never remain a blocking panel lens — they carry
// to the human, holistically, at accept.
export function routeAssertions(assertions: ContractAssertion[]): {
  deterministic: ContractAssertion[];
  agentJudged: ContractAssertion[];
  humanJudged: ContractAssertion[];
} {
  const parts = partitionAssertions(assertions);
  const humanJudged = parts.agentJudged.filter((a) => a.subjective === true);
  const agentJudged = parts.agentJudged.filter((a) => a.subjective !== true);
  return { deterministic: parts.deterministic, agentJudged, humanJudged };
}

// M10.4 — PURE lane-viability check for the pre-flight escalation gate. A
// contract's verification lane is VIABLE when EITHER nothing live is needed
// (all-deterministic: no agent-judged assertions — the zero-browser backend
// path) OR a live target is obtainable: manifest.devCommand set (M5 auto-spin
// owns bringing it up) OR a servers recipe tier resolves to a real driver (a
// repo servers.yaml OR an already-accepted `.telar/servers.yaml`). Mirrors the
// no-target lane check in runPanelVerification, so a previously-persisted
// recipe means the lane is viable and the pre-flight NEVER re-asks. PURE over
// already-resolved inputs (one filesystem tier read) — it cannot loop or spawn.
//
// M11.0 (adaptive-verification.md §3.2) — the predicate REFRAMES from "is a
// lane viable RIGHT NOW?" to "can a PLAN to verify this be formed at all — now
// or after the build?": a THIRD true-path fires when a NON-SERVER verification
// strategy is derivable from the deliverable (a package.json test script / CLI
// bin, notebook/dataset markers, or the charter's gate-shaped proof intent —
// the greenfield case where NO files exist yet). Proceed-and-defer: the
// strategy is ESTABLISHED when the artifact appears, and a deferred plan that
// then can't produce evidence lands the existing fail-closed floor
// (panelRequired skip → demoting coercion, :1157-1160) — never a false green.
// The widening only ever ADDS viability (park less, never more), stays PURE
// (deriveDeliverableSignal is a bounded synchronous fs read — same class as
// the resolveServersConfig tier read; no LLM, no spawn — the M11.0 no-spend
// guarantee), and drives the UNCONDITIONAL dispatcher pre-flight gate. The `charter`
// param is OPTIONAL so every existing 2-arg caller compiles and behaves
// identically; without it the greenfield charter-intent signal simply can't
// fire (the filesystem signals still can).
export function isLaneViable(
  manifest: ProjectManifest,
  assertions: ContractAssertion[],
  charter?: CharterProofIntent,
): boolean {
  const { agentJudged } = partitionAssertions(assertions);
  if (agentJudged.length === 0) return true; // all-deterministic — no live lane needed
  if (manifest.devCommand) return true; // M5 auto-spin brings the dev server up
  // M11.0/M11.2 — a HUMAN-answered verification command (answerBlocked's
  // strategy answer, persisted to telar.yaml). Accept-guard consistency (doc
  // §8 last bullet): every answer answerBlocked accepts must make this
  // predicate true, or the accepted-but-never-resolves re-park loop returns.
  // Consumed downstream by the M11.2 establishment (runIntegrationVerify runs
  // it as a deterministic gate over the frozen worktree), so the proceed is
  // never a dead end.
  if (manifest.verifyCommand?.trim()) return true;
  if (resolveServersConfig(manifest.root).driver !== "none") return true; // repo or accepted .telar tier
  return deriveDeliverableSignal(manifest.root, charter).plannable; // M11.0 — a non-server plan is formable
}

// Unit 4 (docs §3). Runs the deterministic assertions in the SAME gate/command
// layer manifest gates use (runGate: detached process, exit code, 8KB output
// tail, timeout) — no new process machinery. Each GateResult.name = a.id so a
// red result names its assertion, and its output tail feeds the retry prompt
// unchanged. `runner` is injectable for hermetic tests; it defaults to runGate.
//   command      -> runGate({ name: a.id, run: a.expected })     // pass = exit 0
//   gate         -> lookup manifest.gates where name === a.expected; run that
//                   gate's command (missing name -> synthetic ok:false result,
//                   never a silent pass)
//   db(runnable) -> runGate({ name: a.id, run: a.expected })     // pass = exit 0
export async function runContractGates(
  deterministic: ContractAssertion[],
  manifest: ProjectManifest,
  cwd: string,
  // M1 (D2): the gate callback now also receives the ASSERTION it ran, so a
  // gate loom event can carry {assertionId, assertionType} tying the result
  // back to its contract assertion (manifest-gate emits stay id-less).
  onGate?: (r: GateResult, a: ContractAssertion) => void,
  runner: (gate: Gate, cwd: string) => Promise<GateResult> = runGate,
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const a of deterministic) {
    let r: GateResult;
    if (a.type === "gate") {
      const named = manifest.gates.find((g) => g.name === a.expected);
      r = named
        ? await runner({ name: a.id, run: named.run }, cwd)
        : {
            name: a.id,
            ok: false,
            exitCode: null,
            output: `gate assertion ${a.id} references unknown manifest gate "${a.expected ?? ""}"`,
            durationMs: 0,
            timedOut: false,
          };
    } else {
      // command | db(runnable): the runnable string lives in `expected`.
      r = await runner({ name: a.id, run: a.expected ?? "" }, cwd);
    }
    results.push(r);
    onGate?.(r, a);
  }
  return results;
}

// §4 Layer 2 (docs/loom-model.md): grounds the Critic Panel in the loom's
// Spec Bundle and returns its aggregated classification — the new source of
// `verification` for a bundle loom. `target` missing means nothing can be
// driven live, so this never spends anything ("skip", same rule the legacy
// path uses). PURE composition around runPanel/classifyPanel; the only
// side effects are emit() and mutating `attempt` (verifierReport's sibling).
async function runPanelVerification(
  loom: Loom,
  manifest: ProjectManifest,
  attempt: AttemptRecord,
  emit: (ev: { type: string } & Record<string, unknown>) => void,
  contract: VerificationContract,
  account?: AccountProfile,
  target?: string,
  opts?: { abort?: AbortController; run?: typeof agent },
  // M1 (D0.4) → M8 fail-closed: whether this contract was auto-synthesized.
  // Retained for the call signature; classification no longer branches on it —
  // a non-empty agent-judged slice that cannot obtain live evidence (no target,
  // panel threw) is always a panelRequired:true skip, authored and synthesized
  // alike (moat: no evidence ⇒ no promotion, decide() retries then needs-review).
  synthesized = false,
): Promise<{
  verification: Verification;
  report: VerifierReport | null;
  panelReport?: PanelReport | null;
  panelRequired: boolean;
}> {
  // Unit 4 (docs §4): the panel only ever sees the AGENT-JUDGED slice — the
  // deterministic assertions were already settled as gates (executeLoom) and
  // must not be re-judged by prose. panelRequired = agentJudged.length > 0.
  // Subjective-marked assertions are pulled out into humanJudged BEFORE this split,
  // so a subjective criterion never enters agentJudged / the blocking panel; it is
  // stamped onto the attempt (informational) and carried to the human accept.
  const { agentJudged, humanJudged } = routeAssertions(contract.assertions);
  if (humanJudged.length) attempt.humanJudged = humanJudged;
  // All-deterministic contract -> nothing for the panel to judge. Skip it
  // entirely, panelRequired false, so the green merged gates alone promote via
  // decide()'s gatesConfigured && gatesOk + skip + !panelRequired -> {done}
  // path. This is the zero-browser backend verify.
  if (agentJudged.length === 0) {
    return { verification: "skip", report: null, panelReport: null, panelRequired: false };
  }
  if (!target) {
    emit({ type: "panel", n: attempt.n, report: null });
    // M8 fail-closed: a live-critic loom that reached verify with an agent-judged
    // slice but NO target skips with panelRequired:true, so decide() retries then
    // lands the honest needs-review terminal. The unconditional top gate
    // is what stands a lane up when one can be formed.
    return { verification: "skip", report: null, panelReport: null, panelRequired: true };
  }
  try {
    const objective = readBundleFile(loom.id, "objective.md") ?? loom.prompt;
    // M10.4 — the SINGLE production consumer of resolveRunbook: feed the accepted
    // `.telar/runbook.md` narrative into the live-critic panel as READ-ONLY DRIVE
    // context (how to reach/seed/login/drive the app), so the learned
    // "reused-forever" narrative is actually used on reuse. Null-guarded — no
    // accepted runbook ⇒ driveContext unset ⇒ the ctx + critic prompt are
    // unchanged. This is prompt CONTEXT only: the judge's read-only tool wall
    // (VERIFIER_TOOLS/restrictTools/denylist) and the LensSpec-stamped
    // class/blocker are untouched, and it never reaches the deterministic gates
    // (those settled in executeLoom, prose-independent).
    const driveContext = resolveRunbook(manifest.root);
    const ctx: CriticContext = {
      featureName: loom.title,
      url: target,
      objective,
      assertions: agentJudged,
      ...(driveContext ? { driveContext } : {}),
    };

    // §M.4 measurable, post-build signals — never an AI-self-declared label.
    // filesTouched is the UNION of the builder's self-report and an
    // independent `git status --porcelain` read of manifest.root: a builder
    // that omits a file from its own Verdict (adversarially or by mistake)
    // can no longer shrink its own panel or hide a protected-path edit —
    // the git-derived set always carries the true touched files through.
    const selfReported = attempt.verdict?.files_touched ?? [];
    const gitTouched = gitTouchedFiles(buildCwd(loom, manifest));
    const filesTouched = Array.from(new Set([...selfReported, ...gitTouched]));
    const allowedPaths = loom.charter?.scope.allowedPaths ?? [];
    const protectedPaths = manifest.guardrails.protectedPaths;
    const filesOutsideAllowed = allowedPaths.length
      ? filesTouched.filter((f) => !pathUnderAny(f, allowedPaths)).length
      : 0;
    const protectedPathsTouched = filesTouched.some((f) => pathUnderAny(f, protectedPaths));
    const priorFailingCritics = loom.attempts.filter(
      (a) => a.n < attempt.n && a.panelReport && classifyPanel(a.panelReport) === "fail",
    ).length;

    const signals: PanelSignals = {
      diffLines: 0, // no git-diff wiring at this layer yet; filesTouched carries the size signal
      filesTouched: filesTouched.length,
      filesOutsideAllowed,
      protectedPathsTouched,
      priorFailingCritics,
    };

    const evidenceDir = path.join(loomDir(loom.id), "evidence", `panel-${attempt.n}`);
    const maxCriticAgents = loom.charter?.budget.maxCriticAgents ?? 3;

    const panelReport = await runPanel(ctx, {
      signals,
      maxCriticAgents,
      // Size in the ADVISORY aesthetic lens (blocker:false, provably non-gating).
      aesthetic: true,
      evidenceDir,
      account,
      project: manifest.name,
      abort: opts?.abort,
      run: opts?.run,
      onEvent: (e: PanelEvent) => {
        if (e.type === "critic-cost") {
          // §M "panel cost is real spend": flow it into the attempt, not just the event stream.
          attempt.costUsd = (attempt.costUsd ?? 0) + e.costUsd;
          emit({ type: "critic-cost", lens: e.lens, costUsd: e.costUsd });
        } else if (e.type === "critic-verdict") {
          emit({ type: "critic-verdict", lens: e.lens, verdict: e.verdict, durationMs: e.durationMs, turns: e.turns });
        } else if (e.type === "panel-sized") {
          // M1 (D2): re-emit the panel-process events onto the loom log so the
          // Verify tab can fold a live tool-by-tool timeline. n scopes them to
          // this attempt.
          emit({ type: "panel-sized", n: attempt.n, sized: e.sized, sizedFrom: e.sizedFrom });
        } else if (e.type === "critic-start") {
          emit({ type: "critic-start", lens: e.lens, class: e.class, blocker: e.blocker });
        } else if (e.type === "critic-step") {
          emit({ type: "critic-step", lens: e.lens, name: e.name, input: e.input });
        } else if (e.type === "critic-observation") {
          emit({ type: "critic-observation", lens: e.lens, kind: e.kind, output: e.output });
        } else if (e.type === "critic-text") {
          emit({ type: "critic-text", lens: e.lens, text: e.text });
        }
      },
    });

    attempt.panelReport = panelReport;
    emit({ type: "panel", n: attempt.n, report: panelReport });
    return { verification: classifyPanel(panelReport), report: null, panelReport, panelRequired: true };
  } catch (err) {
    emit({ type: "panel-error", message: err instanceof Error ? err.message : String(err) });
    return { verification: "skip", report: null, panelReport: null, panelRequired: true };
  }
}

// ── M9.4: the built-in per-step CHECK evaluator (read-only verify-lens) ──────
// Evaluates a Step's OPTIONAL `check` VerificationContract against that step's
// FAIT-ACCOMPLI output — the shared loom's worktree/app AFTER the step ran
// (buildCwd for the deterministic slice, the loom's live target for the agent-
// judged slice; the check never re-runs the step to produce output) — using the
// SAME Unit-4 primitives runVerification uses:
//   - deterministic assertions -> runContractGates (exit-code gates, NO browser,
//     NO writer-agent budget)
//   - agent-judged assertions   -> the READ-ONLY critic panel (runPanel/runCritic,
//     walled to VERIFIER_TOOLS: no Write/Edit/MultiEdit/Bash/NotebookEdit/Agent)
// The contract is `step.check` passed EXPLICITLY (never readContract(loom.id)) —
// exactly as runIntegrationVerify passes its freshly-built allContract — so this
// NEVER reads/writes the loom's on-disk contract.json floor. Returns a PURE tri-
// state ("pass"|"fail"|"skip") from classifyPanel / gate exit codes; it NEVER
// writes loom.state, sawTrustedWritingGreen, or the contract. It can only ADD
// scrutiny (return "fail"), never promote the loom or relax its contract.
async function runStepCheck(step: Step, ctx: WorkflowStepCtx): Promise<"pass" | "fail" | "skip"> {
  const contract = step.check!; // guarded by the seam (st.check present)
  const { deterministic, agentJudged } = partitionAssertions(contract.assertions);
  if (deterministic.length === 0 && agentJudged.length === 0) return "skip"; // nothing to judge

  const { loom, manifest, opts } = ctx;

  // (a) DETERMINISTIC slice — exit-code gates over the worktree the step wrote.
  // runContractGates spawns detached processes judged by exit code — zero writer
  // agent budget. A single red gate fails the check.
  if (deterministic.length) {
    const gates = await runContractGates(deterministic, manifest, buildCwd(loom, manifest));
    if (gates.some((g) => !g.ok)) return "fail";
  }

  // (b) AGENT-JUDGED slice — the read-only critic panel (walled inside runCritic).
  if (agentJudged.length) {
    const target = manifest.urls?.dev;
    // No live target ⇒ no evidence to judge the agent-judged slice. A green
    // deterministic slice stands (informational pass); an all-agent-judged check
    // with no evidence is an informational skip (never a spurious fail).
    if (!target) return deterministic.length ? "pass" : "skip";
    const objective = readBundleFile(loom.id, "objective.md") ?? loom.prompt;
    const critCtx: CriticContext = { featureName: loom.title, url: target, objective, assertions: agentJudged };
    // Minimal post-step signals (git-derived touched-file count seeds the panel
    // sizing floor); panelSize always seeds an intent+adversarial blocker floor,
    // so a critic-backed check can only ADD adversarial scrutiny.
    const signals: PanelSignals = {
      diffLines: 0,
      filesTouched: gitTouchedFiles(buildCwd(loom, manifest)).length,
      filesOutsideAllowed: 0,
      protectedPathsTouched: false,
      priorFailingCritics: 0,
    };
    // FIX 1 (built-in robustness): mirror runPanelVerification's try/catch around
    // the runPanel call so a critic RUNTIME error (engine/Playwright/abort throw)
    // returns a DEFINITE verdict rather than escaping. For a fail-closed CHECK the
    // definite verdict is "fail" (unlike runPanelVerification's "skip", because a
    // check "skip" would PROCEED — a check that cannot be evaluated is NOT a pass).
    // The seam-level try/catch (below) stays the ultimate fail-closed backstop;
    // this keeps the built-in robust on its own.
    let report: PanelReport;
    try {
      report = await runPanel(critCtx, {
        signals,
        maxCriticAgents: loom.charter?.budget.maxCriticAgents ?? 3,
        evidenceDir: path.join(loomDir(loom.id), "evidence", `step-check-${step.id}`),
        account: opts.accounts?.[manifest.account],
        project: manifest.name,
        abort: opts.abort,
        run: opts.run,
      });
    } catch (err) {
      opts.onEvent?.({ type: "panel-error", message: err instanceof Error ? err.message : String(err) });
      return "fail"; // critic runtime error ⇒ definite fail-closed verdict
    }
    const v = classifyPanel(report); // PURE (panel.ts) — "pass"|"fail"|"skip"
    if (v === "fail") return "fail";
    if (v === "skip" && deterministic.length === 0) return "skip";
  }
  return "pass";
}

// Stringify a verifier engine tool `input` (already engine-capped) for a
// verifier-step event. Strings pass through; anything else JSON best-effort.
function capVerifierInput(input: unknown): string | undefined {
  if (input == null) return undefined;
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

// M1 (D2): emit the terminal `verify-summary` once a verification settles —
// the single event the Verify tab reads for the headline verdict. `source` is
// derived from which report is present (panel → verifier → gates), `reason`
// from panelReason when a panel ran, and blockerFindings is the count of
// blocker-severity critic findings. Purely additive; never gates anything.
function emitVerifySummary(
  emit: (ev: { type: string } & Record<string, unknown>) => void,
  n: number,
  res: {
    verification: Verification;
    report: VerifierReport | null;
    panelReport?: PanelReport | null;
    panelRequired: boolean;
  },
): void {
  const source: "panel" | "verifier" | "gates" = res.panelReport ? "panel" : res.report ? "verifier" : "gates";
  const blockerFindings = res.panelReport
    ? res.panelReport.critics.flatMap((c) => c.findings.filter((f) => f.severity === "blocker")).length
    : 0;
  emit({
    type: "verify-summary",
    n,
    verification: res.verification,
    source,
    panelRequired: res.panelRequired,
    blockerFindings,
    ...(res.panelReport ? { reason: panelReason(res.panelReport) } : {}),
  });
}

// Drive the Verifier over the running app: attaches the report to the attempt,
// relativizes evidence paths, emits {type:"verifier"}, and classifies the loom.
// Best-effort — a verify failure must never break the loom (classifies "skip").
//
// §4 (docs/loom-model.md): a loom anchored to a Spec Bundle (a validated
// Verification Contract present via readContract) is judged by the Critic
// Panel instead — GROUNDING replaces the single Verifier as the source of
// `verification`. A loom with NO bundle/contract (today's acceptanceCriteria
// looms) falls through unchanged to the legacy path below: full back-compat.
export async function runVerification(
  loom: Loom,
  manifest: ProjectManifest,
  attempt: AttemptRecord,
  emit: (ev: { type: string } & Record<string, unknown>) => void,
  account?: AccountProfile,
  url?: string,
  opts?: {
    abort?: AbortController;
    run?: typeof agent;
  },
): Promise<{
  verification: Verification;
  report: VerifierReport | null;
  panelReport?: PanelReport | null;
  panelRequired: boolean;
}> {
  const target = url ?? manifest.urls?.dev;
  const { contract } = readContract(loom.id);
  if (contract) {
    // M1 (D0.4) → M8 fail-closed: isSynth still gates the dev-server spin-up
    // below (a synth no-target loom does not start its own server), but a
    // no-evidence skip is no longer promotable for either kind — runVerification
    // returns panelRequired:true, so decide() retries then lands needs-review.
    const isSynth = contract.synthesized === true;
    // Unit 4: an all-deterministic contract has no agent-judged slice, so the
    // panel is skipped and no live target is needed — never spin up a dev
    // server for a zero-browser backend verify.
    // Route out subjective-marked assertions before the count so an all-subjective
    // contract yields agentJudged:[] ⇒ panelRequired false (no live target needed;
    // the objective slice alone gates).
    const panelRequired = routeAssertions(contract.assertions).agentJudged.length > 0;
    // docs/loom-model.md D13 (run initializer, minimal): a bundle loom with
    // no usable target (no `url` override, no urls.dev) but a configured
    // `devCommand` gets its OWN dev server on a free port instead of the
    // panel silently skipping — torn down again right after this attempt's
    // panel run, win or lose. A project with a static url is unchanged: this
    // path never runs when `target` is already set.
    // M1 (D0.4): a SYNTHESIZED loom with no target behaves like legacy (a
    // promotable skip, no dev server) — `&& !isSynth` keeps the spin-up
    // behavior exclusive to authored contracts.
    if (panelRequired && !target && manifest.devCommand && !isSynth) {
      let server: Awaited<ReturnType<typeof startProjectServer>> | undefined;
      try {
        server = await startProjectServer(manifest.root, manifest.devCommand, { abort: opts?.abort });
        const res = await runPanelVerification(loom, manifest, attempt, emit, contract, account, server.url, opts, isSynth);
        emitVerifySummary(emit, attempt.n, res);
        return res;
      } catch (err) {
        emit({ type: "panel-error", message: err instanceof Error ? err.message : String(err) });
        const res = { verification: "skip" as Verification, report: null, panelReport: null, panelRequired: true };
        emitVerifySummary(emit, attempt.n, res);
        return res;
      } finally {
        await server?.stop();
      }
    }
    const res = await runPanelVerification(loom, manifest, attempt, emit, contract, account, target, opts, isSynth);
    emitVerifySummary(emit, attempt.n, res);
    return res;
  }

  // §M.1/§M.2: a loom that required a Verification Contract to START
  // (loom.contractRequired, stamped by startLoomFromBundle's CONTRACT GATE)
  // can never silently fall through to the legacy no-panel path just because
  // contract.json later went missing, corrupt, or failed validateContract —
  // that would let gates + a self-reported Verdict promote a bundle loom
  // with zero panel evidence for this attempt. Treat it as a hard
  // verification FAILURE instead (retries, then needs-review via decide()),
  // exactly like a panel "fail" would.
  if (loom.contractRequired) {
    emit({ type: "panel-error", message: "verification contract required but missing or invalid" });
    return { verification: "fail", report: null, panelReport: null, panelRequired: true };
  }

  if (!loom.acceptanceCriteria?.length || !target) return { verification: "skip", report: null, panelRequired: false };
  try {
    const evidenceDir = path.join(loomDir(loom.id), "evidence");
    let designGuidelines: string | undefined;
    if (manifest.designRules) {
      try {
        designGuidelines = fs.readFileSync(path.join(manifest.root, manifest.designRules), "utf8");
      } catch {
        // best-effort: missing/unreadable design-rules file never breaks the loom
      }
    }
    const report = await verify(
      { name: loom.title, acceptanceCriteria: loom.acceptanceCriteria },
      {
        url: target,
        evidenceDir,
        account,
        headless: true,
        designGuidelines,
        project: manifest.name,
        // M1 (D2): bridge the verifier agent's live engine events into
        // verifier-step/-observation/-text loom events (inspection only).
        onEvent: (e) => {
          if (e.type === "tool") {
            emit({ type: "verifier-step", n: attempt.n, phase: "verifier", name: e.name, input: capVerifierInput(e.input) });
          } else if (e.type === "tool-result") {
            emit({ type: "verifier-observation", n: attempt.n, phase: "verifier", kind: e.name ?? "result", output: e.output });
          } else if (e.type === "text") {
            emit({ type: "verifier-text", n: attempt.n, text: e.text });
          }
        },
      },
    );
    if (!report) {
      emit({ type: "verifier", n: attempt.n, report: null });
      const res = { verification: "skip" as Verification, report: null, panelRequired: true };
      emitVerifySummary(emit, attempt.n, res);
      return res;
    }
    // Rewrite absolute evidence paths under evidenceDir to relative so the UI
    // can serve them via /api/looms/<id>/evidence/<relpath>.
    const relativize = (p?: string) => {
      if (!p || !path.isAbsolute(p)) return p;
      const rel = path.relative(evidenceDir, p);
      return rel.startsWith("..") || path.isAbsolute(rel) ? p : rel;
    };
    for (const c of report.criteria) for (const e of c.evidence) e.path = relativize(e.path);
    for (const e of report.sessionEvidence) e.path = relativize(e.path);
    attempt.verifierReport = report;
    // Persisted by the caller's onState when the next setState fires (this
    // module stays pure w.r.t. persistence — see the file header).
    emit({ type: "verifier", n: attempt.n, report });
    const res = { verification: classify(report), report, panelRequired: false };
    emitVerifySummary(emit, attempt.n, res);
    return res;
  } catch (err) {
    emit({ type: "verifier-error", message: err instanceof Error ? err.message : String(err) });
    return { verification: "skip", report: null, panelRequired: true };
  }
}

// Unit 6 (docs §8 MVP): the end-of-orchestration ALL-scope integration verify
// PRODUCER's default runner, wired by the dispatcher onto a woven root's
// runWeave deps. It reads the root's full Verification Contract, isolates the
// cross-cutting ALL/unlabelled slice (the properties of the assembled whole no
// single child owns — the exact convention wireChildBundle uses), and runs it
// through the SAME Unit-4 primitives executeLoom's build loop uses:
//   - deterministic assertions -> runContractGates (exit-code gates, NO browser)
//   - agent-judged assertions   -> runPanelVerification (only if a slice exists
//                                  AND a live target does)
// The ALL contract is passed to runPanelVerification EXPLICITLY, so this never
// overwrites the root's on-disk contract.json. It is a real ALL contract only
// when the slice is non-empty AND passes validateContract's falsifiable-hard-
// gate floor (same floor wireChildBundle applies); otherwise returns null and
// the producer is a no-op (back-compat: a woven root with no ALL contract folds
// up exactly as today). INFORMATIONAL: this only PRODUCES + RECORDS a verdict
// (pushes an integration AttemptRecord onto the loom); it never touches
// loom.state — weave.ts records latestVerdict alongside the authoritative
// rollup state, and Unit 7 will read it back to gate finish-loom.
//
// Combine: a red deterministic gate ⇒ "fail"; else the panel's verdict if a
// panel ran; else (all-deterministic ALL slice, gates green) ⇒ "pass" — a real
// zero-browser backend integration verdict. `gateRunner`/`run` are injectable
// so the whole runner is hermetic in tests (no real process, no agent, no
// browser). NOTE (design §3): this deliberately uses the direct
// runContractGates + runPanelVerification pair rather than runVerification —
// runVerification reads the WHOLE on-disk contract and, for an all-deterministic
// contract, returns "skip" WITHOUT running gates, so it is the wrong entry for a
// sub-slice.
export async function runIntegrationVerify(
  loom: Loom,
  manifest: ProjectManifest,
  opts: {
    policy?: ModelPolicy;
    accounts?: Record<string, AccountProfile>;
    url?: string;
    abort?: AbortController;
    emit?: (ev: { type: string } & Record<string, unknown>) => void;
    gateRunner?: (gate: Gate, cwd: string) => Promise<GateResult>;
    run?: typeof agent;
    // M4 (additive; default = today's behavior). verifyCwd re-points the
    // deterministic gate cwd at a FROZEN worktree snapshot instead of
    // manifest.root; subGoalId re-scopes the slice from ALL to one subgoal (a
    // checkpoint). Absent ⇒ byte-identical to the pre-M4 ALL-against-root verify.
    verifyCwd?: string;
    subGoalId?: string;
    // M10.1 (additive; default = today's ALL slice). Verify the FULL contract
    // over the composed whole — every assertion, unfiltered — so the top gate
    // answers both regression (per-child criteria) and completeness. Mutually
    // exclusive with subGoalId (whole-verify vs checkpoint); fullContract wins.
    fullContract?: boolean;
    // M11.2 (additive; absent ⇒ byte-identical). The EXPLICIT no-target marker:
    // the caller (frozenLaneVerify, only under its failClosedLaneDown
    // injection) determined there is NO honest live target — a downed lane or a
    // non-server strategy — and the panel must hit the no-target fail-closed
    // floor (runPanelVerification :576-590 → panelRequired skip → the M10.1
    // fullContract coercion demotes). Without this marker, merely OMITTING
    // opts.url silently reinstates the manifest.urls.dev fallback below and the
    // panel would be judged against a stale URL — a false green through the
    // method layer. The marker can only WITHHOLD a target (tighten); it can
    // never conjure one.
    noTarget?: boolean;
    // M11.2 (additive; absent ⇒ byte-identical) — ARTIFACT-TIME GATE
    // ESTABLISHMENT (adaptive-verification.md §2 point 2, §3.3, §7 M11.2): the
    // runnable the frozen-worktree strategy re-derivation answered (a test-gate
    // `bun|pnpm|yarn|npm run test`, or the human-answered manifest
    // verifyCommand). Consumed ONLY under the sanction gate below — a
    // SYNTHESIZED all-live-critic contract whose criteria somebody actually
    // declared provable-by-gate — where each live-critic assertion is
    // tightened IN MEMORY (never persisted) to {type:"command", expected:run}
    // so runContractGates produces real exit-code evidence instead of the
    // guaranteed no-target demote. live-critic → command is the ONE permitted
    // tightening direction (doc §4); an unsanctioned or non-synthesized
    // contract ignores this entirely and keeps today's fail-closed path.
    establishRun?: string;
  } = {},
): Promise<{
  verification: Verification;
  gatesOk: boolean;
  panelReport?: PanelReport | null;
  gates?: GateResult[];
  // M4 — the STABLE assertion-id sets the auto-repair guards consume. Absent
  // consumers ignore them; always populated, so the guards need no re-parse.
  failingIds?: string[];
  passingIds?: string[];
  // M10.1 fail-closed — the reason a whole-verify verdict demoted. Set ONLY on
  // the fullContract required-panel-no-evidence coercion below; undefined on
  // every legacy path (flag-off byte-identical). Purely informational: the
  // weave gate demotes on `verification` "fail"/"flaky", not on this field.
  error?: string;
} | null> {
  const { contract } = readContract(loom.id);
  if (!contract) return null; // no bundle contract on the root

  // The verify slice. Default (M4 off / no subGoalId) = the cross-cutting
  // integration slice: assertions the assembled whole owns, no single SubGoal
  // (subGoalId === "ALL" OR unlabelled). A checkpoint (opts.subGoalId set)
  // re-scopes to exactly that subgoal's assertions.
  const allSlice = opts.fullContract
    ? contract.assertions // M10.1: the FULL contract, unfiltered (regression + completeness)
    : opts.subGoalId
      ? contract.assertions.filter((a) => a.subGoalId === opts.subGoalId)
      : contract.assertions.filter((a) => a.subGoalId === "ALL" || !a.subGoalId?.trim());
  // M1 (D3.1): PRESERVE the synthesized flag when rebuilding the ALL contract.
  // A synthesized root's ALL slice is all-live-critic; dropping the flag would
  // re-impose the hard-gate floor and validateContract would reject it → the
  // producer would no-op and full re-verify would never fire. With the flag
  // carried through, an all-live-critic synthesized ALL slice validates and the
  // producer fires for EVERY woven root that folds to `ready`.
  const allContract: VerificationContract = {
    version: contract.version,
    assertions: allSlice,
    synthesized: contract.synthesized,
  };
  // A real ALL contract only if it has a falsifiable hard gate (same floor
  // wireChildBundle uses) — OR it is synthesized (floor skipped). No ALL
  // contract ⇒ no-op producer.
  if (allSlice.length === 0 || validateContract(allContract).length !== 0) return null;
  const isSynth = allContract.synthesized === true;

  const emit = opts.emit ?? (() => {});
  const policy = opts.policy ?? ModelPolicy.parse({});
  const account = opts.accounts?.[manifest.account];
  // M11.2 — opts.noTarget WITHHOLDS the manifest.urls.dev fallback: the caller
  // proved no honest live target exists, so the agent-judged slice must land
  // the no-target floor (skip → coercion → demote), never be judged against a
  // stale URL. Absent (every pre-M11.2 caller) ⇒ today's line verbatim.
  const target = opts.noTarget ? undefined : opts.url ?? manifest.urls?.dev;

  // M11.2 — ARTIFACT-TIME GATE ESTABLISHMENT (see the opts.establishRun doc
  // above). The deferred-gate hand-off the frozen deliverable-signal API
  // promised ("establish as test-gate when the artifact exists"): the wt
  // re-derivation answered a concrete runnable, and THIS is where it becomes a
  // gate. Sanction (all three prongs deliberately narrow, and checked HERE
  // where the contract is in hand):
  //   - the contract is SYNTHESIZED (an authored contract is never rewritten),
  //   - the slice is ALL live-critic with no subjective markers (a mixed or
  //     subjective-marked slice keeps its exact current routing), and
  //   - somebody DECLARED the gate proves it: the human answered a
  //     verifyCommand (answerBlocked, telar.yaml), OR the criteria are the
  //     prompt fallback (zero authored acceptanceCriteria — the greenfield
  //     loom_mrigs3zo_vxgrsr shape where synth-0 IS "the deliverable works"),
  //     OR the charter carries gate-shaped proof intent — the SAME sanction
  //     weave-contracts' blanket tightening uses, re-checked at verify time.
  // Unsanctioned (authored prose criteria: credentials, taste), the slice is
  // untouched and the no-target floor demotes honestly — a pre-existing green
  // suite can never rubber-stamp criteria it says nothing about (doc §4).
  // The tightening is IN MEMORY only: contract.json is never rewritten, so
  // every verify pass re-derives (and a repaired repo re-answers) freshly.
  let verifySlice = allSlice;
  const establishRun = opts.establishRun?.trim();
  if (establishRun && isSynth) {
    const sanctioned =
      !!manifest.verifyCommand?.trim() ||
      !(loom.acceptanceCriteria ?? []).some((c) => c.trim()) ||
      charterHasGateIntent(loom.charter);
    const allLiveCritic = allSlice.every((a) => a.type === "live-critic" && a.subjective !== true);
    if (sanctioned && allLiveCritic) {
      verifySlice = allSlice.map((a) => ({
        id: a.id,
        subGoalId: a.subGoalId,
        description: a.description,
        type: "command" as const,
        expected: establishRun,
        blocker: a.blocker,
      }));
      emit({ type: "verify-establish", run: establishRun, assertions: verifySlice.length });
    }
  }

  // Evidence trail on the ROOT loom — additive, never touches child verdicts.
  const attempt: AttemptRecord = {
    n: (loom.attempts?.length ?? 0) + 1,
    role: "integration",
    model: policy.dev,
    startedAt: Date.now(),
  };
  loom.attempts.push(attempt);

  // Over the COMPOSED WHOLE, pull the subjective-marked assertions into humanJudged
  // (carried to accept, never a machine gate) and route ONLY the remainder to
  // gates/panel. If the ONLY judged criteria were subjective, agentJudged is empty
  // ⇒ the panel is skipped and the objective slice alone gates the machine verdict,
  // letting the objective whole reach `ready`.
  // M11.2 — routes the ESTABLISHED slice (verifySlice === allSlice except under
  // the sanctioned establishment above, where the live-critic assertions became
  // command gates and this routing lands them all in `deterministic`).
  const { deterministic, agentJudged, humanJudged } = routeAssertions(verifySlice);
  if (humanJudged.length) attempt.humanJudged = humanJudged;

  // Deterministic ALL slice -> exit-code gates (Unit 4, no browser). For a pure
  // backend ALL contract, agentJudged is empty so the panel never runs.
  const gates = await runContractGates(
    deterministic,
    manifest,
    opts.verifyCwd ?? manifest.root, // M4: frozen worktree snapshot when set
    (r, a) => emit({ type: "gate", result: r, assertionId: a.id, assertionType: a.type }),
    opts.gateRunner,
  );
  attempt.gates = gates;
  const gatesOk = gates.every((r) => r.ok);

  // M4 — STABLE assertion-id sets for the auto-repair guards. Deterministic ids
  // come straight off the gates (GateResult.name === assertion id). The panel is
  // lens-based (no per-assertion verdicts), so the agent-judged slice is
  // attributed as a SET by the panel's aggregate verdict, only in the branch
  // where the panel actually ran.
  const failingIds: string[] = [];
  const passingIds: string[] = [];
  for (const g of gates) (g.ok ? passingIds : failingIds).push(g.name);
  const agentIds = agentJudged.map((a) => a.id);

  let verification: Verification;
  let panelReport: PanelReport | null = null;
  // M10.1 — the demote reason when a REQUIRED panel obtained no evidence over
  // the composed whole. Set only in the fullContract coercion below; undefined
  // everywhere else (flag-off byte-identical).
  let ivError: string | undefined;
  if (!gatesOk) {
    // A red deterministic gate settles the ALL verdict "fail" — no need to run
    // the panel to prose-judge an already-falsified whole.
    verification = "fail";
  } else if (agentJudged.length > 0) {
    // Pass the ALL contract EXPLICITLY (runPanelVerification re-partitions it and
    // only shows the panel the agent-judged slice) — never overwrites contract.json.
    const pv = await runPanelVerification(
      loom,
      manifest,
      attempt,
      emit,
      allContract,
      account,
      target,
      { abort: opts.abort, run: opts.run },
      isSynth,
    );
    verification = pv.verification;
    panelReport = pv.panelReport ?? null;
    // M10.1 top-gate fail-closed (sacred invariant 3: "no evidence ⇒ no
    // promotion — at the top"). Over the COMPOSED WHOLE, a REQUIRED panel
    // (agent-judged slice non-empty ⇒ pv.panelRequired) that obtained NO
    // independent evidence — verification "skip" because the panel could not run
    // (no reachable target / it threw / a vacuous critic set) — must NOT keep the
    // loom `ready`. This mirrors the thread-level decide() rule one altitude up
    // (executor.ts ~264-268/290-298: a panelRequired skip becomes needs-review
    // "panel verification required but did not run"): map the evidence-free
    // required skip to a DEMOTING "fail" the unchanged weave gate already acts on
    // (weave.ts ~414-421 demotes ready → needs-review on "fail"/"flaky").
    //
    // Reachable ONLY when opts.fullContract is true — set EXCLUSIVELY by the
    // top-gate producer (dispatcher.ts). Without fullContract (checkpoint slices)
    // this branch is inert, so a panelRequired skip on the checkpoint slice keeps
    // its keep-ready behavior. A panelRequired-FALSE contract (empty
    // agent-judged slice) never enters this branch at all (it falls to the
    // all-deterministic `pass` below), so a legitimate keep-ready skip is never
    // demoted — the distinguishing condition is exactly `panelRequired && skip`,
    // the same predicate decide() uses.
    if (opts.fullContract && pv.panelRequired && verification === "skip") {
      verification = "fail";
      ivError = "panel verification required but did not run (composed whole)";
    }
    // Attribute the agent-judged slice by the panel's aggregate verdict (set-
    // level; the panel yields no per-assertion ids). "skip" leaves them
    // unattributed — genuinely unknown, not passing.
    if (verification === "pass") passingIds.push(...agentIds);
    else if (verification === "fail" || verification === "flaky") failingIds.push(...agentIds);
  } else {
    // All-deterministic ALL slice, gates green -> a real zero-browser pass.
    verification = "pass";
  }

  attempt.endedAt = Date.now();
  emit({ type: "integration-verify", verification, gatesOk });
  // M1 (D2): terminal summary for the integration verify (source derived like
  // runVerification's — a panel ran ⇒ "panel", else the gate result ⇒ "gates").
  emitVerifySummary(emit, attempt.n, {
    verification,
    report: null,
    panelReport,
    panelRequired: !isSynth,
  });
  return {
    verification,
    gatesOk,
    panelReport,
    gates,
    failingIds: Array.from(new Set(failingIds)),
    passingIds: Array.from(new Set(passingIds)),
    // Flag-off byte-identical: ivError is undefined ⇒ the field is absent from
    // the returned object exactly as before.
    ...(ivError ? { error: ivError } : {}),
  };
}

// M4 — a repair brief for the integration/auto-repair leg, built from an
// integration-verify result (the ALL panel's aggregate reason + any failing
// deterministic gate output). Mirrors buildVerifierRepair's shape for the
// builder path. Pure.
export function buildIntegrationRepairBrief(iv: {
  panelReport?: PanelReport | null;
  gates?: GateResult[];
}): string {
  const parts: string[] = [];
  if (iv.panelReport) parts.push(panelReason(iv.panelReport));
  for (const g of iv.gates ?? []) {
    if (!g.ok) parts.push(`## gate ${g.name} (exit ${g.exitCode ?? (g.timedOut ? "timeout" : "?")})\n${tail(g.output, 1500)}`);
  }
  return parts.filter(Boolean).join("\n\n");
}

// M4 — the LLM repair leg of the auto-repair loop. Dispatches ONE careful
// repair agent against the woven root's working tree with the failing-criteria
// brief, honoring guardrails/disallowedTools exactly like the builder, and
// reports its spend so the guard's budget accounting stays honest. The agent
// writes only in the shared root (or the loom's own worktree if it carries
// one) — the frozen verify always forks a FRESH pinned snapshot the repair can
// never touch, so verification stays read-only against an immutable base.
// LIVE-VALIDATION DEFERRED (M4 §8 item 3): only reached in a supervised
// run; unit tests drive runAutoRepair with a
// fake repair spy and never construct this.
export async function runRepairThread(
  loom: Loom,
  manifest: ProjectManifest,
  brief: string,
  opts: {
    policy?: ModelPolicy;
    accounts?: Record<string, AccountProfile>;
    abort?: AbortController;
    emit?: (ev: { type: string } & Record<string, unknown>) => void;
    run?: typeof agent;
  } = {},
): Promise<{ costUsd: number }> {
  const policy = opts.policy ?? ModelPolicy.parse({});
  const emit = opts.emit ?? (() => {});
  const tools = BASE_TOOLS.filter((t) => !manifest.guardrails.disallowedTools.includes(t));
  const attempt: AttemptRecord = {
    n: (loom.attempts?.length ?? 0) + 1,
    role: "repair",
    model: policy.careful,
    startedAt: Date.now(),
  };
  loom.attempts.push(attempt);
  emit({ type: "repair-attempt", n: attempt.n, model: policy.careful });

  const protectedPaths = manifest.guardrails.protectedPaths;
  const prompt = [
    `# Repair: ${loom.title}`,
    "The assembled whole failed its integration verification. Fix the underlying behavior so the failing acceptance criteria pass. Do not weaken or delete the checks.",
    brief,
    protectedPaths.length ? `Guardrails: the following paths are absolutely forbidden to modify: ${protectedPaths.join(", ")}.` : "",
    "Make focused changes, verify your own work, and call emit_result with your Verdict.",
  ]
    .filter(Boolean)
    .join("\n\n");

  await refreshProjectMcpAuth(manifest.name);
  const verdict = await (opts.run ?? agent)(prompt, {
    schema: Verdict,
    cwd: buildCwd(loom, manifest),
    model: policy.careful,
    maxTurns: policy.maxTurns ?? MAX_TURNS[loom.kind],
    tools,
    disallowedTools: manifest.guardrails.disallowedTools,
    settingSources: ["project", "local"],
    account: opts.accounts?.[manifest.account],
    extraMcpServers: resolveProjectMcpServers(manifest.name),
    abort: opts.abort,
    onEvent: (e) => {
      if (e.type === "session") {
        attempt.sessionId = e.sessionId;
        emit({ type: "session", sessionId: e.sessionId });
      } else if (e.type === "text") {
        emit({ type: "text", text: e.text });
      } else if (e.type === "tool") {
        emit({ type: "tool", name: e.name, input: e.input });
      } else if (e.type === "tool-result") {
        emit({ type: "tool-result", name: e.name, ok: e.ok, output: e.output });
      } else if (e.type === "result") {
        attempt.costUsd = e.costUsd;
        emit({ type: "agent-result", subtype: e.subtype, costUsd: e.costUsd, turns: e.turns });
      }
    },
  });
  attempt.verdict = verdict;
  attempt.endedAt = Date.now();
  return { costUsd: attempt.costUsd ?? 0 };
}

// Pure outcome function for a verify loom: no builder loop, so the mapping
// from Verification to a terminal WorkUnitState is direct — no retries. A
// "pass" routes through terminalStateForCompletedLoom (§A) same as the
// builder path: a ROOT verify loom (no parentLoomId — true for every verify
// loom today, since nothing spawns one as a child) lands "ready", awaiting
// owner acceptance via acceptLoom(), never straight to "done".
export function decideVerifyLoom(
  v: Verification,
  loom: Pick<Loom, "parentLoomId">,
): { state: WorkUnitState; error?: string } {
  switch (v) {
    case "pass":
      return { state: terminalStateForCompletedLoom(loom) };
    case "fail":
      return { state: "needs-review", error: "verification failed" };
    case "flaky":
      return { state: "needs-review", error: "verification flaky" };
    case "skip":
      return { state: "needs-review", error: "nothing verified" };
  }
}

// Read-only loom: drives verify() against loom.target with no builder attempt.
// runVerification already returns "skip" when the target URL or acceptance
// criteria are missing, so a misconfigured verify loom lands needs-review
// cleanly rather than crashing.
async function executeVerifyLoom(loom: Loom, manifest: ProjectManifest, opts: ExecuteOpts = {}): Promise<Loom> {
  const emit = (ev: { type: string } & Record<string, unknown>) => opts.onEvent?.(ev);
  const setState = (s: WorkUnitState) => {
    loom.state = s;
    emit({ type: "state", state: s });
    opts.onState?.(loom);
  };
  const isAborted = () => opts.abort?.signal.aborted === true;
  const halt = () => {
    setState("halted");
    return loom;
  };

  // M3: symmetric worktree cleanup. A verify-kind child would get its own
  // worktree too (verify-only children never FOLD — they produce no build
  // output), but in practice every verify loom is a root (no parentLoomId), so
  // this guard is inert. Kept for the same leak-safe try/finally shape.
  let ownWorktree: string | null = null;
  if (loom.parentLoomId) {
    const baseSha = getLoom(loom.parentLoomId)?.baseSha;
    if (baseSha) {
      ownWorktree = await withWorktreeLock(() => addWorktree(defaultGitRunner, manifest.root, baseSha, loom.id));
      loom.worktree = ownWorktree;
      opts.onState?.(loom);
    }
  }

  try {
    if (isAborted()) return halt();

    const targetKey = loom.target ?? "dev";
    const url = manifest.urls?.[targetKey];
    const policy = opts.policy ?? ModelPolicy.parse({});

    const attempt: AttemptRecord = { n: 1, role: "verifier", model: policy.dev, startedAt: Date.now() };
    loom.attempts.push(attempt);
    opts.onState?.(loom);

    setState("verifying");
    const vr = await runVerification(
      loom,
      manifest,
      attempt,
      emit,
      opts.accounts?.[manifest.account],
      url,
      { abort: opts.abort },
    );
    const { verification, report } = vr;
    attempt.endedAt = Date.now();
    opts.onState?.(loom);

    if (isAborted()) return halt();

    const d = decideVerifyLoom(verification, loom);
    if (d.error) loom.error = report?.summary ? `${d.error}: ${report.summary}` : d.error;
    setState(d.state);
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
  } finally {
    if (ownWorktree) {
      const wt = ownWorktree;
      try {
        await withWorktreeLock(() => removeWorktree(defaultGitRunner, manifest.root, wt));
        loom.worktree = undefined;
        opts.onState?.(loom);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

export async function executeLoom(
  loom: Loom,
  manifest: ProjectManifest,
  opts: ExecuteOpts = {},
): Promise<Loom> {
  if (loom.kind === "verify") return executeVerifyLoom(loom, manifest, opts);
  // A thread is its own inner workflow (§26): runThreadWorkflow is the sole build
  // body. opts.viaWorkflow is the recursion guard — a step delegating back into
  // executeLoom runs the legacy single-builder path below, never re-enters here.
  if (!opts.viaWorkflow) return runThreadWorkflow(loom, manifest, opts);
  const policy = opts.policy ?? ModelPolicy.parse({});
  // Clamp: <= 0 would skip the loop and resolve a still-"queued" loom.
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const maxTurns = policy.maxTurns ?? MAX_TURNS[loom.kind];
  const tools = BASE_TOOLS.filter((t) => !manifest.guardrails.disallowedTools.includes(t));

  const emit = (ev: { type: string } & Record<string, unknown>) => opts.onEvent?.(ev);
  const setState = (s: WorkUnitState) => {
    loom.state = s;
    emit({ type: "state", state: s });
    opts.onState?.(loom);
  };
  const isAborted = () => opts.abort?.signal.aborted === true;
  const halt = () => {
    setState("halted");
    return loom;
  };

  // The single-builder step, extracted verbatim from the pre-M7.3b inline
  // agent() call — a pure extraction, not a behavior change. Every existing
  // side effect (attempt.sessionId capture, attempt.costUsd, the emit()/
  // onState calls, resume) is preserved exactly.
  const runBuildStep = async (
    prompt: string,
    ctx: { model: string; resume?: string; attempt: AttemptRecord },
  ): Promise<Verdict | null> => {
    // Refresh any near-expiry Telar-owned MCP OAuth tokens before resolving the
    // servers so the injected Bearer is live (docs/mcp-oauth-design.md §5).
    await refreshProjectMcpAuth(manifest.name);
    return (opts.run ?? agent)(prompt, {
      schema: Verdict,
      cwd: buildCwd(loom, manifest),
      model: ctx.model,
      maxTurns,
      tools,
      disallowedTools: manifest.guardrails.disallowedTools,
      settingSources: ["project", "local"],
      account: opts.accounts?.[manifest.account],
      // Per-project MCP servers (docs/runtime-architecture.md §B) — each with
      // its OWN token-injected env/headers, decoupled from the build account.
      extraMcpServers: resolveProjectMcpServers(manifest.name),
      abort: opts.abort,
      ...(ctx.resume ? { resume: ctx.resume } : {}),
      onEvent: (e) => {
        if (e.type === "session") {
          ctx.attempt.sessionId = e.sessionId;
          emit({ type: "session", sessionId: e.sessionId });
          opts.onState?.(loom);
        } else if (e.type === "text") {
          emit({ type: "text", text: e.text });
        } else if (e.type === "tool") {
          emit({ type: "tool", name: e.name, input: e.input });
        } else if (e.type === "tool-result") {
          emit({ type: "tool-result", name: e.name, ok: e.ok, output: e.output });
        } else if (e.type === "result") {
          ctx.attempt.costUsd = e.costUsd;
          emit({ type: "agent-result", subtype: e.subtype, costUsd: e.costUsd, turns: e.turns });
          opts.onState?.(loom);
        }
      },
    });
  };

  // Scope a build-fanout piece's prompt to its allowedPaths (mirrors
  // firstPrompt's guardrails framing) and run it as its own agent() call
  // inside the piece's isolated worktree cwd. Bound to the current attempt's
  // ctx (model + AttemptRecord) so every piece — including the final,
  // policy.careful attempt — gets the same model escalation and live
  // session/cost/text/tool reporting as the single-builder path
  // (runBuildStep) rather than silently falling back to engine.ts's default
  // model and vanishing from opts.onEvent / attempt.costUsd.
  const makePieceBuilder =
    (ctx: { model: string; attempt: AttemptRecord }) =>
    async (piece: BuildPiece, cwd: string): Promise<Verdict | null> => {
      // Refresh near-expiry MCP OAuth tokens before resolving the servers, same
      // as runBuildStep (docs/mcp-oauth-design.md §5).
      await refreshProjectMcpAuth(manifest.name);
      // M6 roster: when the piece names a loaded preset, its narrow surface
      // (model/tools/disallowedTools/promptPrelude) overrides the piece
      // defaults. Unnamed piece or empty/unknown roster ⇒ preset is undefined
      // ⇒ every value below is byte-identical to the pre-M6 single-builder path.
      // The preset can only touch these four fields — it can never set
      // restrictTools/settingSources/extraMcpServers (omitted from the Roster
      // schema) and is never consulted for the Verifier/Critic.
      const preset = piece.agent ? opts.roster?.[piece.agent] : undefined;
      return (opts.run ?? agent)(
        [
          preset?.promptPrelude ?? "",
          `# ${piece.title}`,
          piece.prompt,
          piece.allowedPaths.length
            ? `You may ONLY modify files under: ${piece.allowedPaths.join(", ")}. Do not touch anything else.`
            : "",
          "When done, call emit_result with your Verdict (ok, summary, files_touched, blocker). Keep summary to a brief 1-3 sentence overview of what changed and why — not an essay or a per-file list.",
        ]
          .filter(Boolean)
          .join("\n\n"),
        {
          schema: Verdict,
          cwd,
          model: preset?.model ?? ctx.model,
          maxTurns,
          tools: preset?.tools ?? tools,
          disallowedTools: preset?.disallowedTools ?? manifest.guardrails.disallowedTools,
          settingSources: ["project", "local"],
          account: opts.accounts?.[manifest.account],
          extraMcpServers: resolveProjectMcpServers(manifest.name),
          abort: opts.abort,
          onEvent: (e) => {
            if (e.type === "session") {
              ctx.attempt.sessionId = e.sessionId;
              emit({ type: "session", pieceId: piece.id, sessionId: e.sessionId });
              opts.onState?.(loom);
            } else if (e.type === "text") {
              emit({ type: "text", pieceId: piece.id, text: e.text });
            } else if (e.type === "tool") {
              emit({ type: "tool", pieceId: piece.id, name: e.name, input: e.input });
            } else if (e.type === "tool-result") {
              emit({ type: "tool-result", pieceId: piece.id, name: e.name, ok: e.ok, output: e.output });
            } else if (e.type === "result") {
              // Concurrent pieces each report their own cost — sum into the
              // one shared AttemptRecord.costUsd rather than the last writer
              // clobbering the others' spend.
              ctx.attempt.costUsd = (ctx.attempt.costUsd ?? 0) + (e.costUsd ?? 0);
              emit({ type: "agent-result", pieceId: piece.id, subtype: e.subtype, costUsd: e.costUsd, turns: e.turns });
              opts.onState?.(loom);
            }
          },
        },
      );
    };

  // Runs the build step for one attempt: the fanned-out multi-builder path
  // when opts.buildFanout supplies >=2 disjoint pieces, else the single
  // builder (byte-identical to pre-M7.3b). Either way this only returns a
  // Verdict — gates + the Verifier below run on the merged tree unchanged.
  const runAttemptBuild = async (
    prompt: string,
    ctx: { model: string; resume?: string; attempt: AttemptRecord },
  ): Promise<Verdict | null> => {
    const fanout = opts.buildFanout;
    if (!fanout || fanout.pieces.length < 2) return runBuildStep(prompt, ctx);

    emit({ type: "fanout", pieces: fanout.pieces.length });
    const result = await runBuildFanout({
      repoRoot: buildCwd(loom, manifest),
      baseRef: fanout.baseRef ?? "HEAD",
      pieces: fanout.pieces,
      runPieceBuilder: makePieceBuilder(ctx),
    });
    const summary = fanout.pieces
      .map((p, i) => `[${p.id}] ${result.verdicts[i]?.summary ?? (result.verdicts[i]?.ok ? "ok" : "no verdict")}`)
      .join("; ");
    const combined: Verdict = {
      ok: result.ok,
      summary: `fan-out (${fanout.pieces.length} pieces): ${summary}`,
      files_touched: result.merged,
      blocker: result.ok
        ? null
        : result.verdicts.find((v) => v && !v.ok)?.blocker ??
          (result.stray.length ? `stray files outside allowedPaths: ${result.stray.join(", ")}` : "a build piece failed"),
    };
    return combined;
  };

  // M3 worktree isolation lifecycle. Declared out here so the finally (the ONE
  // leak-safe cleanup site, running on every return AND on abort/cancel) sees
  // them. Only a CHILD thread gets its own worktree, and only when isolation is
  // on AND the root pinned a resolvable base SHA; otherwise ownWorktree stays
  // null and every path below is byte-identical to pre-M3.
  let ownWorktree: string | null = null;
  // M11.5 (finding 5) — the pinned base SHA the worktree is detached at, HOISTED
  // out of the isolation `if` so the finally's snapshot can compare it against
  // the (possibly advanced) worktree HEAD. Without this the finally could not
  // tell a truly-clean-at-base worktree (nothing to preserve) from one whose
  // builder COMMITTED its attempt work (clean tree, HEAD past base) — the
  // committed-but-unreferenced case the cancel path was destroying.
  let ownWorktreeBaseSha: string | undefined;
  // Set true ONLY when the done-path fold lands the child's diff on the review
  // branch. Any other terminal (fold FAILED, fold never ran, needs-review/
  // failed/halted) leaves it false, so the finally snapshots the worktree's WIP
  // onto a durable recovery branch BEFORE removing the dir — work is never lost.
  let foldSucceeded = false;
  if (loom.parentLoomId) {
    const baseSha = getLoom(loom.parentLoomId)?.baseSha;
    if (baseSha) {
      ownWorktreeBaseSha = baseSha;
      ownWorktree = await withWorktreeLock(() => addWorktree(defaultGitRunner, manifest.root, baseSha, loom.id));
      loom.worktree = ownWorktree;
      opts.onState?.(loom); // persist BEFORE the build so a crash leaves a reclaimable record
    }
  }

  try {
    // Retry context from the previous attempt.
    let failing: GateResult[] = [];
    let lastVerdict: Verdict | null = null;
    let verdictWasNull = false;
    let verifierRepair = ""; // set when the previous attempt was Verifier-driven
    let flakyUsed = 0;
    const maxFlaky = 2;
    // M11.4 (finding 4) — the previous attempt's per-failing-id output signatures,
    // for the attempt-loop unfixable-gate breaker below. Null until at least one
    // attempt has failing gates.
    let prevFailSig: Record<string, string> | null = null;

    // M11 item-2(iv) (finding 2) — fail-CLOSED backstop for a NON-runnable
    // command `expected` reaching EXECUTION. A `command` runs its `expected`
    // verbatim through sh -c (runContractGates), so a prose / bare-JS expected is
    // unrunnable-by-construction and fails identically forever — the live bug
    // (loom_mriqnl72) burned three attempts on "process: command not found".
    // Author-time validateContract now REJECTS this shape, so a NEW contract can
    // never carry it; the case that still reaches here is a LEGACY on-disk
    // contract authored before the guard (the live-bug loom already persisted),
    // or a write path that bypassed validation.
    //
    // Why raw-parse and not readContract(): readContract re-runs validateContract
    // and, on ANY error, returns contract:null. Post-guard, a non-runnable command
    // expected IS such an error — so both readContract here AND the loop's own
    // readContract below would see null, silently DROP the whole contract, and let
    // the loom proceed judged on manifest.gates alone. That is a fail-OPEN (the
    // falsifiable yardstick vanishes). So we read the RAW bundle contract
    // (structural safeParse, no validateContract) to SEE the broken assertion the
    // validator would hide, and PARK the loom (blocked, a strategy-derived
    // answerable question) instead of letting it run yardstick-less. SCOPED to
    // `command` (matching validateContract): a `gate` expected is a manifest-gate
    // NAME, a `db` expected is legitimately SQL.
    {
      const rawContract = readBundleFile(loom.id, CONTRACT_FILE);
      if (rawContract !== null) {
        let parsedRaw: VerificationContract | null = null;
        try {
          const p = VerificationContract.safeParse(JSON.parse(rawContract));
          if (p.success) parsedRaw = p.data;
        } catch {
          // Malformed JSON / structurally-invalid contract — not our concern;
          // the existing null-contract path handles it. Only a well-formed
          // contract carrying a non-runnable command is the item-2(iv) case.
        }
        if (parsedRaw) {
          const nonRunnable = parsedRaw.assertions.filter(
            (a) => a.type === "command" && !!(a.expected ?? "").trim() && !isRunnableShape(a.expected ?? ""),
          );
          if (nonRunnable.length > 0) {
            const ids = [...new Set(nonRunnable.map((a) => a.id))].sort();
            const signal = deriveDeliverableSignal(manifest.root, loom.charter);
            loom.blockedReason =
              `Non-runnable verification command(s) ${ids.join(", ")}: the authored \`expected\` is prose or a ` +
              `bare expression, not an executable shell command, so it can never pass through the gate runner ` +
              `(it would run verbatim as \`sh -c\` and fail identically forever). ${signal.reason}.`;
            loom.blockedQuestion = blockedStrategyQuestion(signal);
            emit({ type: "lane-escalation", by: "telar", reason: "nonrunnable-expected", ids });
            setState("blocked");
            return loom;
          }
        }
      }
    }

    for (let n = 1; n <= maxAttempts; n++) {
      if (isAborted()) return halt();

      const role = n === maxAttempts ? "careful" : "dev";
      const model = policy[role];
      const resume = loom.attempts[loom.attempts.length - 1]?.sessionId;

      setState("running");
      emit({ type: "attempt", n, role, model });
      const attempt: AttemptRecord = { n, role, model, startedAt: Date.now() };
      loom.attempts.push(attempt);
      opts.onState?.(loom);

      const prompt: string =
        n === 1
          ? firstPrompt(loom, manifest)
          : retryPrompt(failing, lastVerdict, verdictWasNull, verifierRepair || undefined);
      const verdict: Verdict | null = await runAttemptBuild(prompt, { model, resume, attempt });

      if (isAborted()) {
        attempt.endedAt = Date.now();
        return halt();
      }

      setState("verifying");
      const gateRun = await runGates(manifest.gates, buildCwd(loom, manifest), (r) => emit({ type: "gate", result: r }));
      // Unit 4 (docs §3): route the contract's DETERMINISTIC assertions
      // (command / gate / db-with-a-runnable-command) into the SAME gate/command
      // layer as extra gates, BEFORE the panel. For a no-UI backend contract
      // (empty manifest.gates but N routed checks) this flips gatesConfigured
      // true and judges the loom on real exit-code evidence — never a browser.
      // Every existing contract partitions to deterministic:[] -> adds nothing.
      const { contract: routedContract, errors: contractErrors } = readContract(loom.id);
      let deterministic = routedContract
        ? partitionAssertions(routedContract.assertions).deterministic
        : [];
      // M11 (finding: fail-OPEN floor) — readContract returns contract:null on ANY
      // validateContract error, and the ALWAYS-ON non-runnable-command rule (schemas
      // validateContract) is a NEW such error. Left alone, null ⇒ deterministic:[]
      // would SILENTLY DROP the whole deterministic slice of a LEGACY on-disk
      // contract whose ONLY defect is a prose/JS `command` expected — the falsifiable
      // yardstick vanishes and the loom is judged on manifest.gates alone (fail-OPEN,
      // the sacred posture INVERTED; for a gate-less library loom that means passing
      // on the builder's self-report). Instead, when the SOLE reason readContract
      // nulled is that non-runnable-command rule, route the RAW structural slice
      // anyway: the prose `expected` runs verbatim through the gate runner and FAILS
      // CLOSED — exactly the pre-guard behavior, so flag-off stays byte-identical
      // (the command ran and reddened before this diff too). Flag-ON the item-2(iv)
      // pre-flight above already PARKED such a loom before this loop; this floor is
      // the flag-OFF (and any-non-park) safety net. Scoped tightly to the non-
      // runnable-command error so every OTHER null-cause (malformed JSON, dangling
      // expectedFile, prose-only assertion) keeps its exact prior deterministic:[].
      // FINDING 6/7 integration — a finding-6-shaped legacy contract (prose expected
      // + a mis-placed runnable in `observable`) now yields TWO validateContract
      // errors; route its RAW deterministic slice (fail-CLOSED) when EVERY error is
      // author-repairable, so it never collapses to deterministic:[] (fail-OPEN). The
      // shared helper also returns false on an empty list, preserving the prior
      // length>0 guard. Every OTHER null-cause (malformed JSON, dangling expectedFile,
      // prose-only) still falls through to the empty slice, and flag-off never reaches
      // a tightened-predicate error ⇒ byte-identical.
      if (!routedContract && contractErrorsRepairable(contractErrors)) {
        const raw = readBundleFile(loom.id, CONTRACT_FILE);
        if (raw !== null) {
          try {
            const p = VerificationContract.safeParse(JSON.parse(raw));
            if (p.success) deterministic = partitionAssertions(p.data.assertions).deterministic;
          } catch {
            // Structurally broken JSON — keep the empty slice (baseline behavior).
          }
        }
      }
      const contractGateResults = deterministic.length
        ? await runContractGates(deterministic, manifest, buildCwd(loom, manifest), (r, a) =>
            emit({ type: "gate", result: r, assertionId: a.id, assertionType: a.type }),
          )
        : [];
      const mergedGates = [...gateRun.results, ...contractGateResults];
      attempt.gates = mergedGates;
      attempt.verdict = verdict;
      attempt.endedAt = Date.now();
      if (verdict) emit({ type: "verdict", verdict });
      opts.onState?.(loom);

      if (isAborted()) return halt();

      // Deterministic assertions are literally extra gates: they merge into
      // gatesConfigured/gatesOk and flow through builderOk + decide() unchanged.
      const gatesConfigured = manifest.gates.length + deterministic.length > 0;
      const gatesOk = mergedGates.every((r) => r.ok);
      failing = mergedGates.filter((r) => !r.ok);
      lastVerdict = verdict;
      verdictWasNull = verdict === null;

      // M11.4 (finding 4) — the attempt-loop unfixable-gate safety net. A loom
      // with no working repair route (created before the proof-hint plumbing, or
      // whose planner emitted no hints) would otherwise burn EVERY attempt on a
      // gate the builder can never move (finding 2's live bug: a prose `expected`
      // running as `sh -c` fails identically forever). When a failing assertion
      // carries a BYTE-IDENTICAL output signature across consecutive attempts
      // WHILE this attempt's builder actually changed the tree (files_touched
      // non-empty — it TRIED and the gate didn't budge), the red is contract/
      // environment state, not code: PARK the loom (blocked, a strategy-derived
      // answerable question) instead of wasting the remaining attempts. Reuses
      // repair-guard's normalizeGateOutput so both breaker legs (this + the
      // frozen-lane repair loop) derive the signature identically.
      let failSig: Record<string, string> | null = null;
      if (failing.length > 0) {
        failSig = {};
        for (const r of failing) failSig[r.name] = normalizeGateOutput(r.output);
        const treeChanged = (verdict?.files_touched?.length ?? 0) > 0;
        // NO-PROGRESS precondition (adaptive-verification review finding 3) — the
        // breaker may fire ONLY when the failing SET is NOT strictly shrinking
        // between the two attempts, mirroring repair-guard Guard 3's strict-shrink
        // progress test. Without this, a loom with SEVERAL independent failing
        // assertions that the builder legitimately fixes one-per-attempt (attempt
        // n-1 works on Y leaving X's output untouched, attempt n fixes Y) would see
        // X flagged "stuck" and PARK the whole loom before a later attempt could fix
        // X. When F strictly shrank (F_n ⊂ F_{n-1}, |F_n| < |F_{n-1}|) the builder
        // IS converging — never park on a momentarily-identical id; let the
        // remaining attempt run. Only a genuine plateau (same/growing set) with a
        // byte-identical stuck id is unfixable.
        const prevIds = prevFailSig ? new Set(Object.keys(prevFailSig)) : null;
        const curIds = new Set(failing.map((r) => r.name));
        const madeProgress =
          prevIds !== null &&
          [...curIds].every((id) => prevIds.has(id)) &&
          curIds.size < prevIds.size;
        if (prevFailSig && treeChanged && !madeProgress) {
          const prev = prevFailSig;
          const stuck = failing
            .map((r) => r.name)
            .filter((id) => {
              // Non-empty + byte-identical to the previous attempt (an empty
              // output carries no signal — decline to judge, same rule as the
              // repair-guard signature guard).
              const s = failSig![id];
              return s !== undefined && s !== "" && prev[id] === s;
            });
          if (stuck.length > 0) {
            const ids = [...new Set(stuck)].sort();
            const signal = deriveDeliverableSignal(manifest.root, loom.charter);
            loom.blockedReason =
              `Unfixable gate after ${n} attempts: ${ids.join(", ")} failed with byte-identical output ` +
              `while the builder kept changing the tree — the red is contract/environment state, not ` +
              `project code, so no further attempt can move it. ${signal.reason}.`;
            loom.blockedQuestion = blockedStrategyQuestion(signal);
            emit({ type: "lane-escalation", by: "telar", reason: "unfixable-gate", ids });
            setState("blocked");
            return loom;
          }
        }
      }
      prevFailSig = failSig;

      // Drive the Verifier only when the builder succeeded — otherwise there is
      // nothing to verify and verification stays "skip" (no verify call).
      const builderOk = verdict?.ok === true && (gatesConfigured ? gatesOk : true);
      let verification: Verification = "skip";
      let report: VerifierReport | null = null;
      let panelRequired = false;
      if (builderOk) {
        const vr = await runVerification(
          loom,
          manifest,
          attempt,
          emit,
          opts.accounts?.[manifest.account],
          undefined,
          { abort: opts.abort },
        );
        verification = vr.verification;
        report = vr.report;
        panelRequired = vr.panelRequired;
      }

      if (isAborted()) return halt();

      // M10.2 — CHILD-scoped thread-advisory. The M10.1 top gate is UNCONDITIONAL,
      // so coverage a thread stops gating is always re-proven at the top. A ROOT
      // (no parentLoomId) yields false ⇒ decide() takes its unchanged fail-closed
      // path.
      //
      // COVERAGE INVARIANT (fail-open hole closed): the relaxation may fire ONLY
      // for a CONTRACT-BACKED child — one whose `panelRequired` skip came from the
      // contract-partition path (readContract non-null ⇒ runVerification took the
      // `if (contract)` branch, so panelRequired = agentJudged.length > 0 over the
      // child's `contract.assertions`). Those assertions are a `wireChildBundle`
      // filtered slice of the ROOT contract, which M10.1's top gate re-verifies in
      // full (`runIntegrationVerify` with `fullContract:true` over the root's
      // `contract.assertions`). A LEGACY / no-contract child instead reaches a
      // `panelRequired` skip via the `verify()` null/throw fallback, where the
      // relaxed criterion is the subGoal's PROSE `acceptanceCriteria` — NOT an
      // assertion in any contract, so the top gate STRUCTURALLY cannot re-prove it.
      // Relaxing that would silently drop coverage (fail-open). `!!routedContract`
      // gates the relaxation to exactly the criteria the top gate re-proves.
      const childAdvisory = !!loom.parentLoomId && !!routedContract;

      const decision = decide({
        gatesConfigured,
        gatesOk,
        verdict,
        verification,
        panelRequired,
        n,
        maxAttempts,
        flakyUsed,
        maxFlaky,
        childAdvisory,
      });

      if (decision.action === "done") {
        setState(terminalStateForCompletedLoom(loom));
        // M10.2 — surface the human-readable advisory ONLY when this green terminal
        // is the relaxed evidence-unobtainable case (the exact triple decide()
        // short-circuited). Purely additive: it gates nothing, never sets
        // loom.error (which would read as broken), and mirrors emitVerifySummary's
        // contract. The green child's state stays "done"; the note is the only
        // distinguisher from a plain pass. The criterion is re-proven fail-closed
        // at M10.1's top gate over the composed whole.
        if (childAdvisory && panelRequired && verification === "skip") {
          emit({
            type: "thread-advisory",
            n,
            subGoalId: loom.subGoalId,
            note: "couldn't independently verify at thread altitude (panel evidence unobtainable); re-proven at the orchestrator top gate over the composed whole",
          });
        }
        // M3 consolidation: on a CHILD's success, fold its isolated-worktree
        // diff onto the root's review branch BEFORE the finally removes the
        // worktree. Moat: this only ever commits onto telar/<rootId>, never
        // baseBranch, never advances state past "done". A fold FAILURE retains
        // the worktree (guarded in finally) so the work isn't destroyed.
        if (ownWorktree && loom.parentLoomId) {
          const root = getLoom(loom.parentLoomId);
          if (root?.consolidationBranch) {
            try {
              const allowedPaths = root.charter?.scope.allowedPaths ?? [];
              const fold = await foldChildOnDone({ child: loom, root, repoRoot: manifest.root, allowedPaths, git: defaultGitRunner });
              foldSucceeded = true; // diff landed on the review branch — finally may just remove the dir
              emit({ type: "consolidated-thread", branch: root.consolidationBranch });
              // Honest surfacing: two threads changed the same file — the later
              // fold overwrote the earlier on the review branch. Not silently
              // dropped; the human sees exactly which files to reconcile.
              if (fold.collisions.length > 0) {
                emit({
                  type: "consolidate-collision",
                  branch: root.consolidationBranch,
                  thread: loom.id,
                  files: fold.collisions,
                });
              }
            } catch (err) {
              // Fold threw — leave foldSucceeded false so the finally SNAPSHOTS
              // the worktree's un-consolidated work onto a recovery branch (then
              // removes the dir) instead of destroying it.
              emit({ type: "consolidate-failed", message: err instanceof Error ? err.message : String(err) });
            }
          }
        }
        return loom;
      }
      if (decision.action === "needs-review") {
        if (gatesConfigured && gatesOk && verdict && !verdict.ok) loom.error = verdict.blocker;
        else if (verification === "fail") loom.error = `verification failed: ${report?.summary ?? ""}`;
        else if (decision.error !== undefined) loom.error = decision.error;
        setState("needs-review");
        return loom;
      }
      if (decision.action === "failed") {
        loom.error =
          gatesConfigured && !gatesOk
            ? failing.map((r) => r.name).join(", ")
            : verdict
              ? (verdict.blocker ?? verdict.summary)
              : "agent never reported a verdict";
        setState("failed");
        return loom;
      }

      // retry: carry a Verifier-driven repair brief only when the Verifier drove
      // this decision; clear it otherwise so the next prompt isn't misleading.
      if (verification === "fail" || verification === "flaky") {
        verifierRepair = report ? buildVerifierRepair(report) : "";
        if (verification === "flaky") flakyUsed++;
      } else {
        verifierRepair = "";
      }
    }
    return loom; // unreachable: the last attempt always returns above
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Callbacks (onEvent/onState) may be the very thing that threw (e.g. a
    // full disk behind persistence) — never let a second throw reject.
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
  } finally {
    // The ONE leak-safe cleanup site: runs on every return (done/needs-review/
    // failed/halted) AND on abort/cancel. Serialized through the same mutex as
    // create. SNAPSHOT-THEN-REMOVE: unless the done-path fold already landed the
    // work (foldSucceeded), first preserve the worktree's un-consolidated WIP on
    // a durable recovery branch, THEN remove the dir — so work ALWAYS survives
    // AND the dir is ALWAYS reclaimed. Flag-off (ownWorktree null) is a no-op.
    // NOTE: no `return` in this finally — that would clobber the try/catch's
    // resolved loom; retention is signalled via a local flag instead.
    if (ownWorktree) {
      const wt = ownWorktree;
      let retained = false;
      if (!foldSucceeded) {
        try {
          // telar/<rootId|loomId>-wip-<childId> — a durable, human-discoverable ref.
          const branch = `telar/${loom.parentLoomId ?? loom.id}-wip-${loom.id}`;
          // M11.5 (finding 5) — pass the pinned base so a CLEAN worktree whose
          // builder COMMITTED its work (HEAD advanced past base) still pins a
          // recovery branch, instead of the committed commits being destroyed by
          // the removeWorktree below.
          const snapped = await withWorktreeLock(() => snapshotWorktreeToBranch(defaultGitRunner, wt, branch, ownWorktreeBaseSha));
          if (snapped) {
            loom.recoveryBranch = branch;
            try {
              opts.onState?.(loom);
            } catch {}
          }
        } catch {
          // The SNAPSHOT itself failed — retaining the dir is the only way not to
          // lose work. Persist a durable flag so the boot reaper SKIPS it (never
          // an in-memory-only retention), and do NOT remove the dir.
          loom.worktreeRetained = true;
          try {
            opts.onState?.(loom);
          } catch {}
          retained = true;
        }
      }
      if (!retained) {
        try {
          await withWorktreeLock(() => removeWorktree(defaultGitRunner, manifest.root, wt));
          loom.worktree = undefined;
          try {
            opts.onState?.(loom);
          } catch {}
        } catch {
          // best-effort — a cleanup failure must never turn a resolved loom into a reject
        }
      }
    }
  }
}

// M9 (thread-as-workflow) — the runtime per-step outcome the workflow runner
// records. NOT persisted (never lands in loom.json); lives here next to the
// runner, not in schemas.ts.
export type StepResult = {
  id: string;
  ok: boolean;
  state: WorkUnitState;
  // M9.2 CF2 — read-only verification proof from the step's winning attempt.
  // A writing step (build|migrate) reporting terminal-green MUST carry one of
  // these; the built-in delegate fills them ONLY from the real executeLoom
  // output (never fabricated), so an injected runStep cannot forge a green.
  verifierReport?: VerifierReport | null;
  panelReport?: PanelReport | null;
  gatesGreen?: boolean; // a legit gates-only pass (deterministic gates green, no browser verifier)
};
// M9.2 — the per-step pool slice the runner hands each step so total concurrency
// (steps-in-wave × agents-per-step) stays bounded by the shared pool / budget.
type StepClamp = { maxAgents: number; inFlight: number; budgetLeftUsd: number; estCostPerAgent: number };
export type WorkflowStepCtx = { loom: Loom; manifest: ProjectManifest; opts: ExecuteOpts; clamp: StepClamp };

// M9.3 — the READ-ONLY LLM step-planner's fixed instruction. Same prose-contract
// style as splitBuild's task (build-fanout.ts): states the read-only discipline,
// gives the objective, and constrains the emitted ThreadWorkflow shape. Deliberately
// tells the model to emit a single build step when unsure so a low-confidence plan
// still yields a valid graph (belt-and-suspenders with validateWorkflow's degrade).
function plannerPrompt(loom: Loom): string {
  return `You are planning the step-graph (workflow) for a software thread. This is a
READ-ONLY planning pass — you may read the repository to understand context,
but you must NOT write, edit, or run anything.

--- Objective ---
${loom.prompt}

Emit a ThreadWorkflow: { version, steps }. Rules:
- Each step needs a UNIQUE id, a goal, and a kind ∈ {research, design, build,
  migrate, check}.
- Optional agents: each { id, title, prompt, allowedPaths }. For a writing step
  (build/migrate) that you want fanned out, give it partition "disjoint-writer"
  and agents whose allowedPaths are mutually DISJOINT; otherwise use partition
  "free".
- dependsOn lists earlier step ids this step waits on; it must reference EXISTING
  ids only, and the overall graph must be ACYCLIC.
- The graph must contain AT LEAST ONE build or migrate step (the step that does
  the real work).
- Leave each step's check (the per-step contract) ABSENT.
- If you are unsure or the task is small/atomic, emit a single build step.`;
}

// M9.3 — author the thread's step-graph. Three-tier fallback, never throws:
//   (1) deterministic template library (the degrade floor, always valid);
//   (2) read-only LLM planner (the norm) — mirrors splitBuild;
//   (3) validate-or-degrade: any failure/null/invalid/empty/cyclic ⇒ tier 1.
// Timeout/cancellation is NOT locally enforced here — same as splitBuild, the
// planner call passes `abort: opts.abort` with no planner-local timer, so
// cancellation/timeout coverage comes from the caller's AbortController and the
// engine's own turn/time limits, not from this function.
// READ-ONLY: no builder/writer spend — the single agent call is tool-walled
// (READ_ONLY_TOOLS + restrictTools + READ_ONLY_DISALLOWED_TOOLS + settingSources:[]),
// and builders are created only later when the wave loop schedules a writing step
// (defaultRunStep/delegateToExecuteLoom). A planner mistake can only REPLACE the
// EXECUTION graph with another validated graph — it never touches the verifier,
// panel, or provenance gate, so it can never rubber-stamp a green.
export async function planThreadWorkflow(
  loom: Loom,
  manifest: ProjectManifest,
  opts: ExecuteOpts,
): Promise<ThreadWorkflow> {
  const template = selectTemplate(loom); // tier 1 — always valid, the degrade floor
  try {
    const result = await (opts.run ?? agent)(plannerPrompt(loom), {
      schema: ThreadWorkflow, // engine parses → ThreadWorkflow | null
      cwd: manifest.root,
      tools: READ_ONLY_TOOLS, // ── the read-only wall (single source of truth)
      restrictTools: true,
      disallowedTools: READ_ONLY_DISALLOWED_TOOLS,
      settingSources: [],
      account: opts.accounts?.[manifest.account],
      model: opts.policy?.dev,
      abort: opts.abort,
    });
    if (!result || !validateWorkflow(result)) return template; // tier 3 — degrade
    return result;
  } catch {
    return template; // throw/timeout ⇒ degrade
  }
}

// M9.2 — the terminal-FAILURE states a delegate (executeLoom) may already have
// written. The runner's fail-closed guards are IDEMPOTENT against these: they
// never clobber a terminal failure a delegate owns, and only fire when the loom
// is still non-terminal.
function isTerminalFailure(s: WorkUnitState): boolean {
  return s === "failed" || s === "needs-review" || s === "halted";
}

export async function runThreadWorkflow(loom: Loom, manifest: ProjectManifest, opts: ExecuteOpts): Promise<Loom> {
  const emit = (ev: { type: string } & Record<string, unknown>) => opts.onEvent?.(ev);
  const plan = loom.workflow?.steps?.length
    ? loom.workflow                                              // pre-persisted DAG wins, unchanged
    : await (opts.planWorkflow ?? planThreadWorkflow)(loom, manifest, opts);
  const steps = plan.steps;

  // Clamp inputs from the loom's (root) charter budget when present, else uncapped;
  // EVERY wave/agent count is routed through fanoutSize so nothing fans out unclamped.
  const budget = loom.charter?.budget;
  // Explicit BudgetState: only maxCostUsd/spentUsd feed budgetLeftUsd's math,
  // but the type requires the full shape, so the other fields are given their
  // real neutral values (no spend/elapsed tracked yet at workflow start) —
  // same values the old `as any` spread produced, just without the cast.
  const clampArgs = {
    maxAgents: budget?.maxAgents ?? DEFAULT_MAX_AGENTS,
    inFlight: 0,
    budgetLeftUsd: budget
      ? budgetLeftUsd({
          maxAgents: budget.maxAgents,
          inFlight: 0,
          spentUsd: 0,
          startedAtMs: 0,
          maxCostUsd: budget.maxCostUsd,
          maxWallClockHours: budget.maxWallClockHours,
        })
      : Infinity,
    estCostPerAgent: EST_COST_PER_AGENT,
  };

  const doneSteps = new Set<string>();
  const startedSteps = new Set<string>();
  const run = opts.runStep ?? defaultRunStep;
  // M9.4 — the per-step CHECK evaluator (test seam, mirrors `run`) and the step-
  // local repair cap. maxStepRepairs is the SAME cap as the builder loop's
  // maxAttempts (Math.max(1, opts.maxAttempts ?? 3)) — no new counter. Both are
  // consulted ONLY inside the M9.4 seam below, guarded by st.check present.
  const runCheck = opts.runStepCheck ?? runStepCheck;
  const maxStepRepairs = Math.max(1, opts.maxAttempts ?? 3);
  // Fail-closed helper mirroring BLOCKER 1 (:1849) verbatim: idempotent against a
  // terminal failure a delegate already wrote. Used only by the M9.4 seam.
  const failStepClosed = (message: string) => {
    if (!isTerminalFailure(loom.state)) {
      loom.error = message;
      loom.state = "failed";
      emit({ type: "error", message });
      emit({ type: "state", state: "failed" });
      opts.onState?.(loom);
    }
  };
  // CF2 provenance: the built-in defaultRunStep fills the verification-proof
  // fields ONLY from executeLoom's real read-only verifier (never fabricated);
  // an injected opts.runStep supplies them itself and can forge them. This flag
  // is the sole basis on which CF2 trusts a writing-step green's proof.
  const usedBuiltinExecutor = !opts.runStep;
  // HOLE A provenance ledger: flips true ONLY when a WRITING step ran through the
  // BUILT-IN executor (usedBuiltinExecutor), reported terminal-green (ready|done),
  // AND carried real executeLoom-derived proof (verifierReport|panelReport|
  // gatesGreen). This is the SOLE evidence that can leave the loom green — the
  // FINAL PROVENANCE GATE below fails any terminal-green loom closed without it.
  let sawTrustedWritingGreen = false;

  while (doneSteps.size < steps.length) {
    // REUSE the loom's ready predicate one altitude down — steps as nodes, a
    // recorded step-result standing in for a "done" thread.
    const readyIds = readyItems(steps, (id) => startedSteps.has(id), (id) => doneSteps.has(id));
    if (readyIds.length === 0) break; // no progress possible (cycle / blocked) — fail closed below
    // Rank (critical-path first) then clamp concurrency with the SAME clamp tick uses.
    const ranked = prioritizeScored(readyIds, steps).map((r) => r.id); // reads only {id,dependsOn}
    const chosen = fanoutSize(ranked.length, clampArgs);
    const wave = ranked.slice(0, Math.max(1, chosen));
    for (const id of wave) startedSteps.add(id);
    emit({ type: "workflow-wave", stepIds: wave });

    // Concurrency-doubling guard (goal #2): the wave clamp bounds STEPS only;
    // each step then fans out its own agents, so total = wave × agents-per-step.
    // Give each step in the wave an equal SLICE of the pool so the product stays
    // <= the pool: Σ (<= floor(maxAgents/W)) <= W × floor(maxAgents/W) <= maxAgents,
    // and est cost <= W × (budgetLeftUsd/W) = budgetLeftUsd. A writing step whose
    // slice yields <2 degrades to the single-builder delegate (honest fallback).
    const W = wave.length;
    const perStepClamp: StepClamp = {
      maxAgents: Math.max(1, Math.floor(clampArgs.maxAgents / W)),
      inFlight: 0,
      budgetLeftUsd: isFinite(clampArgs.budgetLeftUsd) ? clampArgs.budgetLeftUsd / W : Infinity,
      estCostPerAgent: clampArgs.estCostPerAgent,
    };

    // HOLE B — concurrency race on the SHARED loom. A built-in WRITING step
    // delegates to executeLoom(ctx.loom,…), which mutates loom.state/loom.attempts
    // UNsynchronized (withWorktreeLock guards only the filesystem). Two such steps
    // in one wave running concurrently let a failing step's delegateToExecuteLoom
    // read out.attempts[last]/out.state pick up a SIBLING's successful result — a
    // false green with someone else's verifierReport. SERIALIZE the built-in
    // writing-delegate steps (usedBuiltinExecutor is constant for the run, so this
    // is exactly the writing kinds) so each step's read reflects ONLY its own run.
    // Free steps (never mutate loom.state) and injected-opts.runStep steps (their
    // greens are failed-closed by the FINAL PROVENANCE GATE) stay parallel.
    // M9.3 carry-forward: give each step an isolated loom/worktree context and
    // derive the loom's terminal state from validated per-step results, enabling
    // safe parallel writing steps + trusted custom executors; until then built-in
    // writing steps are serialized and injected-executor greens fail closed.
    const stepById = (id: string) => steps.find((s) => s.id === id)!;
    const isSerialWriting = (id: string) => usedBuiltinExecutor && isWritingKind(stepById(id).kind);
    const runStepFor = (id: string) => run(stepById(id), { loom, manifest, opts, clamp: perStepClamp });
    // Non-serial steps run concurrently (unchanged); serial writing steps run one
    // at a time, awaited in series, alongside the parallel batch.
    const parallelResults = Promise.all(wave.filter((id) => !isSerialWriting(id)).map(runStepFor));
    const serialResults = (async () => {
      const out: StepResult[] = [];
      for (const id of wave.filter(isSerialWriting)) out.push(await runStepFor(id));
      return out;
    })();
    const [parallel, serial] = await Promise.all([parallelResults, serialResults]);
    // Reassemble in wave order so result-handling (BLOCKER 1's first-failure
    // fail-close) is deterministic.
    const byId = new Map<string, StepResult>();
    for (const r of [...parallel, ...serial]) byId.set(r.id, r);
    const results = wave.map((id) => byId.get(id)!);

    for (const res of results) {
      emit({ type: "workflow-step", stepId: res.id, state: res.state });
      const st = steps.find((s) => s.id === res.id)!;

      // BLOCKER 1 — a non-green step must fail the LOOM closed. A step can fail
      // via a branch that never re-enters executeLoom and thus never mutated
      // loom.state (disjoint-writer partition-overlap fail-close; a failing
      // runFreeStepFanout). A bare `return loom` would hand back whatever state
      // an EARLIER green step left (e.g. "ready" from a delegated executeLoom),
      // masking this failure as a green thread. Mirror the CF2 / unschedulable-
      // DAG guards. IDEMPOTENT: never clobber a terminal failure a delegate
      // already wrote — so for the default 1-step template, whose failing
      // executeLoom already set loom.state, this guard is a no-op.
      if (!res.ok) {
        // FINDING 8 — a step that PARKED the loom `blocked` is an awaiting-human
        // PAUSE, not a step failure. A delegated executeLoom can park blocked via
        // the breaker (unfixable gate after N attempts) or the item-2(iv) pre-flight
        // lane-viability floor; that is a resumable question, not a dead step. Surface
        // it (workflow-step-blocked) and RETURN the parked loom VERBATIM so the weave
        // rollup lifts the blockedQuestion to the root — instead of the fail-close
        // below coercing "blocked"→"failed" (run #3's swallow, which buried the ask
        // and cascaded child→failed→root→failed). PROVENANCE GUARD: only the built-in
        // delegateToExecuteLoom parks the SAME loom object (ctx.loom === loom), so
        // loom.state is genuinely "blocked"; a forged {ok:false,state:"blocked"} from
        // an injected runStep that did NOT park the loom fails the loom.state===
        // "blocked" conjunct and falls through to fail-closed (mirrors the file's
        // usedBuiltinExecutor trust discipline). Keyed STRICTLY to "blocked" so every
        // OTHER non-green (failed/skipped) still coerces to failed — the
        // m9-thread-workflow fail-close pins stay unchanged.
        if (res.state === "blocked" && loom.state === "blocked") {
          emit({ type: "workflow-step-blocked", stepId: res.id, state: res.state });
          return loom;
        }
        if (!isTerminalFailure(loom.state)) {
          const message = `step "${res.id}" failed: terminated non-green (state "${res.state}")`;
          loom.error = message;
          loom.state = "failed";
          emit({ type: "error", message });
          emit({ type: "state", state: "failed" });
          opts.onState?.(loom);
        }
        return loom;
      }

      // CF2 — verifier guard: a WRITING step (build|migrate) reporting terminal-
      // green MUST be backed by the moat's read-only verifier. PROVENANCE, not
      // presence: the proof fields (verifierReport | panelReport | genuine
      // gates-only pass) are trustworthy ONLY when they came through the BUILT-IN
      // default path, where delegateToExecuteLoom copies them verbatim from a
      // real executeLoom run (out.attempts[last]). An INJECTED/CUSTOM step
      // executor supplies those fields itself and can forge them (e.g.
      // verifierReport:{}), so its writing-green is REFUSED regardless of any
      // self-reported proof. Non-writing kinds are exempt (they never promote via
      // the verifier). M9.3 carry-forward: to accept a custom executor's writing-
      // step green, the runner must itself run the read-only verifier (verify())
      // against the loom diff — until then, custom writing-greens fail closed.
      const terminalGreen = res.state === "ready" || res.state === "done";
      const hasProof = !!(res.verifierReport || res.panelReport || res.gatesGreen);
      const trustedGreen = usedBuiltinExecutor && hasProof;
      if (isWritingKind(st.kind) && terminalGreen && !trustedGreen) {
        const message =
          `writing step "${res.id}" reported green without verifier proof` +
          (usedBuiltinExecutor ? "" : " — a custom step executor cannot self-certify a writing-step green");
        loom.error = message;
        loom.state = "failed";
        emit({ type: "error", message });
        emit({ type: "state", state: "failed" });
        opts.onState?.(loom);
        return loom; // fail closed
      }
      // HOLE A — record a TRUSTED writing-step green: built-in executor + terminal-
      // green + real executeLoom proof. Reaching here past the CF2 guard already
      // implies trustedGreen for a writing terminal-green, but we re-state the full
      // predicate so the ledger is self-evidently correct on its own.
      if (usedBuiltinExecutor && isWritingKind(st.kind) && terminalGreen && hasProof) {
        sawTrustedWritingGreen = true;
      }

      // ── M9.4 seam: optional post-step informational CHECK (verify-lens) ──────
      // Reached ONLY for a step that already survived BLOCKER 1 (res.ok) and CF2
      // (writing-green-with-proof) and whose HOLE A ledger already recorded any
      // trusted writing green — so this is structurally DOWNSTREAM of the loom-
      // level floor. The check can ADD scrutiny (fail a step / trigger a bounded
      // repair / fail the thread closed) but NEVER promotes the loom (it never
      // writes sawTrustedWritingGreen or loom.state="ready"|"done"; the FINAL
      // PROVENANCE GATE stays the only promotion path) and NEVER relaxes the
      // loom's contract (runStepCheck evaluates st.check EXPLICITLY, never
      // read/writeContract). Runs only for a step that declares a `check`; a
      // step with no check is a proceed (the check is optional, per-step).
      if (st.check) {
        const checkCtx: WorkflowStepCtx = { loom, manifest, opts, clamp: perStepClamp };
        // FIX 1 — the ENTIRE seam body (check evaluation + repair loop) runs inside
        // this try/catch. A throw from runCheck (critic/engine/Playwright/abort) or
        // runStepFor would otherwise escape runThreadWorkflow as an uncaught
        // rejection, leaving the shared loom at a prior green ('ready'/'done') and
        // bypassing the FINAL PROVENANCE GATE. A throw is NOT a designed no-evidence
        // 'skip' (which proceeds): the catch FAILS THE THREAD CLOSED.
        try {
          // FIX 2 — STATE-NEUTRAL check call. A check is READ-ONLY/informational and
          // must NEVER mutate loom.state; an injected runStepCheck could otherwise
          // side-channel loom.state="done" under a genuinely-earned trusted green,
          // bypassing the provenance gate + human acceptLoom (the runStepCheck
          // analogue of usedBuiltinExecutor for opts.runStep). Snapshot loom.state
          // immediately BEFORE runCheck and, if it changed, fail closed WITHOUT
          // honoring the mutated state. Applies to the CHECK call ONLY; the repair
          // re-run (runStepFor) legitimately mutates loom.state via executeLoom and
          // is validated by the normal step guards below.
          let sideChanneled = false;
          const evalCheck = async (): Promise<"pass" | "fail" | "skip"> => {
            const stateBefore = loom.state;
            const v = await runCheck(st, checkCtx);
            if (loom.state !== stateBefore) {
              sideChanneled = true;
              failStepClosed(
                `step "${res.id}" check side-channeled loom.state ("${stateBefore}" → "${loom.state}") — refused`,
              );
            }
            return v;
          };

          let verdict = await evalCheck();
          if (sideChanneled) return loom; // dependents HELD — the mutated state is NOT honored
          if (verdict === "fail") {
            // FIX 3a — a failing NON-WRITING (research/design/check) step would re-run
            // read-only agents against an UNCHANGED worktree, so a repair can never
            // change the verdict. Fail the thread closed immediately (no repair).
            if (!isWritingKind(st.kind)) {
              failStepClosed(`step "${res.id}" check failed (non-writing step — no repair can change the outcome)`);
              return loom;
            }
            // BOUNDED step-local repair for a WRITING step: re-run the FAILING step at
            // most maxStepRepairs times (the SAME cap as the builder loop's
            // maxAttempts), then fail closed. NO infinite loop: this outer loop is
            // <= maxStepRepairs (<=3) and each runStepFor re-enters executeLoom, itself
            // internally clamped at maxAttempts. FIX 3b — the repair nests OUTSIDE
            // executeLoom's own maxAttempts loop, so gate each iteration on REMAINING
            // BUDGET: charge a conservative per-iteration estimate (one writer wave)
            // against the step's budget SLICE and fail closed once the slice can no
            // longer afford another writer. An uncapped slice is Infinity, so the gate
            // never fires and cost-unbounded runs are byte-identical to before.
            let repairSpentUsd = 0;
            for (let r = 0; verdict === "fail" && r < maxStepRepairs; r++) {
              const sliceLeftUsd = budgetLeftUsd({
                maxAgents: perStepClamp.maxAgents,
                inFlight: 0,
                spentUsd: repairSpentUsd,
                startedAtMs: 0,
                maxCostUsd: isFinite(perStepClamp.budgetLeftUsd) ? perStepClamp.budgetLeftUsd : undefined,
              });
              if (fanoutSize(1, { ...perStepClamp, budgetLeftUsd: sliceLeftUsd }) < 1) {
                failStepClosed(`step "${res.id}" check failed; repair budget slice exhausted after ${r} attempt(s)`);
                return loom;
              }
              const repaired = await runStepFor(res.id);
              // Conservative charge against the slice: one estimated writer wave/iter.
              repairSpentUsd += perStepClamp.estCostPerAgent * Math.max(1, perStepClamp.maxAgents);
              emit({ type: "workflow-step", stepId: repaired.id, state: repaired.state });
              // Re-validate the re-run through the SAME guards the first run passed
              // (BLOCKER 1 + CF2). A non-green or forged-green repair fails closed.
              const rTerminalGreen = repaired.state === "ready" || repaired.state === "done";
              const rHasProof = !!(repaired.verifierReport || repaired.panelReport || repaired.gatesGreen);
              if (!repaired.ok || (isWritingKind(st.kind) && rTerminalGreen && !(usedBuiltinExecutor && rHasProof))) {
                failStepClosed(
                  !repaired.ok
                    ? `step "${res.id}" repair re-run terminated non-green (state "${repaired.state}")`
                    : `step "${res.id}" repair re-run reported green without verifier proof`,
                );
                return loom; // dependents HELD — never reaches doneSteps.add
              }
              verdict = await evalCheck(); // re-check this step's NEW output (state-neutral)
              if (sideChanneled) return loom;
            }
            if (verdict === "fail") {
              // Repair exhausted, check still failing ⇒ FAIL THE THREAD CLOSED. Does
              // NOT reach doneSteps.add ⇒ every dependent is HELD (never scheduled);
              // a failing per-step check therefore NEVER yields a green loom.
              failStepClosed(`step "${res.id}" check failed after ${maxStepRepairs} repair attempt(s)`);
              return loom;
            }
          }
          // verdict is "pass" or "skip" ⇒ fall through to doneSteps.add (proceed).
        } catch (err) {
          // FIX 1 backstop — ANY thrown error from the check evaluation or the repair
          // loop FAILS THE THREAD CLOSED (never treated as a proceed-'skip'). Emit a
          // diagnostic, then fail-close via the existing idempotent path so the loom
          // can never escape at a prior green with the provenance gate bypassed.
          const message = err instanceof Error ? err.message : String(err);
          emit({ type: "check-error", stepId: res.id, message });
          failStepClosed(`step "${res.id}" check errored — failed closed: ${message}`);
          return loom;
        }
      }
      doneSteps.add(res.id);
    }
  }

  // Fail closed: this point is reached two ways — (1) the `while` condition
  // went false because every step finished (doneSteps.size === steps.length,
  // the ONLY path for the default 1-step template — always taken here, so
  // this guard is never entered for it), or (2) the loop `break`-ed above with
  // steps still outstanding — an unschedulable DAG (a dependsOn cycle, or a
  // step naming a nonexistent/unreachable dependency). Case (2) must not
  // return the loom silently un-failed (a bare `return loom` here would hand
  // back whatever state the LAST successfully-delegated step left behind —
  // e.g. "ready" — which reads as success even though the workflow never
  // finished). IDEMPOTENT: if a delegated executeLoom already wrote a terminal
  // failure (failed/needs-review/halted) for the last step that ran, that
  // write stands — this only fires when the loom is still non-terminal.
  if (doneSteps.size < steps.length) {
    if (!isTerminalFailure(loom.state)) {
      const message = "unschedulable step DAG: dependsOn cycle or unreachable dependency";
      loom.error = message;
      loom.state = "failed";
      emit({ type: "error", message });
      emit({ type: "state", state: "failed" });
      opts.onState?.(loom);
    }
  }

  // ── FINAL PROVENANCE GATE (HOLE A) ─────────────────────────────────────────
  // A step executor receives ctx.loom BY REFERENCE and can side-channel the loom
  // green — `ctx.loom.state = "ready"` — while returning a StepResult that dodges
  // every per-step guard (e.g. {ok:true, state:"skipped"}: !res.ok is false so
  // BLOCKER 1 skips, terminalGreen is false so CF2 never evaluates). The per-step
  // guards inspect only the RETURNED StepResult, so the mutation slips through and
  // the loom is handed back GREEN with zero verifier proof. Close it by PROVENANCE:
  // a terminal-green loom is trustworthy ONLY if a trusted writing-step green was
  // produced this run (built-in executor + real executeLoom proof — the ledger
  // above). The default template / disjoint-writer fan-out set it (genuine
  // executeLoom green) and pass; a run using an injected/custom executor never sets
  // it, so ANY green it leaves — via a StepResult OR a side-channel loom mutation —
  // fails closed here. The condition already implies loom.state is not a terminal
  // FAILURE, so this never clobbers a delegate-owned failed/needs-review/halted.
  if ((loom.state === "ready" || loom.state === "done") && !sawTrustedWritingGreen) {
    const message = "loom reported green without a verifier-backed writing step";
    loom.error = message;
    loom.state = "failed";
    emit({ type: "error", message });
    emit({ type: "state", state: "failed" });
    opts.onState?.(loom);
  }

  return loom; // terminal loom.state was set by the delegated executeLoom (or the fail-closed guard above)
}

// Built-in step executor (M9.2). Three branches, chosen purely from the step's
// kind/partition/agents and the pool SLICE (ctx.clamp):
//   (1) FREE fan-out    — non-writing kinds (research|design|check): read-only
//                          agent() calls, collect Verdicts. No worktree/merge/stray.
//   (2) WRITING fan-out  — disjoint-writer + >=2 agents + pool grants >=2: re-enter
//                          executeLoom with opts.buildFanout from step.agents (the
//                          EXISTING M6 seam — runBuildFanout/mergeDisjoint/stray
//                          fail-closed reused verbatim, zero duplication).
//   (3) SINGLE-BUILDER   — everything else, incl. the DEFAULT 1-step template
//        DELEGATE          (agents:[]): re-enter executeLoom with NO buildFanout —
//                          BYTE-IDENTICAL to the M9.1 delegation.
async function defaultRunStep(step: Step, ctx: WorkflowStepCtx): Promise<StepResult> {
  // (1) FREE fan-out — non-writing kinds. No worktree, no mergeDisjoint, no stray.
  if (!isWritingKind(step.kind)) return runFreeStepFanout(step, ctx);

  // WRITING kinds (build|migrate) below. Only a disjoint-writer step with >=2
  // agents can fan out, and only if the pool slice grants >=2 concurrency.
  const n =
    step.partition === "disjoint-writer" && step.agents.length >= 2 ? decideBuildFanout(step.agents.length, ctx.clamp) : 1;

  // (2) WRITING fan-out.
  if (n >= 2) {
    const pieces = agentsToPieces(step.agents).slice(0, n);
    // Fail closed on authored overlap (don't let runBuildFanout hard-throw).
    if (!piecesAreDisjoint(pieces)) return { id: step.id, ok: false, state: "failed" };
    return delegateToExecuteLoom(step, ctx, { pieces, baseRef: "HEAD" });
  }

  // (3) SINGLE-BUILDER DELEGATE — the byte-identical path (default template AND
  // any writing step the pool clamped to <2).
  return delegateToExecuteLoom(step, ctx, undefined);
}

// RE-ENTER executeLoom with the recursion guard set: runs today's UNCHANGED
// attempt loop (build → gates → verify → decide → retry) + worktree lifecycle +
// green→ready terminal. With buildFanout undefined this is byte-identical to the
// M9.1 delegation; with buildFanout set, runAttemptBuild takes the M6 fan-out
// path unchanged. The CF2 proof fields are ADDITIVE reads of out.attempts[last]
// — never fabricated — so the moat's read-only verifier stays the only green.
async function delegateToExecuteLoom(
  step: Step,
  ctx: WorkflowStepCtx,
  buildFanout?: { pieces: BuildPiece[]; baseRef?: string },
): Promise<StepResult> {
  const out = await executeLoom(ctx.loom, ctx.manifest, {
    ...ctx.opts,
    viaWorkflow: true,
    ...(buildFanout ? { buildFanout } : {}),
  });
  const last = out.attempts[out.attempts.length - 1];
  const state = out.state;
  const terminalGreen = state === "ready" || state === "done"; // moat's promotable states
  const verifierReport = last?.verifierReport ?? null;
  const panelReport = last?.panelReport ?? null;
  // A genuine gates-only pass: terminal-green with NO browser verifier/panel, but
  // the deterministic gates all ran green and the builder Verdict was ok.
  const gatesGreen =
    terminalGreen &&
    !verifierReport &&
    !panelReport &&
    !!last?.gates?.length &&
    last.gates.every((g) => g.ok) &&
    last?.verdict?.ok === true;
  return { id: step.id, ok: terminalGreen, state, verifierReport, panelReport, gatesGreen };
}

// FREE fan-out for non-writing kinds (research|design|check, partition "free").
// Fans step.agents out as READ-ONLY agent() calls (the same read-only wall
// splitBuild/verifier use) and collects Verdicts — no worktree, no partition, no
// merge, no stray. The loom object is NEVER mutated here: state:"ready" is a
// SCHEDULING signal only (CF2 does not apply to non-writing kinds).
async function runFreeStepFanout(step: Step, ctx: WorkflowStepCtx): Promise<StepResult> {
  const { loom, manifest, opts, clamp } = ctx;
  if (step.agents.length === 0) return { id: step.id, ok: true, state: "ready" }; // vacuously complete; loom NOT promoted
  const n = fanoutSize(step.agents.length, clamp); // same pool-slice clamp
  const chosen = step.agents.slice(0, Math.max(1, n));
  const emit = (ev: { type: string } & Record<string, unknown>) => opts.onEvent?.(ev);
  const verdicts = await Promise.all(
    chosen.map((a) =>
      (opts.run ?? agent)(
        [`# ${a.title}`, a.prompt, "When done, call emit_result with your Verdict (ok, summary, files_touched, blocker)."]
          .filter(Boolean)
          .join("\n\n"),
        {
          schema: Verdict,
          cwd: buildCwd(loom, manifest),
          model: opts.policy?.dev,
          tools: READ_ONLY_TOOLS, // READ-ONLY wall — single source of truth in build-fanout.ts
          restrictTools: true,
          disallowedTools: READ_ONLY_DISALLOWED_TOOLS,
          settingSources: [],
          account: opts.accounts?.[manifest.account],
          abort: opts.abort,
          onEvent: (e) => {
            if (e.type === "text") emit({ type: "text", pieceId: a.id, text: e.text });
            else if (e.type === "tool") emit({ type: "tool", pieceId: a.id, name: e.name, input: e.input });
            else if (e.type === "result") emit({ type: "agent-result", pieceId: a.id, subtype: e.subtype, costUsd: e.costUsd });
          },
        },
      ).catch(() => null),
    ),
  );
  const ok = verdicts.every((v) => v?.ok === true);
  return { id: step.id, ok, state: ok ? "ready" : "failed" }; // free steps never call the verifier; loom state untouched
}
