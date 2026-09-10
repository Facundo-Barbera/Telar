/**
 * The run wire shapes, as the cockpit reads them.
 *
 * MIRRORED ON PURPOSE, TEMPORARILY. These belong in
 * `packages/engine-client/src/protocol`, and will move there in the change that
 * lifts them — that file is being restructured by another writer right now, and
 * a second author in it would cost more than this duplication does. When they
 * land, this module becomes a re-export and nothing below it changes: every
 * consumer already imports from `@/lib/run/types`.
 *
 * SECRET VALUES ARE ABSENT FROM THE VIEW BY CONSTRUCTION. `RunEnvView` has no
 * `value` when `secret` is true, so a component cannot render one by mistake and
 * a screenshot of this panel cannot leak one.
 */

export type RunEnvView = { key: string; value?: string; secret?: boolean };

export type RunConfigurationView = {
  id: string;
  projectId: string;
  name: string;
  command: string;
  cwd?: string;
  env?: RunEnvView[];
  readinessUrl?: string;
  createdAt: number;
  updatedAt: number;
};

export type RunStatus = "starting" | "running" | "ready" | "exited" | "failed" | "unknown";

/**
 * `unattributable` is not a failure: it means the readiness URL was already
 * answering before this run started, so nothing it says afterwards is evidence
 * about this process. The panel shows that rather than a green dot.
 */
export type RunReadiness =
  | { kind: "none" }
  | { kind: "pending" }
  | { kind: "ready"; at: number }
  | { kind: "unattributable"; reason: string };

export type RunOutputLine = { at: number; stream: "stdout" | "stderr"; text: string };

export type RunView = {
  runId: string;
  projectId: string;
  configId: string;
  configName: string;
  command: string;
  /** The tree this run was launched from — not necessarily this session's. */
  worktreePath: string;
  worktreeBranch?: string;
  cwd: string;
  startedBySessionId?: string;
  startedAt: number;
  endedAt?: number;
  status: RunStatus;
  readiness: RunReadiness;
  readinessUrl?: string;
  pid?: number;
  exitCode?: number;
  signal?: string;
  error?: string;
};

export type RunStatusAnswer = {
  active?: RunView;
  history: RunView[];
  /** The tree the session reading this is sitting on. */
  sessionWorktreePath?: string;
};

export type RunOutputAnswer = { lines: RunOutputLine[]; cursor: number; dropped: number };

export type RunConfigurationDraft = {
  name: string;
  command: string;
  cwd?: string;
  env?: { key: string; value: string; secret?: boolean }[];
  readinessUrl?: string;
};
