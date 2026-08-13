/**
 * GitHub, through the `gh` CLI the user already authenticated.
 *
 * WHY `gh` AND NOT THE REST API. A token in Telar's state is a different
 * product: it needs a place to live, a rotation story, an audit story, and a
 * settings screen that lies about none of it. `gh` already solved all four on
 * this machine, and the cockpit's stated arrangement with every other
 * credential is identical — "sign-in lives outside Telar; the worker picks it
 * up from there". This keeps that sentence true.
 *
 * THE RUNNER IS ASYNC, AND THAT IS THE ONE REAL DIFFERENCE FROM `GitRunner`.
 * `git status` is a local syscall and `execFileSync` costs microseconds;
 * `gh issue list` is a network round trip that routinely takes a second and can
 * take thirty. The daemon is a single-threaded HTTP server, so a synchronous
 * call here would stall every other session's turn observations for the
 * duration — a worker reporting a stream would simply stop until GitHub
 * answered. Hence a promise, and hence a timeout: a hung TLS handshake must not
 * become a wedged engine.
 *
 * EVERY FAILURE IS A TYPED ANSWER, NOT A THROW. "gh is not installed", "nobody
 * is logged in" and "this is not a GitHub repository" need three different
 * responses from a human, and the third is usually "nothing, that is fine".
 * Collapsing them into an empty list — which is what the frozen app's panes did
 * with every absent thing — is how a surface teaches its reader to ignore it.
 */
import { execFile } from "node:child_process";
import type {
  GitHubCheck,
  GitHubCheckLog,
  GitHubComment,
  GitHubDetailUnavailable,
  GitHubFacets,
  GitHubIssue,
  GitHubIssueDetail,
  GitHubIssueFilter,
  GitHubIssueRead,
  GitHubMergeMethod,
  GitHubMergeRefusal,
  GitHubMergeResult,
  GitHubMilestone,
  GitHubPullDetail,
  GitHubPullFilter,
  GitHubPullRead,
  GitHubPullRequest,
  GitHubReview,
  GitHubSnapshot,
  GitHubUnavailable,
} from "@telar/engine-client";

export type GhResult = { status: number; stdout: string; stderr: string };
/** Injectable so tests never touch the network. */
export type GhRunner = (cwd: string, args: string[]) => Promise<GhResult>;

/**
 * Long enough for a cold API call on a slow connection, short enough that a
 * hung one is a message rather than a wedged panel.
 */
const GH_TIMEOUT_MS = 20_000;

/** How many rows one read may carry. A panel is not an issue tracker; past
 *  fifty rows the reader wants a search box, and this surface deliberately is
 *  not one. */
export const GITHUB_PAGE_SIZE = 50;

export const defaultGhRunner: GhRunner = (cwd, args) =>
  new Promise((resolve) => {
    execFile(
      "gh",
      args,
      // `GH_PAGER=cat` because `gh` will happily pipe into a pager it inherited
      // from the environment and then never exit — measured on a machine with
      // PAGER=less, where the first issue read hung until the timeout.
      { cwd, encoding: "utf8", timeout: GH_TIMEOUT_MS, env: { ...process.env, GH_PAGER: "cat", NO_COLOR: "1" } },
      (error, stdout, stderr) => {
        const failure = error as (Error & { code?: number | string; killed?: boolean }) | null;
        if (!failure) return resolve({ status: 0, stdout, stderr });
        // ENOENT is `gh` missing; a numeric code is `gh` refusing.
        const status = typeof failure.code === "number" ? failure.code : failure.code === "ENOENT" ? 127 : 1;
        resolve({ status, stdout, stderr: stderr || failure.message });
      },
    );
  });

/**
 * Which kind of nothing this is.
 *
 * MATCHED ON `gh`'s OWN WORDS, which is fragile and is the least-bad option
 * available: `gh` exits 1 for every one of these, so the exit code cannot tell
 * them apart. The fallback is `failed` with the message passed through, so a
 * phrasing change upstream degrades to "here is what gh said" rather than to a
 * wrong diagnosis.
 */
export function classifyGhFailure(result: GhResult): { unavailable: GitHubUnavailable; message?: string } {
  if (result.status === 127) return { unavailable: "not_installed" };
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (text.includes("not logged in") || text.includes("authentication") || text.includes("gh auth login")) {
    return { unavailable: "not_authenticated" };
  }
  if (text.includes("not a git repository") || text.includes("no git remotes") || text.includes("could not determine")) {
    return { unavailable: "no_repository" };
  }
  const message = result.stderr.trim() || result.stdout.trim();
  return { unavailable: "failed", ...(message ? { message } : {}) };
}

/** ISO-8601 from `gh`, epoch milliseconds everywhere else in this contract.
 *  Converted once at the seam rather than by every client that renders a date. */
function epoch(value: unknown): number {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** `gh` nests the author, and a bot has a login and no name. Only the login is
 *  stable enough to show. */
function login(value: unknown): string | undefined {
  const record = value as { login?: unknown } | null;
  const name = typeof record?.login === "string" ? record.login : "";
  return name || undefined;
}

/** Labels, minus the ones with no name — an unnamed label is an empty chip. */
function labels(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((label) => {
    const record = label as Record<string, unknown>;
    const name = text(record.name);
    return name ? [{ name, ...(text(record.color) ? { color: text(record.color) } : {}) }] : [];
  });
}

/** `gh` nests assignees the way it nests the author, and only the login is
 *  stable enough to show. */
function logins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const name = login(entry);
    return name ? [name] : [];
  });
}

