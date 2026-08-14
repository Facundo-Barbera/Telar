/**
 * WHAT GITHUB'S WORDS MEAN, decided once.
 *
 * The engine passes GitHub's own vocabulary through unmapped — `MERGEABLE`,
 * `BLOCKED`, `CHANGES_REQUESTED`, `TIMED_OUT` — on the stated grounds that
 * mapping it is a display decision and three clients should not each invent one.
 * This module is that decision, made in one place: which words are red, which
 * checks count as failing, and whether the merge button is allowed to be pressed.
 *
 * PURE AND FRAMEWORK-FREE, so every rule below is testable without a component.
 * The rules are the interesting part — `mergeReadiness` in particular is the
 * difference between a button that refuses and a button that tells you why it
 * would.
 */
import type {
  GitHubCheck,
  GitHubComment,
  GitHubDetailUnavailable,
  GitHubMergeRefusal,
  GitHubPullDetail,
  GitHubReview,
} from "@telar/engine-client";

/**
 * Why there is nothing to show, and what to do about it.
 *
 * FIVE SENTENCES RATHER THAN ONE. Four of them are the list surface's, and the
 * fifth only a detail read can produce. They need five different responses from a
 * reader, and the last of them — "there is no #999" — is the only one that is not
 * about the machine.
 */
export const UNAVAILABLE: Record<GitHubDetailUnavailable, { title: string; detail: string }> = {
  not_installed: {
    title: "The gh CLI is not installed",
    detail: "Telar reads GitHub through gh so it never has to hold a token. Install it and this fills in.",
  },
  not_authenticated: {
    title: "gh is not signed in",
    detail: "Run gh auth login on this machine. Sign-in lives outside Telar, the same as it does for Claude and Codex.",
  },
  no_repository: {
    title: "No GitHub remote",
    detail: "This project is not a GitHub repository, which is a perfectly ordinary thing for a project to be.",
  },
  not_found: {
    title: "Not in this repository",
    detail: "GitHub has no such number here. It may live in another repository, or the tab may be older than the project it was opened in.",
  },
  failed: { title: "gh could not answer", detail: "" },
};

/**
 * What a merge refusal means, and what to do next.
 *
 * SEVEN SENTENCES, because each has a different next move and only two of them
 * are "wait". Written to be read by the person who just pressed the button, so
 * each one names the actor: somebody rebases, review happens, you re-read.
 */
export const MERGE_REFUSAL: Record<GitHubMergeRefusal, string> = {
  not_open: "There is nothing to merge — this pull request is already closed or merged.",
  conflicted: "The branches do not combine on their own. Somebody has to rebase or merge the base branch in first.",
  blocked: "GitHub is holding this one: a required review or a required check is not satisfied yet.",
  head_moved: "A commit landed on this branch after this page was read, so nothing was merged. Re-read it and look at what changed before merging.",
  method_not_allowed: "This repository does not allow that kind of merge. Try one of the other two.",
  not_permitted: "The account gh is signed in as cannot merge here.",
  failed: "GitHub refused, and not for a reason this cockpit recognises.",
};

/** The five states a check can be in, from a reader's point of view. GitHub has
 *  nine words for them and only these five change what you do. */
export type CheckSummary = {
  total: number;
  passed: number;
  failed: number;
  /** Queued or in progress. Not "not failed" — the difference matters. */
  running: number;
  skipped: number;
  /** Neutral or cancelled: finished, not green, and not blocking. */
  neutral: number;
};

/**
 * `SKIPPED` IS NOT A PASS and `CANCELLED` IS NOT A FAILURE.
 *
 * A repository whose entire matrix skipped would otherwise report "12 passed",
 * which is the wrong answer to "did CI run". A cancelled run is a run somebody
 * stopped — it is neither a verdict nor a problem to fix, and counting it red
 * would put a failure badge on a pull request with nothing wrong with it.
 */
const FAILING = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);

