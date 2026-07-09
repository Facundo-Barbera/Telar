// Executor: the L1 stage loop — attempt, verify with gates, decide, retry.
// Pure w.r.t. persistence: mutates the run object and emits events; the caller
// persists via onState/onEvent. Retries resume the previous attempt's session.
import fs from "node:fs";
import path from "node:path";
import { agent } from "./engine";
import { runGates, type GateResult } from "./gates";
import { runDir, type AttemptRecord, type Run, type RunKind } from "./runs";
import { ModelPolicy, Verdict } from "./schemas";
import type { AccountProfile, ProjectManifest, VerifierReport, WorkUnitState } from "./schemas";
import { verify } from "./verifier";

export type ExecuteOpts = {
  policy?: ModelPolicy;
  accounts?: Record<string, AccountProfile>;
  maxAttempts?: number;
  abort?: AbortController;
  onEvent?: (ev: { type: string } & Record<string, unknown>) => void;
  onState?: (run: Run) => void;
};

const MAX_TURNS: Record<RunKind, number> = { quickfix: 50, story: 150, custom: 80, verify: 40 };
const BASE_TOOLS = ["Read", "Grep", "Glob", "Write", "Edit", "Bash"];

const tail = (s: string, n: number) => (s.length > n ? s.slice(-n) : s);