/** A milestone is an object or null; its title is the only part a row has space
 *  for. */
function milestone(value: unknown): string | undefined {
  const title = text((value as { title?: unknown } | null)?.title);
  return title || undefined;
}

/**
 * The fields EVERY row carries, whether it is an issue or a pull request.
 *
 * `projects` starts empty and is filled in afterwards, because it comes from a
 * different `gh` call — see `readProjects` for why it has to.
 */
function rowFields(row: Record<string, unknown>) {
  return {
    ...(login(row.author) ? { author: login(row.author)! } : {}),
    labels: labels(row.labels),
    assignees: logins(row.assignees),
    ...(milestone(row.milestone) ? { milestone: milestone(row.milestone)! } : {}),
    projects: [] as string[],
    updatedAt: epoch(row.updatedAt),
    url: text(row.url) || `#${typeof row.number === "number" ? row.number : 0}`,
  };
}

/**
 * The fields a LIST row and a DETAIL read share, parsed once.
 *
 * Both readers go through this, so the two can never disagree about what state
 * or which author a row has — the failure that would otherwise show up as a title
 * changing when you click it.
 */
function issueRow(row: Record<string, unknown>): GitHubIssue | undefined {
  const number = typeof row.number === "number" ? row.number : 0;
  if (number <= 0) return undefined;
  return {
    number,
    title: text(row.title),
    state: text(row.state) || "OPEN",
    ...(text(row.stateReason) ? { stateReason: text(row.stateReason) } : {}),
    ...rowFields(row),
  };
}

function pullRow(row: Record<string, unknown>): GitHubPullRequest | undefined {
  const number = typeof row.number === "number" ? row.number : 0;
  if (number <= 0) return undefined;
  const mergedAt = epoch(row.mergedAt);
  return {
    number,
    title: text(row.title),
    state: text(row.state) || "OPEN",
    isDraft: row.isDraft === true,
    ...(text(row.headRefName) ? { headRefName: text(row.headRefName) } : {}),
    ...(text(row.reviewDecision) ? { reviewDecision: text(row.reviewDecision) } : {}),
    // `epoch` answers 0 for an absent date, and an open pull request has no merge
    // time — 0 would render as January 1970.
    ...(mergedAt ? { mergedAt } : {}),
    ...rowFields(row),
  };
}

/** `gh`'s array output through one row parser. A row it cannot number is dropped
 *  rather than rendered as `#0`. */
function rows<T>(stdout: string, one: (row: Record<string, unknown>) => T | undefined): T[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    const parsedRow = one(entry as Record<string, unknown>);
    return parsedRow ? [parsedRow] : [];
  });
}

export function parseIssues(stdout: string): GitHubIssue[] {
  return rows(stdout, issueRow);
}

export function parsePulls(stdout: string): GitHubPullRequest[] {
  return rows(stdout, pullRow);
}

/**
 * What a LIST row asks for.
 *
 * NO `comments`. `gh` has no count field, so asking for comments returns every
 * comment BODY for every row: measured at 245KB and 2.81s against a fifty-issue
 * repository, versus 0.56s without. Five times the read for a number, when the
 * thread itself is one click away.
 *
 * NO `projectItems` EITHER, and that one is not about size — it needs the
 * `read:project` scope, and a token without it fails the ENTIRE query rather than
 * omitting the field. Measured against this machine's own `gh`, whose token has
 * `repo` and not `read:project`: putting it here would blank the Issues list for
 * anybody on a default token. It gets its own call.
 */
const ISSUE_FIELDS = "number,title,state,stateReason,labels,author,assignees,milestone,updatedAt,url";
const PULL_FIELDS = "number,title,state,isDraft,author,assignees,milestone,labels,headRefName,updatedAt,url,reviewDecision,mergedAt";

/**
 * Which boards each row is on, keyed by number.
 *
 * ITS OWN CALL, FOR ONE MEASURED REASON. `projectItems` requires `read:project`;
 * a token without that scope makes `gh` fail the whole `--json` query with a
 * GraphQL scope error, so a single field would take the list, the titles and the
 * states down with it. Asked separately, the worst case is a column that says why
 * it is empty.
 */
export function parseProjectItems(stdout: string): Map<number, string[]> {
  const byNumber = new Map<number, string[]>();
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) return byNumber;
  for (const entry of parsed) {
    const row = entry as Record<string, unknown>;
    const number = typeof row.number === "number" ? row.number : 0;
    if (number <= 0) continue;
    const items = row.projectItems;
    // `projectItems` is `{ title, ... }` per item; a board with no title is a
    // board this cockpit cannot name, so it is dropped rather than shown blank.
    const titles = Array.isArray(items)
      ? items.flatMap((item) => {
          const record = item as { title?: unknown; project?: { title?: unknown } } | null;
          const title = text(record?.title) || text(record?.project?.title);
          return title ? [title] : [];
        })
      : [];
    if (titles.length > 0) byNumber.set(number, titles);
  }
  return byNumber;
}

/**
 * Why the boards could not be read.
 *
 * `scope` IS THE ORDINARY CASE, not a fault: the token `gh auth login` mints by
 * default carries `repo` and not `read:project`, so most machines land here. It is
 * matched on GitHub's own words, which name the scope they want.
 */
