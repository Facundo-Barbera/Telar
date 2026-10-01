import fs from "node:fs";
import path from "node:path";
import { workspaceBaseRef, workspacePath, type DiffBaseOption, type FilePatchOptions, type GitFilePatch, type GitOverview, type Project, type ProjectAvailability, type Session, type SessionDiff, type WorkspaceListing } from "@telar/engine-client";
import type { AsyncGitRunner } from "../../platform/git/runner";
import { EngineStateError } from "../../platform/kernel";
import { listWorkspaceFilesAsync } from "../files";
import { workspaceRootOf } from "../sessions";
import { FolderStatus, type FolderStatusRead } from "./folder-status";
import { gitOverviewAsync, sessionDiffAsync, sessionFilePatchAsync } from "./session";

const MAX_CACHED_READS = 64;
const CACHED_READ_MS = 2_000;

export type WorkspaceReadsHost = {
  now(): number;
  getSession(sessionId: string): Session;
  getProject(projectId: string): Project;
  availability(project: Project): ProjectAvailability;
};

/** Absent keeps the recorded base; `null` drops it; a string replaces it. */
function resolveRequestedBase(options: DiffBaseOption, recorded: string | undefined): string | undefined {
  if (options.base === undefined) return recorded;
  return options.base === null ? undefined : options.base;
}

/** A second path on the same command line, fenced inside the same checkout, or nothing; refused rather than dropped. */
function insideWorkspace(cwd: string, prefix: string, candidate?: string): string | undefined {
  if (!candidate?.trim()) return undefined;
  const resolved = path.resolve(cwd, candidate);
  if (!resolved.startsWith(prefix)) throw new EngineStateError("invalid_request", "that path is outside the workspace");
  return path.relative(cwd, resolved);
}

/** A `local` session shares the project checkout, so its diff is the checkout's difference, not the session's work. */
function sharedCheckout<T extends object>(value: T, session: Pick<Session, "workspace">): T {
  return session.workspace.mode === "local" ? { ...value, shared: true } : value;
}

/**
 * The review surfaces' git reads: overview, diff, file patch and file tree. Polling reads coalesce and are kept
 * briefly in a bounded cache; availability is stamped outside it, because a cable can move inside two seconds.
 */
export class WorkspaceReads {
  private readonly cache = new Map<string, { until: number; value: Promise<unknown> }>();
  private readonly status: FolderStatus;

  constructor(
    private readonly git: AsyncGitRunner,
    private readonly host: WorkspaceReadsHost,
  ) {
    this.status = new FolderStatus(git, () => host.now());
  }

