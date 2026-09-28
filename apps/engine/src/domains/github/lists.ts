import type { GitHubFacets, GitHubIssue, GitHubIssueFilter, GitHubMilestone, GitHubPullFilter, GitHubPullRequest, GitHubSnapshot } from "@telar/engine-client";
import { authorOf, classifyGhFailure, epoch, type GhResult, type GhRunner, GITHUB_PAGE_SIZE, labels, links, login, logins, milestone, parseRepoFromUrl, text } from "./gh";

function rowFields(row: Record<string, unknown>) {
  return {
    ...authorOf(row.author, text(row.url)),
    labels: labels(row.labels),
    assignees: logins(row.assignees),
    ...(milestone(row.milestone) ? { milestone: milestone(row.milestone)! } : {}),
    projects: [] as string[],
    updatedAt: epoch(row.updatedAt),
    url: text(row.url) || `#${typeof row.number === "number" ? row.number : 0}`,
  };
}

export function issueRow(row: Record<string, unknown>): GitHubIssue | undefined {
  const number = typeof row.number === "number" ? row.number : 0;
  if (number <= 0) return undefined;
  return {
    number,
    title: text(row.title),
    state: text(row.state) || "OPEN",
    ...(text(row.stateReason) ? { stateReason: text(row.stateReason) } : {}),
    linkedPulls: links(row.closedByPullRequestsReferences, parseRepoFromUrl(text(row.url))),
    ...rowFields(row),
  };
}

export function pullRow(row: Record<string, unknown>): GitHubPullRequest | undefined {
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
    ...(mergedAt ? { mergedAt } : {}),
    linkedIssues: links(row.closingIssuesReferences, parseRepoFromUrl(text(row.url))),
    ...rowFields(row),
  };
}

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

const ISSUE_FIELDS = "number,title,state,stateReason,labels,author,assignees,milestone,updatedAt,url,closedByPullRequestsReferences";
const PULL_FIELDS =
  "number,title,state,isDraft,author,assignees,milestone,labels,headRefName,updatedAt,url,reviewDecision,mergedAt,closingIssuesReferences";

export function parseProjectItems(stdout: string): Map<number, string[]> {
  const byNumber = new Map<number, string[]>();
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) return byNumber;
  for (const entry of parsed) {
    const row = entry as Record<string, unknown>;
    const number = typeof row.number === "number" ? row.number : 0;
    if (number <= 0) continue;
    const items = row.projectItems;
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

export function classifyProjectFailure(result: GhResult): "scope" | "failed" {
  return `${result.stderr}\n${result.stdout}`.toLowerCase().includes("read:project") ? "scope" : "failed";
}

export const DEFAULT_ISSUE_FILTER: GitHubIssueFilter = { state: "open", labels: [] };
export const DEFAULT_PULL_FILTER: GitHubPullFilter = { state: "open", labels: [] };

export function listArgv(kind: "issue" | "pr", filter: GitHubIssueFilter | GitHubPullFilter, fields: string): string[] {
  const argv = [kind, "list", "--state", filter.state, "--limit", String(GITHUB_PAGE_SIZE)];
  const milestone = (filter as GitHubIssueFilter).milestone;
  if (kind === "issue" && milestone) argv.push("--milestone", milestone);
  if (filter.assignee) argv.push("--assignee", filter.assignee);
  if (filter.author) argv.push("--author", filter.author);
  for (const label of filter.labels) argv.push("--label", label);
  argv.push("--json", fields);
  return argv;
}

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
      return { rows: [], failure: { unavailable: "failed", message: "gh returned output this engine could not read" } };
    }
  };

  const issueRead = read(issues, parseIssues);
  const pullRead = read(pulls, parsePulls);
  const failure = issueRead.failure ?? pullRead.failure;

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

export const MAX_FACET_VALUES = 100;

function apiArray(result: GhResult): Record<string, unknown>[] {
  if (result.status !== 0) return [];
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
}

function parseMilestones(result: GhResult): GitHubMilestone[] {
  return apiArray(result)
    .flatMap((row) => {
      const title = text(row.title);
      if (!title) return [];
      const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0);
      return [{ title, open: count(row.open_issues), closed: count(row.closed_issues) }];
    })
    .slice(0, MAX_FACET_VALUES);
}

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

function parseLabelList(result: GhResult) {
  if (result.status !== 0) return [];
  try {
    return labels(JSON.parse(result.stdout)).slice(0, MAX_FACET_VALUES);
  } catch {
    return [];
  }
}
