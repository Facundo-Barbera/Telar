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
import type { SessionActivity, SessionActivityDetail } from "@telar/engine-client";
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
  /** What the state means, in a sentence — shown on hover, because a word
   *  like "Background" or "Waiting" does not say what it is waiting on. */
  hint: string;
};

export function activityBadge(
  session: { activity: SessionActivity; activityDetail?: SessionActivityDetail },
  now = Date.now(),
): ActivityBadge | null {
  const detail = session.activityDetail;
  switch (session.activity) {
    case "blocked":
      // NOT "Blocked". The engine's word is about the turn; the row's word has
      // to be about the person, because they are the thing that unblocks it.
      return { label: "Waiting on you", tone: "attention", ticking: false, hint: "A question or an approval is waiting for your answer." };
    case "working":
      return { label: "Working", tone: "live", ticking: true, hint: "A turn is running." };
    case "queued":
      return { label: "Queued", tone: "quiet", ticking: false, hint: "A message is waiting for its turn to start." };
    case "monitoring": {
      /**
       * THE TURN HAS ENDED AND WORK IS STILL GOING — shells, monitors, and
       * sub-agents launched in the background. It used to say "Monitoring",
       * which named one of the three and hid how many; the count is the
       * question a person has ("is it still doing the four things I asked?").
       *
       * QUIET AND TICKING, which no other state is. Quiet because nobody is
       * waiting on you and nothing is about to answer — but ticking, because
       * the other question is how long it has been going, and that is exactly
       * what a still label cannot say.
       */
      const counts = detail?.kind === "background" ? detail : undefined;
      return {
        label: counts ? `Background (${counts.tasks})` : "Background",
        tone: "quiet",
        ticking: true,
        hint: counts ? `The turn has ended. ${backgroundBreakdown(counts)} still running in the background.` : "The turn has ended. Work it started is still running in the background.",
      };
    }
    case "waiting": {
      // NOT TICKING and no spinner: nothing here is moving. The session is
      // parked until another one answers, and the hint says which.
      const awaited = detail?.kind === "session" ? detail : undefined;
      const name = awaited?.title ? `“${awaited.title}”` : "another session";
      const more = awaited && awaited.sessions > 1 ? ` and ${awaited.sessions - 1} more` : "";
      return { label: "Waiting on session", tone: "quiet", ticking: false, hint: `Waiting on ${name}${more}. Its answer will wake this session.` };
    }
    case "scheduled": {
      const at = detail?.kind === "schedule" ? detail.at : undefined;
      return {
        label: at === undefined ? "Scheduled" : `Scheduled ${fmtWake(at, now)}`,
        tone: "quiet",
        ticking: false,
        hint: at === undefined ? "A schedule will wake this session." : `A schedule will wake this session ${fmtWakeLong(at, now)}.`,
      };
    }
    case "idle":
      // No badge at all — the row falls back to its timestamp. A "Idle" pill on
      // every resting row is chrome that says only "this row exists".
      return null;
  }
}

/** "2 agents and 1 process" — processes being shells and monitors alike. */
function backgroundBreakdown(counts: { tasks: number; agents: number }): string {
  const processes = counts.tasks - counts.agents;
  const parts = [
    ...(counts.agents > 0 ? [`${counts.agents} ${counts.agents === 1 ? "agent" : "agents"}`] : []),
    ...(processes > 0 ? [`${processes} ${processes === 1 ? "process" : "processes"}`] : []),
  ];
  const verb = counts.tasks === 1 ? "is" : "are";
  return `${parts.join(" and ")} ${verb}`;
}

/**
 * A wake time short enough for the row's one slot: the clock today, the
 * weekday within the week, the date after that.
 */
export function fmtWake(at: number, now: number): string {
  const when = new Date(at);
  const clock = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (new Date(now).toDateString() === when.toDateString()) return clock;
  if (at - now < 6 * 86_400_000) return `${when.toLocaleDateString(undefined, { weekday: "short" })} ${clock}`;
  return when.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The same instant in full, for the hint, where there is room. */
function fmtWakeLong(at: number, now: number): string {
  const when = new Date(at);
  const clock = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (new Date(now).toDateString() === when.toDateString()) return `at ${clock}`;
  return `on ${when.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })} at ${clock}`;
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
  session: { activity: SessionActivity; activityDetail?: SessionActivityDetail; activityAt?: number; updatedAt: number },
  now: number,
): { badge: ActivityBadge | null; time: string } {
  const badge = activityBadge(session, now);
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
  session: { worktreeBranch?: string; projectBranch?: string; projectName?: string; workspacePath?: string },
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
  // NO BRANCH, NO PROJECT AND NO PATH IS THE TWO-LINE ROW, not a third line
  // saying nothing — the same answer this function already gives a local
  // session whose project the header has named. It is what a session with no
  // checkout at all gets (`SessionWorkspace`'s `none` variant).
  if (!session.workspacePath) return null;
  // The leaf rather than the whole path: a sidebar column is ~220px, and an
  // absolute path truncates to its least distinctive half.
  const leaf = session.workspacePath.split("/").filter(Boolean).pop();
  return { text: leaf ?? session.workspacePath, kind: "path" };
}
