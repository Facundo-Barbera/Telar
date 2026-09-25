/**
 * Run configurations, and the terminals they open.
 *
 * TWO NOUNS, AND THE SPLIT IS THE MODEL. A RUN CONFIGURATION is a saved recipe
 * belonging to the PROJECT — a name, a command, a working directory, an
 * environment — and it outlives every conversation. A RUN is one TERMINAL
 * opened from it ("Run = a new terminal"), and it belongs to the SESSION whose
 * panel it opened in. Two presses are two terminals — "web dev", "web dev #2" —
 * and neither blocks the other; closing a terminal ends what runs in it.
 *
 * THE WORKTREE IS ON THE TERMINAL, EXPLICITLY, AND IS NEVER INFERRED. A
 * configuration says `apps/web`, not an absolute path, because the same recipe
 * has to be launchable from the project's checkout and from any worktree cut
 * off it. Which tree a terminal actually used is captured when it opens.
 *
 * A SECRET HAS NO VALUE ON THIS WIRE. `RunEnvView` omits `value` entirely when
 * `secret` is true — not a masked string, absent — so a client cannot render one
 * by accident and a screenshot cannot leak one. The engine keeps the real value
 * because a launch needs it, and scrubs it out of every text field it hands
 * back, including captured output. That is "do not echo what you were told",
 * which is the honest limit here; it is not a vault.
 */
import { z } from "zod";

/** An environment entry as a client sees it: no value for a secret, ever. */
export const RunEnvView = z.object({
  key: z.string(),
  value: z.string().optional(),
  secret: z.boolean().optional(),
});
export type RunEnvView = z.infer<typeof RunEnvView>;

/**
 * THE GLYPH A CONFIGURATION WEARS — a key from a closed set, never an image.
 *
 * The cockpit maps each name to an icon it already ships, so a configuration
 * cannot put a remote asset in the masthead and a stored value can never fail
 * to render. Absent means `play`: the default is resolved where it is drawn,
 * not written into the document, so changing it later rewrites nothing.
 */
export const RunIcon = z.enum(["play", "server", "globe", "terminal", "flask", "database", "package", "bug", "rocket", "hammer"]);
export type RunIcon = z.infer<typeof RunIcon>;

export const DEFAULT_RUN_ICON: RunIcon = "play";

/**
 * WHICH PROGRAM IS HANDED THE COMMAND — explicit rather than implied.
 *
 * The engine spawns `program` with `[...args, command]` and no shell flag, so
 * no layer on this wire has to know a convention for splitting a command line.
 * `a && b` still works: `program` is a shell, and the string is its argument.
 *
 * ABSENT IS THE NORMAL CASE. An unpinned recipe is resolved against whichever
 * platform it launches on, which is why a resolved `/bin/sh` is deliberately
 * NOT written into the document: that would carry one machine's operating
 * system into a recipe that has to open on another.
 */