export function checkSummary(checks: readonly GitHubCheck[]): CheckSummary {
  const summary: CheckSummary = { total: checks.length, passed: 0, failed: 0, running: 0, skipped: 0, neutral: 0 };
  for (const check of checks) {
    // An unfinished check has no conclusion, and its status is the only thing
    // that says so — a missing conclusion must never read as "not failed".
    if (check.status.toUpperCase() !== "COMPLETED" || !check.conclusion) {
      summary.running += 1;
      continue;
    }
    const conclusion = check.conclusion.toUpperCase();
    if (conclusion === "SUCCESS") summary.passed += 1;
    else if (FAILING.has(conclusion)) summary.failed += 1;
    else if (conclusion === "SKIPPED") summary.skipped += 1;
    else summary.neutral += 1;
  }
  return summary;
}

/** The one line a checks row shows. Empty when there are no checks, because "no
 *  checks ran" is a different fact from "everything passed" and the surface says
 *  that in its own words. */
export function checkHeadline(summary: CheckSummary): string {
  if (summary.total === 0) return "";
  const parts: string[] = [];
  if (summary.failed > 0) parts.push(`${summary.failed} failing`);
  if (summary.running > 0) parts.push(`${summary.running} running`);
  if (summary.passed > 0) parts.push(`${summary.passed} passed`);
  if (summary.skipped > 0) parts.push(`${summary.skipped} skipped`);
  if (summary.neutral > 0) parts.push(`${summary.neutral} neutral`);
  return parts.join(" · ");
}

/**
 * Whether the merge button may be pressed, and what it says either way.
 *
 * THE POINT IS TO REFUSE HERE, WITH A REASON, RATHER THAN AT GITHUB. Every state
 * below is one the engine or GitHub would also refuse; deciding it in front of
 * the reader turns a round trip and a red banner into a sentence under a disabled
 * button. The two states that are NOT refusals are the interesting ones:
 *
 *   - `UNKNOWN` means GitHub has not finished computing mergeability, which it
 *     does lazily on first ask. Refusing here would block the first merge of every
 *     quiet pull request. Pressing the button is what makes GitHub compute it.
 *   - `UNSTABLE` means checks are failing that nothing requires. GitHub allows
 *     that merge, so this does too — with the failure named, because a person
 *     merging over a red check should have to see it.
 */
export type MergeReadiness = {
  canMerge: boolean;
  /** What to say under the button. Absent when there is nothing to add. */
  note?: string;
  /** True when the merge is allowed but something is worth reading first. */
  caution?: boolean;
};

export function mergeReadiness(pull: Pick<GitHubPullDetail, "state" | "isDraft" | "mergeable" | "mergeStateStatus" | "baseRefName">): MergeReadiness {
  if (pull.state.toUpperCase() !== "OPEN") return { canMerge: false };
  if (pull.isDraft) return { canMerge: false, note: "This is still a draft. Mark it ready for review on GitHub first." };
  if (pull.mergeable.toUpperCase() === "CONFLICTING") {
    return { canMerge: false, note: `It conflicts with ${pull.baseRefName ?? "its base branch"} — somebody has to rebase.` };
  }
  switch (pull.mergeStateStatus.toUpperCase()) {
    // GitHub says draft in TWO fields — `isDraft` above and this one — and either
    // saying it is enough. Reading only the first would offer a merge GitHub
    // refuses if they ever disagreed.
    case "DRAFT":
      return { canMerge: false, note: "This is still a draft. Mark it ready for review on GitHub first." };
    case "DIRTY":
      return { canMerge: false, note: `It conflicts with ${pull.baseRefName ?? "its base branch"} — somebody has to rebase.` };
    case "BLOCKED":
      return { canMerge: false, note: "GitHub is holding this one: a required review or a required check is not satisfied." };
    case "BEHIND":
      return {
        canMerge: false,
        note: `${pull.baseRefName ?? "The base branch"} has moved on and this repository requires branches to be up to date.`,
      };
    case "UNSTABLE":
      return { canMerge: true, caution: true, note: "Checks are failing, but none of them are required. Merging is allowed." };
    case "UNKNOWN":
      return { canMerge: true, caution: true, note: "GitHub has not finished working out whether this merges. Pressing merge is what asks it." };
    case "HAS_HOOKS":
      return { canMerge: true, caution: true, note: "The repository runs a pre-receive hook on merge, which may still refuse." };
    default:
      return { canMerge: true };
  }
}

