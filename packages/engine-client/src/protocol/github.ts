/**
 * engine protocol v2 — GitHub, as the `gh` CLI reports it.
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
import { Id, Timestamp } from "./common";

/**
 * Why there is nothing to show, when there is nothing to show.
 *
 * FIVE DISTINCT ANSWERS, because they need five different responses from a
 * human and a single "unavailable" would send them to the wrong one. Collapsing
 * these was the failure mode of the frozen app's git pane, which reported every
 * shape of nothing as an empty list.
 *
 * `not_github` IS THE FIFTH, AND IT WAS SPLIT OUT OF `no_repository` — #670.
 * The two were one value, so a GitLab or Gitea checkout was told "this is not a
 * git repository", which is a confident and wrong claim about a repository the
 * person is standing in. It cost nothing while the panel only READ; the moment a
 * button offers to open a pull request, the difference between "there is no repo
 * here" and "this repo lives somewhere gh cannot reach" is the whole of what the
 * reader needs to know.
 */
export const GitHubUnavailable = z.enum([
  /** `gh` is not on PATH. Install it. */
  "not_installed",
  /** `gh` is there and nobody has logged in. `gh auth login`. */
  "not_authenticated",
  /** There is no git repository here — or one with no remotes at all. */
  "no_repository",
  /**
   * There IS a repository and it is not on a GitHub host `gh` knows: GitLab,
   * Gitea, a bare remote on a NAS, an unconfigured enterprise host. Nothing to
   * fix — plenty of projects are like this, and everything that is not
   * GitHub-specific (committing, pushing) still works.
   */
  "not_github",
  /** `gh` answered with something this engine could not read: a version skew, a
   *  rate limit, an enterprise host behaving differently. The message is
   *  passed through rather than replaced. */
  "failed",
]);
export type GitHubUnavailable = z.infer<typeof GitHubUnavailable>;

export const GitHubLabel = z.object({ name: z.string(), color: z.string().optional() });
export type GitHubLabel = z.infer<typeof GitHubLabel>;

/**
 * One end of GitHub's issue↔pull-request link.
 *
 * THE RELATION, NOT AN OUTCOME. `gh` exposes it from both sides — an issue's
 * `closedByPullRequestsReferences` and a pull request's
 * `closingIssuesReferences` — and neither carries the other end's STATE. Measured
 * against cli/cli: an OPEN issue answers a reference to a pull request that was
 * closed without merging. So this is "these two are linked, and merging closes
 * the issue", which is also how github.com words it ("Successfully merging a pull
 * request may close this issue"). Naming it `closedBy` would claim a merge that
 * may never happen.
 *
 * NO TITLE, because `gh` does not send one. The reference is a number, a URL and
 * a repository, which is all a jump needs — and asking for the title would mean a
 * second read per link.
 */
export const GitHubLink = z.object({
  number: z.number().int().positive(),
  url: z.string().min(1),
  /**
   * `owner/name`, and ONLY when it is a DIFFERENT repository from the one this
   * was read out of.
   *
   * ABSENT IS THE JUMPABLE CASE, which is the whole reason this field exists. A
   * pull request in another repository can close an issue here, and the panel's
   * own Pull requests surface can only reach this repository's — so a jump that
   * ignored this would open the wrong #768. Absent means "same repository, go
   * ahead"; present means "this one is only a link out, and here is whose".
   */
  repository: z.string().min(1).optional(),
});
export type GitHubLink = z.infer<typeof GitHubLink>;

/**
 * Where an author's face is.
 *
 * DERIVED ON A ROW, READ ON A COMMENT, and the split is the whole of #814. There
 * is no avatar field in `gh`'s projections to ask for: `--json author` answers
 * `{id, is_bot, login, name}` on every list and detail read, and a comment's
 * author answers `{login}` alone — measured. A ROW's author carries `is_bot`, so
 * a derived `github.com/<login>.png` is safe there and costs nothing. A COMMENT's
 * does not, so a bot's bare slug would render whichever human owns that login —
 * and the thread read asks GitHub outright instead. See
 * `apps/engine/src/github.ts` for both measurements.
 *
 * NO SIZE ON IT. `github.com/<login>.png` takes a `?size=` and the size is the
 * renderer's business — a 16px row glyph and a 40px comment face are the same
 * fact at two scales. Clients append their own; the engine has no business
 * guessing.
 *
 * ABSENT IS ORDINARY, not a failure: a bot has no such page, and a surface draws
 * a monogram rather than a broken image.
 */
