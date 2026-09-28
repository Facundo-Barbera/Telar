import type { GitHubIssueFilter, GitHubPullFilter } from "./schema";

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
