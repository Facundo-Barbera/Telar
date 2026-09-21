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
import type { RunOutputFilter, RunWaitOutcome } from "./manager";
import type { RunConfigurationInput, RunConfigurationView, RunOutputLine, RunView } from "./types";

/**
 * WHICH SIGNAL THE POLITE STOP SENDS — a closed set, because these three are
 * the ones with distinct meanings to a process and the rest would be a hole a
 * caller could aim anywhere.
 */
export type RunStopSignal = "SIGTERM" | "SIGINT" | "SIGKILL";

export type RunWaitAnswer = RunWaitOutcome;

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
  /**
   * Defaults to the project's active run when no id is given.
   *
   * `signal` IS THE POLITE ATTEMPT'S ONLY. Ctrl-C semantics matter to a dev
   * server that traps TERM (#890); the forceful escalation stays SIGKILL.
   */
  stop(input?: { runId?: string; signal?: RunStopSignal }): Promise<RunView>;
  restart(input?: { runId?: string }): Promise<RunView>;
  /** Free the slot held by a run Telar can no longer verify. Signals nothing. */
  release(input: { runId: string }): Promise<RunView>;
  output(input?: { runId?: string; after?: number } & RunOutputFilter): Promise<{ lines: RunOutputLine[]; cursor: number; dropped: number }>;
  /**
   * Block until one of four things happens. See `RunManager.wait` — this is a
   * pass-through, because the conditions are all facts the engine already holds
   * and a worker waiting over HTTP would be polling by another name.
   */
  wait(input: { runId?: string; pattern?: string; ready?: boolean; exit?: boolean; timeoutMs: number }): Promise<RunWaitAnswer>;
  /**
   * The same window as `output`, in the shape a terminal draws: redacted bytes.
   *
   * BOTH, NOT ONE. `output` is what the `run_*` toolkit reads, and an agent
   * wants lines rather than a stream with `CSI H` in it; this is what the
   * cockpit's emulator reads. Retiring either would cost a real reader.
   */
  bytes(input?: { runId?: string; after?: number }): Promise<{ chunks: string[]; cursor: number; dropped: number }>;
  /**
   * Keystrokes for the program a run's recipe named. NOT EXPOSED TO THE
   * TOOLKIT: `RUN_READ_ONLY_TOOLS` is about what an agent may do, and typing
   * into a project's one deployment is a person's act on a surface they are
   * looking at, not a tool call.
   */
  write(input: { runId?: string; data: string }): Promise<{ delivered: boolean }>;
  resize(input: { runId?: string; cols: number; rows: number }): Promise<{ resized: boolean }>;
};
