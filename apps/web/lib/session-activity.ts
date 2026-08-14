/**
 * WHAT A SIDEBAR ROW SAYS ABOUT ITSELF, and how loudly.
 *
 * Ported from t3 code's `Sidebar.tsx`, where the sidebar is an inbox rather
 * than a list of links, and the whole design turns on one idea: A ROW'S VOLUME
 * SHOULD MATCH HOW MUCH IT WANTS FROM YOU. An active thread gets a card —
 * project, status, title, branch, provider — and a settled one collapses to a
 * single dim line. Same list, two densities, and the eye lands on the handful
 * of rows that are actually asking for something.
 *
 * WHAT OURS SAID BEFORE. Every row was the same two lines: title, then
 * "8h ago · project". True of everything, therefore useful about nothing — the
 * only thing you could scan for was recency, which is also the sort order, so
 * the line was restating the position. The two questions a person actually has
 * ("is one of these waiting on me", "is one still going") were unanswerable,
 * because the engine never sent the answer. It does now: `Session.activity`.
 *
 * A MODULE RATHER THAN INLINE JSX for the reason the Providers pane's is one:
 * what a status MEANS is a decision, and a decision made inside a render
 * function is one nothing can test and two surfaces can spell differently.
 */
import type { SessionActivity } from "@telar/engine-client";
import { fmtAgo } from "@/lib/format";

/**
 * The sentence, and the weight it carries.
 *
 * `blocked` IS THE ONLY ONE THAT GETS A COLOUR. Everything else is a fact about
 * the machine; this one is a request addressed to the reader, and if three
 * states are tinted then none of them is a signal. `working` earns emphasis
 * without hue — it is the difference between "going" and "stopped", which the
 * eye reads from weight alone.
 */
export type ActivityBadge = {
  label: string;
  /** `attention` is amber, `live` is plain foreground, `quiet` recedes. */
  tone: "attention" | "live" | "quiet";
  /** Whether to tick a duration beside the label. Only for states with a
   *  meaningful start; a queued turn's wait is not the reader's business. */
  ticking: boolean;
};

export function activityBadge(activity: SessionActivity): ActivityBadge | null {
  switch (activity) {
    case "blocked":
      // NOT "Blocked". The engine's word is about the turn; the row's word has
      // to be about the person, because they are the thing that unblocks it.
      return { label: "Waiting on you", tone: "attention", ticking: false };
    case "working":
      return { label: "Working", tone: "live", ticking: true };
    case "queued":
      return { label: "Queued", tone: "quiet", ticking: false };
    case "monitoring":
      /**
       * t3's own word for this, and the state that used to render as nothing:
       * a watch loop or a long shell outliving the turn that started it, with
       * the row reporting `idle` while it ran.
       *
       * QUIET AND TICKING, which no other state is. Quiet because nobody is
       * waiting on you and nothing is about to answer — but ticking, because
       * the one question a person has about a background watcher is how long
       * it has been going, and that is exactly what a still label cannot say.
       */
      return { label: "Monitoring", tone: "quiet", ticking: true };
    case "idle":
      // No badge at all — the row falls back to its timestamp. A "Idle" pill on
      // every resting row is chrome that says only "this row exists".
      return null;
  }
}

export const ACTIVITY_TONE: Record<ActivityBadge["tone"], string> = {
  /**
   * On the five-token vocabulary (app/globals.css), never a raw Tailwind ramp.
   *
   * `attention` IS `--warning` BY THE VOCABULARY'S OWN RULE — globals.css says
   * "Blocked folds into --warning on purpose: both mean a person has to move".
   * `live` is `--primary`, which is where t3 puts Working too: a running turn
   * should be visible from across the list, and plain foreground made it
   * indistinguishable from the timestamp it replaces.
   */
  attention: "text-warning",
  live: "text-primary",
  quiet: "text-muted-foreground",
};

/**
 * The right-hand slot's text: the status when there is one, the age otherwise.
 *
 * ONE SLOT, NOT TWO. t3 puts the status where the timestamp goes rather than
 * beside it, and that is the choice that keeps a card readable — a row showing
 * both "Working" and "8h ago" invites the question of which one is now, and the
 * answer ("both, about different things") is not worth the pixel.
 */
export function rowStatusText(
  session: { activity: SessionActivity; activityAt?: number; updatedAt: number },
  now: number,
): { badge: ActivityBadge | null; time: string } {
  const badge = activityBadge(session.activity);
  return { badge, time: fmtAgo(session.updatedAt, now) };
}

/**
 * "3m", "2h", "4d" — a duration, not a timestamp, and deliberately not
 * `fmtAgo`'s wording.
 *
 * "Working 3m ago" would be wrong in a way that matters: the work did not
 * happen 3 minutes ago, it started then and is still going. Seconds are shown
 * below a minute so a turn that just began does not read as `0m`.
 */
export function fmtDuration(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The line under the title on a card — WHERE THIS WORK LANDS — or nothing.
 *
 * ALWAYS THE BRANCH WHERE THERE IS ONE, which is t3's own correction: the plan
 * step used to take this slot while a thread worked, "but it truncated to a
 * half-sentence and dropped the branch, so the row lost its most stable
 * identifier".
 *
 * `null` IS A REAL ANSWER AND THE ONE THIS FUNCTION EXISTS FOR. Every t3 thread
 * runs in a worktree, so its card always has a branch to show; ours has local
 * sessions, which have nowhere else to land than the project — and the header
 * line above already says which project it is. The first version of this fell
 * back to the project name and rendered it twice on the same card, one line
 * apart. Caught by reading a row rather than by a test, because the code was
 * doing exactly what it said.
 *
 * So: a branch, else a workspace the header has NOT already named, else
 * nothing, and the row is two lines rather than three with an empty one.
 */
export function rowSubtitle(
  session: { worktreeBranch?: string; projectBranch?: string; projectName?: string; workspacePath: string },
  options: { projectShown: boolean } = { projectShown: false },
): { text: string; kind: "branch" | "project" | "path" } | null {
  if (session.worktreeBranch) return { text: session.worktreeBranch, kind: "branch" };
  // A LOCAL SESSION'S BRANCH IS ITS PROJECT'S, because it runs on that
  // checkout — which is what the composer's own footer has always shown. It is
  // still the answer to "where does this land", so it takes the same slot; the
  // difference is that it moves under the session's feet when somebody
  // switches branches, which is true and worth seeing.
  if (session.projectBranch) return { text: session.projectBranch, kind: "branch" };
  if (session.projectName) return options.projectShown ? null : { text: session.projectName, kind: "project" };
  // The leaf rather than the whole path: a sidebar column is ~220px, and an
  // absolute path truncates to its least distinctive half.
  const leaf = session.workspacePath.split("/").filter(Boolean).pop();
  return { text: leaf ?? session.workspacePath, kind: "path" };
}
