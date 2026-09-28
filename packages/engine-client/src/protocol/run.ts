import { z } from "zod";

/** An environment entry as a client sees it: no value for a secret, ever. */
export const RunEnvView = z.object({
  key: z.string(),
  value: z.string().optional(),
  secret: z.boolean().optional(),
});
export type RunEnvView = z.infer<typeof RunEnvView>;

export const RunIcon = z.enum(["play", "server", "globe", "terminal", "flask", "database", "package", "bug", "rocket", "hammer"]);
export type RunIcon = z.infer<typeof RunIcon>;

export const DEFAULT_RUN_ICON: RunIcon = "play";

export const RunShell = z.object({
  /** The program spawned. An absolute path, or a name found on PATH. */
  program: z.string().min(1).max(1024),
  args: z.array(z.string().max(4000)).max(32).optional(),
});
export type RunShell = z.infer<typeof RunShell>;

/** What a client may store. Ids and timestamps are the engine's to mint. */
export const RunConfigurationDraft = z.object({
  name: z.string().min(1).max(120),
  /** Which glyph the Run menu draws before the name. Default: `play`. */
  icon: RunIcon.optional(),
  command: z.string().min(1).max(4000),
  /** Which shell, spelled out. Absent: the engine's platform default. */
  shell: RunShell.optional(),
  /** Relative to the worktree the run is launched from. Default: its root. */
  cwd: z.string().max(1024).optional(),
  env: z.array(z.object({ key: z.string(), value: z.string(), secret: z.boolean().optional() })).max(200).optional(),
  /** An http(s) URL that answers once the thing is up. See `RunReadiness`. */
  readinessUrl: z.string().url().optional(),
});
export type RunConfigurationDraft = z.infer<typeof RunConfigurationDraft>;

export const RunConfigurationView = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  /** Absent on every configuration saved before icons existed, and on any
   *  saved since that kept the default. The cockpit draws `play` for both. */
  icon: RunIcon.optional(),
  command: z.string(),
  /** Present only on a recipe that pinned one. Scrubbed like every other text. */
  shell: RunShell.optional(),
  cwd: z.string().optional(),
  /** Always present, possibly empty — the engine emits the scrubbed list on
   *  every read, so a client never has to distinguish "no env" from "not sent". */
  env: z.array(RunEnvView),
  readinessUrl: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type RunConfigurationView = z.infer<typeof RunConfigurationView>;

export const RunStatus = z.enum(["running", "ready", "exited", "failed", "closed"]);
export type RunStatus = z.infer<typeof RunStatus>;

/** A terminal that has ended for good. */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return status === "exited" || status === "failed" || status === "closed";
}

/** Why a terminal exists: a saved configuration (`run`), or a command an agent
 *  opened so the person can watch it (`agent`). */
export const RunOrigin = z.enum(["run", "agent"]);
export type RunOrigin = z.infer<typeof RunOrigin>;

export const RunClosedBy = z.enum(["person", "agent", "telar"]);
export type RunClosedBy = z.infer<typeof RunClosedBy>;

export const RunReadiness = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("pending") }),
  z.object({ kind: z.literal("ready"), at: z.number() }),
  z.object({ kind: z.literal("unattributable"), reason: z.string() }),
]);
export type RunReadiness = z.infer<typeof RunReadiness>;

/** One captured line. Streams stay apart so a client can colour stderr. */
export const RunOutputLine = z.object({
  at: z.number(),
  stream: z.enum(["stdout", "stderr"]),
  text: z.string(),
});
export type RunOutputLine = z.infer<typeof RunOutputLine>;