export function classifyProjectFailure(result: GhResult): "scope" | "failed" {
  return `${result.stderr}\n${result.stdout}`.toLowerCase().includes("read:project") ? "scope" : "failed";
}

export const DEFAULT_ISSUE_FILTER: GitHubIssueFilter = { state: "open", labels: [] };
export const DEFAULT_PULL_FILTER: GitHubPullFilter = { state: "open", labels: [] };

/**
 * The argv for one list read.
 *
 * SHARED BY THE ROW CALL AND THE BOARD CALL, which is not a tidiness point: the
 * boards are folded onto rows BY NUMBER, so a board call filtered differently from
 * its rows would attach one issue's boards to another's. One builder, one filter,
 * two `--json` field sets.
 *
 * `--label` REPEATS, everything else is single — `gh` takes one assignee and one
 * author, and it ANDs repeated labels. A label containing a comma is why this
 * repeats the flag instead of joining: `--label "a,b"` asks for one label named
 * `a,b`, which is a real label somebody can create.
 */
export function listArgv(kind: "issue" | "pr", filter: GitHubIssueFilter | GitHubPullFilter, fields: string): string[] {
  const argv = [kind, "list", "--state", filter.state, "--limit", String(GITHUB_PAGE_SIZE)];
  const milestone = (filter as GitHubIssueFilter).milestone;
  // Issues only. `gh pr list` has no `--milestone`, and passing one would make gh
  // fail on a flag this cockpit chose rather than on anything the reader did.
  if (kind === "issue" && milestone) argv.push("--milestone", milestone);
  if (filter.assignee) argv.push("--assignee", filter.assignee);
  if (filter.author) argv.push("--author", filter.author);
  for (const label of filter.labels) argv.push("--label", label);
  argv.push("--json", fields);
  return argv;
}

/**
 * One read of a project's issues and pull requests.
 *
 * BOTH IN ONE CALL, CONCURRENTLY, because they are one panel gesture: a reader
 * opening the Issues tab will open Pull requests seconds later, and two
 * sequential network round trips make the second one feel broken. They fail
 * independently — an org that disabled issues still has pull requests, and the
 * shape says so rather than reporting the whole repository as unavailable.
 *
 * FIVE CALLS AT MOST, ALL AT ONCE, so the wall clock is the slowest one rather
 * than their sum: the two lists, the repository name, and the two board reads.
 * `skipProjects` is how the store stops paying for the last two once a token has
 * told us it has no `read:project` — see `projectGitHub`.
 */
export async function readGitHub(
  gh: GhRunner,
  cwd: string,
  now: () => number = Date.now,
  options: { issues?: GitHubIssueFilter; pulls?: GitHubPullFilter; skipProjects?: boolean } = {},
): Promise<GitHubSnapshot> {
  const issueFilter = options.issues ?? DEFAULT_ISSUE_FILTER;
  const pullFilter = options.pulls ?? DEFAULT_PULL_FILTER;
  const [issues, pulls, repo, issueBoards, pullBoards] = await Promise.all([
    gh(cwd, listArgv("issue", issueFilter, ISSUE_FIELDS)),
    gh(cwd, listArgv("pr", pullFilter, PULL_FIELDS)),
    gh(cwd, ["repo", "view", "--json", "nameWithOwner"]),
    options.skipProjects ? Promise.resolve(undefined) : gh(cwd, listArgv("issue", issueFilter, "number,projectItems")),
    options.skipProjects ? Promise.resolve(undefined) : gh(cwd, listArgv("pr", pullFilter, "number,projectItems")),
  ]);

  const repository = (() => {
    if (repo.status !== 0) return undefined;
    try {
      const parsed = JSON.parse(repo.stdout) as { nameWithOwner?: unknown };
      return typeof parsed.nameWithOwner === "string" ? parsed.nameWithOwner : undefined;
    } catch {
      return undefined;
    }
  })();

  const read = <T>(result: GhResult, parse: (stdout: string) => T[]): { rows: T[]; failure?: ReturnType<typeof classifyGhFailure> } => {
    if (result.status !== 0) return { rows: [], failure: classifyGhFailure(result) };
    try {
      return { rows: parse(result.stdout) };
    } catch {
      // `gh` answered and this engine could not read it — a version skew, most
      // likely. Reported as `failed` rather than as an empty list.
      return { rows: [], failure: { unavailable: "failed", message: "gh returned output this engine could not read" } };
    }
  };

  const issueRead = read(issues, parseIssues);
  const pullRead = read(pulls, parsePulls);
  // The FIRST failure wins the headline, and the two are almost always the same
  // one — both calls run against the same repository with the same credentials.
  const failure = issueRead.failure ?? pullRead.failure;

  /**
   * The boards, folded onto the rows they belong to.
   *
   * A BOARD FAILURE IS NOT A LIST FAILURE. It reports itself in its own field, and
   * the rows keep their titles, states and assignees — which is the entire reason
   * this is a separate call.
   */
  const boards = (result: GhResult | undefined): { items?: Map<number, string[]>; failed?: "scope" | "failed" } => {
    if (!result) return {};
    if (result.status !== 0) return { failed: classifyProjectFailure(result) };
    try {
      return { items: parseProjectItems(result.stdout) };
    } catch {
      return { failed: "failed" };
    }
  };
  const issueBoardRead = boards(issueBoards);
  const pullBoardRead = boards(pullBoards);
  const withBoards = <T extends { number: number; projects: string[] }>(rows: T[], items?: Map<number, string[]>): T[] =>
    items === undefined ? rows : rows.map((row) => ({ ...row, projects: items.get(row.number) ?? [] }));
  const projectsUnavailable = issueBoardRead.failed ?? pullBoardRead.failed;

  return {
    ...(repository ? { repository } : {}),
    issues: withBoards(issueRead.rows, issueBoardRead.items),
    pulls: withBoards(pullRead.rows, pullBoardRead.items),
    issueFilter,
    pullFilter,
    ...(projectsUnavailable ? { projectsUnavailable } : {}),
    ...(failure ? { unavailable: failure.unavailable, ...(failure.message ? { message: failure.message } : {}) } : {}),
    readAt: now(),
  };
}

