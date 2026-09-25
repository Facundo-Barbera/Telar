/**
 * What the `run_*` toolkit and the run routes may do — a thin port, exactly as
 * `DsCapability` and `LatexCapability` are.
 *
 * TWO IMPLEMENTATIONS, ONE SHAPE: the daemon builds this over the real
 * `RunStore` and `RunManager`; the worker builds it out of HTTP calls, because
 * the daemon is what talks to the terminal host.
 *
 * CONFIGURATIONS ARE THE PROJECT'S; TERMINALS ARE THE SESSION'S. Both come from
 * the session on the daemon side rather than from an argument: a tool that
 * could name any session would let one conversation close another's terminal
 * by typo.
 *
 * A TERMINAL IS NAMED BY `terminalId`. `runId` is accepted everywhere as the
 * same thing under its old name, for one release.
 */
import type { RunOutputFilter, RunWaitOutcome } from "./manager";
import type { RunClosedBy, RunConfigurationInput, RunConfigurationView, RunOutputLine, RunView } from "./types";

/**
 * WHICH SIGNAL A CLOSE MAY SEND FIRST — a closed set, because these three are
 * the ones with distinct meanings to a process.
 */
export type RunStopSignal = "SIGTERM" | "SIGINT" | "SIGKILL";

export type RunWaitAnswer = RunWaitOutcome;

/** Which terminal a verb is about. Absent: see each verb's default. */
export type RunTarget = { terminalId?: string; runId?: string };

export type RunStatusAnswer = {
  /** This session's terminals, newest first — open ones and recently ended. */
  terminals: RunView[];
  /** The tree the ASKING session sits on. */
  sessionWorktreePath?: string;
};

export type RunCapability = {
  configurations(): Promise<RunConfigurationView[]>;
  createConfiguration(input: RunConfigurationInput): Promise<RunConfigurationView>;
  updateConfiguration(configId: string, patch: Partial<RunConfigurationInput>): Promise<RunConfigurationView>;
  removeConfiguration(configId: string): Promise<void>;

  status(): Promise<RunStatusAnswer>;
  /**
   * Open a NEW terminal from a saved configuration, in this session's panel
   * and worktree. Never a conflict with another terminal. `replace` is
   * accepted and ignored: there is nothing to replace any more.
   */
  start(input: { configId: string; replace?: boolean }): Promise<RunView>;
  /**
   * Close a terminal, which ends what runs in it. With no id, the session's
   * one open terminal — and a refusal naming them when there are several.
   *
   * `closedBy` IS WHO IS ASKING, and it defaults to `person`: a close is
   * reported to an agent as "the person closed it", which is the safer thing
   * to be wrong about — an agent told that will not reopen it unasked. The
   * toolkit always says `agent`.
   */
  stop(input?: RunTarget & { signal?: RunStopSignal; closedBy?: RunClosedBy }): Promise<RunView>;
  /** Close, then open the same recipe as a new terminal. */
  restart(input?: RunTarget & { closedBy?: RunClosedBy }): Promise<RunView>;
  output(input?: RunTarget & { after?: number } & RunOutputFilter): Promise<{ lines: RunOutputLine[]; cursor: number; dropped: number }>;
  /**
   * Block until one of four things happens. See `RunManager.wait` — a
   * pass-through, because the conditions are all facts the engine holds.
   */
  wait(input: RunTarget & { pattern?: string; ready?: boolean; exit?: boolean; timeoutMs: number }): Promise<RunWaitAnswer>;
  /** The same window as `output`, as the redacted bytes an emulator draws. */
  bytes(input?: RunTarget & { after?: number }): Promise<{ chunks: string[]; cursor: number; dropped: number }>;
  /**
   * Keystrokes for the program a terminal's recipe named. NOT EXPOSED TO THE
   * TOOLKIT: typing into a terminal is a person's act on a surface they are
   * looking at, not a tool call.
   */
  write(input: RunTarget & { data: string }): Promise<{ delivered: boolean }>;
  resize(input: RunTarget & { cols: number; rows: number }): Promise<{ resized: boolean }>;
};