const authorAvatarField = { authorAvatar: z.string().min(1).optional() };

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
 * The narrowing a list read carries, beyond which states.
 *
 * ONE OBJECT RATHER THAN FIVE LOOSE PARAMETERS, because it is also the CACHE KEY:
 * the engine holds a read for thirty seconds, and a key that missed one field
 * would answer "assigned to me" from a cache of everybody's. As a shape it can be
 * normalised and stringified in one place, and it can be echoed back on the
 * snapshot so a surface showing four rows can say why there are four.
 *
 * EVERY FIELD IS A `gh` FLAG, and only flags `gh` actually has. `--assignee` and
 * `--author` take ONE value each, so these are single rather than arrays; `--label`
 * repeats and ANDs, which is why labels is a list.
 */
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
  /** A milestone TITLE (or its number — `gh` takes either). Issues only: `gh pr
   *  list` has no `--milestone` flag, so offering one on pull requests would be a
   *  control that cannot work. */
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

/**
 * What there is to filter BY, in this repository.
 *
 * READ SEPARATELY AND LAZILY. These change on the timescale of a sprint, not of a
 * page view, so they are cached far longer than a list read and are only fetched
 * when somebody opens the filter menu — which means a reader who never filters
 * pays nothing for the feature.
 *
 * EACH LIST FAILS ALONE. A repository with no milestones and a repository whose
 * milestones cannot be read both answer `[]`; neither is a failure of the others,
 * and none of them is a failure of the list itself.
 */
export const GitHubFacets = z.object({
  /** The login `gh` is signed in as, so "assigned to me" can name the account it
   *  means rather than asking the reader to trust `@me`. */
  viewer: z.string().min(1).optional(),
  milestones: z.array(GitHubMilestone),
  labels: z.array(GitHubLabel),
  /** Who CAN be assigned here, which is a longer list than who is. Capped. */
  assignees: z.array(z.string()),
  readAt: Timestamp,
});
export type GitHubFacets = z.infer<typeof GitHubFacets>;

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
  ...authorAvatarField,
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
  /**
   * The pull requests linked to close this issue.
   *
   * ON THE ROW, WHICH IS A COST DECISION AND WAS MEASURED. github.com puts this
   * beside the state badge because "is this closed, and by which pull request" is
   * the question an issue raises — and answering it by hand with `gh` was the
   * evidence #790 was filed on. It rides the LIST field set because it is cheap and
   * unprivileged, unlike the two fields that are deliberately absent above: 0.75s
   * → 0.88s and 25KB → 32KB against fifty issues, on a token carrying `repo` and
   * no `read:project`. `comments` costs 2.81s and 245KB; `projectItems` fails the
   * whole query without its scope. This does neither.
   *
   * EMPTY MEANS NO LINK, and there is no third answer to tell apart — the field
   * travels with the rows, so a read that got rows got this too.
   */
  linkedPulls: z.array(GitHubLink),
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
  /** The issues this pull request closes when it merges — the same link
   *  `GitHubIssue.linkedPulls` carries, seen from the other end, and on the row
   *  for the same measured reason. */
  linkedIssues: z.array(GitHubLink),
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
  /**
   * WHICH ROWS THESE ARE, echoed back in full.
   *
   * A surface showing four rows has to be able to say why there are four, and a
   * surface showing none has to be able to say whether that is an empty repository
   * or a filter nobody can see. Without this echo it would have to trust that the
   * answer matches the filter it last sent — which a thirty-second cache and an
   * in-flight refresh both make untrue.
   */
  issueFilter: GitHubIssueFilter,
  pullFilter: GitHubPullFilter,
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
 * One reaction GitHub is holding on a comment.
 *
 * GITHUB'S OWN WORD FOR THE CONTENT — `THUMBS_UP`, `HEART`, `ROCKET` — passed
 * through rather than mapped to a glyph, because which emoji stands for
 * `HOORAY` is a display decision and three clients should not each invent one.
 *
 * EMPTY GROUPS ARE DROPPED. The GraphQL read answers all eight contents for
 * every comment whether or not anybody used them — measured — so a comment
 * nobody reacted to would otherwise arrive as eight zeroes.
 *
 * `viewerHasReacted` IS CARRIED AND NOTHING CAN ACT ON IT YET. It is free on the
 * read that already happens, and the write half (`addReaction`/`removeReaction`)
 * does not exist — `gh`'s own comment projection drops the field entirely, so
 * having it at all is the reason the thread read is GraphQL. See #814's issue B.
 */