function firstPrompt(run: Run, manifest: ProjectManifest): string {
  const protectedPaths = manifest.guardrails.protectedPaths;
  return [
    `# ${run.title}`,
    run.prompt,
    protectedPaths.length
      ? `Guardrails: the following paths are absolutely forbidden to modify: ${protectedPaths.join(", ")}.`
      : "",
    "Make focused changes, verify your own work, and when done call emit_result with your Verdict (ok, summary, files_touched, blocker).",
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

// How the Verifier's run classifies. "skip" = not run / not applicable / errored;
// callers also pass "skip" when the builder never succeeded (nothing to verify).
export type Verification = "skip" | "pass" | "fail" | "flaky";

export type Decision =
  | { action: "done" }
  | { action: "needs-review"; error?: string }
  | { action: "failed"; error?: string }
  | { action: "retry" };

// Pure outcome function: given the attempt's gate/verdict/verification state,
// decide what to do. No side effects, no persistence. When verification ===
// "skip" the outcome is byte-identical to the pre-M2 behavior.
export function decide(input: {
  gatesConfigured: boolean;
  gatesOk: boolean;
  verdict: Verdict | null;
  verification: Verification;
  n: number;
  maxAttempts: number;
  flakyUsed: number;
  maxFlaky: number;
}): Decision {
  const { gatesConfigured, gatesOk, verdict, verification, n, maxAttempts, flakyUsed, maxFlaky } = input;
  const canRetry = n < maxAttempts;
  const flakyDecision = (): Decision =>
    flakyUsed < maxFlaky && canRetry ? { action: "retry" } : { action: "needs-review", error: "verification flaky" };

  if (gatesConfigured && gatesOk) {
    if (verdict?.ok) {
      // Deterministic gates + agent both green; the Verifier now gates promotion.
      switch (verification) {
        case "skip":
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
          return { action: "needs-review" }; // nothing verified — unchanged
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

// Drive the Verifier over the running app: attaches the report to the attempt,
// relativizes evidence paths, emits {type:"verifier"}, and classifies the run.
// Best-effort — a verify failure must never break the run (classifies "skip").
export async function runVerification(
  run: Run,
  manifest: ProjectManifest,
  attempt: AttemptRecord,
  emit: (ev: { type: string } & Record<string, unknown>) => void,
  account?: AccountProfile,
  url?: string,
): Promise<{ verification: Verification; report: VerifierReport | null }> {
  const target = url ?? manifest.urls?.dev;
  if (!run.acceptanceCriteria?.length || !target) return { verification: "skip", report: null };
  try {
    const evidenceDir = path.join(runDir(run.id), "evidence");
    let designGuidelines: string | undefined;
    if (manifest.designRules) {
      try {
        designGuidelines = fs.readFileSync(path.join(manifest.root, manifest.designRules), "utf8");
      } catch {
        // best-effort: missing/unreadable design-rules file never breaks the run
      }
    }
    const report = await verify(
      { name: run.title, acceptanceCriteria: run.acceptanceCriteria },
      { url: target, evidenceDir, account, headless: true, designGuidelines },
    );
    if (!report) {
      emit({ type: "verifier", n: attempt.n, report: null });
      return { verification: "skip", report: null };
    }
    // Rewrite absolute evidence paths under evidenceDir to relative so the UI
    // can serve them via /api/runs/<id>/evidence/<relpath>.
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
    return { verification: classify(report), report };
  } catch (err) {
    emit({ type: "verifier-error", message: err instanceof Error ? err.message : String(err) });
    return { verification: "skip", report: null };
  }
}

// Pure outcome function for a verify run: no builder loop, so the mapping
// from Verification to a terminal WorkUnitState is direct — no retries.
export function decideVerifyRun(v: Verification): { state: WorkUnitState; error?: string } {
  switch (v) {
    case "pass":
      return { state: "done" };
    case "fail":
      return { state: "needs-review", error: "verification failed" };
    case "flaky":
      return { state: "needs-review", error: "verification flaky" };
    case "skip":
      return { state: "needs-review", error: "nothing verified" };
  }
}

// Read-only run: drives verify() against run.target with no builder attempt.
// runVerification already returns "skip" when the target URL or acceptance
// criteria are missing, so a misconfigured verify run lands needs-review
// cleanly rather than crashing.
async function executeVerifyRun(run: Run, manifest: ProjectManifest, opts: ExecuteOpts = {}): Promise<Run> {
  const emit = (ev: { type: string } & Record<string, unknown>) => opts.onEvent?.(ev);
  const setState = (s: WorkUnitState) => {
    run.state = s;
    emit({ type: "state", state: s });
    opts.onState?.(run);
  };
  const isAborted = () => opts.abort?.signal.aborted === true;
  const halt = () => {
    setState("halted");
    return run;
  };

  try {
    if (isAborted()) return halt();

    const targetKey = run.target ?? "dev";
    const url = manifest.urls?.[targetKey];
    const policy = opts.policy ?? ModelPolicy.parse({});

    const attempt: AttemptRecord = { n: 1, role: "verifier", model: policy.dev, startedAt: Date.now() };
    run.attempts.push(attempt);
    opts.onState?.(run);

    setState("verifying");
    const { verification, report } = await runVerification(
      run,
      manifest,
      attempt,
      emit,
      opts.accounts?.[manifest.account],
      url,
    );
    attempt.endedAt = Date.now();
    opts.onState?.(run);

    if (isAborted()) return halt();

    const d = decideVerifyRun(verification);
    if (d.error) run.error = report?.summary ? `${d.error}: ${report.summary}` : d.error;
    setState(d.state);
    return run;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      if (isAborted()) return halt();
      emit({ type: "error", message });
      run.error = message;
      setState("failed");
    } catch {
      run.state = isAborted() ? "halted" : "failed";
      if (run.state === "failed") run.error ??= message;
    }
    return run;
  }
}

export async function executeRun(
  run: Run,
  manifest: ProjectManifest,
  opts: ExecuteOpts = {},
): Promise<Run> {
  if (run.kind === "verify") return executeVerifyRun(run, manifest, opts);
  const policy = opts.policy ?? ModelPolicy.parse({});
  // Clamp: <= 0 would skip the loop and resolve a still-"queued" run.
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const maxTurns = MAX_TURNS[run.kind];
  const tools = BASE_TOOLS.filter((t) => !manifest.guardrails.disallowedTools.includes(t));

  const emit = (ev: { type: string } & Record<string, unknown>) => opts.onEvent?.(ev);
  const setState = (s: WorkUnitState) => {
    run.state = s;
    emit({ type: "state", state: s });
    opts.onState?.(run);
  };
  const isAborted = () => opts.abort?.signal.aborted === true;
  const halt = () => {
    setState("halted");
    return run;
  };

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
      const resume = run.attempts[run.attempts.length - 1]?.sessionId;

      setState("running");
      emit({ type: "attempt", n, role, model });
      const attempt: AttemptRecord = { n, role, model, startedAt: Date.now() };
      run.attempts.push(attempt);
      opts.onState?.(run);

      const prompt: string =
        n === 1
          ? firstPrompt(run, manifest)
          : retryPrompt(failing, lastVerdict, verdictWasNull, verifierRepair || undefined);
      const verdict: Verdict | null = await agent(prompt, {
        schema: Verdict,
        cwd: manifest.root,
        model,
        maxTurns,
        tools,
        disallowedTools: manifest.guardrails.disallowedTools,
        settingSources: ["project", "local"],
        account: opts.accounts?.[manifest.account],
        abort: opts.abort,
        ...(resume ? { resume } : {}),
        onEvent: (e) => {
          if (e.type === "session") {
            attempt.sessionId = e.sessionId;
            emit({ type: "session", sessionId: e.sessionId });
            opts.onState?.(run);
          } else if (e.type === "text") {
            emit({ type: "text", text: e.text });
          } else if (e.type === "tool") {
            emit({ type: "tool", name: e.name });
          } else if (e.type === "result") {
            attempt.costUsd = e.costUsd;
            emit({ type: "agent-result", subtype: e.subtype, costUsd: e.costUsd, turns: e.turns });
            opts.onState?.(run);
          }
        },
      });

      if (isAborted()) {
        attempt.endedAt = Date.now();
        return halt();
      }

      setState("verifying");
      const gateRun = await runGates(manifest.gates, manifest.root, (r) => emit({ type: "gate", result: r }));
      attempt.gates = gateRun.results;
      attempt.verdict = verdict;
      attempt.endedAt = Date.now();
      if (verdict) emit({ type: "verdict", verdict });
      opts.onState?.(run);

      if (isAborted()) return halt();

      const gatesConfigured = manifest.gates.length > 0;
      failing = gateRun.results.filter((r) => !r.ok);
      lastVerdict = verdict;
      verdictWasNull = verdict === null;

      // Drive the Verifier only when the builder succeeded — otherwise there is
      // nothing to verify and verification stays "skip" (no verify call).
      const builderOk = verdict?.ok === true && (gatesConfigured ? gateRun.ok : true);
      let verification: Verification = "skip";
      let report: VerifierReport | null = null;
      if (builderOk) {
        const vr = await runVerification(run, manifest, attempt, emit, opts.accounts?.[manifest.account]);
        verification = vr.verification;
        report = vr.report;
      }

      if (isAborted()) return halt();

      const decision = decide({
        gatesConfigured,
        gatesOk: gateRun.ok,
        verdict,
        verification,
        n,
        maxAttempts,
        flakyUsed,
        maxFlaky,
      });

      if (decision.action === "done") {
        setState("done");
        return run;
      }
      if (decision.action === "needs-review") {
        if (gatesConfigured && gateRun.ok && verdict && !verdict.ok) run.error = verdict.blocker;
        else if (verification === "fail") run.error = `verification failed: ${report?.summary ?? ""}`;
        else if (decision.error !== undefined) run.error = decision.error;
        setState("needs-review");
        return run;
      }
      if (decision.action === "failed") {
        run.error =
          gatesConfigured && !gateRun.ok
            ? failing.map((r) => r.name).join(", ")
            : verdict
              ? (verdict.blocker ?? verdict.summary)
              : "agent never reported a verdict";
        setState("failed");
        return run;
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
    return run; // unreachable: the last attempt always returns above
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Callbacks (onEvent/onState) may be the very thing that threw (e.g. a
    // full disk behind persistence) — never let a second throw reject.
    try {
      if (isAborted()) return halt();
      emit({ type: "error", message });
      run.error = message;
      setState("failed");
    } catch {
      run.state = isAborted() ? "halted" : "failed";
      if (run.state === "failed") run.error ??= message;
    }
    return run;
  }
}
