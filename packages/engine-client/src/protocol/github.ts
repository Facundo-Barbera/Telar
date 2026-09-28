import { z } from "zod";
import { Id, Timestamp } from "./common";

export const GitHubUnavailable = z.enum([
  /** `gh` is not on PATH. Install it. */
  "not_installed",
  /** `gh` is there and nobody has logged in. `gh auth login`. */
  "not_authenticated",
  /** There is no git repository here — or one with no remotes at all. */
  "no_repository",
  "no_checkout",
  "not_github",
  /** `gh` answered with something this engine could not read: a version skew, a
   *  rate limit, an enterprise host behaving differently. The message is
   *  passed through rather than replaced. */
  "failed",
]);
export type GitHubUnavailable = z.infer<typeof GitHubUnavailable>;

export const GitHubLabel = z.object({ name: z.string(), color: z.string().optional() });
export type GitHubLabel = z.infer<typeof GitHubLabel>;

export const GitHubLink = z.object({
  number: z.number().int().positive(),
  url: z.string().min(1),
  repository: z.string().min(1).optional(),
});
export type GitHubLink = z.infer<typeof GitHubLink>;

const authorAvatarField = { authorAvatar: z.string().min(1).optional() };

export const GitHubIssueListState = z.enum(["open", "closed", "all"]);
export type GitHubIssueListState = z.infer<typeof GitHubIssueListState>;

export const GitHubPullListState = z.enum(["open", "closed", "merged", "all"]);
export type GitHubPullListState = z.infer<typeof GitHubPullListState>;

const forgeFilterFields = {
  /** A login, or `@me` — which `gh` resolves itself, so this cockpit never has to
   *  know who you are to ask "what is mine". */
  assignee: z.string().min(1).optional(),
  author: z.string().min(1).optional(),
  /** ANDed by `gh`: three labels means rows carrying all three. */
  labels: z.array(z.string().min(1)),
};

export const GitHubIssueFilter = z.object({
  state: GitHubIssueListState,
  milestone: z.string().min(1).optional(),
  ...forgeFilterFields,
});
export type GitHubIssueFilter = z.infer<typeof GitHubIssueFilter>;

export const GitHubPullFilter = z.object({
  state: GitHubPullListState,
  ...forgeFilterFields,
});
export type GitHubPullFilter = z.infer<typeof GitHubPullFilter>;

export const GitHubMilestone = z.object({
  title: z.string().min(1),
  /** How much is left in it, and how much is done. A milestone with nothing open
   *  is worth showing differently from one with forty. */
  open: z.number().int().nonnegative(),
  closed: z.number().int().nonnegative(),
});
export type GitHubMilestone = z.infer<typeof GitHubMilestone>;

export const GitHubFacets = z.object({
  /** The login `gh` is signed in as, so "assigned to me" can name the account it
   *  means rather than asking the reader to trust `@me`. */
  viewer: z.string().min(1).optional(),
  milestones: z.array(GitHubMilestone),
  labels: z.array(GitHubLabel),
  assignees: z.array(z.string()),
  readAt: Timestamp,
});
export type GitHubFacets = z.infer<typeof GitHubFacets>;

const forgeRowFields = {
  author: z.string().optional(),
  ...authorAvatarField,
  labels: z.array(GitHubLabel),
  /** Logins, not names: a bot has a login and no name. */
  assignees: z.array(z.string()),
  milestone: z.string().min(1).optional(),
  projects: z.array(z.string()),
  updatedAt: Timestamp,
  url: z.string().min(1),
};

export const GitHubIssue = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.string(),
  stateReason: z.string().min(1).optional(),
  linkedPulls: z.array(GitHubLink),
  ...forgeRowFields,
});
export type GitHubIssue = z.infer<typeof GitHubIssue>;

export const GitHubPullRequest = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  headRefName: z.string().optional(),
  /** GitHub's own word — `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED` —
   *  passed through rather than mapped, because the mapping is a display
   *  decision and three clients should not each invent one. */
  reviewDecision: z.string().optional(),
  mergedAt: Timestamp.optional(),
  linkedIssues: z.array(GitHubLink),
  ...forgeRowFields,
});
export type GitHubPullRequest = z.infer<typeof GitHubPullRequest>;