/**
 * WHAT STATUS A ROW IS IN, as one word and one glyph.
 *
 * SIX STATES, NOT TWO. A list that can show closed rows is a list where "open or
 * not" is the least interesting thing about a row: a merged pull request, one
 * somebody closed without merging, an issue completed and an issue abandoned are
 * four different outcomes, and GitHub gives each its own icon precisely because
 * the difference is what a reader is looking for.
 *
 * The names are this cockpit's; the DISTINCTIONS are GitHub's.
 */
export type ForgeStatus = "open" | "draft" | "merged" | "closed" | "completed" | "abandoned";

export function issueStatus(issue: { state: string; stateReason?: string }): ForgeStatus {
  if (issue.state.toUpperCase() !== "CLOSED") return "open";
  const reason = issue.stateReason?.toUpperCase();
  if (reason === "COMPLETED") return "completed";
  // `NOT_PLANNED` and `DUPLICATE` both mean "this is not getting done", which is a
  // different answer from "done" and the reason green is wrong for it.
  if (reason === "NOT_PLANNED" || reason === "DUPLICATE") return "abandoned";
  return "closed";
}

export function pullStatus(pull: { state: string; isDraft: boolean; mergedAt?: number }): ForgeStatus {
  const state = pull.state.toUpperCase();
  if (state === "MERGED" || pull.mergedAt) return "merged";
  if (state === "CLOSED") return "closed";
  // Draft is checked AFTER merged and closed: a draft that was closed is closed,
  // and calling it a draft would suggest it is still waiting for somebody.
  return pull.isDraft ? "draft" : "open";
}

/** The word under a row. Short enough for a 320px column, and never a repeat of
 *  what the glyph beside it already said in colour. */
export const STATUS_LABEL: Record<ForgeStatus, string> = {
  open: "open",
  draft: "draft",
  merged: "merged",
  closed: "closed",
  completed: "closed · done",
  abandoned: "closed · not planned",
};

/**
 * Which of the five colours a status wears.
 *
 * `merged` AND `completed` ARE THE SAME GREEN because they are the same fact —
 * this finished. `abandoned` and `closed` are grey: they finished too, and not by
 * being done. Nothing here is red, deliberately: a closed issue is not an error,
 * and spending the destructive colour on an ordinary outcome would leave nothing
 * for a failing check to say.
 */
export const STATUS_TONE: Record<ForgeStatus, "active" | "done" | "none" | "info"> = {
  open: "active",
  draft: "none",
  merged: "done",
  closed: "none",
  completed: "done",
  abandoned: "none",
};

/**
 * WHAT A FILTER IS NARROWING BY, as removable chips.
 *
 * A HIDDEN FILTER THAT RETURNS NOTHING LOOKS LIKE AN EMPTY REPOSITORY. That is the
 * failure this exists to prevent: choose a milestone, come back tomorrow, see zero
 * rows and conclude the project has no issues. Every narrowing beyond the state has
 * to be visible without opening the menu that set it, and removable where it sits.
 *
 * THE STATE IS NOT ONE OF THESE. It is always set to something, it is always shown
 * on the trigger, and there is no "no state" to clear it to — a chip for it would be
 * a chip that cannot be removed.
 */
export type ForgeFilterChip = { key: string; label: string; clear: "milestone" | "assignee" | "author" | "label"; value?: string };

export function filterChips(filter: { milestone?: string; assignee?: string; author?: string; labels: readonly string[] }): ForgeFilterChip[] {
  const chips: ForgeFilterChip[] = [];
  if (filter.milestone) chips.push({ key: `m:${filter.milestone}`, label: filter.milestone, clear: "milestone" });
  // `@me` is `gh`'s own token and reads as jargon on a chip; the surface passes the
  // viewer's login in so this can say who that is.
  if (filter.assignee) chips.push({ key: `a:${filter.assignee}`, label: `@${filter.assignee}`, clear: "assignee" });
  if (filter.author) chips.push({ key: `w:${filter.author}`, label: `by ${filter.author}`, clear: "author" });
  for (const label of filter.labels) chips.push({ key: `l:${label}`, label, clear: "label", value: label });
  return chips;
}

