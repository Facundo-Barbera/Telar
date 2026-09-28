import type {
  GitHubCheck,
  GitHubComment,
  GitHubDetailUnavailable,
  GitHubMergeRefusal,
  GitHubPullCreateRefusal,
  GitHubPullDetail,
  GitHubReaction,
  GitHubReactionContent,
  GitHubReactionRefusal,
  GitHubReactionResult,
  GitHubReview,
  GitHubReviewComment,
  GitHubReviewThread,
  GitHubThreadRefusal,
  GitHubThreadReplyResult,
  GitHubThreadResolveResult,
  GitPushRefusal,
} from "@telar/engine-client";

export const AVATAR_PIXELS = 48;

export function avatarSrc(url: string): string {
  return `${url}?size=${AVATAR_PIXELS}`;
}

export function authorMonogram(login?: string): string {
  const first = login?.trim().replace(/^app\//, "").charAt(0);
  return first ? first.toUpperCase() : "?";
}

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
    title: "Not a repository",
    detail: "There is no git repository here — or one with no remotes at all — so there is nothing for gh to read.",
  },
  not_github: {
    title: "Not on GitHub",
    detail: "This repository's remote is not a GitHub host, so gh has nothing to show. Committing and pushing are unaffected.",
  },
  not_found: {
    title: "Not in this repository",
    detail: "GitHub has no such number here. It may live in another repository, or the tab may be older than the project it was opened in.",
  },
  no_checkout: {
    title: "Project folder not found",
    detail: "The project's folder is not on this machine, so GitHub cannot be asked about it.",
  },
  failed: { title: "gh could not answer", detail: "" },
};

export const MERGE_REFUSAL: Record<GitHubMergeRefusal, string> = {
  not_open: "There is nothing to merge — this pull request is already closed or merged.",
  conflicted: "The branches do not combine on their own. Somebody has to rebase or merge the base branch in first.",
  blocked: "GitHub is holding this one: a required review or a required check is not satisfied yet.",
  head_moved: "A commit landed on this branch after this page was read, so nothing was merged. Re-read it and look at what changed before merging.",
  method_not_allowed: "This repository does not allow that kind of merge. Try one of the other two.",
  not_permitted: "The account gh is signed in as cannot merge here.",
  failed: "GitHub refused, and not for a reason this cockpit recognises.",
};

export const PUSH_REFUSAL: Record<GitPushRefusal, string> = {
  not_repository: "This session's checkout is not a git repository, so there is nothing to push.",
  local_checkout: "This session works in the project's own checkout, which it shares with your editor. There is no session branch to publish.",
  no_remote: "This checkout has no origin, so there is nowhere to push it. Add a remote in a terminal and this becomes available.",
  not_session_branch: "The checkout is not on this session's own branch, so Telar will not push whatever is there instead.",
  nothing_to_push: "Nothing to push — the remote already has every commit on this branch.",
  not_permitted: "The credentials git uses on this machine cannot write to that repository.",
  rejected: "The remote has commits this branch does not. Pull or rebase in a terminal first — Telar will not force a push.",
  auth: "Git needed a credential and there was nobody to ask. Sign in the way you normally would in a terminal, then try again.",
  timeout: "The push did not finish in time and was stopped. The machine or the connection was busy; try it again.",
  failed: "Git refused, and not for a reason this cockpit recognises.",
};

export const PULL_CREATE_REFUSAL: Record<GitHubPullCreateRefusal, string> = {
  not_pushed: "This branch is not on the remote yet. Push it first, and this becomes available.",
  exists: "A pull request for this branch is already open.",
  nothing_to_compare: "There is nothing to review — this branch has no commits the base branch does not already have.",
  invalid_title: "A pull request needs a title.",
  not_permitted: "The account gh is signed in as cannot open a pull request here.",
  failed: "GitHub refused, and not for a reason this cockpit recognises.",
};

export type CheckSummary = {
  total: number;
  passed: number;
  failed: number;
  running: number;
  skipped: number;
  neutral: number;
};

const FAILING = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);