export const GitHubSnapshot = z.object({
  repository: z.string().min(1).optional(),
  issues: z.array(GitHubIssue),
  pulls: z.array(GitHubPullRequest),
  issueFilter: GitHubIssueFilter,
  pullFilter: GitHubPullFilter,
  projectsUnavailable: z.enum(["scope", "failed"]).optional(),
  unavailable: GitHubUnavailable.optional(),
  /** `gh`'s own words when it failed. Never invented here. */
  message: z.string().min(1).optional(),
  readAt: Timestamp,
});
export type GitHubSnapshot = z.infer<typeof GitHubSnapshot>;

// ── one issue, one pull request ─────────────────────────────────────────────

export const GitHubReactionContent = z.enum(["THUMBS_UP", "THUMBS_DOWN", "LAUGH", "HOORAY", "CONFUSED", "HEART", "ROCKET", "EYES"]);
export type GitHubReactionContent = z.infer<typeof GitHubReactionContent>;

export const GitHubSubjectId = z.string().regex(/^[A-Za-z0-9_=-]{1,200}$/);

export const GitHubReaction = z.object({
  content: z.string().min(1),
  count: z.number().int().positive(),
  viewerHasReacted: z.boolean(),
});
export type GitHubReaction = z.infer<typeof GitHubReaction>;

export const GitHubComment = z.object({
  author: z.string().optional(),
  ...authorAvatarField,
  authorAssociation: z.string().optional(),
  /** The comment as a reader should see it — the attribution marker removed.
   *  GitHub's renderer drops an HTML comment anyway; this matters for the
   *  surfaces that read raw text, like the head `github_status` hands a model. */
  body: z.string(),
  createdAt: Timestamp,
  minimized: z.boolean(),
  /** GitHub's reason, when it hid the comment. */
  minimizedReason: z.string().min(1).optional(),
  url: z.string().min(1),
  reactions: z.array(GitHubReaction).optional(),
  subjectId: GitHubSubjectId.optional(),
  attribution: z.object({ sessionId: Id }).optional(),
});
export type GitHubComment = z.infer<typeof GitHubComment>;

export const GitHubReview = z.object({
  author: z.string().optional(),
  ...authorAvatarField,
  /** `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`, `PENDING`. */
  state: z.string(),
  body: z.string(),
  submittedAt: Timestamp,
});
export type GitHubReview = z.infer<typeof GitHubReview>;

export const GitHubReviewComment = z.object({
  author: z.string().optional(),
  ...authorAvatarField,
  authorAssociation: z.string().optional(),
  body: z.string(),
  createdAt: Timestamp,
  url: z.string().min(1),
  /** Asked on the same read, so `[]` here is always an answer. */
  reactions: z.array(GitHubReaction),
  subjectId: GitHubSubjectId.optional(),
});
export type GitHubReviewComment = z.infer<typeof GitHubReviewComment>;