  private cached<T>(key: string, read: () => Promise<T>): Promise<T> {
    const now = this.host.now();
    for (const [oldKey, entry] of this.cache) {
      if (now >= entry.until) this.cache.delete(oldKey);
    }
    const hit = this.cache.get(key);
    if (hit && now < hit.until) return hit.value as Promise<T>;
    const entry = { until: Infinity, value: Promise.resolve().then(read) as Promise<unknown> };
    while (this.cache.size >= MAX_CACHED_READS) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, entry);
    void entry.value.then(() => { entry.until = this.host.now() + CACHED_READ_MS; }, () => { if (this.cache.get(key) === entry) this.cache.delete(key); });
    return entry.value as Promise<T>;
  }

  /** Drops every cached read that names `root`: a write the store knows about must not be answered by a stale read. */
  forgetUnder(root: string): void {
    for (const key of this.cache.keys()) {
      if (key.includes(root)) this.cache.delete(key);
    }
    this.status.markStaleUnder(root);
  }

  private async withAvailability<T extends object>(answer: Promise<T>, project: Project | undefined): Promise<T> {
    const value = await answer;
    return project === undefined ? value : { ...value, availability: this.host.availability(project) };
  }

  /** The project a session's work belongs to, when it has one. */
  projectOf(session: Session): Project | undefined {
    if (session.projectId === undefined) return undefined;
    try {
      return this.host.getProject(session.projectId);
    } catch {
      // The read it decorates still answers.
      return undefined;
    }
  }

  /** The session's checkout, or the project root once it is gone: worktrees share one object database, so an anchored turn outlives its checkout. */
  anchorReadRoot(session: Session): string | undefined {
    const workspace = workspacePath(session.workspace);
    if (workspace !== undefined && fs.existsSync(workspace)) return workspace;
    return this.projectOf(session)?.root;
  }

  projectOverview(projectId: string): Promise<GitOverview> {
    const project = this.host.getProject(projectId);
    return this.withAvailability(this.cached(`git:${project.root}`, () => gitOverviewAsync(this.git, project.root)), project);
  }

  projectDiff(projectId: string): Promise<SessionDiff> {
    const project = this.host.getProject(projectId);
    return this.withAvailability(this.cached(`diff:${project.root}`, () => sessionDiffAsync(this.git, { cwd: project.root })), project);
  }

  /** Not `async`, so a session with no directory is refused before the first await. A range is read where it still resolves. */
  sessionDiff(sessionId: string, options: DiffBaseOption = {}): Promise<SessionDiff> {
    const session = this.host.getSession(sessionId);
    const base = resolveRequestedBase(options, workspaceBaseRef(session.workspace));
    const cwd = options.to ? this.anchorReadRoot(session) ?? workspaceRootOf(session) : workspaceRootOf(session);
    return this.withAvailability(
      this.cached(`diff:${cwd}:${base ?? ""}:${options.to ?? ""}`, () => sessionDiffAsync(this.git, {
        cwd,
        ...(base ? { baseRef: base } : {}),
        ...(options.to ? { to: options.to } : {}),
      })),
      this.projectOf(session),
      // Outside the cache: two local sessions on one checkout share that entry.
    ).then((value) => sharedCheckout(value, session));
  }

  sessionStatus(sessionId: string): Promise<FolderStatusRead> {
    return this.status.read(workspaceRootOf(this.host.getSession(sessionId)));
  }

  projectFilePatch(projectId: string, target: string, options: FilePatchOptions = {}): Promise<GitFilePatch> {
    return this.filePatch(this.host.getProject(projectId).root, target, options);
  }

  /** Read against the same base as the list, so a row's hunks and its ± counts come from one comparison. */
  sessionFilePatch(sessionId: string, target: string, options: FilePatchOptions = {}): Promise<GitFilePatch> {
    const session = this.host.getSession(sessionId);
    const cwd = options.to ? this.anchorReadRoot(session) ?? workspaceRootOf(session) : workspaceRootOf(session);
    return this.filePatch(cwd, target, options, resolveRequestedBase(options, workspaceBaseRef(session.workspace)));
  }

  private filePatch(cwd: string, target: string, options: FilePatchOptions, baseRef?: string): Promise<GitFilePatch> {
    if (!target.trim()) throw new EngineStateError("invalid_request", "a file path is required");
    const resolved = path.resolve(cwd, target);
    const prefix = cwd.endsWith(path.sep) ? cwd : `${cwd}${path.sep}`;
    if (!resolved.startsWith(prefix)) throw new EngineStateError("invalid_request", "that path is outside the workspace");
    // The old path reaches the same pathspec, so it is fenced exactly as the new one is.
    const renamedFrom = insideWorkspace(cwd, prefix, options.renamedFrom);
    // Every option that changes the git command is part of the key, or one path would answer two comparisons.
    const key = `patch:${cwd}:${baseRef ?? ""}:${options.to ?? ""}:${resolved}:${!!options.untracked}:${!!options.ignoreWhitespace}:${renamedFrom ?? ""}`;
    return this.cached(key, () => sessionFilePatchAsync(this.git, {
      cwd,
      path: path.relative(cwd, resolved),
      ...(baseRef ? { baseRef } : {}),
      ...(options.to ? { to: options.to } : {}),
      ...(options.untracked ? { untracked: true } : {}),
      ...(options.ignoreWhitespace ? { ignoreWhitespace: true } : {}),
      ...(renamedFrom ? { renamedFrom } : {}),
    }));
  }

  /** Project-scoped because a tree is a view of a place: the new-conversation canvas has a project and no session. */
  projectFiles(projectId: string): Promise<WorkspaceListing> {
    const project = this.host.getProject(projectId);
    const cwd = project.root;
    return this.withAvailability(this.cached(`files:${cwd}`, () => listWorkspaceFilesAsync(this.git, { cwd, now: this.host.now() })), project);
  }

  sessionFiles(sessionId: string): Promise<WorkspaceListing> {
    const session = this.host.getSession(sessionId);
    const cwd = workspaceRootOf(session);
    return this.withAvailability(this.cached(`files:${cwd}`, () => listWorkspaceFilesAsync(this.git, { cwd, now: this.host.now() })), this.projectOf(session));
  }
}
