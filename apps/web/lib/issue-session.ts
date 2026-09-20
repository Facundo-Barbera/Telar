/**
 * ISSUE → SESSION: where a new worktree session on an issue lands, or why it
 * cannot be cut — issue #695.
 *
 * WHY THIS ONE GESTURE EXISTS AT ALL, when there are no creation forms. The
 * Issues and Pull requests surfaces are here to be less bad than github.com's
 * lists at the one thing a panel can do better: sitting beside the conversation.
 * A form for filing an issue would be a worse github.com, and github.com is one
 * tab away in Telar's own browser. This is the other kind of thing entirely —
 * the panel's only durable advantage is that IT KNOWS ABOUT SESSIONS, and
 * "start work on this issue, in its own checkout, on its own branch" is the move
 * github.com structurally cannot make.
 *
 * IT ARMS A CANVAS; IT DOES NOT CREATE A SESSION. The first message is what
 * creates a session in Telar (session-cockpit's `submit`), and that rule is not
 * bent for this: a row action that minted a session on click would put a row in
 * the rail every time somebody pressed it to have a look, and a worktree on disk
 * with it. So what this returns is a canvas to open and the sentence to put in
 * its composer — the worktree is armed and the base is chosen, and the cut
 * happens when the person actually sends.
 *
 * NOTHING NEW IN THE URL. `?base=<ref>` is the mechanism the session menu's
 * "New session on <branch>" already uses, and the cockpit already honours it by
 * seeding the base AND flipping the mode to `worktree` (see `canvasHref` and the
 * `requestedBase` seed). Reusing it means this action needs no new canvas
 * vocabulary and no change to the cockpit at all.
 *
 * THE BRANCH IS NOT HERE, AND THAT IS THE POINT. It is derived from the session
 * title, which is derived from the first message, which is the issue reference
 * this returns — `derivedBranchFor` in the engine turns that into
 * `telar/<slug>-<id6>`, the convention this repository's branches already follow.
 * The `-<id6>` suffix is the engine's own disambiguation, so two sessions on one
 * issue cannot collide. There is deliberately no branch-naming decision in this
 * module to disagree with it.
 *
 * PURE, so every refusal below is testable without a component or a network.
 */
import type { GitOverview } from "@telar/engine-client";
import { issueReference } from "@/lib/drag-reference";
import { canvasHref } from "@/lib/session-list";

/**
 * Either a canvas to open, or a sentence to show. Never a thrown error and never
 * a disabled control with no explanation: #695's constraint is that this refuses
 * WITH THE REASON, and a button that goes grey says nothing about a cable.
 */
export type IssueSessionStart =
  | {
      ok: true;
      /** The project's canvas, with the worktree armed and the base named. */
      href: string;
      /** What goes into that canvas's composer — the same string the row's own
       *  drag carries, so the two gestures produce identical first messages. */
      text: string;
      /** What the worktree will be cut from. Returned so the control can say it
       *  out loud rather than making a promise only the URL knows about. */
      baseRef: string;
    }
  | { ok: false; reason: string };

/**
 * WHAT IS KNOWABLE BEFORE THE CUT, AND WHAT IS NOT.
 *
 * Three refusals are answerable from the `projectGit` read this takes: the drive
 * is not connected, the folder is gone, the directory is not a repository. Those
 * are the ones worth refusing HERE, because opening a canvas that cannot possibly
 * cut a worktree only moves the bad news behind a paragraph somebody has to write
 * first.
 *
 * The rest — a branch that collides, a base ref that does not resolve — are only
 * knowable AT the cut, by git, on send. They are the engine's to refuse, and it
 * does: `prepareSessionWorktree` raises each one as a sentence for a person and
 * the daemon now carries it across as a `400 invalid_request` rather than a 500
 * (see `errorFor`, #695). The composer prints it and gives the words back. So
 * this module deliberately does NOT re-implement them — a second vocabulary for
 * the same refusals is how the two start disagreeing.
 */
export function issueSessionStart(input: {
  issue: { number: number; title: string; url: string };
  projectId: string;
  /** What a person calls this project. The path is not what they call it. */
  projectName?: string;
  /** WHICH MAC — carried into the canvas URL so a remote session's action stays
   *  on the remote, exactly as every other link this app builds does. */
  hostId?: string;
  /** The project's checkout, as `projectGit` just answered it. Absent means the
   *  read failed or has not come back — which is a refusal, not a green light. */
  git?: GitOverview;
  /** What the engine said when that read failed, when it said anything. */
  unreadable?: string;
}): IssueSessionStart {
  const name = input.projectName ?? "this project";
  if (!input.git) {
    // The engine's own sentence when there is one: it knows why its read failed
    // and this module does not.
    return {
      ok: false,
      reason: input.unreadable
        ? `Telar could not read ${name}'s checkout, so it did not cut a worktree. ${input.unreadable}`
        : `Telar could not read ${name}'s checkout, so it did not cut a worktree.`,
    };
  }
  /**
   * THE DISK FIRST, BEFORE ANYTHING GIT — the same order `prepareSessionWorktree`
   * takes and for the same reason (#534): a repository in somebody's bag is still
   * a repository, and "this is not a git repository" is wrong about it in a way
   * that sends the reader looking for the wrong problem.
   */
  if (input.git.availability === "unmounted") {
    return { ok: false, reason: `The drive holding ${name} is not connected. Plug it back in and this will work again.` };
  }
  if (input.git.availability === "missing") {
    return { ok: false, reason: `The folder for ${name} is not on this machine any more, so there is nowhere to cut a worktree.` };
  }
  if (!input.git.repository) {
    // Barely reachable — a project with no repository has no GitHub remote either,
    // so this surface would have no issues to draw a row for. Spelled rather than
    // asserted away: the honest answer costs a line, and an unreachable arm that
    // throws is how an unreachable arm gets reached.
    return { ok: false, reason: `${name} is not a git repository, so a session on #${input.issue.number} cannot have a worktree of its own.` };
  }
  /**
   * THE BASE IS CHOSEN HERE RATHER THAN LEFT TO THE CANVAS, because `?base=` is
   * what arms the worktree — an armed mode with no ref is not something the URL
   * can say. `defaultBase` IS the canvas's own default for a fresh worktree
   * (`WhereThisLands` picks exactly this), and `HEAD` is what absent has always
   * meant, so naming it explicitly changes nothing and lets the control say it.
   */
  const baseRef = input.git.defaultBase ?? "HEAD";
  return {
    ok: true,
    href: canvasHref(input.projectId, input.hostId, { baseRef }),
    text: issueReference(input.issue).text,
    baseRef,
  };
}