// ── what there is to filter by ─────────────────────────────────────────────

/**
 * How many milestones, labels and assignable people one facet read carries.
 *
 * A hundred is past the point where a menu is a menu — nobody scrolls a
 * hundred-item dropdown — and it is `gh`'s own page size, so asking for it costs
 * one request rather than pagination. A repository with more than this many labels
 * has a labelling problem the panel cannot fix.
 */
export const MAX_FACET_VALUES = 100;

/** `gh api` answers an ARRAY here, unlike the `--json` readers above. Anything that
 *  is not one is treated as "could not ask", which is the same as "none" for a
 *  filter menu — the list itself is unaffected either way. */
function apiArray(result: GhResult): Record<string, unknown>[] {
  if (result.status !== 0) return [];
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
}

export function parseMilestones(result: GhResult): GitHubMilestone[] {
  return apiArray(result)
    .flatMap((row) => {
      const title = text(row.title);
      if (!title) return [];
      const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0);
      return [{ title, open: count(row.open_issues), closed: count(row.closed_issues) }];
    })
    .slice(0, MAX_FACET_VALUES);
}

/**
 * What there is to filter by.
 *
 * FOUR CALLS, CONCURRENTLY, AND EVERY ONE OF THEM MAY FAIL ALONE. A repository with
 * no milestones, a token that cannot list who is assignable, and a `gh` that cannot
 * answer at all are three different situations and all three come back as an empty
 * list — because for a filter MENU they mean the same thing, and none of them is a
 * reason to break the list the menu belongs to.
 *
 * `gh api` FOR MILESTONES AND ASSIGNEES because `gh` has no first-class command for
 * either; `gh label list` exists and is used. The `{owner}/{repo}` placeholders are
 * `gh`'s own — it resolves them from the checkout, so this never has to parse a
 * remote URL.
 */
export async function readForgeFacets(gh: GhRunner, cwd: string, now: () => number = Date.now): Promise<GitHubFacets> {
  const page = `per_page=${MAX_FACET_VALUES}`;
  const [milestones, labels, assignees, viewer] = await Promise.all([
    gh(cwd, ["api", `repos/{owner}/{repo}/milestones?state=all&${page}`]),
    gh(cwd, ["label", "list", "--limit", String(MAX_FACET_VALUES), "--json", "name,color"]),
    gh(cwd, ["api", `repos/{owner}/{repo}/assignees?${page}`]),
    gh(cwd, ["api", "user"]),
  ]);

  const viewerLogin = (() => {
    if (viewer.status !== 0) return undefined;
    try {
      return login(JSON.parse(viewer.stdout));
    } catch {
      return undefined;
    }
  })();

  return {
    ...(viewerLogin ? { viewer: viewerLogin } : {}),
    milestones: parseMilestones(milestones),
    labels: parseLabelList(labels),
    assignees: apiArray(assignees)
      .flatMap((row) => {
        const name = text(row.login);
        return name ? [name] : [];
      })
      .slice(0, MAX_FACET_VALUES),
    readAt: now(),
  };
}

/** `gh label list --json name,color` answers the same shape a row's labels do, so
 *  the same parser applies — one definition of "a label with no name is not one". */
export function parseLabelList(result: GhResult) {
  if (result.status !== 0) return [];
  try {
    return labels(JSON.parse(result.stdout)).slice(0, MAX_FACET_VALUES);
  } catch {
    return [];
  }
}

// ── one issue, one pull request ─────────────────────────────────────────────

/**
 * How many comments one detail read carries, newest kept.
 *
 * Rendering a three-thousand-comment thread as three thousand markdown blocks in
 * a 320px column locks the window, and the count that was dropped travels with
 * the answer so no surface has to pretend it showed the whole thing.
 */
export const MAX_THREAD_COMMENTS = 100;

function comment(entry: unknown): GitHubComment | undefined {
  const row = entry as Record<string, unknown>;
  const url = text(row.url);
  // A comment with no url is not a comment this engine can identify or link, and
  // it has never been observed — dropped rather than rendered as a dead row.
  if (!url) return undefined;
  const reason = text(row.minimizedReason);
  return {
    ...(login(row.author) ? { author: login(row.author)! } : {}),
    ...(text(row.authorAssociation) ? { authorAssociation: text(row.authorAssociation) } : {}),
    body: text(row.body),
    createdAt: epoch(row.createdAt),
    minimized: row.isMinimized === true,
    ...(reason ? { minimizedReason: reason } : {}),
    url,
  };
}