export const GitHubReviewThread = z.object({
  /** The node id resolving, unresolving and replying are written against. */
  id: GitHubSubjectId,
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
  startLine: z.number().int().positive().optional(),
  originalLine: z.number().int().positive().optional(),
  originalStartLine: z.number().int().positive().optional(),
  /** `LEFT` for the base side of the diff, `RIGHT` for the head. */
  diffSide: z.string().optional(),
  /** `LINE` or `FILE` — a comment on a whole file has no line at all. */
  subjectType: z.string().optional(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  resolvedBy: z.string().min(1).optional(),
  viewerCanResolve: z.boolean(),
  viewerCanUnresolve: z.boolean(),
  viewerCanReply: z.boolean(),
  diffHunk: z.string(),
  comments: z.array(GitHubReviewComment),
  /** Replies past the per-thread cap. Never silent, for `olderComments`' reason. */
  moreComments: z.number().int().nonnegative(),
});
export type GitHubReviewThread = z.infer<typeof GitHubReviewThread>;

export const GitHubCheck = z.object({
  name: z.string().min(1),
  /** `QUEUED`, `IN_PROGRESS`, `COMPLETED`. A commit status has no separate
   *  status, so a pending one reports `IN_PROGRESS` and a settled one
   *  `COMPLETED` — derived from its state rather than invented. */
  status: z.string(),
  conclusion: z.string().optional(),
  /** The workflow a check run belongs to. Several checks share a workflow name
   *  and `name` alone is often a bare word like `test`. */
  workflow: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
});
export type GitHubCheck = z.infer<typeof GitHubCheck>;

export const GitHubCheckLog = z.union([
  z.object({
    lines: z.array(z.string()),
    truncated: z.boolean(),
  }),
  z.object({ unavailable: z.string().min(1) }),
]);
export type GitHubCheckLog = z.infer<typeof GitHubCheckLog>;

export const GitHubIssueDetail = GitHubIssue.extend({
  body: z.string(),
  comments: z.array(GitHubComment),
  olderComments: z.number().int().nonnegative(),
  reactions: z.array(GitHubReaction).optional(),
  /** What a reaction on the issue itself is written against; see
   *  `GitHubComment.subjectId`. */
  subjectId: GitHubSubjectId.optional(),
  createdAt: Timestamp,
  closedAt: Timestamp.optional(),
  readAt: Timestamp,
});
export type GitHubIssueDetail = z.infer<typeof GitHubIssueDetail>;

/** The three ways GitHub can combine two branches. Not a preference the engine
 *  holds: a repository enables some subset of these, and asking for one it
 *  disabled is a refusal rather than a fallback to another. */
export const GitHubMergeMethod = z.enum(["merge", "squash", "rebase"]);
export type GitHubMergeMethod = z.infer<typeof GitHubMergeMethod>;

export const GitHubPullDetail = GitHubPullRequest.extend({
  body: z.string(),
  baseRefName: z.string().min(1).optional(),
  headRefOid: z.string().min(1).optional(),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  mergeMethods: z.array(GitHubMergeMethod),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
  comments: z.array(GitHubComment),
  /** Capped like an issue's, and for the same reason. */
  olderComments: z.number().int().nonnegative(),
  /** The pull request's own reactions, read like an issue's. */
  reactions: z.array(GitHubReaction).optional(),
  subjectId: GitHubSubjectId.optional(),
  reviewThreads: z.array(GitHubReviewThread).optional(),
  /** Threads past the cap. */
  moreReviewThreads: z.number().int().nonnegative().optional(),
  reviews: z.array(GitHubReview),
  /** The head commit's checks. Empty means no checks ran, which is different
   *  from every check passing — the surface says which. */
  checks: z.array(GitHubCheck),
  createdAt: Timestamp,
  mergedBy: z.string().min(1).optional(),
  readAt: Timestamp,
});
export type GitHubPullDetail = z.infer<typeof GitHubPullDetail>;

export const GitHubDetailUnavailable = z.enum([...GitHubUnavailable.options, "not_found"]);
export type GitHubDetailUnavailable = z.infer<typeof GitHubDetailUnavailable>;

const detailFailure = { unavailable: GitHubDetailUnavailable, message: z.string().min(1).optional() };

export const GitHubIssueRead = z.union([z.object({ issue: GitHubIssueDetail }), z.object(detailFailure)]);
export type GitHubIssueRead = z.infer<typeof GitHubIssueRead>;

export const GitHubPullRead = z.union([z.object({ pull: GitHubPullDetail }), z.object(detailFailure)]);
export type GitHubPullRead = z.infer<typeof GitHubPullRead>;

export const GitHubMergeRefusal = z.enum([
  /** Already merged, or closed. Nothing to do. */
  "not_open",
  /** The trees do not combine. Somebody has to rebase. */
  "conflicted",
  /** Required reviews or required checks are not satisfied. */
  "blocked",
  "head_moved",
  /** The repository does not allow that merge method. */
  "method_not_allowed",
  /** This account cannot merge here. */
  "not_permitted",
  /** Anything else. `message` is `gh`'s, never invented. */
  "failed",
]);
export type GitHubMergeRefusal = z.infer<typeof GitHubMergeRefusal>;

export const GitHubMergeResult = z.union([
  z.object({ merged: z.literal(true), pull: GitHubPullDetail }),
  z.object({ merged: z.literal(false), refusal: GitHubMergeRefusal, message: z.string().min(1).optional() }),
]);
export type GitHubMergeResult = z.infer<typeof GitHubMergeResult>;

// ── posting one comment ─────────────────────────────────────────────────────

export const MAX_COMMENT_BODY = 65_536;

export const GitHubCommentRefusal = z.enum([
  /** There is no issue or pull request with that number here. */
  "not_found",
  "invalid_body",
  /** Locked, archived, or this account cannot comment here. */
  "not_permitted",
  /** Anything else. `message` is `gh`'s, never invented. */
  "failed",
]);
export type GitHubCommentRefusal = z.infer<typeof GitHubCommentRefusal>;

export const GitHubCommentResult = z.union([
  z.object({ posted: z.literal(true), url: z.string().min(1), attribution: z.object({ sessionId: Id }) }),
  z.object({ posted: z.literal(false), refusal: GitHubCommentRefusal, message: z.string().min(1).optional() }),
]);
export type GitHubCommentResult = z.infer<typeof GitHubCommentResult>;

// ── reacting ───────────────────────────────────────────────────────────────

export const GitHubReactionRefusal = z.enum([
  /** The token lacks the scope to write here. */
  "scope",
  /** Locked, archived, or this account cannot react here. */
  "not_permitted",
  /** The thing reacted to is gone. */
  "not_found",
  /** Anything else. `message` is GitHub's own words, never invented. */
  "failed",
]);
export type GitHubReactionRefusal = z.infer<typeof GitHubReactionRefusal>;

export const GitHubReactionResult = z.union([
  z.object({ reacted: z.literal(true), reactions: z.array(GitHubReaction) }),
  z.object({ reacted: z.literal(false), refusal: GitHubReactionRefusal, message: z.string().min(1).optional() }),
]);
export type GitHubReactionResult = z.infer<typeof GitHubReactionResult>;

// ── acting on a review thread ──────────────────────────────────────────────

export const GitHubThreadRefusal = z.enum([...GitHubReactionRefusal.options, "invalid_body"]);
export type GitHubThreadRefusal = z.infer<typeof GitHubThreadRefusal>;

export const GitHubThreadReplyResult = z.union([
  z.object({ replied: z.literal(true), comment: GitHubReviewComment }),
  z.object({ replied: z.literal(false), refusal: GitHubThreadRefusal, message: z.string().min(1).optional() }),
]);
export type GitHubThreadReplyResult = z.infer<typeof GitHubThreadReplyResult>;

export const GitHubThreadResolveResult = z.union([
  z.object({
    changed: z.literal(true),
    isResolved: z.boolean(),
    resolvedBy: z.string().min(1).optional(),
    viewerCanResolve: z.boolean(),
    viewerCanUnresolve: z.boolean(),
  }),
  z.object({ changed: z.literal(false), refusal: GitHubThreadRefusal, message: z.string().min(1).optional() }),
]);
export type GitHubThreadResolveResult = z.infer<typeof GitHubThreadResolveResult>;

/** One `@@ -oldStart,oldLines +newStart,newLines @@` header, as numbers. */
export const DiffHunkRange = z.object({
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
});
export type DiffHunkRange = z.infer<typeof DiffHunkRange>;

export const GitHubPullAnchor = z.object({
  pull: z
    .object({
      number: z.number().int().positive(),
      url: z.string().min(1),
      headRefOid: z.string().min(1),
      baseRefName: z.string().min(1),
    })
    .optional(),
  head: z.string().min(1).optional(),
  dirty: z.array(z.string()),
  files: z.array(z.object({ path: z.string().min(1), hunks: z.array(DiffHunkRange) })),
});
export type GitHubPullAnchor = z.infer<typeof GitHubPullAnchor>;

export const GitHubLineSide = z.enum(["LEFT", "RIGHT"]);
export type GitHubLineSide = z.infer<typeof GitHubLineSide>;

/** A new review comment on one line or a range. `startLine`/`startSide` are
 *  present only for a range; `commitId` pins it to the head the reader saw. */
export const GitHubLineCommentInput = z.object({
  commitId: z.string().regex(/^[0-9a-f]{40}$/),
  path: z.string().min(1),
  line: z.number().int().positive(),
  side: GitHubLineSide,
  startLine: z.number().int().positive().optional(),
  startSide: GitHubLineSide.optional(),
  body: z.string(),
});
export type GitHubLineCommentInput = z.infer<typeof GitHubLineCommentInput>;

export const GitHubLineCommentRefusal = z.enum([...GitHubThreadRefusal.options, "stale"]);
export type GitHubLineCommentRefusal = z.infer<typeof GitHubLineCommentRefusal>;

export const GitHubLineCommentResult = z.union([
  z.object({ commented: z.literal(true), url: z.string().min(1) }),
  z.object({ commented: z.literal(false), refusal: GitHubLineCommentRefusal, message: z.string().min(1).optional() }),
]);
export type GitHubLineCommentResult = z.infer<typeof GitHubLineCommentResult>;

// ── opening one pull request ────────────────────────────────────────────────

/** How long a pull request's title may be. GitHub's own ceiling is 256; held
 *  here because the title travels as an argv string to `gh`. */
export const MAX_PULL_TITLE = 256;

export const GitHubPullCreateRefusal = z.enum([
  /** This branch is not on the remote yet. Push it first. */
  "not_pushed",
  /** A pull request for this branch is already open. `url` carries it. */
  "exists",
  /** The head branch and the base branch are the same, or the head has no
   *  commits the base does not — there would be nothing to review. */
  "nothing_to_compare",
  "invalid_title",
  /** This account cannot open a pull request here. */
  "not_permitted",
  /** Anything else. `message` is `gh`'s own words, never invented. */
  "failed",
]);
export type GitHubPullCreateRefusal = z.infer<typeof GitHubPullCreateRefusal>;

export const GitHubPullCreateResult = z.union([
  z.object({
    opened: z.literal(true),
    url: z.string().min(1),
    /** Absent when `gh` printed something this engine could not read as a
     *  number — the pull request IS open at that point, so the caller is told
     *  so and loses only the number. */
    number: z.number().int().positive().optional(),
    attribution: z.object({ sessionId: Id }),
  }),
  z.object({
    opened: z.literal(false),
    refusal: GitHubPullCreateRefusal,
    message: z.string().min(1).optional(),
    /** The pull request that already exists, when `gh` named it. */
    url: z.string().min(1).optional(),
  }),
]);
export type GitHubPullCreateResult = z.infer<typeof GitHubPullCreateResult>;

// ── the wire encoding of a filter ───────────────────────────────────────────

export function forgeQuery(options: { refresh?: boolean; issues?: GitHubIssueFilter; pulls?: GitHubPullFilter }): string {
  const query = new URLSearchParams();
  if (options.refresh) query.set("refresh", "1");
  if (options.issues) {
    query.set("issues", options.issues.state);
    if (options.issues.milestone) query.set("issueMilestone", options.issues.milestone);
    if (options.issues.assignee) query.set("issueAssignee", options.issues.assignee);
    if (options.issues.author) query.set("issueAuthor", options.issues.author);
    for (const label of options.issues.labels) query.append("issueLabel", label);
  }
  if (options.pulls) {
    query.set("pulls", options.pulls.state);
    if (options.pulls.assignee) query.set("pullAssignee", options.pulls.assignee);
    if (options.pulls.author) query.set("pullAuthor", options.pulls.author);
    for (const label of options.pulls.labels) query.append("pullLabel", label);
  }
  return query.size > 0 ? `?${query.toString()}` : "";
}

export function parseForgeQuery(params: URLSearchParams): { refresh: boolean; issues: GitHubIssueFilter; pulls: GitHubPullFilter } {
  const value = (name: string) => {
    const raw = params.get(name)?.trim();
    return raw ? raw : undefined;
  };
  const labels = (prefix: string) => params.getAll(`${prefix}Label`).filter((label) => label.trim().length > 0);
  const issueState = params.get("issues") ?? "open";
  const pullState = params.get("pulls") ?? "open";
  if (!["open", "closed", "all"].includes(issueState)) throw new Error("issue state must be open, closed or all");
  if (!["open", "closed", "merged", "all"].includes(pullState)) throw new Error("pull request state must be open, closed, merged or all");
  return {
    refresh: params.get("refresh") === "1",
    issues: {
      state: issueState as GitHubIssueFilter["state"],
      ...(value("issueMilestone") ? { milestone: value("issueMilestone")! } : {}),
      ...(value("issueAssignee") ? { assignee: value("issueAssignee")! } : {}),
      ...(value("issueAuthor") ? { author: value("issueAuthor")! } : {}),
      labels: labels("issue"),
    },
    pulls: {
      state: pullState as GitHubPullFilter["state"],
      ...(value("pullAssignee") ? { assignee: value("pullAssignee")! } : {}),
      ...(value("pullAuthor") ? { author: value("pullAuthor")! } : {}),
      labels: labels("pull"),
    },
  };
}
