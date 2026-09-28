import type { GitHubCheck, GitHubCheckLog, GitHubDetailUnavailable, GitHubIssueDetail, GitHubIssueRead, GitHubMergeMethod, GitHubPullDetail, GitHubPullRead, GitHubReviewThread } from "@telar/engine-client";
import { classifyGhFailure, epoch, type GhResult, type GhRunner, login, text } from "./gh";
import { issueRow, parseProjectItems, pullRow } from "./lists";
import { parseComments, parseReviews, readReviewThreads, readThread, STATUS_CONTEXT, type ThreadRead } from "./threads";

export function parseJobId(url: string): string | undefined {
  const match = /\/actions\/runs\/\d+\/job\/(\d+)/.exec(url);
  return match?.[1];
}

export const MAX_CHECK_LOG_LINES = 200;

export function parseCheckLog(stdout: string): { lines: string[]; truncated: boolean } {
  const all = stdout
    .split(/\r?\n/)
    .map((line) => {
      const tail = line.slice(line.lastIndexOf("\t") + 1);
      return tail.replace(/^﻿/, "").replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, "");
    })
    .filter((line) => line.trim().length > 0);
  if (all.length <= MAX_CHECK_LOG_LINES) return { lines: all, truncated: false };
  return { lines: all.slice(-MAX_CHECK_LOG_LINES), truncated: true };
}

export async function readCheckLog(gh: GhRunner, cwd: string, jobId: string): Promise<GitHubCheckLog> {
  const result = await gh(cwd, ["run", "view", "--job", jobId, "--log-failed"]);
  if (result.status !== 0) {
    const message = result.stderr.trim() || result.stdout.trim();
    return { unavailable: message || "gh could not read this job's log." };
  }
  const parsed = parseCheckLog(result.stdout);
  if (parsed.lines.length === 0) return { unavailable: "This job has no failing step to show a log for." };
  return parsed;
}

export function parseChecks(value: unknown): GitHubCheck[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = entry as Record<string, unknown>;
    const name = text(row.name) || text(row.context);
    if (!name) return [];
    const url = text(row.detailsUrl) || text(row.targetUrl);
    const workflow = text(row.workflowName);
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

export function parseIssueDetail(
  stdout: string,
  now: number,
  projects: string[] = [],
  second?: ThreadRead,
): GitHubIssueDetail {
  const row = JSON.parse(stdout) as Record<string, unknown>;
  const base = issueRow(row);
  if (!base) throw new Error("gh returned an issue with no number");
  const thread = parseComments(row.comments, second?.authors);
  const closedAt = epoch(row.closedAt);
  return {
    ...base,
    projects,
    body: text(row.body),
    comments: thread.comments,
    olderComments: thread.olderComments,
    ...(second?.reactions ? { reactions: second.reactions } : {}),
    ...(second?.subjectId ? { subjectId: second.subjectId } : {}),
    createdAt: epoch(row.createdAt),
    ...(closedAt ? { closedAt } : {}),
    readAt: now,
  };
}

export function parseMergeMethods(stdout: string): GitHubMergeMethod[] {
  try {
    const row = JSON.parse(stdout) as Record<string, unknown>;
    const allowed: GitHubMergeMethod[] = [];
    if (row.mergeCommitAllowed === true) allowed.push("merge");
    if (row.squashMergeAllowed === true) allowed.push("squash");
    if (row.rebaseMergeAllowed === true) allowed.push("rebase");
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
  second?: ThreadRead,
  review?: { threads: GitHubReviewThread[]; more: number },
): GitHubPullDetail {
  const row = JSON.parse(stdout) as Record<string, unknown>;
  const base = pullRow(row);
  if (!base) throw new Error("gh returned a pull request with no number");
  const thread = parseComments(row.comments, second?.authors);
  const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0);
  return {
    ...base,
    projects,
    body: text(row.body),
    ...(text(row.baseRefName) ? { baseRefName: text(row.baseRefName) } : {}),
    ...(text(row.headRefOid) ? { headRefOid: text(row.headRefOid) } : {}),
    mergeable: text(row.mergeable) || "UNKNOWN",
    mergeStateStatus: text(row.mergeStateStatus) || "UNKNOWN",
    mergeMethods,
    additions: count(row.additions),
    deletions: count(row.deletions),
    changedFiles: count(row.changedFiles),
    comments: thread.comments,
    olderComments: thread.olderComments,
    ...(second?.reactions ? { reactions: second.reactions } : {}),
    ...(second?.subjectId ? { subjectId: second.subjectId } : {}),
    ...(review ? { reviewThreads: review.threads, moreReviewThreads: review.more } : {}),
    reviews: parseReviews(row.reviews, text(row.url)),
    checks: parseChecks(row.statusCheckRollup),
    createdAt: epoch(row.createdAt),
    ...(login(row.mergedBy) ? { mergedBy: login(row.mergedBy)! } : {}),
    readAt: now,
  };
}

const ISSUE_DETAIL_FIELDS =
  "number,title,state,stateReason,author,body,labels,assignees,milestone,comments,createdAt,updatedAt,url,closedAt,closedByPullRequestsReferences";
const PULL_DETAIL_FIELDS =
  "number,title,state,isDraft,author,body,labels,assignees,baseRefName,headRefName,headRefOid,reviewDecision,mergeable,mergeStateStatus,additions,deletions,changedFiles,comments,reviews,statusCheckRollup,createdAt,updatedAt,url,mergedAt,mergedBy,closingIssuesReferences";

export function classifyDetailFailure(result: GhResult): { unavailable: GitHubDetailUnavailable; message?: string } {
  if (`${result.stderr}\n${result.stdout}`.toLowerCase().includes("could not resolve to")) return { unavailable: "not_found" };
  return classifyGhFailure(result);
}

async function readBoards(gh: GhRunner, cwd: string, kind: "issue" | "pr", number: number, skip?: boolean): Promise<string[]> {
  if (skip) return [];
  const result = await gh(cwd, [kind, "view", String(number), "--json", "number,projectItems"]);
  if (result.status !== 0) return [];
  try {
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
  const [result, boards, second] = await Promise.all([
    gh(cwd, ["issue", "view", String(number), "--json", ISSUE_DETAIL_FIELDS]),
    readBoards(gh, cwd, "issue", number, options.skipProjects),
    readThread(gh, cwd, number),
  ]);
  if (result.status !== 0) return classifyDetailFailure(result);
  try {
    return { issue: parseIssueDetail(result.stdout, now(), boards, second) };
  } catch {
    return { unavailable: "failed", message: "gh returned output this engine could not read" };
  }
}

export async function readPull(
  gh: GhRunner,
  cwd: string,
  number: number,
  now: () => number = Date.now,
  options: { skipProjects?: boolean } = {},
): Promise<GitHubPullRead> {
  const [result, repo, boards, second, review] = await Promise.all([
    gh(cwd, ["pr", "view", String(number), "--json", PULL_DETAIL_FIELDS]),
    gh(cwd, ["repo", "view", "--json", MERGE_METHOD_FIELDS]),
    readBoards(gh, cwd, "pr", number, options.skipProjects),
    readThread(gh, cwd, number),
    readReviewThreads(gh, cwd, number),
  ]);
  if (result.status !== 0) return classifyDetailFailure(result);
  try {
    return { pull: parsePullDetail(result.stdout, now(), parseMergeMethods(repo.status === 0 ? repo.stdout : ""), boards, second, review) };
  } catch {
    return { unavailable: "failed", message: "gh returned output this engine could not read" };
  }
}