export const GitHubReaction = z.object({
  content: z.string().min(1),
  count: z.number().int().positive(),
  viewerHasReacted: z.boolean(),
});
export type GitHubReaction = z.infer<typeof GitHubReaction>;

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
  ...authorAvatarField,
  /** GitHub's own word for how the author relates to the repository — `OWNER`,
   *  `MEMBER`, `CONTRIBUTOR`, `NONE`. Passed through, not mapped: which of these
   *  is worth a badge is a display decision. */
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
  /**
   * What GitHub is holding against this comment.
   *
   * ABSENT AND EMPTY MEAN DIFFERENT THINGS, which is why this is optional rather
   * than defaulted. It rides a SECOND read (#814) that may fail on its own —
   * absent is "this engine did not get to ask", `[]` is "asked, and nobody
   * reacted". A surface that conflated them would draw "no reactions" over a
   * failed read.
   *
   * NO SURFACE YET, on purpose. Where a reaction chip sits and whether it is
   * actionable is the display decision #814's issue B is about; this is the half
   * that was free on a read already being made, and it travels so that issue is
   * a display change and not another round trip.
   */
  reactions: z.array(GitHubReaction).optional(),
  /**
   * WHICH TELAR SESSION THIS COMMENT CLAIMS TO COME FROM — issue #791, the one
   * thing github.com structurally cannot show.
   *
   * A CLAIM, NOT A PROOF, and the distinction has to survive every reader of
   * this field. A comment posted through the engine carries an id stamped from
   * a verified claim token, exactly as `Session.startedFrom` is — so a model
   * driving that path cannot name a session it is not. But a comment body is
   * typed by whoever posts it, and an agent with a shell can run
   * `gh issue comment` and write any marker it likes, including one it read off
   * a public comment belonging to another session.
   *
   * So this answers "the body says session X", and a surface should present it
   * as a link to a conversation rather than as a badge of authorship. NOTHING
   * MAY AUTHORISE ON IT.
   *
   * Absent is the ordinary case: every comment written by a person, and every
   * one an agent posted before this existed.
   */
  attribution: z.object({ sessionId: Id }).optional(),
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
  ...authorAvatarField,
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
  /**
   * The Actions job behind this check, when there is one.
   *
   * PARSED OUT OF `detailsUrl`, which ends `/actions/runs/<run>/job/<job>` — the
   * only place `gh`'s rollup carries it. It exists so a failing check can be asked
   * for its LOG, which is the difference between handing an agent a URL it cannot
   * read and handing it the error. A commit status has no job and no log.
   */
  jobId: z.string().min(1).optional(),
});
export type GitHubCheck = z.infer<typeof GitHubCheck>;

/**
 * The failing part of a check's log.
 *
 * THE TAIL, NOT THE HEAD. `gh run view --log-failed` starts with the runner's own
 * preamble — image provisioner, region, worker id — and the error is at the bottom.
 * A head-capped excerpt is thirty lines about Ubuntu; the tail is the failure.
 *
 * STRIPPED OF `gh`'s PREFIXES. Every line arrives as
 * `job / step<TAB>STEP NAME<TAB>2026-08-12T16:25:32.4355162Z message`, which triples
 * the length and buries the message. The job and step are already known from the
 * check itself, so only the message survives.
 */
export const GitHubCheckLog = z.union([
  z.object({
    lines: z.array(z.string()),
    /** True when older lines were dropped to fit the cap — so a surface can say
     *  "the last 200 lines" rather than implying this is the whole log. */
    truncated: z.boolean(),
  }),
  z.object({ unavailable: z.string().min(1) }),
]);
export type GitHubCheckLog = z.infer<typeof GitHubCheckLog>;

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

// ── posting one comment ─────────────────────────────────────────────────────

/**
 * How long a comment body may be.
 *
 * GitHub's own ceiling is 65,536 characters and it answers a 422 past it. Held
 * here as well because the body travels as an argv string to `gh`, and a body
 * that overran the operating system's argument limit would fail as a confusing
 * spawn error rather than as "that comment is too long".
 */
export const MAX_COMMENT_BODY = 65_536;

