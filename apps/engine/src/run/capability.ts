/**
 * What the `run_*` toolkit may do — a thin port, one member per store/manager
 * method, exactly as `DsCapability` and `LatexCapability` are.
 *
 * TWO IMPLEMENTATIONS, ONE SHAPE: the daemon builds this over the real
 * `RunStore` and `RunManager`; the worker builds it out of HTTP calls, because
 * a process the worker spawned would die with the worker and belong to one
 * session — the exact two properties this feature exists to avoid.
 *
 * EVERY VERB IS PROJECT-SCOPED, and the project comes from the session on the
 * daemon side rather than from an argument. A tool that could name any project
 * would let one conversation stop another project's server by typo.
 */
import type { RunConfigurationInput, RunConfigurationView, RunOutputLine, RunView } from "./types";

export type RunStatusAnswer = {
  /** The project's one live deployment, when there is one. */
  active?: RunView;
  /** Recent runs, newest first, including the live one. */
  history: RunView[];
  /** The tree the ASKING session sits on, so a client can spot a mismatch. */
  sessionWorktreePath?: string;
};

export type RunCapability = {
  configurations(): Promise<RunConfigurationView[]>;
  createConfiguration(input: RunConfigurationInput): Promise<RunConfigurationView>;
  updateConfiguration(configId: string, patch: Partial<RunConfigurationInput>): Promise<RunConfigurationView>;
  removeConfiguration(configId: string): Promise<void>;

  status(): Promise<RunStatusAnswer>;
  /**
   * Launch a saved configuration on this session's worktree. `replace: true` is
   * the deliberate takeover — without it, an existing deployment is a conflict
   * rather than something to quietly stop.
   */
  start(input: { configId: string; replace?: boolean }): Promise<RunView>;
  /** Defaults to the project's active run when no id is given. */
  stop(input?: { runId?: string }): Promise<RunView>;
  restart(input?: { runId?: string }): Promise<RunView>;
  /** Free the slot held by a run Telar can no longer verify. Signals nothing. */
  release(input: { runId: string }): Promise<RunView>;
  output(input?: { runId?: string; after?: number }): Promise<{ lines: RunOutputLine[]; cursor: number; dropped: number }>;
};
