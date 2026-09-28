import { z } from "zod";

type Refused<R> = { refusal: R; message?: string };

export type GitHubUnavailable = "not_installed" | "not_authenticated" | "no_repository" | "no_checkout" | "not_github" | "failed";

type GitHubLabel = { name: string; color?: string };

export type GitHubLink = { number: number; url: string; repository?: string };

type ForgeFilter = {
  /** A login, or `@me`, which `gh` resolves itself. */
  assignee?: string;
  author?: string;
  /** ANDed by `gh`. */
  labels: string[];
};

export type GitHubIssueFilter = ForgeFilter & { state: "open" | "closed" | "all"; milestone?: string };

export type GitHubPullFilter = ForgeFilter & { state: "open" | "closed" | "merged" | "all" };

export type GitHubMilestone = { title: string; open: number; closed: number };

export type GitHubFacets = { viewer?: string; milestones: GitHubMilestone[]; labels: GitHubLabel[]; assignees: string[]; readAt: number };

type ForgeRow = {
  number: number;
  title: string;
  state: string;
  author?: string;
  authorAvatar?: string;
  labels: GitHubLabel[];
  assignees: string[];
  milestone?: string;
  projects: string[];
  updatedAt: number;
  url: string;
};

export type GitHubIssue = ForgeRow & { stateReason?: string; linkedPulls: GitHubLink[] };

export type GitHubPullRequest = ForgeRow & {
  isDraft: boolean;
  headRefName?: string;
  /** GitHub's own word (`APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`), passed through unmapped. */
  reviewDecision?: string;
  mergedAt?: number;
  linkedIssues: GitHubLink[];
};

export type GitHubSnapshot = {
  repository?: string;
  issues: GitHubIssue[];
  pulls: GitHubPullRequest[];
  issueFilter: GitHubIssueFilter;
  pullFilter: GitHubPullFilter;
  projectsUnavailable?: "scope" | "failed";
  unavailable?: GitHubUnavailable;
  message?: string;
  readAt: number;
};

export const GitHubReactionContent = z.enum(["THUMBS_UP", "THUMBS_DOWN", "LAUGH", "HOORAY", "CONFUSED", "HEART", "ROCKET", "EYES"]);
export type GitHubReactionContent = z.infer<typeof GitHubReactionContent>;

export const GitHubSubjectId = z.string().regex(/^[A-Za-z0-9_=-]{1,200}$/);

export type GitHubReaction = { content: string; count: number; viewerHasReacted: boolean };

export type GitHubComment = {
  author?: string;
  authorAvatar?: string;
  authorAssociation?: string;
  /** With the attribution marker removed. */
  body: string;
  createdAt: number;
  minimized: boolean;
  minimizedReason?: string;
  url: string;
  reactions?: GitHubReaction[];
  subjectId?: string;
  attribution?: { sessionId: string };
};

export type GitHubReview = { author?: string; authorAvatar?: string; state: string; body: string; submittedAt: number };

export type GitHubReviewComment = {
  author?: string;
  authorAvatar?: string;
  authorAssociation?: string;
  body: string;
  createdAt: number;
  url: string;
  reactions: GitHubReaction[];
  subjectId?: string;
};

export type GitHubReviewThread = {
  id: string;
  path: string;
  line?: number;
  startLine?: number;
  originalLine?: number;
  originalStartLine?: number;
  /** `LEFT` for the base side of the diff, `RIGHT` for the head. */
  diffSide?: string;
  /** `LINE` or `FILE`. */
  subjectType?: string;
  isResolved: boolean;
  isOutdated: boolean;
  resolvedBy?: string;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  viewerCanReply: boolean;
  diffHunk: string;
  comments: GitHubReviewComment[];
  moreComments: number;
};

export type GitHubCheck = {
  name: string;
  /** `QUEUED`, `IN_PROGRESS` or `COMPLETED`; a commit status is mapped onto the same words. */
  status: string;
  conclusion?: string;
  workflow?: string;
  url?: string;
  jobId?: string;
};

export type GitHubCheckLog = { lines: string[]; truncated: boolean } | { unavailable: string };

