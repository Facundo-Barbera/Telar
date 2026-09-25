/**
 * A project's saved launches, and the terminals they open.
 *
 * TWO NOUNS, AND THE SPLIT IS THE WHOLE MODEL. A RUN CONFIGURATION is a saved
 * recipe that belongs to the PROJECT — a name, a command, a working directory,
 * environment variables — and it outlives every conversation. A RUN is one
 * TERMINAL opened from that recipe ("Run = a new terminal"): it captured a
 * worktree, a resolved cwd and a title, and it belongs to the SESSION whose
 * panel it was opened in. Pressing Run twice opens two terminals; neither
 * blocks the other, and closing the terminal is what ends its process.
 *
 * THE CWD IS RELATIVE AND THE WORKTREE IS EXPLICIT. A configuration says
 * `apps/web`, not `/Users/…/apps/web`, because the same recipe has to be
 * launchable from the project's own checkout and from any worktree cut off it.
 * Which tree a terminal actually used is captured on the TERMINAL — never
 * inferred later, because the reader may be sitting on a different one.
 *
 * SECRET VALUES NEVER LEAVE THIS MODULE. An env var may be marked `secret`; the
 * stored document keeps its value because a launch needs it, and every read
 * that crosses a wire — API, tool, status, error, captured output — goes
 * through `redactConfiguration` / `redactText` first. There is no new vault
 * here and none is claimed: this is "do not echo what you were told", which is
 * the honest limit of a first milestone.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * Below this, a value is not scrubbable: replacing every "ab" in a log turns it
 * into confetti. Enforced when saving, so nothing is ever labelled secret and
 * then printed anyway.
 */
export const MIN_SECRET_CHARS = 4;

/** What a caller may store. Ids and timestamps are the store's to mint. */
export const RunEnvVar = z
  .object({
    key: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "an environment variable name is letters, digits and underscores, not starting with a digit"),
    value: z.string().max(8192),
    /** Redacted from every read. The launch still gets the real value. */
    secret: z.boolean().optional(),
  })
  /**
   * WHAT WE CANNOT HIDE, WE REFUSE TO CALL SECRET. Redaction is substring
   * replacement over captured output, so two shapes of value defeat it: one too
   * short to replace without shredding unrelated prose, and one containing a
   * line break, since output is captured and redacted line by line. Both used to
   * be accepted and then quietly skipped — the value was labelled secret in the
   * UI and printed in full in the log. Say no at the door instead.
   */
  .superRefine((entry, ctx) => {
    if (!entry.secret) return;
    if (entry.value.length < MIN_SECRET_CHARS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: `a secret value must be at least ${MIN_SECRET_CHARS} characters: a shorter one cannot be removed from captured output without mangling unrelated text, and Telar will not label a value secret it cannot hide`,
      });
    }
    if (/[\r\n]/.test(entry.value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: "a secret value cannot contain a line break: captured output is redacted one line at a time, so a multi-line secret would survive in pieces",
      });
    }
  });
export type RunEnvVar = z.infer<typeof RunEnvVar>;

/**
 * A relative path INSIDE the selected tree. `..` is refused here rather than at
 * spawn time so a configuration cannot be saved pointing out of the project at
 * all — the resolved-path check in the manager is the belt to this braces.
 */
const RelativeCwd = z
  .string()
  .max(1024)
  .refine((value) => !value.startsWith("/") && !value.split(/[\\/]/).includes(".."), "the working directory must stay inside the worktree");

/**
 * THE GLYPH A CONFIGURATION WEARS, AND IT IS A CLOSED SET ON PURPOSE.
 *
 * A key, never an image and never a URL: the cockpit maps each name to an icon
 * it already ships, so a configuration cannot smuggle a remote asset into the
 * masthead and a stored value can never fail to render. Ten names cover the
 * things people actually launch; an eleventh is a code change, which is the
 * honest cost of keeping the set closed.
 *
 * `play` is the default and is NOT stored for it — an absent icon means "the
 * default", so changing what the default looks like later does not have to
 * rewrite every saved document.
 */
export const RunIcon = z.enum(["play", "server", "globe", "terminal", "flask", "database", "package", "bug", "rocket", "hammer"]);
export type RunIcon = z.infer<typeof RunIcon>;