export function checkSummary(checks: readonly GitHubCheck[]): CheckSummary {
  const summary: CheckSummary = { total: checks.length, passed: 0, failed: 0, running: 0, skipped: 0, neutral: 0 };
  for (const check of checks) {
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

export type MergeReadiness = {
  canMerge: boolean;
  note?: string;
  caution?: boolean;
};

export function mergeReadiness(pull: Pick<GitHubPullDetail, "state" | "isDraft" | "mergeable" | "mergeStateStatus" | "baseRefName">): MergeReadiness {
  if (pull.state.toUpperCase() !== "OPEN") return { canMerge: false };
  if (pull.isDraft) return { canMerge: false, note: "This is still a draft. Mark it ready for review on GitHub first." };
  if (pull.mergeable.toUpperCase() === "CONFLICTING") {
    return { canMerge: false, note: `It conflicts with ${pull.baseRefName ?? "its base branch"} — somebody has to rebase.` };
  }
  switch (pull.mergeStateStatus.toUpperCase()) {
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
      return { canMerge: true, note: `GitHub has nothing holding this back from ${pull.baseRefName ?? "its base branch"}.` };
  }
}

export type ForgeStatus = "open" | "draft" | "merged" | "closed" | "completed" | "abandoned";

export function issueStatus(issue: { state: string; stateReason?: string }): ForgeStatus {
  if (issue.state.toUpperCase() !== "CLOSED") return "open";
  const reason = issue.stateReason?.toUpperCase();
  if (reason === "COMPLETED") return "completed";
  if (reason === "NOT_PLANNED" || reason === "DUPLICATE") return "abandoned";
  return "closed";
}

export function pullStatus(pull: { state: string; isDraft: boolean; mergedAt?: number }): ForgeStatus {
  const state = pull.state.toUpperCase();
  if (state === "MERGED" || pull.mergedAt) return "merged";
  if (state === "CLOSED") return "closed";
  return pull.isDraft ? "draft" : "open";
}

export function offersMerge(pull: { state: string; isDraft: boolean; mergedAt?: number }): boolean {
  return pullStatus(pull) === "open";
}

export const STATUS_LABEL: Record<ForgeStatus, string> = {
  open: "open",
  draft: "draft",
  merged: "merged",
  closed: "closed",
  completed: "closed · done",
  abandoned: "closed · not planned",
};

export const STATUS_TONE: Record<ForgeStatus, "active" | "done" | "none" | "info"> = {
  open: "active",
  draft: "none",
  merged: "done",
  closed: "none",
  completed: "done",
  abandoned: "none",
};

export type ForgeFilterChip = { key: string; label: string; clear: "milestone" | "assignee" | "author" | "label"; value?: string };

export function filterChips(filter: { milestone?: string; assignee?: string; author?: string; labels: readonly string[] }): ForgeFilterChip[] {
  const chips: ForgeFilterChip[] = [];
  if (filter.milestone) chips.push({ key: `m:${filter.milestone}`, label: filter.milestone, clear: "milestone" });
  if (filter.assignee) chips.push({ key: `a:${filter.assignee}`, label: `@${filter.assignee}`, clear: "assignee" });
  if (filter.author) chips.push({ key: `w:${filter.author}`, label: `by ${filter.author}`, clear: "author" });
  for (const label of filter.labels) chips.push({ key: `l:${label}`, label, clear: "label", value: label });
  return chips;
}

export function activeFilterCount(filter: { milestone?: string; assignee?: string; author?: string; labels: readonly string[] }): number {
  return filterChips(filter).length;
}

type ForgeEntryKind = "body" | "comment" | "review";

export type ForgeEntry = {
  id: string;
  kind: ForgeEntryKind;
  at: number;
  author?: string;
  avatar?: string;
  association?: string;
  state?: string;
  body: string;
  minimized?: boolean;
  minimizedReason?: string;
  url?: string;
  sessionId?: string;
  subjectId?: string;
  reactions?: readonly GitHubReaction[];
};

export function buildForgeTimeline(input: {
  body: string;
  author?: string;
  authorAvatar?: string;
  createdAt: number;
  comments: readonly GitHubComment[];
  reviews?: readonly GitHubReview[];
  reactions?: readonly GitHubReaction[];
  subjectId?: string;
}): ForgeEntry[] {
  const entries: ForgeEntry[] = input.comments.map((comment) => ({
    id: comment.url,
    kind: "comment" as const,
    at: comment.createdAt,
    ...(comment.author ? { author: comment.author } : {}),
    ...(comment.authorAvatar ? { avatar: comment.authorAvatar } : {}),
    ...(comment.authorAssociation && comment.authorAssociation !== "NONE" ? { association: comment.authorAssociation } : {}),
    body: comment.body,
    minimized: comment.minimized,
    ...(comment.minimizedReason ? { minimizedReason: comment.minimizedReason } : {}),
    url: comment.url,
    ...(comment.attribution ? { sessionId: comment.attribution.sessionId } : {}),
    ...(comment.reactions ? { reactions: comment.reactions } : {}),
    ...(comment.subjectId ? { subjectId: comment.subjectId } : {}),
  }));

  for (const [at, review] of (input.reviews ?? []).entries()) {
    if (!review.body.trim() && review.state.toUpperCase() === "COMMENTED") continue;
    entries.push({
      id: `review-${at}-${review.submittedAt}`,
      kind: "review",
      at: review.submittedAt,
      ...(review.author ? { author: review.author } : {}),
      ...(review.authorAvatar ? { avatar: review.authorAvatar } : {}),
      state: review.state,
      body: review.body,
    });
  }

  entries.sort((left, right) => left.at - right.at);
  return [
    {
      id: "body",
      kind: "body",
      at: input.createdAt,
      ...(input.author ? { author: input.author } : {}),
      ...(input.authorAvatar ? { avatar: input.authorAvatar } : {}),
      body: input.body,
      ...(input.reactions ? { reactions: input.reactions } : {}),
      ...(input.subjectId ? { subjectId: input.subjectId } : {}),
    },
    ...entries,
  ];
}

export const REACTIONS = [
  { content: "THUMBS_UP", glyph: "👍", label: "thumbs up" },
  { content: "THUMBS_DOWN", glyph: "👎", label: "thumbs down" },
  { content: "LAUGH", glyph: "😄", label: "laugh" },
  { content: "HOORAY", glyph: "🎉", label: "hooray" },
  { content: "CONFUSED", glyph: "😕", label: "confused" },
  { content: "HEART", glyph: "❤️", label: "heart" },
  { content: "ROCKET", glyph: "🚀", label: "rocket" },
  { content: "EYES", glyph: "👀", label: "eyes" },
] as const;

export function reactionPills(reactions: readonly GitHubReaction[]): (GitHubReaction & { glyph: string; label: string })[] {
  return REACTIONS.flatMap(({ content, glyph, label }) => {
    const held = reactions.find((reaction) => reaction.content === content);
    return held && held.count > 0 ? [{ ...held, glyph, label }] : [];
  });
}

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

export function toggleReaction(reactions: readonly GitHubReaction[], content: GitHubReactionContent, react: boolean): GitHubReaction[] {
  const held = reactions.find((reaction) => reaction.content === content);
  if (react === Boolean(held?.viewerHasReacted)) return [...reactions];
  if (!held) return [...reactions, { content, count: 1, viewerHasReacted: true }];
  const count = held.count + (react ? 1 : -1);
  return count <= 0
    ? reactions.filter((reaction) => reaction !== held)
    : reactions.map((reaction) => (reaction === held ? { content, count, viewerHasReacted: react } : reaction));
}

export const REACTION_REFUSAL: Record<GitHubReactionRefusal, string> = {
  scope: "Your GitHub sign-in can read here but not react. Run `gh auth refresh -s repo` in a terminal, then try again.",
  not_permitted: "GitHub will not take a reaction here — it may be locked or archived.",
  not_found: "That is gone from GitHub. Refresh to see what is there now.",
  failed: "GitHub did not take that reaction.",
};

export async function applyReaction(input: {
  current: readonly GitHubReaction[];
  content: GitHubReactionContent;
  react: boolean;
  send: () => Promise<GitHubReactionResult>;
  draw: (reactions: readonly GitHubReaction[]) => void;
}): Promise<string | undefined> {
  input.draw(toggleReaction(input.current, input.content, input.react));
  let result: GitHubReactionResult;
  try {
    result = await input.send();
  } catch (cause) {
    input.draw(input.current);
    return cause instanceof Error && cause.message ? cause.message : "The engine did not answer.";
  }
  if (result.reacted) {
    input.draw(result.reactions);
    return undefined;
  }
  input.draw(input.current);
  return REACTION_REFUSAL[result.refusal];
}

export type ThreadAnchor = { path: string; from?: number; to?: number; side: "base" | "head"; outdated: boolean; label: string };

export function threadAnchor(thread: GitHubReviewThread): ThreadAnchor {
  const side = thread.diffSide === "LEFT" ? "base" : "head";
  const current = thread.line !== undefined;
  const to = current ? thread.line : thread.originalLine;
  const from = current ? (thread.startLine ?? to) : (thread.originalStartLine ?? to);
  const outdated = thread.isOutdated || (!current && to !== undefined);
  if (thread.subjectType === "FILE" || to === undefined) return { path: thread.path, side, outdated, label: "file" };
  const span = from !== undefined && from < to ? `L${from}–${to}` : `L${to}`;
  return { path: thread.path, from: from ?? to, to, side, outdated, label: side === "base" ? `${span} (base)` : span };
}

export type HunkLine = { kind: "add" | "del" | "ctx"; text: string };

export function hunkTail(diffHunk: string, span = 1, context = 3): HunkLine[] {
  const lines = diffHunk.split(/\r?\n/).filter((line, index) => !(index === 0 && line.startsWith("@@")));
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines.slice(-(Math.max(1, span) + context)).map((line) => {
    const mark = line[0];
    if (mark === "+") return { kind: "add", text: line.slice(1) };
    if (mark === "-") return { kind: "del", text: line.slice(1) };
    return { kind: "ctx", text: mark === " " ? line.slice(1) : line };
  });
}

export function threadsByFile(threads: readonly GitHubReviewThread[]): { path: string; threads: GitHubReviewThread[] }[] {
  const files = new Map<string, GitHubReviewThread[]>();
  for (const thread of threads) files.set(thread.path, [...(files.get(thread.path) ?? []), thread]);
  return [...files.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, list]) => ({
      path,
      threads: [...list].sort((left, right) => (threadAnchor(left).to ?? 0) - (threadAnchor(right).to ?? 0)),
    }));
}

