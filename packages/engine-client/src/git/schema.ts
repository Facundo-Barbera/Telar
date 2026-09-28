import type { GitReadFailure, ProjectAvailability } from "../protocol/entities";

export type GitWorktreeEntry = { path: string; basename: string; branch?: string; isMainCheckout: boolean };

export type GitChangeStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

export type GitFileChange = {
  path: string;
  status: GitChangeStatus;
  renamedFrom?: string;
  /** Absent rather than zero for binary and untracked files, which git does not count. */
  linesAdded?: number;
  linesRemoved?: number;
  binary?: boolean;
};

export type GitCommitEntry = { sha: string; shortSha: string; subject: string; at: number; author: string };

export type GitPushRefusal =
  | "not_repository"
  | "local_checkout"
  | "no_remote"
  | "not_session_branch"
  | "nothing_to_push"
  | "not_permitted"
  | "rejected"
  | "auth"
  | "timeout"
  | "failed";

export type GitPushResult =
  | { pushed: true; branch: string; commits?: number; created?: boolean }
  | { pushed: false; refusal: GitPushRefusal; message?: string };

export type SessionDiff = {
  repository: boolean;
  /** The session's own checkout: its worktree, or the project root. */
  workspacePath: string;
  branch?: string;
  base?: string;
  baseUnverified?: GitReadFailure;
  ahead?: number;
  behind?: number;
  files: GitFileChange[];
  filesIncomplete?: GitReadFailure;
  commits: GitCommitEntry[];
  commitsIncomplete?: GitReadFailure;
  linesAdded: number;
  linesRemoved: number;
  truncated: boolean;
  shared?: boolean;
  availability?: ProjectAvailability;
};

export type GitPatchIncomplete = "timeout" | "failed" | "truncated";

export type GitFilePatch = { patch: string; binary: boolean; incomplete?: GitPatchIncomplete };

export type GitRefEntry = { name: string; kind: "local" | "remote"; head?: boolean };

export type GitOverview = {
  repository: boolean;
  branch?: string;
  dirtyFiles?: number;
  ahead?: number;
  behind?: number;
  /** Absent when `git worktree list` did not answer; `[]` only when there are none. */
  worktrees?: GitWorktreeEntry[];
  refs?: GitRefEntry[];
  refsIncomplete?: GitReadFailure;
  defaultBase?: string;
  availability?: ProjectAvailability;
};

export type GitignoreResult = { added: string[]; present: string[]; path: string; created: boolean };

export type GitignoreRemoval = { removed: string[]; path: string };
