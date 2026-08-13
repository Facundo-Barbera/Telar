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

/**
 * Which rows a list read asks for.
 *
 * TWO ENUMS, NOT ONE, because `merged` is not a state an issue can be in and
 * offering it would put a filter on the Issues surface that always returns
 * nothing. These are `gh`'s own words for its `--state` flag.
 */
export const GitHubIssueListState = z.enum(["open", "closed", "all"]);
export type GitHubIssueListState = z.infer<typeof GitHubIssueListState>;

export const GitHubPullListState = z.enum(["open", "closed", "merged", "all"]);
export type GitHubPullListState = z.infer<typeof GitHubPullListState>;

/**
 * The fields a LIST row carries, beyond its number and title.
 *
 * WHAT IS HERE IS WHAT A ROW CAN SHOW WITHOUT A SECOND READ. Status, who it is
 * assigned to, which milestone, which board — the questions somebody scanning a
 * list is actually asking, and every one of them a field `gh` returns alongside
 * the title for free.
 *
 * WHAT IS DELIBERATELY ABSENT IS A COMMENT COUNT. `gh` has no count field: asking
 * for `comments` returns every comment BODY for every row, which measured at
 * 245KB and 2.81s against a fifty-issue repository versus 0.56s without — five
 * times the read for a number nobody asked for. The thread is one click away.
 */
const forgeRowFields = {
  author: z.string().optional(),
  labels: z.array(GitHubLabel),
  /** Logins, not names: a bot has a login and no name. */
  assignees: z.array(z.string()),
  milestone: z.string().min(1).optional(),
  /**
   * The boards this is on, by title.
   *
   * READ BY ITS OWN `gh` CALL, because `projectItems` needs the `read:project`
   * scope and a token without it fails the WHOLE query rather than that field —
   * measured, and the reason the list would otherwise go blank for anybody on a
   * default token. Empty means "no boards" OR "could not ask"; the snapshot's
   * `projectsUnavailable` is what tells those apart.
   */
  projects: z.array(z.string()),
  updatedAt: Timestamp,
  url: z.string().min(1),
};

export const GitHubIssue = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.string(),
  /** Why it closed — `COMPLETED`, `NOT_PLANNED`, `DUPLICATE`. On the ROW as well
   *  as the detail, because a list that includes closed issues is a list where
   *  "was this done?" is the question every row raises. */
  stateReason: z.string().min(1).optional(),
  ...forgeRowFields,
});
export type GitHubIssue = z.infer<typeof GitHubIssue>;

export const GitHubPullRequest = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  /** The branch the PR is FROM. This is what lets a session recognise its own
   *  pull request: a worktree session's branch is `telar/<session>`, and the
   *  panel marks the row whose head matches. */
  headRefName: z.string().optional(),
  /** GitHub's own word — `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED` —
   *  passed through rather than mapped, because the mapping is a display
   *  decision and three clients should not each invent one. */
  reviewDecision: z.string().optional(),
  /** Set when it landed. `state: "MERGED"` says the same thing, and this says
   *  WHEN — which is what a row full of closed pull requests is sorted by. */
  mergedAt: Timestamp.optional(),
  ...forgeRowFields,
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
  /** WHICH ROWS THIS IS, echoed back. A surface showing forty closed issues must
   *  be able to say so; without this it would have to trust that the answer
   *  matches the filter it last sent, which a cache makes untrue. */
  issueState: GitHubIssueListState,
  pullState: GitHubPullListState,
  /**
   * Why the board column is empty, when it is.
   *
   * `scope` is the common one and is not a failure of anything else: the default
   * `gh` token has no `read:project`, so this cockpit asks in a call of its own and
   * carries the reason rather than showing every row as "on no boards".
   */
  projectsUnavailable: z.enum(["scope", "failed"]).optional(),
  unavailable: GitHubUnavailable.optional(),
  /** `gh`'s own words when it failed. Never invented here. */
  message: z.string().min(1).optional(),
  /** When this was read. A network read is not live, and a surface that cannot
   *  say how old its answer is invites the reader to trust a stale one. */
  readAt: Timestamp,
});
export type GitHubSnapshot = z.infer<typeof GitHubSnapshot>;

// ── one issue, one pull request ─────────────────────────────────────────────

/**
 * One comment.
 *
 * `minimized` IS CARRIED RATHER THAN DROPPED, and it is not a nicety: GitHub
 * hides comments as spam, abuse or off-topic, and a reader who sees one rendered
 * in full beside the real ones has been shown something the repository decided
 * to hide. So the flag travels and the surface collapses it, which is what
 * GitHub itself does.
 *
 * NO `id`. `url` is unique, non-empty and already here; a second identifier
 * would be one more field to keep true for no reader.
 */
export const GitHubComment = z.object({
  author: z.string().optional(),
  /** GitHub's own word for how the author relates to the repository — `OWNER`,
   *  `MEMBER`, `CONTRIBUTOR`, `NONE`. Passed through, not mapped: which of these
   *  is worth a badge is a display decision. */
  authorAssociation: z.string().optional(),
  body: z.string(),
  createdAt: Timestamp,
  minimized: z.boolean(),
  /** GitHub's reason, when it hid the comment. */
  minimizedReason: z.string().min(1).optional(),
  url: z.string().min(1),
});
export type GitHubComment = z.infer<typeof GitHubComment>;