export const THREAD_REFUSAL: Record<GitHubThreadRefusal, string> = {
  scope: "Your GitHub sign-in can read here but not write. Run `gh auth refresh -s repo` in a terminal, then try again.",
  not_permitted: "GitHub will not take that here — the conversation may be locked, or this account cannot.",
  not_found: "That thread is gone from GitHub. Refresh to see what is there now.",
  invalid_body: "A reply needs something in it, and at most 65,536 characters.",
  failed: "GitHub did not take that.",
};

export async function applyThreadResolve(input: {
  current: GitHubReviewThread;
  resolved: boolean;
  send: () => Promise<GitHubThreadResolveResult>;
  draw: (thread: GitHubReviewThread) => void;
}): Promise<string | undefined> {
  const { current } = input;
  input.draw({ ...current, isResolved: input.resolved });
  let result: GitHubThreadResolveResult;
  try {
    result = await input.send();
  } catch (cause) {
    input.draw(current);
    return cause instanceof Error && cause.message ? cause.message : "The engine did not answer.";
  }
  if (!result.changed) {
    input.draw(current);
    return result.message && result.refusal === "failed" ? result.message : THREAD_REFUSAL[result.refusal];
  }
  const next: GitHubReviewThread = {
    ...current,
    isResolved: result.isResolved,
    viewerCanResolve: result.viewerCanResolve,
    viewerCanUnresolve: result.viewerCanUnresolve,
  };
  if (result.resolvedBy) next.resolvedBy = result.resolvedBy;
  else delete next.resolvedBy;
  input.draw(next);
  return undefined;
}

export const PENDING_REPLY_URL = "pending:";

export async function applyThreadReply(input: {
  current: GitHubReviewThread;
  body: string;
  author?: string;
  now: number;
  send: () => Promise<GitHubThreadReplyResult>;
  draw: (thread: GitHubReviewThread) => void;
}): Promise<string | undefined> {
  const { current } = input;
  const pending: GitHubReviewComment = {
    ...(input.author ? { author: input.author } : {}),
    body: input.body.trim(),
    createdAt: input.now,
    url: `${PENDING_REPLY_URL}${input.now}`,
    reactions: [],
  };
  input.draw({ ...current, comments: [...current.comments, pending] });
  let result: GitHubThreadReplyResult;
  try {
    result = await input.send();
  } catch (cause) {
    input.draw(current);
    return cause instanceof Error && cause.message ? cause.message : "The engine did not answer.";
  }
  if (!result.replied) {
    input.draw(current);
    return result.message && (result.refusal === "failed" || result.refusal === "invalid_body") ? result.message : THREAD_REFUSAL[result.refusal];
  }
  input.draw({ ...current, comments: [...current.comments, result.comment] });
  return undefined;
}