export const RunShell = z.object({
  /** The program spawned. An absolute path, or a name found on PATH. */
  program: z.string().min(1).max(1024),
  /** Argv BEFORE the command, e.g. `["-c"]`. The command is appended to it. */
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

/**
 * WHERE A TERMINAL IS IN ITS LIFE — and `ready` is deliberately expensive.
 *
 *   running   open, with no readiness check or none answered yet
 *   ready     ONLY after a readiness URL that was silent before the launch
 *             answered after it, with something other than a 5xx
 *   exited    ended on its own; `exitCode` says how
 *   failed    never started, or ended non-zero
 *   closed    somebody closed the terminal; `closedBy` says who
 *
 * No `unknown` and no `starting`: there is no deployment slot to hold for a
 * process Telar lost, and Telar does not track liveness — the engine records
 * what the terminal host tells it.
 */
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

/**
 * WHO CLOSED A TERMINAL: the person (the cockpit), an agent (a tool call), or
 * Telar itself (quitting, or the host no longer holding it). Recorded so an
 * agent can be told "the person closed it" and not reopen it unasked.
 */
export const RunClosedBy = z.enum(["person", "agent", "telar"]);
export type RunClosedBy = z.infer<typeof RunClosedBy>;

/**
 * WHY A RUN IS OR IS NOT CALLED READY — and how weak the claim really is.
 *
 * A readiness probe is an HTTP request to a port, and a port is not a process.
 * The engine takes a baseline BEFORE spawning: if something already answers, a
 * 200 afterwards proves nothing and the run stays `unattributable` for life.
 * That is COLLISION DETECTION, NOT ATTRIBUTION — it rules out the one false
 * positive that is actually visible. Nothing here proves the answering socket
 * belongs to the launched process group.
 */
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

/**
 * ONE TERMINAL — open, or recently ended and kept for its output.
 *
 * IDENTITY IS `terminalId`: the desktop host's id for the pseudo-terminal (the
 * name the cockpit's strip attaches by), or an engine-minted `pipe_…` id when
 * there is no Electron. It stays on the record after the terminal ends.
 */
export const RunView = z.object({
  terminalId: z.string(),
  /** The same value as `terminalId`, under its old name, for one release. */
  runId: z.string(),
  projectId: z.string(),
  /** The session whose panel it lives in. The session OWNS it. */
  sessionId: z.string(),
  origin: RunOrigin,
  /** What the tab says: the configuration's name, then `#2`, `#3`… */
  title: z.string(),
  /** The recipe it came from, when it came from one. */
  configId: z.string().optional(),
  /** Copied at launch: renaming or deleting the recipe must not rewrite history. */
  configName: z.string(),
  command: z.string(),
  /** The tree this terminal was launched from — not necessarily the reader's. */
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
  /** Who closed it, when it was closed rather than ending by itself. */
  closedBy: RunClosedBy.optional(),
  /** Something worth knowing that did not stop the launch, e.g. "port 3000
   *  already answers". A busy port warns; it never blocks. */
  warning: z.string().optional(),
  /** Why it failed, in a sentence. Redacted. */
  error: z.string().optional(),
  env: z.array(RunEnvView),
});
export type RunView = z.infer<typeof RunView>;

/**
 * ONE TERMINAL CHANGED — the frame `/run/stream` carries (#890), for the
 * session the stream is opened on.
 *
 * THE WHOLE VIEW IS ON IT: a terminal's state lives in the engine's memory and
 * the only read of it is `/run/status`, the poll this feed exists to delete.
 * The frame IS the state, so a reader that missed one is corrected by the next.
 */
export const RunStatusEvent = z.object({
  type: z.literal("run.status"),
  projectId: z.string(),
  sessionId: z.string(),
  run: RunView,
});
export type RunStatusEvent = z.infer<typeof RunStatusEvent>;

/** A session's terminals — a list, where there used to be one project-wide
 *  `active` run and its `history`. */
export const RunStatusAnswer = z.object({
  /** Newest first, open ones and recently ended ones. */
  terminals: z.array(RunView),
  /** The tree the session reading this is sitting on. */
  sessionWorktreePath: z.string().optional(),
});
export type RunStatusAnswer = z.infer<typeof RunStatusAnswer>;

/**
 * HOW MUCH OF A RUN'S OUTPUT, AND WHICH OF IT (#890).
 *
 * WHAT AN AGENT ACTUALLY NEEDS FROM A LONG-RUNNING PROCESS. `run_output` used
 * to answer one bounded window and nothing else, so "show me the last five
 * lines" and "show me the errors" were both "read everything and think about
 * it" — which on a dev server's log is a context window spent on a scrollback
 * nobody wanted.
 *
 * NONE OF THESE MOVES THE CURSOR, which is the property that makes them
 * composable with `after`: the cursor advances over the whole window, so a
 * caller that greps and then resumes has still read past what did not match.
 */
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

/**
 * WHICH SIGNAL A STOP'S POLITE ATTEMPT SENDS.
 *
 * A CLOSED SET, because these three have distinct meanings to a process and
 * anything wider would be a hole a caller could aim anywhere. SIGINT is the one
 * that earns the field: a dev server that traps SIGTERM to drain connections
 * stops the way Ctrl-C stops it and no other way. The forceful escalation stays
 * SIGKILL whatever was asked for.
 */
export const RunStopSignal = z.enum(["SIGTERM", "SIGINT", "SIGKILL"]);
export type RunStopSignal = z.infer<typeof RunStopSignal>;

/**
 * WHAT A WAIT ANSWERS — and `fired` is the whole of why this is a tool rather
 * than a sleep.
 *
 * "It came back" is not the same fact as "the server is up". An agent that
 * could not tell a timeout from a match would curl a port nothing is listening
 * on and report the connection refusal as the project's bug.
 *
 * `lines` IS WHAT ARRIVED WHILE WAITING, from the cursor the call opened at —
 * not the whole scrollback, which `run_output` is for.
 */
export const RunWaitAnswer = z.object({
  fired: z.enum(["pattern", "ready", "exit", "timeout"]),
  cursor: z.number(),
  lines: z.array(RunOutputLine),
});
export type RunWaitAnswer = z.infer<typeof RunWaitAnswer>;

/**
 * A window of captured output. `cursor` resumes; `dropped` is REPORTED rather
 * than hidden, so a client can say "earlier output was discarded" instead of
 * showing a gap. A cursor that goes backwards means a different run.
 */
export const RunOutputAnswer = z.object({
  lines: z.array(RunOutputLine),
  cursor: z.number(),
  dropped: z.number(),
});
export type RunOutputAnswer = z.infer<typeof RunOutputAnswer>;

/**
 * The same window, as the redacted BYTES an emulator draws.
 *
 * CHUNKS RATHER THAN ONE STRING, and that is a contract rather than a shape.
 * Every chunk left the engine's redactor whole, so no escape sequence straddles
 * a boundary and a reader may concatenate them in order or write them one at a
 * time with the same result. `dropped` counts CHUNKS, for the same reason
 * `cursor` does.
 */
export const RunBytesAnswer = z.object({
  chunks: z.array(z.string()),
  cursor: z.number(),
  dropped: z.number(),
});
export type RunBytesAnswer = z.infer<typeof RunBytesAnswer>;

/**
 * Whether keystrokes reached a process.
 *
 * `false` IS NOT AN ERROR. The desktop shell learns of an exit before the
 * cockpit does, so a key pressed across that gap is the ordinary case — a run
 * that is not running at all refuses with `conflict` instead, which is a
 * different fact and arrives a different way.
 */
export const RunWriteAnswer = z.object({ delivered: z.boolean() });
export type RunWriteAnswer = z.infer<typeof RunWriteAnswer>;

export const RunResizeAnswer = z.object({ resized: z.boolean() });
export type RunResizeAnswer = z.infer<typeof RunResizeAnswer>;

/** `replace` is still accepted and means nothing: every start opens a new
 *  terminal, and there is no deployment left to take over.
 *
 *  `openedBy: "agent"` marks a terminal the agent opened, so a person closing
 *  it is told to the agent on its next turn. Absent means the person. */
export const RunStartInput = z.object({
  configId: z.string().min(1),
  replace: z.boolean().optional(),
  openedBy: z.enum(["person", "agent"]).optional(),
});
export type RunStartInput = z.infer<typeof RunStartInput>;

/**
 * A terminal an AGENT opens with a command of its own rather than a saved
 * configuration (`terminal_open`). It is recorded with `origin: "agent"` and
 * opens in the session's panel like any other.
 *
 * READINESS IS ONE OF TWO THINGS: a URL that answers once it is up (the same
 * rule as a configuration's), or a pattern its output prints when it is.
 */
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
