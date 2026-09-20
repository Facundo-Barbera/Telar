/**
 * Run configurations and the one local deployment a project may have.
 *
 * TWO NOUNS, AND THE SPLIT IS THE MODEL. A RUN CONFIGURATION is a saved recipe
 * belonging to the PROJECT — a name, a command, a working directory, an
 * environment — and it outlives every conversation. A RUN is one execution of
 * it, and it belongs to the project too rather than to the session that pressed
 * play. Changing conversation neither switches nor kills a run; every session
 * looking at the project sees the same deployment.
 *
 * THE WORKTREE IS ON THE RUN, EXPLICITLY, AND IS NEVER INFERRED. A configuration
 * says `apps/web`, not an absolute path, because the same recipe has to be
 * launchable from the project's checkout and from any worktree cut off it. Which
 * tree a run actually used is captured when it starts, because the session
 * reading it later may be sitting somewhere else — and a run silently
 * attributed to the reader's tree is how you stop a server you did not start.
 * `RunStatusAnswer` therefore carries BOTH the run's tree and the reader's.
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
 * WHERE A RUN IS IN ITS LIFE — and `ready` is deliberately expensive to reach.
 *
 *   starting  reserved and spawning; the project's slot is already held
 *   running   alive, with no readiness check or none answered yet
 *   ready     ONLY after a readiness URL that was silent before the launch
 *             answered after it, with something other than a 5xx
 *   exited    ended on its own; `exitCode` says how
 *   failed    never started, or ended non-zero
 *   unknown   the engine cannot vouch for the process any more. The slot STAYS
 *             HELD and nothing is signalled — clearing it is `release`, an
 *             explicit human act.
 */
export const RunStatus = z.enum(["starting", "running", "ready", "exited", "failed", "unknown"]);
export type RunStatus = z.infer<typeof RunStatus>;

/** A run that has stopped for good. `unknown` is NOT terminal: it holds the slot. */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return status === "exited" || status === "failed";
}

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

export const RunView = z.object({
  runId: z.string(),
  projectId: z.string(),
  configId: z.string(),
  /** Copied at launch: renaming or deleting the recipe must not rewrite history. */
  configName: z.string(),
  command: z.string(),
  /** The tree this run was launched from — not necessarily the reader's. */
  worktreePath: z.string(),
  worktreeBranch: z.string().optional(),
  cwd: z.string(),
  /** The session that pressed play. Provenance only: it owns nothing. */
  startedBySessionId: z.string().optional(),
  status: RunStatus,
  readiness: RunReadiness,
  readinessUrl: z.string().optional(),
  /** Present only while the engine still holds the process handle. */
  pid: z.number().optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  exitCode: z.number().optional(),
  signal: z.string().optional(),
  /** Why it failed or went unknown, in a sentence. Redacted. */
  error: z.string().optional(),
  env: z.array(RunEnvView),
});
export type RunView = z.infer<typeof RunView>;

export const RunStatusAnswer = z.object({
  active: RunView.optional(),
  /** Newest first, the live one included. History is what makes an exit readable. */
  history: z.array(RunView),
  /** The tree the session reading this is sitting on. */
  sessionWorktreePath: z.string().optional(),
});
export type RunStatusAnswer = z.infer<typeof RunStatusAnswer>;

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

/** `replace` is opt-in and named: taking over a deployment somebody else is
 *  watching must be asked for, never inferred from an ordinary start. */
export const RunStartInput = z.object({ configId: z.string().min(1), replace: z.boolean().optional() });
export type RunStartInput = z.infer<typeof RunStartInput>;

export const RunConfigurationsAnswer = z.object({ configurations: z.array(RunConfigurationView) });
export type RunConfigurationsAnswer = z.infer<typeof RunConfigurationsAnswer>;
