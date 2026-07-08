// Executor: the L1 stage loop — attempt, verify with gates, decide, retry.
// Pure w.r.t. persistence: mutates the run object and emits events; the caller
// persists via onState/onEvent. Retries resume the previous attempt's session.
import { agent } from "./engine";
import { runGates, type GateResult } from "./gates";
import type { AttemptRecord, Run, RunKind } from "./runs";
import { ModelPolicy, Verdict } from "./schemas";
import type { AccountProfile, ProjectManifest, WorkUnitState } from "./schemas";

export type ExecuteOpts = {
  policy?: ModelPolicy;
  accounts?: Record<string, AccountProfile>;
  maxAttempts?: number;
  abort?: AbortController;
  onEvent?: (ev: { type: string } & Record<string, unknown>) => void;
  onState?: (run: Run) => void;
};

const MAX_TURNS: Record<RunKind, number> = { quickfix: 50, story: 150, custom: 80 };
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

function retryPrompt(failing: GateResult[], verdict: Verdict | null, verdictWasNull: boolean): string {
  const parts: string[] = [];
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

export async function executeRun(
  run: Run,
  manifest: ProjectManifest,
  opts: ExecuteOpts = {},
): Promise<Run> {
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
        n === 1 ? firstPrompt(run, manifest) : retryPrompt(failing, lastVerdict, verdictWasNull);
      const verdict: Verdict | null = await agent(prompt, {
        schema: Verdict,
        cwd: manifest.root,
        model,
        maxTurns,
        tools,
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

      if (gatesConfigured && gateRun.ok) {
        if (verdict?.ok) {
          setState("done");
          return run;
        }
        if (verdict) {
          run.error = verdict.blocker;
          setState("needs-review");
          return run;
        }
        // Gates pass but the agent never reported — retry; exhausted = unconfirmed.
        if (n === maxAttempts) {
          run.error = "gates pass but agent never confirmed";
          setState("needs-review");
          return run;
        }
        continue;
      }

      if (!gatesConfigured) {
        // Nothing deterministically verified — never auto-done without gates.
        if (verdict?.ok) {
          setState("needs-review");
          return run;
        }
        if (n === maxAttempts) {
          run.error = verdict ? (verdict.blocker ?? verdict.summary) : "agent never reported a verdict";
          setState("failed");
          return run;
        }
        continue;
      }

      // Gates fail: retry; exhausted = failed.
      if (n === maxAttempts) {
        run.error = failing.map((r) => r.name).join(", ");
        setState("failed");
        return run;
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
