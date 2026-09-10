/**
 * A project's saved launches, and the record of one actually running.
 *
 * TWO NOUNS, AND THE SPLIT IS THE WHOLE MODEL. A RUN CONFIGURATION is a saved
 * recipe that belongs to the PROJECT — a name, a command, a working directory,
 * environment variables — and it outlives every conversation. A RUN is one
 * execution of that recipe: it captured a worktree, a resolved cwd, a process
 * group and an exit code, and it belongs to the project too rather than to the
 * session that happened to press play. Changing conversation, or closing one,
 * neither switches nor kills a run; that is the point of keeping the run off
 * the session.
 *
 * THE CWD IS RELATIVE AND THE WORKTREE IS EXPLICIT. A configuration says
 * `apps/web`, not `/Users/…/apps/web`, because the same recipe has to be
 * launchable from the project's own checkout and from any worktree cut off it.
 * Which tree a run actually used is captured on the RUN — never inferred later,
 * because the session that reads it may be sitting on a different one, and a
 * run silently attributed to the reader's tree is how you stop a server you
 * did not start.
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

export const RunConfigurationInput = z.object({
  name: z.string().min(1).max(120),
  /** Run by a shell, so `bun run dev` and `a && b` both mean what they look like. */
  command: z.string().min(1).max(4000),
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
 * WHERE A RUN IS IN ITS LIFE — and `ready` is deliberately expensive to reach.
 *
 *   starting  reserved and spawning; the slot is already held
 *   running   the process is alive and we have no readiness check, or it has
 *             not answered yet
 *   ready     ONLY after a readiness URL that was silent before the launch
 *             answered after it. See `RunReadiness`.
 *   exited    the process ended on its own; `exitCode` says how
 *   failed    it never started, or ended non-zero
 *   unknown   we cannot vouch for the process any more. The slot STAYS HELD and
 *             nothing is signalled — see `release`.
 */
export const RunStatus = z.enum(["starting", "running", "ready", "exited", "failed", "unknown"]);
export type RunStatus = z.infer<typeof RunStatus>;

export function isTerminal(status: RunStatus): boolean {
  return status === "exited" || status === "failed";
}

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

/** A run as anyone outside the manager sees it. Never carries secret values. */
export type RunView = {
  runId: string;
  projectId: string;
  configId: string;
  /** Copied at launch: renaming or deleting the recipe must not rewrite history. */
  configName: string;
  command: string;
  /** The tree this run was launched from, absolute — shown, never inferred. */
  worktreePath: string;
  /** Its branch when the caller knew one. */
  worktreeBranch?: string;
  /** The resolved absolute working directory. */
  cwd: string;
  /** The session that pressed play. Provenance only: it owns nothing. */
  startedBySessionId?: string;
  status: RunStatus;
  readiness: RunReadiness;
  readinessUrl?: string;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  signal?: string;
  /** Why it failed or went unknown, in a sentence. Redacted. */
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
    /** Structured detail a UI can act on — e.g. the run holding the slot. */
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RunError";
  }
}

export function newRunId(): string {
  return `run_${randomBytes(8).toString("hex")}`;
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
 * Telar", so it has to hold across every text field we hand back.
 */
export function redactConfiguration(config: RunConfiguration): RunConfigurationView {
  const secrets = secretValues(config);
  return {
    ...config,
    name: redactText(config.name, secrets),
    command: redactText(config.command, secrets),
    ...(config.cwd === undefined ? {} : { cwd: redactText(config.cwd, secrets) }),
    ...(config.readinessUrl === undefined ? {} : { readinessUrl: redactText(config.readinessUrl, secrets) }),
    env: (config.env ?? []).map((entry) => (entry.secret ? { key: entry.key, secret: true } : { key: entry.key, value: redactText(entry.value, secrets) })),
  };
}