export const DEFAULT_RUN_ICON: RunIcon = "play";

/**
 * WHICH PROGRAM IS HANDED THE COMMAND, WHEN THE RECIPE WANTS TO SAY.
 *
 * The launch is `spawn(program, [...args, command])` with no shell flag: the
 * argv is spelled out, so nothing downstream has to know a convention for
 * splitting a command line. `a && b` still works, because `program` is still a
 * shell and the string is still its argument.
 *
 * ABSENT IS THE NORMAL CASE AND IS NOT A GAP. An unpinned recipe is resolved
 * against the platform it launches on — see `shell.ts`. Storing a resolved
 * `/bin/sh` here would put this machine's operating system inside a document
 * that has to open on another one, which is what the portability rule this
 * field exists for actually forbids.
 */
export const RunShell = z.object({
  /** The program spawned. An absolute path, or a name found on PATH. */
  program: z.string().min(1).max(1024),
  /** Argv BEFORE the command, e.g. `["-c"]`. The command is appended to it. */
  args: z.array(z.string().max(4000)).max(32).optional(),
});
export type RunShell = z.infer<typeof RunShell>;

export const RunConfigurationInput = z.object({
  name: z.string().min(1).max(120),
  /** Which glyph the Run menu draws before the name. Default: `play`. */
  icon: RunIcon.optional(),
  /** Run by a shell, so `bun run dev` and `a && b` both mean what they look like. */
  command: z.string().min(1).max(4000),
  /** Which shell, spelled out. Absent: this platform's own, resolved at launch. */
  shell: RunShell.optional(),
  /** Relative to the worktree the run is launched from. Default: its root. */
  cwd: RelativeCwd.optional(),
  env: z.array(RunEnvVar).max(200).optional(),
  /**
   * An http(s) URL that answers once the thing is up. OPTIONAL AND MEANINGFUL:
   * a run without one never claims `ready`, because "the process is alive" is
   * not "the server is serving" and this milestone will not pretend otherwise.
   * The scheme is checked because the probe is an HTTP request: an `ftp://` here
   * would be a check that can only ever fail.
   */
  readinessUrl: z
    .string()
    .url()
    .refine((value) => /^https?:$/.test(new URL(value).protocol), "a readiness URL is checked with an HTTP request, so it must be http:// or https://")
    .optional(),
});
export type RunConfigurationInput = z.infer<typeof RunConfigurationInput>;