/**
 * The comments, newest-capped.
 *
 * SORTED BY CREATION rather than trusted in `gh`'s order, because the cap keeps
 * a TAIL and a tail is only the newest comments if the list is in order. It has
 * always arrived in order; sorting costs nothing and makes the cap correct
 * rather than correct-so-far.
 */
export function parseComments(value: unknown): { comments: GitHubComment[]; olderComments: number } {
  if (!Array.isArray(value)) return { comments: [], olderComments: 0 };
  const all = value
    .flatMap((entry) => {
      const parsed = comment(entry);
      return parsed ? [parsed] : [];
    })
    .sort((left, right) => left.createdAt - right.createdAt);
  if (all.length <= MAX_THREAD_COMMENTS) return { comments: all, olderComments: 0 };
  return { comments: all.slice(-MAX_THREAD_COMMENTS), olderComments: all.length - MAX_THREAD_COMMENTS };
}

export function parseReviews(value: unknown): GitHubReview[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) => {
      const row = entry as Record<string, unknown>;
      const state = text(row.state);
      // Without a state a review says nothing — it is neither an approval, a
      // rejection nor a comment.
      if (!state) return [];
      return [
        {
          ...(login(row.author) ? { author: login(row.author)! } : {}),
          state,
          body: text(row.body),
          submittedAt: epoch(row.submittedAt),
        },
      ];
    })
    .sort((left, right) => left.submittedAt - right.submittedAt);
}

/**
 * How a commit status's one `state` becomes a check run's `status` plus
 * `conclusion`.
 *
 * `ERROR` BECOMES `FAILURE` because a check run has no `ERROR` conclusion and
 * every reader of this field would have to learn that a sixth word also means
 * red. `EXPECTED` is a status GitHub is waiting for and has not received, which
 * is queued rather than running.
 */
const STATUS_CONTEXT: Record<string, { status: string; conclusion?: string }> = {
  SUCCESS: { status: "COMPLETED", conclusion: "SUCCESS" },
  FAILURE: { status: "COMPLETED", conclusion: "FAILURE" },
  ERROR: { status: "COMPLETED", conclusion: "FAILURE" },
  PENDING: { status: "IN_PROGRESS" },
  EXPECTED: { status: "QUEUED" },
};

/**
 * The head commit's checks, from a rollup that mixes two GitHub types.
 *
 * THE `CheckRun` HALF IS MEASURED — `__typename`, `name`, `status`,
 * `conclusion`, `detailsUrl`, `workflowName`, against a real pull request. The
 * `StatusContext` half is GitHub's published GraphQL schema (`context`, `state`,
 * `targetUrl`) and is NOT verified here, because no repository within reach still
 * uses the older commit-status API. It is written to degrade rather than throw: an
 * entry this parser cannot name is dropped, so an unfamiliar shape costs a row
 * and not the panel.
 */
/**
 * The Actions job id inside a check's details URL.
 *
 * `https://github.com/o/r/actions/runs/18386406777/job/52385857117` — measured, and
 * the only place `gh`'s rollup carries the job. Anything not shaped like that (a
 * commit status's `targetUrl`, a third-party check's own dashboard) has no job and
 * therefore no log to fetch, which is a normal answer rather than a failure.
 */
export function parseJobId(url: string): string | undefined {
  const match = /\/actions\/runs\/\d+\/job\/(\d+)/.exec(url);
  return match?.[1];
}

/** How many lines of a failing log travel to a client. Enough to hold a stack
 *  trace and a test summary; short enough that dropping it into a message does not
 *  spend the context on runner boilerplate. */
export const MAX_CHECK_LOG_LINES = 200;

/**
 * A failing check's log, from the bottom.
 *
 * THE TAIL IS THE FAILURE. `--log-failed` opens with the runner's image
 * provisioner, its Azure region and its worker id; the error is at the end. Capping
 * from the front would return thirty lines about Ubuntu.
 *
 * PREFIXES STRIPPED. Every line is `job / step<TAB>STEP<TAB><ISO timestamp> message`.
 * The job and step are already on the check that asked, and the timestamp is noise
 * in a chat message, so only the message survives.
 */
export function parseCheckLog(stdout: string): { lines: string[]; truncated: boolean } {
  const all = stdout
    .split(/\r?\n/)
    .map((line) => {
      // The message is after the last tab; a line with no tabs is already bare.
      const tail = line.slice(line.lastIndexOf("\t") + 1);
      // `2026-08-12T16:25:32.4355162Z ` — and a BOM, which the first line carries.
      return tail.replace(/^﻿/, "").replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, "");
    })
    .filter((line) => line.trim().length > 0);
  if (all.length <= MAX_CHECK_LOG_LINES) return { lines: all, truncated: false };
  return { lines: all.slice(-MAX_CHECK_LOG_LINES), truncated: true };
}

/**
 * Ask for one job's failing log.
 *
 * `--log-failed` RATHER THAN `--log`, because a green job's full log is megabytes of
 * nothing anybody asked about and the question here is always "what broke".
 */
export async function readCheckLog(gh: GhRunner, cwd: string, jobId: string): Promise<GitHubCheckLog> {
  const result = await gh(cwd, ["run", "view", "--job", jobId, "--log-failed"]);
  if (result.status !== 0) {
    const message = result.stderr.trim() || result.stdout.trim();
    return { unavailable: message || "gh could not read this job's log." };
  }
  const parsed = parseCheckLog(result.stdout);
  // A job that failed without a failing STEP — cancelled, or the runner died — has
  // an empty `--log-failed`. Saying so beats an empty box.
  if (parsed.lines.length === 0) return { unavailable: "This job has no failing step to show a log for." };
  return parsed;
}