export const RunView = z.object({
  terminalId: z.string(),
  /** The same value as `terminalId`, under its old name, for one release. */
  runId: z.string(),
  projectId: z.string(),
  sessionId: z.string(),
  origin: RunOrigin,
  /** What the tab says: the configuration's name, then `#2`, `#3`… */
  title: z.string(),
  /** The recipe it came from, when it came from one. */
  configId: z.string().optional(),
  configName: z.string(),
  command: z.string(),
  worktreePath: z.string(),
  worktreeBranch: z.string().optional(),
  cwd: z.string(),
  status: RunStatus,
  readiness: RunReadiness,
  readinessUrl: z.string().optional(),
  /** Present only while the terminal is open. */
  pid: z.number().optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  exitCode: z.number().optional(),
  signal: z.string().optional(),
  closedBy: RunClosedBy.optional(),
  /** Something worth knowing that did not stop the launch, e.g. "port 3000
   *  already answers". A busy port warns; it never blocks. */
  warning: z.string().optional(),
  /** Why it failed, in a sentence. Redacted. */
  error: z.string().optional(),
  env: z.array(RunEnvView),
});
export type RunView = z.infer<typeof RunView>;

export const RunStatusEvent = z.object({
  type: z.literal("run.status"),
  projectId: z.string(),
  sessionId: z.string(),
  run: RunView,
});
export type RunStatusEvent = z.infer<typeof RunStatusEvent>;

export const RunStatusAnswer = z.object({
  /** Newest first, open ones and recently ended ones. */
  terminals: z.array(RunView),
  /** The tree the session reading this is sitting on. */
  sessionWorktreePath: z.string().optional(),
});
export type RunStatusAnswer = z.infer<typeof RunStatusAnswer>;

export const RunOutputFilter = z.object({
  /** Only the last N lines of the window, after the other two. */
  tail: z.number().int().min(1).max(1000).optional(),
  /** A regular expression; only matching lines come back. */
  grep: z.string().min(1).max(500).optional(),
  /** One stream only. A PTY-launched run has only `stdout` — a pseudo-terminal
   *  is one device, and nothing downstream can un-merge what went into it. */
  stream: z.enum(["stdout", "stderr"]).optional(),
});
export type RunOutputFilter = z.infer<typeof RunOutputFilter>;

export const RunStopSignal = z.enum(["SIGTERM", "SIGINT", "SIGKILL"]);
export type RunStopSignal = z.infer<typeof RunStopSignal>;

export const RunWaitAnswer = z.object({
  fired: z.enum(["pattern", "ready", "exit", "timeout"]),
  cursor: z.number(),
  lines: z.array(RunOutputLine),
});
export type RunWaitAnswer = z.infer<typeof RunWaitAnswer>;

export const RunOutputAnswer = z.object({
  lines: z.array(RunOutputLine),
  cursor: z.number(),
  dropped: z.number(),
});
export type RunOutputAnswer = z.infer<typeof RunOutputAnswer>;

export const RunBytesAnswer = z.object({
  chunks: z.array(z.string()),
  cursor: z.number(),
  dropped: z.number(),
});
export type RunBytesAnswer = z.infer<typeof RunBytesAnswer>;

export const RunWriteAnswer = z.object({ delivered: z.boolean() });
export type RunWriteAnswer = z.infer<typeof RunWriteAnswer>;

export const RunResizeAnswer = z.object({ resized: z.boolean() });
export type RunResizeAnswer = z.infer<typeof RunResizeAnswer>;

export const RunStartInput = z.object({
  configId: z.string().min(1),
  replace: z.boolean().optional(),
  openedBy: z.enum(["person", "agent"]).optional(),
});
export type RunStartInput = z.infer<typeof RunStartInput>;

export const RunOpenInput = z.object({
  command: z.string().min(1).max(4000),
  /** Relative to the session's worktree. Default: its root. */
  cwd: z.string().max(1024).optional(),
  /** The tab's title. Default: the start of the command. */
  name: z.string().min(1).max(120).optional(),
  readinessUrl: z.string().url().optional(),
  readyPattern: z.string().min(1).max(500).optional(),
});
export type RunOpenInput = z.infer<typeof RunOpenInput>;

export const RunConfigurationsAnswer = z.object({ configurations: z.array(RunConfigurationView) });
export type RunConfigurationsAnswer = z.infer<typeof RunConfigurationsAnswer>;
