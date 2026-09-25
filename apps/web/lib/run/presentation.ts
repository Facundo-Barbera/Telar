/**
 * What the run surfaces SAY, decided away from the components that say it.
 *
 * The interesting decisions here are not cosmetic: whether a readiness dot is
 * green is a claim about a process we may not be able to attribute anything
 * to, and whether a label says "Running" is a claim about a terminal that may
 * have ended. Both are folds over the status answer, both are wrong in ways a
 * screenshot will not show, so both are tested as functions.
 *
 * A RUN IS A TERMINAL NOW ("Run = a new terminal"): a session has a LIST of
 * them, any number open at once, and pressing Run opens another. There is no
 * deployment slot, so there is no Replace, Switch or Release to choose from.
 */

import type {
  RunConfigurationDraft,
  RunReadiness,
  RunStatus,
  RunStatusAnswer,
  RunView,
} from "./types";

/** Mirrors `MIN_SECRET_CHARS` in `apps/engine/src/run/types.ts`. The engine
 *  refuses a shorter secret at save time; this refuses it before the round trip
 *  so the editor can point at the field. The engine remains the authority. */
export const MIN_SECRET_CHARS = 4;

export type RunTone = "idle" | "working" | "good" | "bad";

export function statusTone(status: RunStatus): RunTone {
  switch (status) {
    case "running":
      return "working";
    case "ready":
      return "good";
    case "failed":
      return "bad";
    case "exited":
    case "closed":
      return "idle";
  }
}

/** Present tense for the states a human can still act on; past tense once the
 *  terminal has ended, because "Running" on a dead process is the lie that
 *  makes people hunt for a server that is not there. */
export function statusLabel(view: RunView): string {
  switch (view.status) {
    case "running":
      return "Running";
    case "ready":
      return "Ready";
    case "failed":
      return "Failed";
    case "closed":
      return "Closed";
    case "exited":
      return view.exitCode === undefined || view.exitCode === 0 ? "Exited" : `Exited (${view.exitCode})`;
  }
}

/** The one-line explanation under the status, or nothing when the status is
 *  already the whole story. Errors come from the engine already redacted. */
export function statusDetail(view: RunView): string | undefined {
  if (view.error) return view.error;
  if (view.warning) return `${view.warning.charAt(0).toUpperCase()}${view.warning.slice(1)}.`;
  if (view.status === "closed") return view.closedBy === "agent" ? "Closed by the agent." : view.closedBy === "telar" ? "Closed by Telar." : "Closed.";
  if (view.status === "exited" && view.signal) return `Stopped by ${view.signal}.`;
  if (view.status === "failed" && view.exitCode !== undefined) return `Exited with code ${view.exitCode}.`;
  return undefined;
}

/** True while a terminal is open — what can still be closed, typed into or
 *  waited on. */
export function isOpenTerminal(view: RunView | undefined): boolean {
  return view?.status === "running" || view?.status === "ready";
}

/**
 * THE NEWEST OPEN TERMINAL, which is what the masthead summarises until the
 * Run control is redesigned around the whole list. `undefined` when none is
 * open.
 */
export function latestOpenTerminal(answer: RunStatusAnswer | undefined): RunView | undefined {
  // `?? []`: a paired Mac on an older engine answers without the list.
  return (answer?.terminals ?? []).find((run) => isOpenTerminal(run));
}

export function describeReadiness(readiness: RunReadiness, url?: string): string | undefined {
  switch (readiness.kind) {
    case "none":
      return undefined;
    case "pending":
      return url ? `Waiting for ${url} to answer.` : "Waiting for a first response.";
    case "ready":
      return url ? `${url} answered.` : "The readiness check answered.";
    case "unattributable":
      // Not a failure and not a success: something was already on that address
      // before this run started, so nothing it says afterwards is evidence
      // about this process. Saying "ready" here would be a guess.
      return readiness.reason;
  }
}

/** The last path segment, for a label; the full path stays in the title. */
export function worktreeLabel(path: string, branch?: string): string {
  const name = path.replace(/\/+$/, "").split("/").pop() || path;
  return branch ? `${name} (${branch})` : name;
}

export type DraftProblem = { field: "name" | "command" | "cwd" | "readinessUrl" | "env"; message: string };

/**
 * The same refusals the engine makes, made early enough to point at a field.
 * The two secret rules are not style: a value under four characters, or one
 * containing a line break, cannot be scrubbed out of captured output without
 * mangling unrelated text — so the engine will not accept it and neither will
 * this form. Telling somebody that AFTER they typed a password is worse.
 */
export function draftProblems(draft: RunConfigurationDraft): DraftProblem[] {
  const problems: DraftProblem[] = [];
  if (!draft.name.trim()) problems.push({ field: "name", message: "Give this configuration a name." });
  if (!draft.command.trim()) problems.push({ field: "command", message: "A configuration needs a command to run." });
  if (draft.cwd && draft.cwd.startsWith("/")) {
    problems.push({ field: "cwd", message: "The working directory is relative to the worktree, so it cannot start with “/”." });
  }
  if (draft.readinessUrl?.trim() && !/^https?:\/\//i.test(draft.readinessUrl.trim())) {
    problems.push({ field: "readinessUrl", message: "A readiness check must be an http:// or https:// address." });
  }
  const seen = new Set<string>();
  for (const entry of draft.env ?? []) {
    const key = entry.key.trim();
    if (!key) {
      problems.push({ field: "env", message: "An environment variable needs a name." });
      continue;
    }
    if (seen.has(key)) problems.push({ field: "env", message: `${key} is listed twice.` });
    seen.add(key);
    if (!entry.secret) continue;
    if (entry.value.length < MIN_SECRET_CHARS) {
      problems.push({
        field: "env",
        message: `${key} is marked secret, so it must be at least ${MIN_SECRET_CHARS} characters — a shorter value cannot be hidden from this run's output without mangling unrelated text.`,
      });
    }
    if (/[\r\n]/.test(entry.value)) {
      problems.push({ field: "env", message: `${key} is marked secret and contains a line break, which cannot be hidden from output.` });
    }
  }
  return problems;
}

export function draftIsSavable(draft: RunConfigurationDraft): boolean {
  return draftProblems(draft).length === 0;
}

/**
 * THE LINE BUFFER LEFT HERE WITH THE `<pre>` (#198).
 *
 * `appendOutput`, `emptyOutput`, `droppedNotice` and `RunOutputBuffer` folded a
 * `/run/output` poll into a list of lines on screen. Nothing in the cockpit
 * shows a list of lines any more — the panel draws the run's bytes in an
 * emulator, and the fold that shape needs is `lib/run/terminal-feed.ts`, where
 * "the cursor went backwards" has to mean `term.reset()` rather than a replaced
 * array.
 *
 * `/run/output` ITSELF IS NOT GONE and is not deprecated: `run_output` is an
 * agent tool, and an agent wants lines rather than a stream with `CSI H` in it.
 * What was removed is a client for it that no longer has a screen to draw on.
 */

/** Newest first, which is how a run list reads. The engine's list is already
 *  ordered; this makes the component independent of that. */
export function recentRuns(answer: RunStatusAnswer, limit = 5): RunView[] {
  return [...answer.terminals].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
}