/**
 * One review.
 *
 * NO IDENTIFIER, DELIBERATELY: `gh` returns `id: ""` for a review left by an
 * app rather than a person — measured, on a real pull request — so an id field
 * here would be a required-looking key that is routinely empty. Author and
 * submission time identify a review well enough for a list.
 */
export const GitHubReview = z.object({
  author: z.string().optional(),
  /** `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`, `PENDING`. */
  state: z.string(),
  body: z.string(),
  submittedAt: Timestamp,
});
export type GitHubReview = z.infer<typeof GitHubReview>;

/**
 * One check on a pull request's head commit.
 *
 * FLATTENED FROM TWO DIFFERENT GITHUB TYPES. `statusCheckRollup` mixes
 * `CheckRun` (Actions and the like: `name`, `status`, `conclusion`,
 * `detailsUrl`) with `StatusContext` (the older commit-status API: `context`,
 * `state`, `targetUrl`, and no status of its own). A client that had to know
 * which was which would grow a `__typename` switch in every renderer, so the
 * engine normalises once, here.
 */
export const GitHubCheck = z.object({
  name: z.string().min(1),
  /** `QUEUED`, `IN_PROGRESS`, `COMPLETED`. A commit status has no separate
   *  status, so a pending one reports `IN_PROGRESS` and a settled one
   *  `COMPLETED` — derived from its state rather than invented. */
  status: z.string(),
  /** `SUCCESS`, `FAILURE`, `NEUTRAL`, `CANCELLED`, `SKIPPED`, `TIMED_OUT`,
   *  `ACTION_REQUIRED`. ABSENT WHILE STILL RUNNING, which is the difference
   *  between "this check has not failed" and "this check has passed". */
  conclusion: z.string().optional(),
  /** The workflow a check run belongs to. Several checks share a workflow name
   *  and `name` alone is often a bare word like `test`. */
  workflow: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
});
export type GitHubCheck = z.infer<typeof GitHubCheck>;

/**
 * One issue, opened.
 *
 * EXTENDS THE LIST ROW rather than replacing it, so a surface that already knows
 * how to draw a row can draw this one's header from the same fields. What is
 * added is everything a list cannot afford: the body, the conversation, and the
 * three fields that say what happened to it.
 */
export const GitHubIssueDetail = GitHubIssue.extend({
  body: z.string(),
  comments: z.array(GitHubComment),
  /**
   * How many OLDER comments were left out.
   *
   * A thread is capped because rendering three thousand markdown blocks into a
   * 320px column locks the window, and the newest are the ones that say where a
   * discussion currently stands — the opening context is the body, which is
   * carried whole. Zero almost always, and never silent: a surface that dropped
   * half a conversation without saying so has lied about the conversation.
   */
  olderComments: z.number().int().nonnegative(),
  createdAt: Timestamp,
  closedAt: Timestamp.optional(),
  /** When this was read. Same reason as the snapshot's: a network read is not
   *  live, and a detail view is the surface most likely to be left open. */
  readAt: Timestamp,
});
export type GitHubIssueDetail = z.infer<typeof GitHubIssueDetail>;

/** The three ways GitHub can combine two branches. Not a preference the engine
 *  holds: a repository enables some subset of these, and asking for one it
 *  disabled is a refusal rather than a fallback to another. */
export const GitHubMergeMethod = z.enum(["merge", "squash", "rebase"]);
export type GitHubMergeMethod = z.infer<typeof GitHubMergeMethod>;

/**
 * One pull request, opened.
 *
 * `mergeable` AND `mergeStateStatus` ARE GITHUB'S OWN WORDS, unmapped, for the
 * reason `reviewDecision` already is above. They are also NOT the same question:
 * `mergeable` is `MERGEABLE` / `CONFLICTING` / `UNKNOWN` and answers "do the
 * trees combine", while `mergeStateStatus` is `CLEAN` / `BLOCKED` / `BEHIND` /
 * `DIRTY` / `DRAFT` / `UNSTABLE` / `HAS_HOOKS` / `UNKNOWN` and answers "will
 * GitHub let you". A pull request can be perfectly mergeable and blocked.
 *
 * `UNKNOWN` MEANS ASK AGAIN, NOT NO. GitHub computes mergeability lazily on
 * first request, so the first read of a quiet pull request routinely returns
 * `UNKNOWN` — measured. A client that renders that as "cannot merge" is lying
 * about a pull request that merges fine a second later.
 */
