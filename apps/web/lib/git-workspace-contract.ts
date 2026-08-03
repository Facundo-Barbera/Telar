export type GitFileStatus = {
  path: string;
  previousPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  additions: number;
  deletions: number;
  binary: boolean;
};

export type GitWorkspaceStatusResponse = {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
  summary: {
    files: number;
    staged: number;
    unstaged: number;
    untracked: number;
    additions: number;
    deletions: number;
  };
};

export type GitDiffScope = "working" | "staged" | "all" | "compare";

export type GitDiffResponse = {
  scope: GitDiffScope;
  path: string | null;
  base: string | null;
  patch: string;
  binary: boolean;
  truncated: boolean;
};

export type GitActionResponse = {
  ok: true;
  message: string;
};
