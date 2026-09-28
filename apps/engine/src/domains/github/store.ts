import type {
  GitHubCheckLog,
  GitHubCommentResult,
  GitHubFacets,
  GitHubIssueFilter,
  GitHubIssueRead,
  GitHubMergeMethod,
  GitHubMergeResult,
  GitHubPullFilter,
  GitHubPullRead,
  GitHubReactionContent,
  GitHubReactionResult,
  GitHubSnapshot,
  GitHubThreadReplyResult,
  GitHubThreadResolveResult,
  Project,
} from "@telar/engine-client";
import { assertId, EngineStateError, type Kernel } from "../../platform/kernel";
import { readCheckLog, readIssue, readPull } from "./detail";
import type { GhRunner } from "./gh";
import { DEFAULT_ISSUE_FILTER, DEFAULT_PULL_FILTER, readForgeFacets, readGitHub } from "./lists";
import { commentOn, mergePull, reactOn, replyToThread, resolveThread } from "./writes";

const GITHUB_CACHE_MS = 30_000;
const FACET_CACHE_MS = 5 * 60_000;

type GitHubDeps = {
  gh: GhRunner;
  getProject: (projectId: string) => Project;
  /** Throws unless the claim is live; the session id returned is the store's finding, not the caller's. */
  requireSenderClaim: (proof: { sessionId: string; runId: string; claimToken: string }) => { sessionId: string };
};

// Normalised so two spellings of one filter share an entry; `gh` ANDs labels regardless of order.
function listKey(projectId: string, issues: GitHubIssueFilter, pulls: GitHubPullFilter): string {
  const shape = (filter: GitHubIssueFilter | GitHubPullFilter) => ({
    state: filter.state,
    milestone: (filter as GitHubIssueFilter).milestone ?? "",
    assignee: filter.assignee ?? "",
    author: filter.author ?? "",
    labels: [...filter.labels].sort(),
  });
  return `${projectId}:${JSON.stringify([shape(issues), shape(pulls)])}`;
}

/** A positive whole number: it goes into an argv and a URL. */
function forgeNumber(value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new EngineStateError("invalid_request", "an issue or pull request number is required");
  return value;
}

/**
 * A project's issues and pull requests, the only network reads in the store:
 * lists and details are cached for thirty seconds (only `force` gets past),
 * filter facets for five minutes, and every write drops what it made stale.
 */
export class GitHubStore {
  private readonly lists = new Map<string, GitHubSnapshot>();
  private readonly details = new Map<string, GitHubIssueRead | GitHubPullRead>();
  private readonly facets = new Map<string, GitHubFacets>();
  // A token with no `read:project` is asked once; a forced read clears the verdict.
  private noProjectScope = false;

  constructor(
    private readonly kernel: Kernel,
    private readonly deps: GitHubDeps,
  ) {}

  async list(projectId: string, options: { force?: boolean; issues?: GitHubIssueFilter; pulls?: GitHubPullFilter } = {}): Promise<GitHubSnapshot> {
    const project = this.deps.getProject(projectId);
    const issues = options.issues ?? DEFAULT_ISSUE_FILTER;
    const pulls = options.pulls ?? DEFAULT_PULL_FILTER;
    const key = listKey(project.id, issues, pulls);
    const cached = this.lists.get(key);
    if (cached && !options.force && this.kernel.now() - cached.readAt < GITHUB_CACHE_MS) return structuredClone(cached);
    const skipProjects = this.noProjectScope && !options.force;
    const snapshot = await readGitHub(this.deps.gh, project.root, this.kernel.now, { issues, pulls, ...(skipProjects ? { skipProjects: true } : {}) });
    if (snapshot.projectsUnavailable === "scope") this.noProjectScope = true;
    else if (snapshot.projectsUnavailable === undefined && options.force) this.noProjectScope = false;
    // The known reason survives a skipped read, so the panel can still explain the missing boards.
    const answer = skipProjects && this.noProjectScope ? { ...snapshot, projectsUnavailable: "scope" as const } : snapshot;
    this.lists.set(key, answer);
    return structuredClone(answer);
  }

  /** Drops every cached list for a project, whichever filter it was read under. */
  forgetLists(projectId: string): void {
    for (const key of this.lists.keys()) {
      if (key === projectId || key.startsWith(`${projectId}:`)) this.lists.delete(key);
    }
  }

  forgetDetail(projectId: string, kind: "issue" | "pull", number: number): void {
    this.details.delete(`${projectId}:${kind}:${number}`);
  }

  async facetsOf(projectId: string, options: { force?: boolean } = {}): Promise<GitHubFacets> {
    const project = this.deps.getProject(projectId);
    const cached = this.facets.get(project.id);
    if (cached && !options.force && this.kernel.now() - cached.readAt < FACET_CACHE_MS) return structuredClone(cached);
    const facets = await readForgeFacets(this.deps.gh, project.root, this.kernel.now);
    this.facets.set(project.id, facets);
    return structuredClone(facets);
  }

