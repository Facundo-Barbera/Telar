/**
 * vNext engine protocol v2 — GitHub, as the `gh` CLI reports it.
 *
 * NAMED FOR THE THING IT ACTUALLY IS. Not `Forge`, not `Issue`: these shapes are
 * whatever `gh issue list --json` and `gh pr list --json` hand back, and a
 * generic name would promise a GitLab implementation that does not exist and
 * would not have these fields. A second forge gets its own runner and its own
 * shapes; the panel surface is what they would share.
 *
 * NO CREDENTIALS CROSS THIS CONTRACT, deliberately and permanently. The engine
 * shells out to `gh`, which the user authenticated on this machine — the same
 * arrangement the cockpit already has with Claude Code and Codex, and stated in
 * the same place (settings → Providers: "sign-in lives outside Telar"). A token
 * field here would make Telar a credential store, which is a different product
 * with different obligations.
 */
import { z } from "zod";
import { Timestamp } from "./common";

/**
 * Why there is nothing to show, when there is nothing to show.
 *
 * FOUR DISTINCT ANSWERS, because they need four different responses from a
 * human and a single "unavailable" would send them to the wrong one. Collapsing
 * these was the failure mode of the frozen app's git pane, which reported every
 * shape of nothing as an empty list.
 */
export const GitHubUnavailable = z.enum([
  /** `gh` is not on PATH. Install it. */
  "not_installed",
  /** `gh` is there and nobody has logged in. `gh auth login`. */
  "not_authenticated",
  /** The project is not a git repository, or its remote is not GitHub. Nothing
   *  to fix — plenty of projects are neither. */
  "no_repository",
  /** `gh` answered with something this engine could not read: a version skew, a
   *  rate limit, an enterprise host behaving differently. The message is
   *  passed through rather than replaced. */
  "failed",
]);
export type GitHubUnavailable = z.infer<typeof GitHubUnavailable>;

export const GitHubLabel = z.object({ name: z.string(), color: z.string().optional() });
export type GitHubLabel = z.infer<typeof GitHubLabel>;

export const GitHubIssue = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.string(),
  author: z.string().optional(),
  labels: z.array(GitHubLabel),
  updatedAt: Timestamp,
  url: z.string().min(1),
});
export type GitHubIssue = z.infer<typeof GitHubIssue>;

export const GitHubPullRequest = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  author: z.string().optional(),
  /** The branch the PR is FROM. This is what lets a session recognise its own
   *  pull request: a worktree session's branch is `telar/<session>`, and the
   *  panel marks the row whose head matches. */
  headRefName: z.string().optional(),
  /** GitHub's own word — `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED` —
   *  passed through rather than mapped, because the mapping is a display
   *  decision and three clients should not each invent one. */
  reviewDecision: z.string().optional(),
  updatedAt: Timestamp,
  url: z.string().min(1),
});
export type GitHubPullRequest = z.infer<typeof GitHubPullRequest>;

/**
 * One read of a project's GitHub state.
 *
 * `unavailable` AND CONTENT ARE MUTUALLY EXCLUSIVE IN PRACTICE but not in the
 * type, on purpose: a rate-limited read can legitimately return the previous
 * page of issues alongside the reason the newest ones are missing, and a shape
 * that forbade that would force the engine to throw away data it has.
 */
export const GitHubSnapshot = z.object({
  /** The `owner/repo` this came from, so a panel can say which repository it is
   *  describing when a project has several remotes. */
  repository: z.string().min(1).optional(),
  issues: z.array(GitHubIssue),
  pulls: z.array(GitHubPullRequest),
  unavailable: GitHubUnavailable.optional(),
  /** `gh`'s own words when it failed. Never invented here. */
  message: z.string().min(1).optional(),
  /** When this was read. A network read is not live, and a surface that cannot
   *  say how old its answer is invites the reader to trust a stale one. */
  readAt: Timestamp,
});
export type GitHubSnapshot = z.infer<typeof GitHubSnapshot>;
