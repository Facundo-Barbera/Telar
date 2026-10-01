import type { EngineTransport } from "../platform/transport";
import { diffBaseQuery, filePatchQuery, type DiffBaseOption, type FilePatchOptions } from "./diff-query";
import type { GitCommitEntry, GitFilePatch, GitignoreRemoval, GitignoreResult, GitOverview, GitPushResult, SessionDiff } from "./schema";

const projectPath = (projectId: string) => `/v2/projects/${encodeURIComponent(projectId)}`;
const sessionPath = (sessionId: string) => `/v2/sessions/${encodeURIComponent(sessionId)}`;

export const gitClient = {
  /** Read fresh on every call: a stale branch name is worse than a slow one. */
  projectGit(this: EngineTransport, projectId: string): Promise<{ git: GitOverview }> {
    return this.request("GET", `${projectPath(projectId)}/git`);
  },

  projectDiff(this: EngineTransport, projectId: string): Promise<{ diff: SessionDiff }> {
    return this.request("GET", `${projectPath(projectId)}/diff`);
  },

  projectFilePatch(this: EngineTransport, projectId: string, path: string, options: FilePatchOptions = {}): Promise<{ file: GitFilePatch }> {
    return this.request("GET", `${projectPath(projectId)}/diff?${filePatchQuery(path, options)}`);
  },

  sessionDiff(this: EngineTransport, sessionId: string, options: DiffBaseOption = {}): Promise<{ diff: SessionDiff }> {
    const query = diffBaseQuery(options);
    return this.request("GET", `${sessionPath(sessionId)}/diff${query ? `?${query}` : ""}`);
  },

  sessionDirtyFiles(this: EngineTransport, sessionId: string): Promise<{ dirtyFiles?: number }> {
    return this.request("GET", `${sessionPath(sessionId)}/git/status`);
  },

  sessionFilePatch(this: EngineTransport, sessionId: string, path: string, options: FilePatchOptions = {}): Promise<{ file: GitFilePatch }> {
    return this.request("GET", `${sessionPath(sessionId)}/diff?${filePatchQuery(path, options)}`);
  },

  /** The engine's only git mutation: additive, reversible and never automatic. */
  commitSessionWork(this: EngineTransport, sessionId: string, message: string): Promise<{ committed: boolean; commit?: GitCommitEntry; reason?: string }> {
    return this.request("POST", `${sessionPath(sessionId)}/git/commit`, { message });
  },

  pushSessionBranch(this: EngineTransport, sessionId: string): Promise<GitPushResult> {
    return this.request("POST", `${sessionPath(sessionId)}/git/push`, {});
  },

  projectGitignore(this: EngineTransport, projectId: string): Promise<{ gitignore: GitignoreResult }> {
    return this.request("POST", `${projectPath(projectId)}/gitignore`, {});
  },

  undoProjectGitignore(this: EngineTransport, projectId: string): Promise<{ gitignore: GitignoreRemoval }> {
    return this.request("DELETE", `${projectPath(projectId)}/gitignore`);
  },
};