  /** Not cached: a finished job's log never changes, and a running one must not be stale. */
  checkLog(projectId: string, jobId: string): Promise<GitHubCheckLog> {
    const project = this.deps.getProject(projectId);
    if (!/^\d+$/.test(jobId)) throw new EngineStateError("invalid_request", "a job id is a number");
    return readCheckLog(this.deps.gh, project.root, jobId);
  }

  issue(projectId: string, number: number, options: { force?: boolean } = {}): Promise<GitHubIssueRead> {
    return this.detail(projectId, "issue", number, (root) => readIssue(this.deps.gh, root, number, this.kernel.now), options);
  }

  pull(projectId: string, number: number, options: { force?: boolean } = {}): Promise<GitHubPullRead> {
    return this.detail(projectId, "pull", number, (root) => readPull(this.deps.gh, root, number, this.kernel.now), options);
  }

  /** Requires the head the merge was reviewed against; a success replaces the cached detail and drops the lists. */
  async merge(projectId: string, number: number, input: { method: GitHubMergeMethod; expectedHeadOid: string }): Promise<GitHubMergeResult> {
    const project = this.deps.getProject(projectId);
    const target = forgeNumber(number);
    if (!input.expectedHeadOid.trim()) throw new EngineStateError("invalid_request", "the head commit this merge was reviewed against is required");
    const result = await mergePull(this.deps.gh, project.root, { number: target, method: input.method, expectedHeadOid: input.expectedHeadOid }, this.kernel.now);
    this.details.delete(`${project.id}:pull:${target}`);
    if (result.merged) {
      this.forgetLists(project.id);
      this.details.set(`${project.id}:pull:${target}`, { pull: result.pull });
    }
    return structuredClone(result);
  }

  /** Attributed to the session found on the live claim; the marker is a claim that is ordinarily true, not a signature. */
  async comment(
    projectId: string,
    input: { kind: "issue" | "pull"; number: number; body: string },
    proof: { sessionId: string; runId: string; claimToken: string },
  ): Promise<GitHubCommentResult> {
    const project = this.deps.getProject(projectId);
    const target = forgeNumber(input.number);
    assertId(proof.sessionId, "sender session id");
    const claimed = this.deps.requireSenderClaim(proof);
    const result = await commentOn(this.deps.gh, project.root, { kind: input.kind, number: target, body: input.body, sessionId: claimed.sessionId });
    if (result.posted) this.details.delete(`${project.id}:${input.kind}:${target}`);
    return structuredClone(result);
  }

  /** A person's gesture, so no claim is checked. */
  async react(
    projectId: string,
    input: { kind: "issue" | "pull"; number: number; subjectId: string; content: GitHubReactionContent; react: boolean },
  ): Promise<GitHubReactionResult> {
    const project = this.deps.getProject(projectId);
    const target = forgeNumber(input.number);
    const result = await reactOn(this.deps.gh, project.root, { subjectId: input.subjectId, content: input.content, react: input.react });
    if (result.reacted) this.details.delete(`${project.id}:${input.kind}:${target}`);
    return structuredClone(result);
  }

  async threadReply(projectId: string, number: number, input: { threadId: string; body: string }): Promise<GitHubThreadReplyResult> {
    const project = this.deps.getProject(projectId);
    const target = forgeNumber(number);
    const result = await replyToThread(this.deps.gh, project.root, input);
    if (result.replied) this.details.delete(`${project.id}:pull:${target}`);
    return structuredClone(result);
  }

  async threadResolve(projectId: string, number: number, input: { threadId: string; resolved: boolean }): Promise<GitHubThreadResolveResult> {
    const project = this.deps.getProject(projectId);
    const target = forgeNumber(number);
    const result = await resolveThread(this.deps.gh, project.root, input);
    if (result.changed) this.details.delete(`${project.id}:pull:${target}`);
    return structuredClone(result);
  }

  // Only a read that worked is cached: every reason a detail read fails is fixed in under thirty seconds.
  private async detail<T extends GitHubIssueRead | GitHubPullRead>(
    projectId: string,
    kind: "issue" | "pull",
    number: number,
    read: (root: string) => Promise<T>,
    options: { force?: boolean },
  ): Promise<T> {
    const project = this.deps.getProject(projectId);
    const key = `${project.id}:${kind}:${forgeNumber(number)}`;
    const cached = this.details.get(key) as T | undefined;
    const readAt = cached && "issue" in cached ? cached.issue.readAt : cached && "pull" in cached ? cached.pull.readAt : undefined;
    if (readAt !== undefined && !options.force && this.kernel.now() - readAt < GITHUB_CACHE_MS) return structuredClone(cached!);
    const answer = await read(project.root);
    if ("issue" in answer || "pull" in answer) this.details.set(key, answer);
    return structuredClone(answer);
  }
}