export function parseChecks(value: unknown): GitHubCheck[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = entry as Record<string, unknown>;
    // `name` for a check run, `context` for a commit status.
    const name = text(row.name) || text(row.context);
    if (!name) return [];
    const url = text(row.detailsUrl) || text(row.targetUrl);
    const workflow = text(row.workflowName);
    // A check run carries its own status; a commit status has only `state`.
    const status = text(row.status);
    if (status) {
      const conclusion = text(row.conclusion);
      const jobId = parseJobId(url);
      return [
        {
          name,
          status,
          ...(conclusion ? { conclusion } : {}),
          ...(workflow ? { workflow } : {}),
          ...(url ? { url } : {}),
          ...(jobId ? { jobId } : {}),
        },
      ];
    }
    const mapped = STATUS_CONTEXT[text(row.state)];
    if (!mapped) return [];
    return [
      {
        name,
        status: mapped.status,
        ...(mapped.conclusion ? { conclusion: mapped.conclusion } : {}),
        ...(url ? { url } : {}),
      },
    ];
  });
}

export function parseIssueDetail(stdout: string, now: number, projects: string[] = []): GitHubIssueDetail {
  const row = JSON.parse(stdout) as Record<string, unknown>;
  const base = issueRow(row);
  if (!base) throw new Error("gh returned an issue with no number");
  const thread = parseComments(row.comments);
  const closedAt = epoch(row.closedAt);
  return {
    // `base` already carries the author, labels, assignees, milestone and state
    // reason — every field a ROW has, parsed by the one function both readers use.
    ...base,
    projects,
    body: text(row.body),
    comments: thread.comments,
    olderComments: thread.olderComments,
    createdAt: epoch(row.createdAt),
    // `epoch` answers 0 for an absent date, and an open issue has no closing
    // time — 0 would render as January 1970.
    ...(closedAt ? { closedAt } : {}),
    readAt: now,
  };
}

/**
 * Which merge methods a repository allows.
 *
 * ALL THREE WHEN THE READ FAILED, not none. An unknown setting must not disable
 * merging — the worst case of guessing generously is one refusal that names
 * itself (`method_not_allowed`), and the worst case of guessing meanly is a
 * button that cannot be pressed for a reason nobody can see.
 */
export function parseMergeMethods(stdout: string): GitHubMergeMethod[] {
  try {
    const row = JSON.parse(stdout) as Record<string, unknown>;
    const allowed: GitHubMergeMethod[] = [];
    if (row.mergeCommitAllowed === true) allowed.push("merge");
    if (row.squashMergeAllowed === true) allowed.push("squash");
    if (row.rebaseMergeAllowed === true) allowed.push("rebase");
    // A repository with every method off cannot be merged through this route at
    // all, and `gh` reporting that is different from `gh` not answering — so an
    // explicit "none allowed" is honoured rather than widened to all three.
    return row.mergeCommitAllowed === undefined ? ["merge", "squash", "rebase"] : allowed;
  } catch {
    return ["merge", "squash", "rebase"];
  }
}

const MERGE_METHOD_FIELDS = "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed";

export function parsePullDetail(
  stdout: string,
  now: number,
  mergeMethods: GitHubMergeMethod[] = [],
  projects: string[] = [],
): GitHubPullDetail {
  const row = JSON.parse(stdout) as Record<string, unknown>;
  const base = pullRow(row);
  if (!base) throw new Error("gh returned a pull request with no number");
  const thread = parseComments(row.comments);
  const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0);
  return {
    // Labels, assignees, milestone, the merge time and the review decision all
    // come from `pullRow`, which the list read uses too.
    ...base,
    projects,
    body: text(row.body),
    ...(text(row.baseRefName) ? { baseRefName: text(row.baseRefName) } : {}),
    ...(text(row.headRefOid) ? { headRefOid: text(row.headRefOid) } : {}),
    // `UNKNOWN` rather than an empty string when GitHub has not computed it:
    // it is GitHub's own word for "ask again", and every client already has to
    // handle it.
    mergeable: text(row.mergeable) || "UNKNOWN",
    mergeStateStatus: text(row.mergeStateStatus) || "UNKNOWN",
    mergeMethods,
    additions: count(row.additions),
    deletions: count(row.deletions),
    changedFiles: count(row.changedFiles),
    comments: thread.comments,
    olderComments: thread.olderComments,
    reviews: parseReviews(row.reviews),
    checks: parseChecks(row.statusCheckRollup),
    createdAt: epoch(row.createdAt),
    ...(login(row.mergedBy) ? { mergedBy: login(row.mergedBy)! } : {}),
    readAt: now,
  };
}

const ISSUE_DETAIL_FIELDS = "number,title,state,stateReason,author,body,labels,assignees,milestone,comments,createdAt,updatedAt,url,closedAt";
const PULL_DETAIL_FIELDS =
  "number,title,state,isDraft,author,body,labels,assignees,baseRefName,headRefName,headRefOid,reviewDecision,mergeable,mergeStateStatus,additions,deletions,changedFiles,comments,reviews,statusCheckRollup,createdAt,updatedAt,url,mergedAt,mergedBy";