export const GitHubPullDetail = GitHubPullRequest.extend({
  body: z.string(),
  /** The branch the pull request is INTO. `headRefName` on the row above is the
   *  branch it is from; a pull request is the pair. */
  baseRefName: z.string().min(1).optional(),
  /**
   * The head commit this read describes.
   *
   * THE MERGE PRECONDITION. It goes back out with the merge as
   * `--match-head-commit`, so a commit pushed between reading this page and
   * pressing the button means GitHub refuses rather than merging code the person
   * who pressed it never saw. Exactly the file editor's hash precondition, with
   * GitHub enforcing it instead of the engine.
   */
  headRefOid: z.string().min(1).optional(),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  /**
   * Which merge methods THIS REPOSITORY allows.
   *
   * A repository setting, not a pull request one, and it travels with the pull
   * request because that is where a person needs it: offering "squash and merge"
   * on a repository that has squashing turned off produces a refusal nobody could
   * have predicted from the screen. Read concurrently with the pull request, so it
   * costs no wall-clock. EMPTY means the read failed and the surface should offer
   * all three rather than none — an unknown setting must not disable merging.
   */
  mergeMethods: z.array(GitHubMergeMethod),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
  comments: z.array(GitHubComment),
  /** Capped like an issue's, and for the same reason. */
  olderComments: z.number().int().nonnegative(),
  /** EVERY review, not the latest per reviewer. `reviewDecision` above is
   *  already the aggregate; this is the conversation, and hiding the round that
   *  requested changes because a later one approved loses why it was approved. */
  reviews: z.array(GitHubReview),
  /** The head commit's checks. Empty means no checks ran, which is different
   *  from every check passing — the surface says which. */
  checks: z.array(GitHubCheck),
  createdAt: Timestamp,
  mergedBy: z.string().min(1).optional(),
  readAt: Timestamp,
});
export type GitHubPullDetail = z.infer<typeof GitHubPullDetail>;

/**
 * Why one issue or one pull request could not be read.
 *
 * THE SNAPSHOT'S FOUR, PLUS ONE THE LIST CANNOT HAVE. A list read either works
 * or the environment is broken; a detail read can also name something that is
 * not there — `gh` answers "Could not resolve to a PullRequest with the number
 * of 999999", measured. That fifth case is real here and impossible there, which
 * is why this is its own enum rather than a member added to `GitHubUnavailable`
 * that one of its two users could never produce.
 */
export const GitHubDetailUnavailable = z.enum([...GitHubUnavailable.options, "not_found"]);
export type GitHubDetailUnavailable = z.infer<typeof GitHubDetailUnavailable>;

/**
 * A detail read: the thing, or why not.
 *
 * A UNION RATHER THAN A DETAIL FULL OF OPTIONAL FIELDS. "gh is not signed in"
 * has nothing in common with an issue except the moment it was asked for, and a
 * shape that could hold either would make every field on the happy path
 * optional for a client that then has to guard all of them.
 *
 * AND NOT AN HTTP ERROR, for the reason the snapshot route is a 200: a detail
 * tab restored from a previous run may open into a machine where `gh` has since
 * been logged out, and the four sentences that tell a reader what to do about
 * that are worth as much here as they are on the list.
 */
const detailFailure = { unavailable: GitHubDetailUnavailable, message: z.string().min(1).optional() };

export const GitHubIssueRead = z.union([z.object({ issue: GitHubIssueDetail }), z.object(detailFailure)]);
export type GitHubIssueRead = z.infer<typeof GitHubIssueRead>;

export const GitHubPullRead = z.union([z.object({ pull: GitHubPullDetail }), z.object(detailFailure)]);
export type GitHubPullRead = z.infer<typeof GitHubPullRead>;

/**
 * Why a merge did not happen.
 *
 * SEVEN ANSWERS, because each one has a different next move and only two of
 * them are "wait": `blocked` clears when review or CI does, `head_moved` clears
 * by re-reading the page, `conflicted` needs a rebase, `method_not_allowed`
 * needs a different button, `not_permitted` needs a different person, `not_open`
 * needs nothing at all. `failed` carries `gh`'s own words rather than a guess.
 */
export const GitHubMergeRefusal = z.enum([
  /** Already merged, or closed. Nothing to do. */
  "not_open",
  /** The trees do not combine. Somebody has to rebase. */
  "conflicted",
  /** Required reviews or required checks are not satisfied. */
  "blocked",
  /** A commit landed on the head branch after this page was read, so the
   *  precondition refused. Re-read and look again before merging. */
  "head_moved",
  /** The repository does not allow that merge method. */
  "method_not_allowed",
  /** This account cannot merge here. */
  "not_permitted",
  /** Anything else. `message` is `gh`'s, never invented. */
  "failed",
]);
export type GitHubMergeRefusal = z.infer<typeof GitHubMergeRefusal>;

/**
 * What a merge attempt answers.
 *
 * A REFUSAL IS DATA, NOT AN EXCEPTION — the same shape as the file write's, and
 * for the same reason: "GitHub would not merge this, and here is which of the
 * seven reasons" is something a surface has to render, not something to throw.
 *
 * SUCCESS CARRIES THE RE-READ PULL REQUEST. Without it the panel would show a
 * merged pull request as open until its cache expired, which is precisely the
 * stale-header bug the file editor had.
 */
export const GitHubMergeResult = z.union([
  z.object({ merged: z.literal(true), pull: GitHubPullDetail }),
  z.object({ merged: z.literal(false), refusal: GitHubMergeRefusal, message: z.string().min(1).optional() }),
]);
export type GitHubMergeResult = z.infer<typeof GitHubMergeResult>;
