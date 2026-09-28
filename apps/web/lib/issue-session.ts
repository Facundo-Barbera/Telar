/**
 * Issue → session: arms a worktree canvas via `?base=` and returns the issue reference to send.
 * It never creates a session; the first message does. The branch is derived by the engine.
 */
import type { GitOverview } from "@telar/engine-client";
import { issueReference } from "@/lib/drag-reference";
import { canvasHref } from "@/lib/session-list";

/** A canvas to open, or a reason to show; never a throw or an unexplained disabled control. */
export type IssueSessionStart =
  | {
      ok: true;
      /** The project's canvas with the worktree armed and the base named. */
      href: string;
      /** The same string the row's drag carries. */
      text: string;
      /** Returned so the control can name it. */
      baseRef: string;
    }
  | { ok: false; reason: string };

/**
 * Refuses only what the `projectGit` read can answer (disconnected drive, missing folder, not a
 * repo). Branch collisions and bad refs are the engine's to refuse at the cut.
 */
export function issueSessionStart(input: {
  issue: { number: number; title: string; url: string };
  projectId: string;
  projectName?: string;
  /** Carried into the canvas URL so a remote session's action stays on the remote. */
  hostId?: string;
  /** Absent means the read failed or has not returned, which is a refusal. */
  git?: GitOverview;
  unreadable?: string;
}): IssueSessionStart {
  const name = input.projectName ?? "this project";
  if (!input.git) {
    return {
      ok: false,
      reason: input.unreadable
        ? `Telar could not read ${name}'s checkout, so it did not cut a worktree. ${input.unreadable}`
        : `Telar could not read ${name}'s checkout, so it did not cut a worktree.`,
    };
  }
  // Disk before git, as `prepareSessionWorktree` does: a disconnected repo is still a repo.
  if (input.git.availability === "unmounted") {
    return { ok: false, reason: `The drive holding ${name} is not connected. Plug it back in and this will work again.` };
  }
  if (input.git.availability === "missing") {
    return { ok: false, reason: `The folder for ${name} is not on this machine any more, so there is nowhere to cut a worktree.` };
  }
  if (!input.git.repository) {
    // Barely reachable: with no repository there is no GitHub remote to list issues from.
    return { ok: false, reason: `${name} is not a git repository, so a session on #${input.issue.number} cannot have a worktree of its own.` };
  }
  // `?base=` is what arms the worktree; `defaultBase` matches the canvas's own default.
  const baseRef = input.git.defaultBase ?? "HEAD";
  return {
    ok: true,
    href: canvasHref(input.projectId, input.hostId, { baseRef }),
    text: issueReference(input.issue).text,
    baseRef,
  };
}