/** Whether anything beyond the state is narrowing the list — what the trigger shows
 *  a count for, so a collapsed menu still admits it is filtering. */
export function activeFilterCount(filter: { milestone?: string; assignee?: string; author?: string; labels: readonly string[] }): number {
  return filterChips(filter).length;
}

/**
 * ONE CONVERSATION, IN ORDER.
 *
 * The detail view used to draw three separate lists — the body, then every review,
 * then every comment — which is not how any of it happened. On a pull request where
 * a review answers a comment, the answer appeared in a different section, above the
 * thing it answered. A reader had to reconstruct the order themselves, from
 * timestamps, in a 320px column.
 *
 * So it is one timeline: the body, then comments and reviews interleaved by when
 * they were written. That is also what makes a CARD per entry worth having — with
 * three sections the boundaries were section headings; with one list the boundary
 * has to be the entry itself.
 */
export type ForgeEntryKind = "body" | "comment" | "review";

export type ForgeEntry = {
  /** Stable within one thread, for React and for nothing else. */
  id: string;
  kind: ForgeEntryKind;
  at: number;
  author?: string;
  /** GitHub's `OWNER` / `MEMBER` / `CONTRIBUTOR`, when it is worth a badge. */
  association?: string;
  /** A review's verdict. Absent on a body and on a comment. */
  state?: string;
  body: string;
  minimized?: boolean;
  minimizedReason?: string;
  url?: string;
};

export function buildForgeTimeline(input: {
  body: string;
  author?: string;
  createdAt: number;
  comments: readonly GitHubComment[];
  reviews?: readonly GitHubReview[];
}): ForgeEntry[] {
  const entries: ForgeEntry[] = input.comments.map((comment) => ({
    id: comment.url,
    kind: "comment" as const,
    at: comment.createdAt,
    ...(comment.author ? { author: comment.author } : {}),
    ...(comment.authorAssociation && comment.authorAssociation !== "NONE" ? { association: comment.authorAssociation } : {}),
    body: comment.body,
    minimized: comment.minimized,
    ...(comment.minimizedReason ? { minimizedReason: comment.minimizedReason } : {}),
    url: comment.url,
  }));

  for (const [at, review] of (input.reviews ?? []).entries()) {
    /**
     * AN EMPTY `COMMENTED` REVIEW IS NOT AN EVENT.
     *
     * GitHub creates one every time somebody leaves inline comments on the diff:
     * the review row exists to hold them and its own body is blank. Rendering those
     * puts "someone commented" cards with nothing in them through the middle of the
     * conversation. An empty APPROVED is kept, because who approved and when is the
     * whole content of an approval.
     */
    if (!review.body.trim() && review.state.toUpperCase() === "COMMENTED") continue;
    entries.push({
      id: `review-${at}-${review.submittedAt}`,
      kind: "review",
      at: review.submittedAt,
      ...(review.author ? { author: review.author } : {}),
      state: review.state,
      body: review.body,
    });
  }

  entries.sort((left, right) => left.at - right.at);
  /**
   * THE BODY IS ALWAYS FIRST, not sorted with the rest. It is the thing that opened
   * the thread by definition, and a repository where a bot comments in the same
   * second the issue is filed would otherwise be able to sort a reply above the
   * thing it replies to.
   */
  return [
    {
      id: "body",
      kind: "body",
      at: input.createdAt,
      ...(input.author ? { author: input.author } : {}),
      body: input.body,
    },
    ...entries,
  ];
}

/** GitHub's review vocabulary, in words a row has space for. An unfamiliar state
 *  is shown as GitHub sent it rather than dropped. */
export function reviewLabel(state: string): string {
  const labels: Record<string, string> = {
    APPROVED: "approved",
    CHANGES_REQUESTED: "requested changes",
    COMMENTED: "commented",
    DISMISSED: "dismissed",
    PENDING: "pending",
  };
  return labels[state.toUpperCase()] ?? state.toLowerCase().replaceAll("_", " ");
}