/**
 * Which kind of nothing a DETAIL read is.
 *
 * The list's four, plus the one only this read can produce: `gh` answers
 * "GraphQL: Could not resolve to a PullRequest with the number of 999999"
 * — measured — and that is a typo, not a broken machine.
 */
export function classifyDetailFailure(result: GhResult): { unavailable: GitHubDetailUnavailable; message?: string } {
  if (`${result.stderr}\n${result.stdout}`.toLowerCase().includes("could not resolve to")) return { unavailable: "not_found" };
  return classifyGhFailure(result);
}

/**
 * The boards ONE issue or pull request is on.
 *
 * Its own call for the same measured reason the list's is: `projectItems` needs
 * `read:project` and a token without it fails the whole `--json` query. Asked
 * beside the detail rather than inside it, a missing scope costs the board chips
 * and not the issue.
 */
async function readBoards(gh: GhRunner, cwd: string, kind: "issue" | "pr", number: number, skip?: boolean): Promise<string[]> {
  if (skip) return [];
  const result = await gh(cwd, [kind, "view", String(number), "--json", "number,projectItems"]);
  if (result.status !== 0) return [];
  try {
    // `view` answers one object where `list` answers an array; the list parser
    // handles both by being handed a one-element array.
    return parseProjectItems(`[${result.stdout}]`).get(number) ?? [];
  } catch {
    return [];
  }
}

export async function readIssue(
  gh: GhRunner,
  cwd: string,
  number: number,
  now: () => number = Date.now,
  options: { skipProjects?: boolean } = {},
): Promise<GitHubIssueRead> {
  const [result, boards] = await Promise.all([
    gh(cwd, ["issue", "view", String(number), "--json", ISSUE_DETAIL_FIELDS]),
    readBoards(gh, cwd, "issue", number, options.skipProjects),
  ]);
  if (result.status !== 0) return classifyDetailFailure(result);
  try {
    return { issue: parseIssueDetail(result.stdout, now(), boards) };
  } catch {
    return { unavailable: "failed", message: "gh returned output this engine could not read" };
  }
}

/**
 * One pull request.
 *
 * TWO CALLS, CONCURRENTLY, for the same reason `readGitHub` makes three: the
 * repository's allowed merge methods are needed by the same surface at the same
 * moment, and a second sequential round trip would double the time this takes for
 * a fact that costs nothing to fetch alongside. The repository read failing is not
 * a failure of this read — `parseMergeMethods` widens to all three and the merge
 * itself is what finds out.
 */
export async function readPull(
  gh: GhRunner,
  cwd: string,
  number: number,
  now: () => number = Date.now,
  options: { skipProjects?: boolean } = {},
): Promise<GitHubPullRead> {
  const [result, repo, boards] = await Promise.all([
    gh(cwd, ["pr", "view", String(number), "--json", PULL_DETAIL_FIELDS]),
    gh(cwd, ["repo", "view", "--json", MERGE_METHOD_FIELDS]),
    readBoards(gh, cwd, "pr", number, options.skipProjects),
  ]);
  if (result.status !== 0) return classifyDetailFailure(result);
  try {
    return { pull: parsePullDetail(result.stdout, now(), parseMergeMethods(repo.status === 0 ? repo.stdout : ""), boards) };
  } catch {
    return { unavailable: "failed", message: "gh returned output this engine could not read" };
  }
}

// ── merging ────────────────────────────────────────────────────────────────

/**
 * Why `gh pr merge` refused, when the engine could not already tell.
 *
 * MATCHED ON PHRASING, LIKE `classifyGhFailure`, AND FOR THE SAME REASON: every
 * one of these exits 1. The difference is that this classifier handles only three
 * of the seven refusals — `not_open`, `conflicted`, `head_moved` and a draft are
 * decided from the pull request's own fields BEFORE GitHub is asked (see
 * `mergePull`), so they are facts rather than string matches. What is left over
 * degrades to `failed` with `gh`'s own words, which is a sentence a person can
 * act on even when this function guesses wrong.
 */
export function classifyMergeFailure(result: GhResult): { refusal: GitHubMergeRefusal; message?: string } {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  const message = result.stderr.trim() || result.stdout.trim();
  const carry = message ? { message } : {};
  /**
   * THE ORDER IS THE WHOLE FUNCTION, and it is measured rather than guessed.
   *
   * `gh` uses "Pull request #N is not mergeable: <reason>" as a PREFIX for
   * several unrelated refusals. Measured against a real blocked pull request:
   *
   *   X Pull request cli/cli#14120 is not mergeable: the base branch policy
   *     prohibits the merge.
   *
   * Branch protection, wearing the words for a conflict. A classifier that
   * matched "not mergeable" first — as the first version of this one did —
   * tells the reader to go and rebase a branch that has nothing wrong with it.
   * So every specific reason is tried before the generic phrase, and the generic
   * phrase means "conflict" only once nothing else has claimed it.
   */
  if (text.includes("head branch was modified") || text.includes("head sha") || text.includes("match-head-commit")) {
    // Belt and braces: the engine checks the head itself, and this catches a
    // commit that landed in the seconds between that check and the merge.
    return { refusal: "head_moved", ...carry };
  }
  if (text.includes("already merged") || text.includes("is closed") || text.includes("not open")) {
    return { refusal: "not_open", ...carry };
  }
  if (
    text.includes("must have") ||
    text.includes("permission") ||
    text.includes("not accessible") ||
    text.includes("http 403") ||
    text.includes("write access")
  ) {
    return { refusal: "not_permitted", ...carry };
  }
  if (text.includes("not allowed") || text.includes("is not enabled")) {
    return { refusal: "method_not_allowed", ...carry };
  }
  // Branch protection: a base-branch policy, a required review, a required
  // check. This has to come BEFORE the conflict test — see above.
  if (text.includes("branch policy") || text.includes("protected") || text.includes("required") || text.includes("blocked")) {
    return { refusal: "blocked", ...carry };
  }
  if (text.includes("not mergeable") || text.includes("merge conflict") || text.includes("cannot be cleanly created")) {
    return { refusal: "conflicted", ...carry };
  }
  return { refusal: "failed", ...carry };
}

