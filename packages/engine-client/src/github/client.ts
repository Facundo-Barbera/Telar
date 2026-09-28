import type { EngineTransport } from "../platform/transport";
import { forgeQuery } from "./query";
import type {
  GitHubCheckLog,
  GitHubFacets,
  GitHubIssueFilter,
  GitHubIssueRead,
  GitHubLineCommentInput,
  GitHubLineCommentResult,
  GitHubMergeMethod,
  GitHubMergeResult,
  GitHubPullAnchor,
  GitHubPullCreateResult,
  GitHubPullFilter,
  GitHubPullRead,
  GitHubReactionContent,
  GitHubReactionResult,
  GitHubSnapshot,
  GitHubThreadReplyResult,
  GitHubThreadResolveResult,
} from "./schema";

const forgePath = (projectId: string) => `/v2/projects/${encodeURIComponent(projectId)}/github`;
const threadPath = (projectId: string, number: number, threadId: string) => `${forgePath(projectId)}/pulls/${number}/threads/${encodeURIComponent(threadId)}`;
const sessionPullPath = (sessionId: string) => `/v2/sessions/${encodeURIComponent(sessionId)}/github/pull`;
const refreshed = (options: { refresh?: boolean }) => (options.refresh ? "?refresh=1" : "");

export const githubClient = {
  /** Cached for thirty seconds in the engine; `refresh` is a person pressing the button. */
  projectGitHub(
    this: EngineTransport,
    projectId: string,
    options: { refresh?: boolean; issues?: GitHubIssueFilter; pulls?: GitHubPullFilter } = {},
  ): Promise<{ github: GitHubSnapshot }> {
    return this.request("GET", `${forgePath(projectId)}${forgeQuery(options)}`);
  },

  projectForgeFacets(this: EngineTransport, projectId: string, options: { refresh?: boolean } = {}): Promise<{ facets: GitHubFacets }> {
    return this.request("GET", `${forgePath(projectId)}/facets${refreshed(options)}`);
  },

  projectCheckLog(this: EngineTransport, projectId: string, jobId: string): Promise<{ log: GitHubCheckLog }> {
    return this.request("GET", `${forgePath(projectId)}/checks/${encodeURIComponent(jobId)}/log`);
  },

  projectIssue(this: EngineTransport, projectId: string, number: number, options: { refresh?: boolean } = {}): Promise<GitHubIssueRead> {
    return this.request("GET", `${forgePath(projectId)}/issues/${number}${refreshed(options)}`);
  },

  projectPull(this: EngineTransport, projectId: string, number: number, options: { refresh?: boolean } = {}): Promise<GitHubPullRead> {
    return this.request("GET", `${forgePath(projectId)}/pulls/${number}${refreshed(options)}`);
  },

  mergeProjectPull(
    this: EngineTransport,
    projectId: string,
    number: number,
    input: { method: GitHubMergeMethod; expectedHeadOid: string },
  ): Promise<GitHubMergeResult> {
    return this.request("POST", `${forgePath(projectId)}/pulls/${number}/merge`, input);
  },

  reactOnProjectForge(
    this: EngineTransport,
    projectId: string,
    kind: "issue" | "pull",
    number: number,
    input: { subjectId: string; content: GitHubReactionContent; react: boolean },
  ): Promise<GitHubReactionResult> {
    return this.request("POST", `${forgePath(projectId)}/${kind === "issue" ? "issues" : "pulls"}/${number}/reactions`, input);
  },

  replyToProjectThread(this: EngineTransport, projectId: string, number: number, threadId: string, body: string): Promise<GitHubThreadReplyResult> {
    return this.request("POST", `${threadPath(projectId, number, threadId)}/replies`, { body });
  },

  resolveProjectThread(this: EngineTransport, projectId: string, number: number, threadId: string, resolved: boolean): Promise<GitHubThreadResolveResult> {
    return this.request("POST", `${threadPath(projectId, number, threadId)}/resolve`, { resolved });
  },

  openSessionPullRequest(this: EngineTransport, sessionId: string, input: { title: string; body?: string; base?: string }): Promise<GitHubPullCreateResult> {
    return this.request("POST", sessionPullPath(sessionId), input);
  },

  sessionPullAnchor(this: EngineTransport, sessionId: string): Promise<GitHubPullAnchor> {
    return this.request("GET", `${sessionPullPath(sessionId)}/anchor`);
  },

  commentOnSessionPullLine(this: EngineTransport, sessionId: string, input: GitHubLineCommentInput): Promise<GitHubLineCommentResult> {
    return this.request("POST", `${sessionPullPath(sessionId)}/comments`, input);
  },
};
