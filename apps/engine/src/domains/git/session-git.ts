import type { GitCommitEntry, GitignoreRemoval, GitignoreResult, GitPushResult, Project } from "@telar/engine-client";
import type { AsyncGitRunner } from "../../platform/git/runner";
import { EngineStateError, type Kernel } from "../../platform/kernel";
import { workspaceRootOf, type SessionRecords } from "../sessions";
import { cloneRepository, isCloneFailure } from "./clone";
import { removeTelarGitignore, ensureTelarGitignore } from "./gitignore";
import { commitSessionWork, pushSessionBranch } from "./push";

type SessionGitDeps = {
  records: SessionRecords;
  worktreeGit: AsyncGitRunner;
  forgetGitReadsUnder: (root: string) => void;
  getProject: (projectId: string) => Project;
  registerProject: (input: { name: string; root: string }) => Project;
};

/** The git a session's turns and buttons write: commit, push, clone and Telar's gitignore block. */
export class SessionGit {
  constructor(
    private readonly kernel: Kernel,
    private readonly deps: SessionGitDeps,
  ) {}

  /** One commit of the session's work in its own checkout; the message is checked before the first await. */
  commit(sessionId: string, message: string): Promise<{ committed: boolean; commit?: GitCommitEntry; reason?: string }> {
    const session = this.deps.records.get(sessionId);
    const text = message.trim();
    if (!text) throw new EngineStateError("invalid_request", "a commit message is required");
    if (text.length > 2_000) throw new EngineStateError("invalid_request", "commit message is too long");
    const cwd = workspaceRootOf(session);
    return commitSessionWork(this.deps.worktreeGit, { cwd, message: text }).finally(() => this.deps.forgetGitReadsUnder(cwd));
  }

  /** Publishes the session's branch. The checkout and branch come off the record, never the caller. */
  async push(sessionId: string): Promise<GitPushResult> {
    const session = this.deps.records.get(sessionId);
    const workspace = session.workspace;
    if (workspace.mode === "none") throw new EngineStateError("invalid_request", "this session has no working directory");
    const cwd = workspaceRootOf(session);
    try {
      return structuredClone(
        await pushSessionBranch(this.deps.worktreeGit, {
          cwd,
          mode: workspace.mode,
          ...(workspace.mode === "worktree" ? { branch: workspace.branch } : {}),
        }),
      );
    } finally {
      this.deps.forgetGitReadsUnder(cwd);
    }
  }

  /** Telar's own ignore rules; the lines are the engine's, so a caller can only name the project. */
  gitignore(projectId: string): GitignoreResult {
    return ensureTelarGitignore(this.deps.getProject(projectId).root);
  }

  undoGitignore(projectId: string): GitignoreRemoval {
    return removeTelarGitignore(this.deps.getProject(projectId).root);
  }

  /** Clones and registers what landed. A failed registration keeps the clone: it is the expensive, good half. */
  async cloneProject(input: { url: string; parent: string; name?: string }): Promise<Project> {
    const outcome = await cloneRepository(this.deps.worktreeGit, { url: input.url, parent: input.parent });
    if (isCloneFailure(outcome)) {
      throw new EngineStateError(outcome.code === "failed" ? "invalid_request" : outcome.code, outcome.message);
    }
    const folder = outcome.root.split("/").pop() ?? outcome.root;
    return this.deps.registerProject({ name: input.name?.trim() || folder, root: outcome.root });
  }
}
