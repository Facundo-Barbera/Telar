import type { GitHubLineCommentInput, GitHubLineCommentResult, GitHubPullAnchor, GitHubPullCreateResult, Project, Session } from "@telar/engine-client";
import { porcelainPaths } from "../../platform/git/parse";
import type { AsyncGitRunner } from "../../platform/git/runner";
import { EngineStateError } from "../../platform/kernel";
import { defaultRemoteBaseAsync, listGitRefsAsync, pullRequestBlockedBy, sessionBranchFacts } from "../git";
import { workspaceRootOf } from "../sessions";
import type { GhRunner } from "./gh";
import { commentOnPullLine, openPullRequest, readPullFiles, readPullForBranch } from "./pulls";
import type { GitHubStore } from "./store";

/** A base this engine will put in `gh`'s argv: no leading `-`, space, `$` or quote, so it cannot become a flag or a second argument. */
const REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export type SessionPullsHost = {
  getSession(sessionId: string): Session;
  getProject(projectId: string): Project;
  /** The mutation pool: remote reads and `gh` writes must not hold the rail's read slots. */
  worktreeGit: AsyncGitRunner;
  asyncGit: AsyncGitRunner;
  gh: GhRunner;
};

/** A worktree session's pull request. The head branch always comes off the session record, never the caller. */
export class SessionPulls {
  constructor(
    private readonly github: GitHubStore,
    private readonly host: SessionPullsHost,
  ) {}

  /** Refuses from local facts before `gh` is asked; only the base is the caller's choice, defaulted to the remote's default branch. */
  async open(sessionId: string, input: { title: string; body?: string; base?: string }): Promise<GitHubPullCreateResult> {
    const session = this.host.getSession(sessionId);
    const workspace = session.workspace;
    if (workspace.mode !== "worktree") {
      return {
        opened: false,
        refusal: "not_pushed",
        message: "This session works in the project's own checkout, so it has no branch of its own to open a pull request for.",
      };
    }
    if (session.projectId === undefined) throw new EngineStateError("invalid_request", "this session has no project");
    const project = this.host.getProject(session.projectId);
    const cwd = workspaceRootOf(session);
    const branch = workspace.branch;

    const facts = await sessionBranchFacts(this.host.worktreeGit, cwd);
    const blocked = pullRequestBlockedBy(facts, branch);
    if (blocked) return { opened: false, refusal: "failed", message: blocked.message };
    if (facts.upstream !== true) {
      return { opened: false, refusal: "not_pushed", message: `origin has never seen ${branch}. Push it first, and this becomes available.` };
    }

    const base = input.base?.trim() || (await this.defaultBase(project.root));
    if (!base) {
      return { opened: false, refusal: "failed", message: "This engine could not work out which branch to open the pull request against." };
    }
    if (!REF_NAME.test(base)) throw new EngineStateError("invalid_request", "that is not a branch name");

    const result = await openPullRequest(this.host.gh, cwd, { head: branch, base, title: input.title, body: input.body ?? "", sessionId: session.id });
    if (result.opened) this.github.forgetLists(project.id);
    return structuredClone(result);
  }

  /** Read when asked, never cached: HEAD, the dirty paths and the pull request's head are compared as they are now. */
  async anchor(sessionId: string): Promise<GitHubPullAnchor> {
    const session = this.host.getSession(sessionId);
    const workspace = session.workspace;
    if (workspace.mode !== "worktree") return { dirty: [], files: [] };
    const cwd = workspaceRootOf(session);
    const [pull, local] = await Promise.all([readPullForBranch(this.host.gh, cwd, workspace.branch), this.headAndDirty(cwd)]);
    if (!pull) return { ...local, files: [] };
    return { pull, ...local, files: await readPullFiles(this.host.gh, cwd, pull.number) };
  }

  /** `stale` unless the anchored commit is still both the checkout's HEAD and the pull request's head. */
  async lineComment(sessionId: string, input: GitHubLineCommentInput): Promise<GitHubLineCommentResult> {
    const session = this.host.getSession(sessionId);
    const workspace = session.workspace;
    if (workspace.mode !== "worktree") {
      return { commented: false, refusal: "not_found", message: "This session has no branch of its own, so it has no pull request." };
    }
    const cwd = workspaceRootOf(session);
    const [pull, local] = await Promise.all([readPullForBranch(this.host.gh, cwd, workspace.branch), this.headAndDirty(cwd)]);
    if (!pull) return { commented: false, refusal: "not_found", message: `${workspace.branch} has no open pull request.` };
    if (pull.headRefOid !== input.commitId || local.head !== input.commitId || local.dirty.includes(input.path)) {
      return { commented: false, refusal: "stale", message: "The branch moved after this diff was read. Refresh and select the lines again." };
    }
    const result = await commentOnPullLine(this.host.gh, cwd, pull.number, input);
    if (result.commented && session.projectId !== undefined) this.github.forgetDetail(session.projectId, "pull", pull.number);
    return structuredClone(result);
  }

  private async headAndDirty(cwd: string): Promise<{ head?: string; dirty: string[] }> {
    const [head, status] = await Promise.all([this.host.asyncGit(cwd, ["rev-parse", "HEAD"]), this.host.asyncGit(cwd, ["status", "--porcelain=v1", "-z"])]);
    // Without the dirty list no line can be called safe, so a failed status leaves HEAD out too.
    const sha = head.status === 0 && status.status === 0 ? head.stdout.trim() : "";
    return { ...(sha ? { head: sha } : {}), dirty: status.status === 0 ? porcelainPaths(status.stdout) : [] };
  }

  /** `origin/main` is what a worktree is cut from; `main` is what `gh pr create --base` takes. */
  private async defaultBase(projectRoot: string): Promise<string | undefined> {
    const listing = await listGitRefsAsync(this.host.worktreeGit, projectRoot);
    const qualified = await defaultRemoteBaseAsync(this.host.worktreeGit, projectRoot, listing);
    return qualified?.replace(/^origin\//, "");
  }
}
