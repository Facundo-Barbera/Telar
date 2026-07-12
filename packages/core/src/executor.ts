// Executor: the L1 stage loop — attempt, verify with gates, decide, retry.
// Pure w.r.t. persistence: mutates the loom object and emits events; the caller
// persists via onState/onEvent. Retries resume the previous attempt's session.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { agent } from "./engine";
import { refreshProjectMcpAuth, resolveProjectMcpServers } from "./mcp";
import { type BuildPiece, runBuildFanout } from "./build-fanout";
import { readBundleFile, readContract } from "./bundle";
import { runPanel, type CriticContext, type PanelEvent } from "./critic";
import { classifyPanel, panelReason, type PanelSignals } from "./panel";
import { type Gate, runGate, runGates, type GateResult } from "./gates";
import { getLoom, loomDir, type AttemptRecord, type Loom, type LoomKind } from "./looms";
import { addWorktree, defaultGitRunner, isolationEnabled, removeWorktree, snapshotWorktreeToBranch, withWorktreeLock } from "./vcs";
import { foldChildOnDone } from "./consolidate";
import { startProjectServer } from "./run-server";
import { ModelPolicy, validateContract, Verdict } from "./schemas";
import type {
  AccountProfile,
  ContractAssertion,
  PanelReport,
  ProjectManifest,
  Roster,
  VerificationContract,
  VerifierReport,
  WorkUnitState,
} from "./schemas";
import { verify } from "./verifier";

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
}): Decision {
  const { gatesConfigured, gatesOk, verdict, verification, n, maxAttempts, flakyUsed, maxFlaky, panelRequired } =
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
  const { agentJudged } = partitionAssertions(contract.assertions);
  // All-deterministic contract -> nothing for the panel to judge. Skip it
  // entirely, panelRequired false, so the green merged gates alone promote via
  // decide()'s gatesConfigured && gatesOk + skip + !panelRequired -> {done}
  // path. This is the zero-browser backend verify.
  if (agentJudged.length === 0) {
    return { verification: "skip", report: null, panelReport: null, panelRequired: false };
  }
  if (!target) {
    emit({ type: "panel", n: attempt.n, report: null });
    return { verification: "skip", report: null, panelReport: null, panelRequired: true };
  }
  try {
    const objective = readBundleFile(loom.id, "objective.md") ?? loom.prompt;
    const ctx: CriticContext = { featureName: loom.title, url: target, objective, assertions: agentJudged };

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
  opts?: { abort?: AbortController; run?: typeof agent },
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
    const panelRequired = partitionAssertions(contract.assertions).agentJudged.length > 0;
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
} | null> {
  const { contract } = readContract(loom.id);
  if (!contract) return null; // no bundle contract on the root

  // The verify slice. Default (M4 off / no subGoalId) = the cross-cutting
  // integration slice: assertions the assembled whole owns, no single SubGoal
  // (subGoalId === "ALL" OR unlabelled). A checkpoint (opts.subGoalId set)
  // re-scopes to exactly that subgoal's assertions.
  const allSlice = opts.subGoalId
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
  const target = opts.url ?? manifest.urls?.dev;

  // Evidence trail on the ROOT loom — additive, never touches child verdicts.
  const attempt: AttemptRecord = {
    n: (loom.attempts?.length ?? 0) + 1,
    role: "integration",
    model: policy.dev,
    startedAt: Date.now(),
  };
  loom.attempts.push(attempt);

  const { deterministic, agentJudged } = partitionAssertions(allSlice);

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
// LIVE-VALIDATION DEFERRED (M4 §8 item 3): only reached with the autoRepair
// master flag ON in a supervised run; unit tests drive runAutoRepair with a
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
  if (isolationEnabled(manifest) && loom.parentLoomId) {
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
    const { verification, report } = await runVerification(
      loom,
      manifest,
      attempt,
      emit,
      opts.accounts?.[manifest.account],
      url,
      { abort: opts.abort },
    );
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
  // Set true ONLY when the done-path fold lands the child's diff on the review
  // branch. Any other terminal (fold FAILED, fold never ran, needs-review/
  // failed/halted) leaves it false, so the finally snapshots the worktree's WIP
  // onto a durable recovery branch BEFORE removing the dir — work is never lost.
  let foldSucceeded = false;
  if (isolationEnabled(manifest) && loom.parentLoomId) {
    const baseSha = getLoom(loom.parentLoomId)?.baseSha;
    if (baseSha) {
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
      const { contract: routedContract } = readContract(loom.id);
      const deterministic = routedContract
        ? partitionAssertions(routedContract.assertions).deterministic
        : [];
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
      });

      if (decision.action === "done") {
        setState(terminalStateForCompletedLoom(loom));
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
          const snapped = await withWorktreeLock(() => snapshotWorktreeToBranch(defaultGitRunner, wt, branch));
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
