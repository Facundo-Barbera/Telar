import type { GitHubCheck, GitHubIssueFilter, GitHubMergeMethod, GitHubPullFilter, GitOverview } from "@telar/engine-client";
import { issueReference } from "@/lib/drag-reference";
import type { ForgeFilterChip } from "@/lib/github-forge";
import { canvasHref } from "@/lib/session-list";

export type IssueSessionStart =
  | { ok: true; href: string; text: string; baseRef: string }
  | { ok: false; reason: string };

/** Arms a worktree canvas via `?base=` and returns the issue reference to send; the first message creates the session. */
export function issueSessionStart(input: {
  issue: { number: number; title: string; url: string };
  projectId: string;
  projectName?: string;
  hostId?: string;
  git?: GitOverview;
  unreadable?: string;
}): IssueSessionStart {
  const name = input.projectName ?? "this project";
  if (!input.git) {
    return {
      ok: false,
      reason: input.unreadable
        ? `Telar could not read ${name}'s checkout, so it did not cut a worktree. ${input.unreadable}`
        : `Telar could not read ${name}'s checkout, so it did not cut a worktree.`,
    };
  }
  if (input.git.availability === "unmounted") {
    return { ok: false, reason: `The drive holding ${name} is not connected. Plug it back in and this will work again.` };
  }
  if (input.git.availability === "missing") {
    return { ok: false, reason: `The folder for ${name} is not on this machine any more, so there is nowhere to cut a worktree.` };
  }
  if (!input.git.repository) {
    return { ok: false, reason: `${name} is not a git repository, so a session on #${input.issue.number} cannot have a worktree of its own.` };
  }
  const baseRef = input.git.defaultBase ?? "HEAD";
  return {
    ok: true,
    href: canvasHref(input.projectId, input.hostId, { baseRef }),
    text: issueReference(input.issue).text,
    baseRef,
  };
}

export type ForgeListKind = "issues" | "pulls";

// `gh issue list` has no `merged` state.
export const STATES = {
  issues: [
    { id: "open", label: "Open" },
    { id: "closed", label: "Closed" },
    { id: "all", label: "All" },
  ],
  pulls: [
    { id: "open", label: "Open" },
    { id: "merged", label: "Merged" },
    { id: "closed", label: "Closed" },
    { id: "all", label: "All" },
  ],
} as const;

export type ForgeFilter = {
  state: GitHubIssueFilter["state"] | GitHubPullFilter["state"];
  milestone?: string;
  assignee?: string;
  author?: string;
  labels: string[];
};

export function githubQuery(kind: ForgeListKind, filter: ForgeFilter): { issues: GitHubIssueFilter } | { pulls: GitHubPullFilter } {
  if (kind === "issues") return { issues: filter as GitHubIssueFilter };
  return {
    pulls: {
      state: filter.state as GitHubPullFilter["state"],
      ...(filter.assignee ? { assignee: filter.assignee } : {}),
      ...(filter.author ? { author: filter.author } : {}),
      labels: filter.labels,
    },
  };
}

export function toggleLabel(filter: ForgeFilter, label: string): ForgeFilter {
  return { ...filter, labels: filter.labels.includes(label) ? filter.labels.filter((entry) => entry !== label) : [...filter.labels, label] };
}

export function clearChip(filter: ForgeFilter, chip: ForgeFilterChip): ForgeFilter {
  return chip.clear === "label"
    ? { ...filter, labels: filter.labels.filter((entry) => entry !== chip.value) }
    : { ...filter, [chip.clear]: undefined };
}

/** The engine's page size: a list exactly this long is probably truncated. */
const GITHUB_PAGE_HINT = 50;

export function listCount(count: number, label: string): string {
  if (count === 0) return `no ${label}`;
  return `${count}${count === GITHUB_PAGE_HINT ? "+" : ""} ${count === 1 ? label.replace(/s$/, "") : label}`;
}

export const METHOD_LABEL: Record<GitHubMergeMethod, string> = {
  merge: "Create a merge commit",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};

export function exactTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);
const QUIET_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL", "CANCELLED"]);

const finished = (check: GitHubCheck) => check.status.toUpperCase() === "COMPLETED" && Boolean(check.conclusion);

export function checkRunning(check: GitHubCheck): boolean {
  return !finished(check);
}

/** Failing or not finished: the checks somebody needs to look at. */
export function isNotable(check: GitHubCheck): boolean {
  return !finished(check) || !QUIET_CONCLUSIONS.has(check.conclusion!.toUpperCase());
}

export function hasFailed(check: GitHubCheck): boolean {
  return check.status.toUpperCase() === "COMPLETED" && FAILED_CONCLUSIONS.has(check.conclusion?.toUpperCase() ?? "");
}

export type CheckLogState =
  | { loading: true; lines?: undefined; truncated?: undefined; unavailable?: undefined }
  | { loading?: false; unavailable: string; lines?: undefined; truncated?: undefined }
  | { loading?: false; lines: string[]; truncated: boolean; unavailable?: undefined };

// An issue's closing-PR reference is a relation, not an outcome: an open issue can
// reference a PR that closed without merging, so only a closed issue says "closed by".
export function linkVerb(isPull: boolean, state: string): string {
  if (isPull) return "closes";
  return state.toUpperCase() === "CLOSED" ? "closed by" : "will close with";
}
