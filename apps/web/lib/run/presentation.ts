/**
 * What the run surfaces SAY, decided away from the components that say it.
 *
 * The interesting decisions here are not cosmetic. Which button a human is
 * offered ("Start" vs "Replace" vs "Release") is the difference between
 * launching a second server on a taken port and being told the port is taken;
 * whether a readiness dot is green is a claim about a process we may not be able
 * to attribute anything to. Both are folds over the status answer, both are
 * wrong in ways a screenshot will not show, so both are tested as functions.
 *
 * NOTHING HERE INVENTS AN OPTIMISTIC ANSWER. When the engine says `unknown`, the
 * cockpit says the same thing to the human: Telar lost contact, here is the pid
 * it last saw, you tell us. That is less satisfying than a spinner and it is the
 * only honest state.
 */

import type {
  RunConfigurationDraft,
  RunOutputAnswer,
  RunOutputLine,
  RunReadiness,
  RunStatus,
  RunStatusAnswer,
  RunView,
} from "./types";

/** Mirrors `MIN_SECRET_CHARS` in `apps/engine/src/run/types.ts`. The engine
 *  refuses a shorter secret at save time; this refuses it before the round trip
 *  so the editor can point at the field. The engine remains the authority. */
export const MIN_SECRET_CHARS = 4;

export type RunTone = "idle" | "working" | "good" | "bad" | "lost";

export function statusTone(status: RunStatus): RunTone {
  switch (status) {
    case "starting":
      return "working";
    case "running":
      return "working";
    case "ready":
      return "good";
    case "failed":
      return "bad";
    case "unknown":
      return "lost";
    case "exited":
      return "idle";
  }
}

/** Present tense for the states a human can still act on; past tense once the
 *  run is over, because "Running" on a dead process is the lie that makes people
 *  hunt for a server that is not there. */
export function statusLabel(view: RunView): string {
  switch (view.status) {
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "ready":
      return "Ready";
    case "failed":
      return "Failed";
    case "unknown":
      return "Lost contact";
    case "exited":
      return view.exitCode === undefined || view.exitCode === 0 ? "Exited" : `Exited (${view.exitCode})`;
  }
}

/** The one-line explanation under the status, or nothing when the status is
 *  already the whole story. Errors come from the engine already redacted. */
export function statusDetail(view: RunView): string | undefined {
  if (view.error) return view.error;
  if (view.status === "exited" && view.signal) return `Stopped by ${view.signal}.`;
  if (view.status === "failed" && view.exitCode !== undefined) return `Exited with code ${view.exitCode}.`;
  return undefined;
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

export type RunAction =
  | { kind: "start" }
  /** Something is deployed on the SAME tree: stopping it is the ordinary way
   *  to start a different configuration. */
  | { kind: "replace"; active: RunView }
  /** Deployed from a DIFFERENT tree — a takeover the human must mean, because
   *  the thing it replaces is somebody else's working state. */
  | { kind: "switch"; active: RunView; from: string }
  /** Nothing to signal safely; the slot is only freed by a human saying so. */
  | { kind: "release"; active: RunView }
  | { kind: "wait"; active: RunView };

/**
 * WHAT PRESSING THE BUTTON MEANS, given what is already deployed. The caller
 * renders one control; the label and the confirmation it needs come from here.
 */
export function runAction(answer: RunStatusAnswer): RunAction {
  const active = answer.active;
  if (!active) return { kind: "start" };
  if (active.status === "unknown") return { kind: "release", active };
  if (active.status === "starting") return { kind: "wait", active };
  const ours = answer.sessionWorktreePath;
  if (ours && active.worktreePath !== ours) return { kind: "switch", active, from: active.worktreePath };
  return { kind: "replace", active };
}

/** True when the live deployment came from a tree other than this session's —
 *  the fact that makes a run's output confusing if it is not stated. */
export function worktreeMismatch(answer: RunStatusAnswer): boolean {
  return runAction(answer).kind === "switch";
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

export type RunOutputBuffer = { lines: RunOutputLine[]; cursor: number; dropped: number };

export const emptyOutput: RunOutputBuffer = { lines: [], cursor: 0, dropped: 0 };

/**
 * Fold a poll into what is already on screen.
 *
 * THE CURSOR MOVING BACKWARDS MEANS A DIFFERENT RUN, not lost lines: a restart
 * mints a new run whose output starts at zero, and appending it to the previous
 * one would show two servers' logs as one. That case replaces rather than
 * appends. `dropped` is carried, not summed, because the engine reports the
 * total a run has discarded rather than a delta.
 */
export function appendOutput(buffer: RunOutputBuffer, answer: RunOutputAnswer, limit = 2000): RunOutputBuffer {
  const restarted = answer.cursor < buffer.cursor;
  const lines = restarted ? answer.lines : [...buffer.lines, ...answer.lines];
  return {
    lines: lines.length > limit ? lines.slice(lines.length - limit) : lines,
    cursor: answer.cursor,
    dropped: answer.dropped,
  };
}

/** What to say above a truncated log, so the gap is visible rather than a
 *  silently shorter history. */
export function droppedNotice(buffer: RunOutputBuffer): string | undefined {
  if (!buffer.dropped) return undefined;
  return `${buffer.dropped.toLocaleString()} earlier ${buffer.dropped === 1 ? "line" : "lines"} are no longer kept.`;
}

/** Newest first, which is how a run list reads. History from the engine is
 *  already ordered; this makes the component independent of that. */
export function recentRuns(answer: RunStatusAnswer, limit = 5): RunView[] {
  return [...answer.history].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
}