export const GitHubCommentRefusal = z.enum([
  /** There is no issue or pull request with that number here. */
  "not_found",
  /** The body was empty, or past `MAX_COMMENT_BODY`. */
  "invalid_body",
  /** Locked, archived, or this account cannot comment here. */
  "not_permitted",
  /** Anything else. `message` is `gh`'s, never invented. */
  "failed",
]);
export type GitHubCommentRefusal = z.infer<typeof GitHubCommentRefusal>;

/**
 * What posting one comment answers.
 *
 * A REFUSAL IS DATA, exactly as a merge's is, and for the same reason: "GitHub
 * would not take this comment" is something a surface renders.
 *
 * SUCCESS CARRIES THE URL AND THE ATTRIBUTION THE ENGINE STAMPED, which is the
 * whole point of routing the write through here. The caller learns which
 * session the comment was recorded as — from the engine's verified claim, not
 * from anything the caller said — so a tool answer can state it rather than
 * assert it.
 */
export const GitHubCommentResult = z.union([
  z.object({ posted: z.literal(true), url: z.string().min(1), attribution: z.object({ sessionId: Id }) }),
  z.object({ posted: z.literal(false), refusal: GitHubCommentRefusal, message: z.string().min(1).optional() }),
]);
export type GitHubCommentResult = z.infer<typeof GitHubCommentResult>;

// ── opening one pull request ────────────────────────────────────────────────

/** How long a pull request's title may be. GitHub's own ceiling is 256; held
 *  here because the title travels as an argv string to `gh`. */
export const MAX_PULL_TITLE = 256;

/**
 * Why a pull request was not opened — issue #670.
 *
 * `not_pushed` IS THE ONE WITH A BUTTON BEHIND IT, and it is decided from data:
 * a pull request on a branch the remote has never seen is not a thing, so the
 * engine checks for the remote-tracking ref and refuses before `gh` is asked.
 * The other arm on the Diff surface is exactly the remedy.
 *
 * `exists` IS NOT A FAILURE in the way the rest are. `gh` refuses a second pull
 * request for a head branch that already has one, and the honest response is to
 * show the reader the one that is already open.
 */
export const GitHubPullCreateRefusal = z.enum([
  /** This branch is not on the remote yet. Push it first. */
  "not_pushed",
  /** A pull request for this branch is already open. `url` carries it. */
  "exists",
  /** The head branch and the base branch are the same, or the head has no
   *  commits the base does not — there would be nothing to review. */
  "nothing_to_compare",
  /** The title was empty, or past `MAX_PULL_TITLE`. */
  "invalid_title",
  /** This account cannot open a pull request here. */
  "not_permitted",
  /** Anything else. `message` is `gh`'s own words, never invented. */
  "failed",
]);
export type GitHubPullCreateRefusal = z.infer<typeof GitHubPullCreateRefusal>;

/**
 * What opening a pull request answers.
 *
 * SUCCESS CARRIES THE URL AND NOTHING ELSE, deliberately. `gh pr create` prints
 * one line and a full detail read would be a second round trip for a page this
 * surface does not draw — the forge panel already knows how to open the number,
 * and the link is what a person reaches for next.
 *
 * THE ATTRIBUTION IS THE SAME CLAIM #791's COMMENTS CARRY, with the same
 * caveat: the marker says this body claims that session, not that the session
 * signed it. Nothing authorises on it.
 */
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

/**
 * The query string for a filtered list read.
 *
 * EXPORTED AND SHARED, because the cockpit's own adapter builds the same string for
 * its own route and two hand-written copies of this would drift on the first filter
 * anybody adds. `Label` REPEATS rather than being comma-joined: a GitHub label may
 * contain a comma, and joining would ask for a label nobody has.
 */
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

/**
 * The other half of `forgeQuery`, and it lives here for one measured reason.
 *
 * THE PARAMETERS WERE SILENTLY DROPPED. The cockpit built this query correctly, the
 * engine parsed it correctly, and the Next adapter in between forwarded only
 * `refresh` — so choosing a milestone typechecked, passed every test, made a request
 * with the milestone in it, and returned every issue in the repository. Found by
 * driving it and reading the dev server's own log.
 *
 * A builder and a parser in one file cannot drift; a builder in the contract and a
 * parser hand-written in each of two proxies drift on the first filter anybody adds.
 *
 * INVALID IS REFUSED, NOT COERCED. An unknown state throws, because `gh` would fail
 * on the flag and report it as GitHub being broken. Everything else is free text —
 * a login, a milestone title, a label — and `gh` is the one that decides whether it
 * matches anything.
 */
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