/** GitHub's `mergeable`, when it means the trees do not combine. `UNKNOWN` is
 *  not on this list on purpose — it means GitHub has not finished computing. */
const CONFLICTING = "CONFLICTING";

/**
 * Merge a pull request.
 *
 * PINNED TO THE HEAD THE READER SAW. `expectedHeadOid` is the `headRefOid` a
 * detail read returned, and it travels two ways: the engine compares it against a
 * fresh read, and `--match-head-commit` makes GitHub compare it again at the
 * moment of the merge. Without it, a person reviews one diff, an agent pushes
 * another commit, and the button merges code nobody looked at.
 *
 * FOUR REFUSALS ARE DECIDED HERE, FROM DATA, and GitHub is not asked at all when
 * one of them holds: a pull request that is not open, a draft, one GitHub reports
 * as conflicting, or one whose head has moved. That is worth a round trip — it
 * turns four of the seven answers from a phrase match into a fact, and it means a
 * refusal costs nothing on GitHub's side.
 *
 * NO `--delete-branch`, NO `--admin`, NO `--auto`. Deleting the head branch is a
 * second destructive act on a branch a session's worktree may be sitting on;
 * `--admin` bypasses the protection the repository asked for; `--auto` would turn
 * a button that says "merge" into one that means "merge later, without me".
 */
export async function mergePull(
  gh: GhRunner,
  cwd: string,
  input: { number: number; method: GitHubMergeMethod; expectedHeadOid: string },
  now: () => number = Date.now,
): Promise<GitHubMergeResult> {
  const before = await readPull(gh, cwd, input.number, now);
  if (!("pull" in before)) {
    // The read failed, so nothing is known about the pull request — including
    // whether merging it would be safe. `not_found` is its own refusal; anything
    // else carries the read's own explanation.
    return before.unavailable === "not_found"
      ? { merged: false, refusal: "not_open", message: `There is no pull request #${input.number} in this repository.` }
      : { merged: false, refusal: "failed", ...(before.message ? { message: before.message } : {}) };
  }
  const pull = before.pull;
  if (pull.state.toUpperCase() !== "OPEN") {
    return {
      merged: false,
      refusal: "not_open",
      message: pull.mergedAt ? `#${pull.number} was already merged.` : `#${pull.number} is ${pull.state.toLowerCase()}.`,
    };
  }
  if (pull.isDraft) {
    return { merged: false, refusal: "blocked", message: `#${pull.number} is still a draft. Mark it ready for review first.` };
  }
  if (pull.mergeable.toUpperCase() === CONFLICTING) {
    return { merged: false, refusal: "conflicted", message: `#${pull.number} conflicts with ${pull.baseRefName ?? "its base branch"}.` };
  }
  /**
   * GITHUB ALREADY SAID IT. `mergeStateStatus: "BLOCKED"` is GitHub's own word for
   * "the merge is blocked", and it is why its own merge button is greyed out. This
   * check is here because MEASURING the alternative was unpleasant: `gh` reports
   * the same situation as "is not mergeable: the base branch policy prohibits the
   * merge", which reads like a conflict and is not one. One field beats one
   * sentence, so the field decides and the phrase matcher is left with less to do.
   */
  if (pull.mergeStateStatus.toUpperCase() === "BLOCKED") {
    return {
      merged: false,
      refusal: "blocked",
      message: `GitHub is blocking #${pull.number}: a required review or a required check is not satisfied.`,
    };
  }
  if (pull.headRefOid && pull.headRefOid !== input.expectedHeadOid) {
    return {
      merged: false,
      refusal: "head_moved",
      message: `A commit landed on ${pull.headRefName ?? "the head branch"} after this page was read.`,
    };
  }

  const merge = await gh(cwd, [
    "pr",
    "merge",
    String(input.number),
    `--${input.method}`,
    "--match-head-commit",
    input.expectedHeadOid,
  ]);
  if (merge.status !== 0) {
    const failure = classifyMergeFailure(merge);
    return { merged: false, ...failure };
  }
  /**
   * READ IT BACK, and report what the read says rather than what the merge said.
   *
   * The pull request now has a merge commit, a merger and a closed state, and the
   * surface has to show them. Reporting the pre-merge record with a success flag
   * is exactly the stale-header bug the file editor had.
   */
  const after = await readPull(gh, cwd, input.number, now);
  if ("pull" in after) return { merged: true, pull: after.pull };
  // The merge SUCCEEDED and the confirming read did not. Reporting a refusal here
  // would be a lie about a merged pull request, so the pre-merge record goes back
  // with the fields the merge is now known to have changed.
  return { merged: true, pull: { ...pull, state: "MERGED", mergedAt: now(), readAt: now() } };
}
