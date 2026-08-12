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
import type { GitHubIssue, GitHubPullRequest, GitHubSnapshot, GitHubUnavailable } from "@telar/engine-client";

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

export function parseIssues(stdout: string): GitHubIssue[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    const row = entry as Record<string, unknown>;
    const number = typeof row.number === "number" ? row.number : 0;
    if (number <= 0) return [];
    return [
      {
        number,
        title: text(row.title),
        state: text(row.state) || "OPEN",
        ...(login(row.author) ? { author: login(row.author)! } : {}),
        labels: Array.isArray(row.labels)
          ? row.labels.flatMap((label) => {
              const record = label as Record<string, unknown>;
              const name = text(record.name);
              return name ? [{ name, ...(text(record.color) ? { color: text(record.color) } : {}) }] : [];
            })
          : [],
        updatedAt: epoch(row.updatedAt),
        url: text(row.url) || `#${number}`,
      },
    ];
  });
}

export function parsePulls(stdout: string): GitHubPullRequest[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    const row = entry as Record<string, unknown>;
    const number = typeof row.number === "number" ? row.number : 0;
    if (number <= 0) return [];
    return [
      {
        number,
        title: text(row.title),
        state: text(row.state) || "OPEN",
        isDraft: row.isDraft === true,
        ...(login(row.author) ? { author: login(row.author)! } : {}),
        ...(text(row.headRefName) ? { headRefName: text(row.headRefName) } : {}),
        ...(text(row.reviewDecision) ? { reviewDecision: text(row.reviewDecision) } : {}),
        updatedAt: epoch(row.updatedAt),
        url: text(row.url) || `#${number}`,
      },
    ];
  });
}

const ISSUE_FIELDS = "number,title,state,labels,author,updatedAt,url";
const PULL_FIELDS = "number,title,state,isDraft,author,headRefName,updatedAt,url,reviewDecision";

/**
 * One read of a project's issues and pull requests.
 *
 * BOTH IN ONE CALL, CONCURRENTLY, because they are one panel gesture: a reader
 * opening the Issues tab will open Pull requests seconds later, and two
 * sequential network round trips make the second one feel broken. They fail
 * independently — an org that disabled issues still has pull requests, and the
 * shape says so rather than reporting the whole repository as unavailable.
 */
export async function readGitHub(gh: GhRunner, cwd: string, now: () => number = Date.now): Promise<GitHubSnapshot> {
  const [issues, pulls, repo] = await Promise.all([
    gh(cwd, ["issue", "list", "--limit", String(GITHUB_PAGE_SIZE), "--json", ISSUE_FIELDS]),
    gh(cwd, ["pr", "list", "--limit", String(GITHUB_PAGE_SIZE), "--json", PULL_FIELDS]),
    gh(cwd, ["repo", "view", "--json", "nameWithOwner"]),
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

  return {
    ...(repository ? { repository } : {}),
    issues: issueRead.rows,
    pulls: pullRead.rows,
    ...(failure ? { unavailable: failure.unavailable, ...(failure.message ? { message: failure.message } : {}) } : {}),
    readAt: now(),
  };
}
