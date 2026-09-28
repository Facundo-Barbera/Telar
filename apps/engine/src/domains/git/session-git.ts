import type { GitCommitEntry, GitignoreRemoval, GitignoreResult, GitPushResult, GitReadFailure, Project, Session } from "@telar/engine-client";
import type { AsyncGitRunner, GitResult } from "../../platform/git/runner";
import { EngineStateError, type Kernel } from "../../platform/kernel";
import { workspaceRootOf, type SessionQueue, type SessionRecords } from "../sessions";
import { cloneRepository, isCloneFailure } from "./clone";
import { removeTelarGitignore, ensureTelarGitignore } from "./gitignore";
import { commitSessionWork, pushSessionBranch } from "./push";

// Runs at the start and end of every turn on a shared slot; a probe slower than this is recorded as `read`, not waited for.
const ANCHOR_PROBE_MS = 5_000;

type SessionGitDeps = {
  records: SessionRecords;
  asyncGit: AsyncGitRunner;
  worktreeGit: AsyncGitRunner;
  anchorReadRoot: (session: Session) => string | undefined;
  forgetGitReadsUnder: (root: string) => void;
  readQueue: (sessionId: string) => SessionQueue;
  writeQueue: (sessionId: string, queue: SessionQueue) => void;
  getProject: (projectId: string) => Project;
  registerProject: (input: { name: string; root: string }) => Project;
};

/** The git a session's turns and buttons write: turn anchors, commit, push, clone and Telar's gitignore block. */
export class SessionGit {
  constructor(
    private readonly kernel: Kernel,
    private readonly deps: SessionGitDeps,
  ) {}

  /**
   * Stamps where the repository stands as a turn starts or ends. Dispatched, never awaited: this runs under the lock
   * for every turn, and sync git there froze the daemon. A probe that does not answer records `read`, not an absence.
   */
  anchorTurn(sessionId: string, runId: string, side: "before" | "after"): void {
    let cwd: string | undefined;
    try {
      // `require`, not `get`: the activity fold would parse the queue again inside `markRunning`.
      cwd = this.deps.anchorReadRoot(this.deps.records.require(sessionId));
    } catch {
      return;
    }
    if (cwd === undefined) return;
    // A turn that ended has just written to this checkout, so cached reads of it are dropped.
    if (side === "after") this.deps.forgetGitReadsUnder(cwd);
    void this.deps.asyncGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], { timeoutMs: ANCHOR_PROBE_MS })
      .then((result) => this.stampAnchor(sessionId, runId, side, result))
      .catch(() => {
        // The runner reports failures as results; a throw here would be the store, and must not take the daemon down.
      });
  }

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

  // Status 0 is a sha; a timeout or git not answering is `read`; status 1 is a repository with no commits yet, nothing to write.
  private stampAnchor(sessionId: string, runId: string, side: "before" | "after", result: GitResult): void {
    if (result.timedOut) return this.writeAnchor(sessionId, runId, { read: "timeout" });
    if (result.status === 0) {
      const sha = result.stdout.trim();
      return this.writeAnchor(sessionId, runId, sha ? { [side]: sha } : { read: "failed" });
    }
    if (result.status === 1) return;
    this.writeAnchor(sessionId, runId, { read: "failed" });
  }

  // Through a command, since this arrives on a promise; the turn is re-read, not closed over.
  private writeAnchor(sessionId: string, runId: string, patch: { before?: string; after?: string; read?: GitReadFailure }): void {
    if (Object.keys(patch).length === 0) return;
    try {
      this.kernel.command("stampTurnAnchor", () => {
        const queue = this.deps.readQueue(sessionId);
        const turn = queue.turns.find((candidate) => candidate.runId === runId);
        if (!turn) return;
        const merged = { ...turn.anchor, ...patch };
        // A later good read clears an earlier doubt, but a doubt never erases a sha already observed.
        if (patch.read === undefined) delete merged.read;
        turn.anchor = merged;
        turn.updatedAt = this.kernel.now();
        this.deps.writeQueue(sessionId, queue);
      });
    } catch {
      // A session deleted while the probe ran leaves nothing to write to.
    }
  }
}