export type GitHubIssueDetail = GitHubIssue & {
  body: string;
  comments: GitHubComment[];
  olderComments: number;
  reactions?: GitHubReaction[];
  subjectId?: string;
  createdAt: number;
  closedAt?: number;
  readAt: number;
};

export type GitHubMergeMethod = "merge" | "squash" | "rebase";

export type GitHubPullDetail = GitHubPullRequest & {
  body: string;
  baseRefName?: string;
  headRefOid?: string;
  mergeable: string;
  mergeStateStatus: string;
  mergeMethods: GitHubMergeMethod[];
  additions: number;
  deletions: number;
  changedFiles: number;
  comments: GitHubComment[];
  olderComments: number;
  reactions?: GitHubReaction[];
  subjectId?: string;
  reviewThreads?: GitHubReviewThread[];
  moreReviewThreads?: number;
  reviews: GitHubReview[];
  /** Empty means no checks ran, which differs from every check passing. */
  checks: GitHubCheck[];
  createdAt: number;
  mergedBy?: string;
  readAt: number;
};

export type GitHubDetailUnavailable = GitHubUnavailable | "not_found";

type DetailFailure = { unavailable: GitHubDetailUnavailable; message?: string };

export type GitHubIssueRead = { issue: GitHubIssueDetail } | DetailFailure;

export type GitHubPullRead = { pull: GitHubPullDetail } | DetailFailure;

export type GitHubMergeRefusal = "not_open" | "conflicted" | "blocked" | "head_moved" | "method_not_allowed" | "not_permitted" | "failed";

export type GitHubMergeResult = { merged: true; pull: GitHubPullDetail } | ({ merged: false } & Refused<GitHubMergeRefusal>);

export const MAX_COMMENT_BODY = 65_536;

export type GitHubCommentRefusal = "not_found" | "invalid_body" | "not_permitted" | "failed";

export type GitHubCommentResult =
  | { posted: true; url: string; attribution: { sessionId: string } }
  | ({ posted: false } & Refused<GitHubCommentRefusal>);

export type GitHubReactionRefusal = "scope" | "not_permitted" | "not_found" | "failed";

export type GitHubReactionResult = { reacted: true; reactions: GitHubReaction[] } | ({ reacted: false } & Refused<GitHubReactionRefusal>);

export type GitHubThreadRefusal = GitHubReactionRefusal | "invalid_body";

export type GitHubThreadReplyResult = { replied: true; comment: GitHubReviewComment } | ({ replied: false } & Refused<GitHubThreadRefusal>);

export type GitHubThreadResolveResult =
  | { changed: true; isResolved: boolean; resolvedBy?: string; viewerCanResolve: boolean; viewerCanUnresolve: boolean }
  | ({ changed: false } & Refused<GitHubThreadRefusal>);

/** One `@@ -oldStart,oldLines +newStart,newLines @@` header, as numbers. */
export type DiffHunkRange = { oldStart: number; oldLines: number; newStart: number; newLines: number };

export type GitHubPullAnchor = {
  pull?: { number: number; url: string; headRefOid: string; baseRefName: string };
  head?: string;
  dirty: string[];
  files: { path: string; hunks: DiffHunkRange[] }[];
};

export const GitHubLineSide = z.enum(["LEFT", "RIGHT"]);
export type GitHubLineSide = z.infer<typeof GitHubLineSide>;

/** `startLine`/`startSide` only for a range; `commitId` pins it to the head the reader saw. */
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

export type GitHubLineCommentRefusal = GitHubThreadRefusal | "stale";

export type GitHubLineCommentResult = { commented: true; url: string } | ({ commented: false } & Refused<GitHubLineCommentRefusal>);

/** Held below GitHub's own ceiling because the title travels as an argv string to `gh`. */
export const MAX_PULL_TITLE = 256;

export type GitHubPullCreateRefusal = "not_pushed" | "exists" | "nothing_to_compare" | "invalid_title" | "not_permitted" | "failed";

export type GitHubPullCreateResult =
  | { opened: true; url: string; number?: number; attribution: { sessionId: string } }
  | ({ opened: false; url?: string } & Refused<GitHubPullCreateRefusal>);