export const RunConfiguration = RunConfigurationInput.extend({
  id: z.string().min(1),
  projectId: z.string().min(1),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type RunConfiguration = z.infer<typeof RunConfiguration>;

/** What a client sees: same shape, secret values gone. */
export type RunConfigurationView = Omit<RunConfiguration, "env"> & {
  env: Array<{ key: string; value?: string; secret?: boolean }>;
};

/**
 * WHERE A TERMINAL IS IN ITS LIFE — and `ready` is deliberately expensive.
 *
 *   running   the host started it; we have no readiness check, or it has not
 *             answered yet
 *   ready     ONLY after a readiness URL that was silent before the launch
 *             answered after it. See `RunReadiness`.
 *   exited    the process ended on its own; `exitCode` says how
 *   failed    it never started, or ended non-zero
 *   closed    somebody closed the terminal, which ends what runs in it.
 *             `closedBy` says who.
 *
 * THERE IS NO `unknown` AND NO `starting`, and both absences are the point of
 * "Run = a new terminal". `unknown` held a project's one deployment slot
 * whenever Telar could not vouch for a process; there is no slot now, and
 * Telar does not track liveness at all — the terminal owns its process, and
 * the engine records only what the host tells it (output, an exit, a close).
 * `starting` covered a slot reserved before the spawn; a terminal record now
 * exists from the moment the host names it.
 */
export const RunStatus = z.enum(["running", "ready", "exited", "failed", "closed"]);
export type RunStatus = z.infer<typeof RunStatus>;

export function isTerminal(status: RunStatus): boolean {
  return status === "exited" || status === "failed" || status === "closed";
}

/**
 * WHY A TERMINAL EXISTS. `run` is a saved configuration a person or an agent
 * started; `agent` is a command an agent opened so the person can watch it.
 * The desktop host enforces the same pairing — the engine may open only these
 * two, and a person's own shells (`user`) never pass through here.
 */
export const RunOrigin = z.enum(["run", "agent"]);
export type RunOrigin = z.infer<typeof RunOrigin>;

/**
 * WHO CLOSED A TERMINAL — recorded so a later turn can tell an agent "the
 * person closed it" rather than letting it read a close as a crash and reopen
 * what somebody deliberately ended.
 *
 *   person  the cockpit (a chip, a tab, a Stop button)
 *   agent   a tool call
 *   telar   Telar itself: quitting, the engine going down, or the host no
 *           longer holding the terminal when the engine looked again
 */
export const RunClosedBy = z.enum(["person", "agent", "telar"]);
export type RunClosedBy = z.infer<typeof RunClosedBy>;

/**
 * WHY A RUN IS OR IS NOT CALLED READY — and how weak the claim really is.
 *
 * A readiness probe is an HTTP request to a port, and a port is not a process.
 * We take a baseline BEFORE spawning: if something already answers that URL, a
 * 200 afterwards proves nothing and the run is `unattributable` for the rest of
 * its life. That is COLLISION DETECTION, NOT ATTRIBUTION — it rules out the one
 * false positive we can actually see. A URL silent at baseline could still be
 * claimed a second later by something else entirely, and `ready` would then be
 * about that stranger. Nothing here proves the answering socket belongs to our
 * process group; proving that needs the child's own port, and it is deferred.
 *
 * `ready` also asks for more than an answer: a 5xx means something is listening
 * but not serving, which is the state a human is waiting to leave, not the one
 * they are waiting for.
 */
export type RunReadiness =
  | { kind: "none" }
  | { kind: "pending" }
  | { kind: "ready"; at: number }
  | { kind: "unattributable"; reason: string };

/**
 * What one probe of a readiness URL found.
 *
 * `answered` is occupancy: anything at all replied, which is all a baseline
 * needs to know. `serving` is the stronger reading used to call a run ready —
 * a 5xx answers but is not yet serving, and a dev server mid-crash would
 * otherwise light up green.
 */
export type RunProbeResult = { answered: boolean; serving: boolean };
export type RunProbe = (url: string) => Promise<RunProbeResult>;

/** One captured line. Streams are kept apart so a client can colour stderr. */
export type RunOutputLine = { at: number; stream: "stdout" | "stderr"; text: string };

/**
 * A terminal as anyone outside the manager sees it. Never carries secret values.
 *
 * IDENTITY IS `terminalId`, and it stays on the record after the terminal
 * ends — the finished ones are kept for their output, and a reader has to be
 * able to name the one it is reading. On the desktop it is the host's own id
 * for the pseudo-terminal, the name the cockpit's strip attaches by. Without
 * Electron (the pipe fallback) the engine mints one in the same role, so a
 * caller never has to know which launcher answered.
 */
export type RunView = {
  terminalId: string;
  /**
   * THE SAME VALUE AS `terminalId`, under the name every caller from before
   * terminals spells. Kept for one release so the `run_*` tools and today's
   * cockpit keep working while they move to `terminalId`.
   */
  runId: string;
  projectId: string;
  /** The session whose panel this terminal lives in. It OWNS the terminal. */
  sessionId: string;
  origin: RunOrigin;
  /** What the tab says: the configuration's name, then `#2`, `#3`… for more
   *  instances open at once in the same session. */
  title: string;
  /** The recipe it came from, when it came from one. */
  configId?: string;
  /** Copied at launch: renaming or deleting the recipe must not rewrite history. */
  configName: string;
  command: string;
  /** The tree this terminal was launched from, absolute — shown, never inferred. */
  worktreePath: string;
  /** Its branch when the caller knew one. */
  worktreeBranch?: string;
  /** The resolved absolute working directory. */
  cwd: string;
  status: RunStatus;
  readiness: RunReadiness;
  readinessUrl?: string;
  /** Present only while the terminal is open. */
  pid?: number;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  signal?: string;
  /** Who closed it, when it was closed rather than ending by itself. */
  closedBy?: RunClosedBy;
  /**
   * SOMETHING WORTH KNOWING THAT DID NOT STOP THE LAUNCH — today, that the
   * readiness URL's port already answered before this terminal opened. A busy
   * port warns and never blocks: a second instance of a dev server is often
   * exactly what somebody asked for, and whether it collides is theirs to see.
   */
  warning?: string;
  /** Why it failed, in a sentence. Redacted. */
  error?: string;
  /** Env keys that were set, with secret values withheld. */
  env: Array<{ key: string; value?: string; secret?: boolean }>;
};

/**
 * The engine's refusals, shaped like `EngineStateError` so the mount point can
 * adapt them without knowing this module exists.
 *
 * DELIBERATELY NOT AN IMPORT OF `state.ts`. That file is owned elsewhere while
 * this one is being written, and a run module that cannot be unit-tested
 * without the whole engine state is worse than a four-line class.
 */
export class RunError extends Error {
  constructor(
    readonly code: "invalid_request" | "not_found" | "conflict",
    message: string,
    /** Structured detail a UI can act on — e.g. the terminals to choose from. */
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RunError";
  }
}

/**
 * AN ID FOR A TERMINAL NO HOST NAMED — the pipe fallback's. Prefixed so it can
 * never be mistaken for, or collide with, the desktop host's `term_…` ids.
 */
export function newPipeTerminalId(): string {
  return `pipe_${randomBytes(8).toString("hex")}`;
}

export function newConfigId(): string {
  return `runcfg_${randomBytes(8).toString("hex")}`;
}

/**
 * Every secret value in a configuration, longest first.
 *
 * LONGEST FIRST MATTERS: with `PASSWORD=abc123` and `TOKEN=abc123xyz`, replacing
 * the short one first leaves `«redacted»xyz` on the line — the tail of the
 * longer secret, published.
 *
 * The length and line-break filters are belt to `RunEnvVar`'s braces: nothing
 * saved through the store can be marked secret and be unscrubbable, but a
 * configuration built in a test or by a future caller can, and this must not be
 * the layer that decides to publish it. Such a value is dropped from the secret
 * list AND reported by `unhideableSecrets`, so a caller can refuse rather than
 * discover the leak in a log.
 */
export function secretValues(config: Pick<RunConfiguration, "env">): string[] {
  return (config.env ?? [])
    .filter((entry) => entry.secret && isHideable(entry.value))
    .map((entry) => entry.value)
    .sort((a, b) => b.length - a.length);
}

function isHideable(value: string): boolean {
  return value.length >= MIN_SECRET_CHARS && !/[\r\n]/.test(value);
}

/** Keys marked secret whose values redaction cannot actually remove. */
export function unhideableSecrets(config: Pick<RunConfiguration, "env">): string[] {
  return (config.env ?? []).filter((entry) => entry.secret && !isHideable(entry.value)).map((entry) => entry.key);
}

export const REDACTED = "«redacted»";

/** Replace every secret value in `text`. Used on output, errors and messages. */
export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

/**
 * A configuration safe to hand to a client: secret values dropped, not masked.
 *
 * THE OTHER FIELDS GET SCRUBBED TOO. Dropping `env[].value` is not enough — a
 * human who marks `TOKEN` secret and then writes `curl -H "x: sk_live_…"` in the
 * command has put the same string in a field this used to spread verbatim. The
 * promise attached to the word "secret" is "you will not see this value in
 * Telar", so it has to hold across every text field we hand back — INCLUDING
 * every field added later. A pinned shell is text a human wrote, so its program
 * and each of its arguments go through the scrubber like everything else.
 */
export function redactConfiguration(config: RunConfiguration): RunConfigurationView {
  const secrets = secretValues(config);
  return {
    ...config,
    name: redactText(config.name, secrets),
    command: redactText(config.command, secrets),
    ...(config.shell === undefined
      ? {}
      : {
          shell: {
            program: redactText(config.shell.program, secrets),
            ...(config.shell.args === undefined ? {} : { args: config.shell.args.map((arg) => redactText(arg, secrets)) }),
          },
        }),
    ...(config.cwd === undefined ? {} : { cwd: redactText(config.cwd, secrets) }),
    ...(config.readinessUrl === undefined ? {} : { readinessUrl: redactText(config.readinessUrl, secrets) }),
    env: (config.env ?? []).map((entry) => (entry.secret ? { key: entry.key, secret: true } : { key: entry.key, value: redactText(entry.value, secrets) })),
  };
}
