/**
 * THE ONE PLACE A SHELL COMMAND RUNS.
 *
 * Every command the Loom executes — `probe`, `list`, `detail`, `publish`,
 * `setup`, every gate — arrives here and nowhere else. Not for tidiness: it is
 * the only way the injection promise in `daemon.ts:51-85` can hold. A second
 * spawn site somewhere in `dispatch.ts` would be a path a test cannot fake, and
 * the first time it ran in CI it would spend somebody's GitHub rate limit.
 *
 * ── WHY SUBSTITUTION GOES THROUGH THE ENVIRONMENT ───────────────────────────
 * The Program declares slots as literal `$ITEM`, `$BRANCH`, `$TITLE`, `$BODY`,
 * `$BASE` (build spec §1). The naive implementation pastes the value into the
 * command string. That is wrong for one boring, guaranteed reason: `$TITLE` and
 * `$BODY` are issue text. Issue text contains quotes, backticks, `$`, and
 * newlines. Pasting `Fix the "auth" bug` into
 *
 *     gh pr create --title "$TITLE"
 *
 * produces `--title "Fix the "auth" bug"` — three arguments, a broken publish,
 * and at worst a backtick that executes. So `substitute` replaces `$TITLE` with
 * `"$LOOM_TITLE"` — a QUOTED ENVIRONMENT REFERENCE — and the value is exported
 * as `LOOM_TITLE`. The shell then dereferences it without re-parsing it, which
 * is the one path where a value containing quotes stays one value.
 *
 * The values are ALSO passed as plain `ITEM`/`BRANCH`/… env vars, so a Program
 * that prefers `${ITEM}` or reads the environment directly still works. The
 * command string itself remains user-authored shell — refusing that would mean
 * building the abstraction the spec's §1 exists to forbid.
 *
 * ── BOTH STREAMS, ALWAYS, TRUNCATED ─────────────────────────────────────────
 * This output goes into an agent prompt. A gate that fails and prints 40 MB of
 * stack traces would otherwise blow a tick's context — and §3.2's whole claim is
 * that a tick is bounded by construction. So each stream is capped and the cut
 * is MARKED: silent truncation reads to the agent as "that was all of it".
 */
import { spawn } from "node:child_process";

export type LoomExecInput = {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type LoomExecResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type LoomExec = (input: LoomExecInput) => Promise<LoomExecResult>;

/** Ordinary commands: `probe`, `list`, `detail`, `publish`, `setup`. */
export const DEFAULT_TIMEOUT_MS = 120_000;
/** Gates run a test suite. 15 minutes, per the build spec. */
export const GATE_TIMEOUT_MS = 900_000;
/** Per stream. 64 KB is far more than a human reads and far less than a context. */
export const OUTPUT_CAP = 64 * 1024;

/** The slots the Program may reference, per build spec §1. */
export const SLOTS = ["ITEM", "BRANCH", "TITLE", "BODY", "BASE"] as const;
export type Slot = (typeof SLOTS)[number];

/** The env prefix. Namespaced so a Program's own `TITLE` cannot be shadowed by
 *  accident, and so the reference `substitute` writes is unambiguous. */
export const ENV_PREFIX = "LOOM_";

export function truncate(text: string, cap = OUTPUT_CAP): string {
  if (text.length <= cap) return text;
  const dropped = text.length - cap;
  return `${text.slice(0, cap)}\n… [truncated ${dropped} more characters]`;
}

/**
 * Literal `$NAME` (and `${NAME}`) replacement, rewritten to a quoted env
 * reference rather than to the value. See this file's header for why.
 *
 * `\b` after the name is what keeps `$ITEMS` from being eaten when `ITEM` is a
 * slot: `M` and `S` are both word characters, so there is no boundary between
 * them and the alternative does not match.
 */
export function substitute(command: string, vars: Record<string, string>): string {
  const names = Object.keys(vars).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  if (names.length === 0) return command;
  // Longest first, so `$BASE` cannot be matched as a prefix of a longer slot.
  names.sort((a, b) => b.length - a.length);
  const group = names.join("|");
  const pattern = new RegExp(`\\$\\{(${group})\\}|\\$(${group})\\b`, "g");
  return command.replace(pattern, (_match, braced?: string, bare?: string) => `"$${ENV_PREFIX}${braced ?? bare}"`);
}

/**
 * The environment half of the substitution: both the namespaced reference
 * `substitute` writes and the bare name, so either style of Program works.
 */
export function slotEnv(vars: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(vars)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    env[`${ENV_PREFIX}${name}`] = value;
    env[name] = value;
  }
  return env;
}

/** `substitute` + `slotEnv` in one call, which is how every caller wants it. */
export function withSlots(
  input: Omit<LoomExecInput, "command"> & { command: string; vars?: Record<string, string> },
): LoomExecInput {
  const vars = input.vars ?? {};
  const { vars: _dropped, ...rest } = input;
  return { ...rest, command: substitute(input.command, vars), env: { ...slotEnv(vars), ...(input.env ?? {}) } };
}

// ── git, run here rather than on the synchronous runner ─────────────────────

/**
 * THE ENGINE'S OWN GIT, ASYNCHRONOUSLY.
 *
 * `GitRunner` (`worktree.ts`) is `execFileSync`. For a `rev-parse` that is the
 * right trade — a ref read is faster than the fork it would take to avoid it.
 * For `fetch` and `rebase` it is not: those are network- and repository-sized,
 * and a synchronous one stalls the daemon's event loop, which means it stalls
 * every HTTP request the cockpit makes, at exactly the moment several looms are
 * advancing at once. Those calls come through here instead.
 *
 * ── WHY ARGV DOES NOT GO INTO THE COMMAND STRING ────────────────────────────
 * `LoomExec` runs a shell, so `git rebase ${ref}` would be a command-injection
 * surface — and the values are not hypothetical: a branch prefix comes from the
 * Program a human authored, and a ref comes back out of `git` itself. So argv
 * takes the route this file's header already argues for `$TITLE` and `$BODY`:
 * each argument is exported as `LOOM_ARG<n>` and the command string references
 * it QUOTED. The shell dereferences without re-parsing, so a value containing
 * `;`, a backtick or a newline stays exactly one argument, and nothing an
 * attacker can write into a branch name reaches the shell as syntax.
 *
 * The consequence worth stating: the command string contains no data at all,
 * only `git` and a fixed number of `"$LOOM_ARGn"` tokens. That is the property
 * to test, not the prefix.
 */
export const ARG_PREFIX = `${ENV_PREFIX}ARG`;

export function gitCommand(args: string[]): { command: string; env: Record<string, string> } {
  const env: Record<string, string> = {};
  const parts = ["git"];
  args.forEach((arg, index) => {
    const name = `${ARG_PREFIX}${index}`;
    env[name] = arg;
    parts.push(`"$${name}"`);
  });
  return { command: parts.join(" "), env };
}

/**
 * `GitResult`'s shape plus the one thing a shell adds: a command can be killed
 * for taking too long, which is `unknown` rather than a git failure and must not
 * be read as one by the caller.
 */
export type LoomGitResult = { status: number; stdout: string; stderr: string; timedOut: boolean };

export async function execGit(
  exec: LoomExec,
  cwd: string,
  args: string[],
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<LoomGitResult> {
  const { command, env } = gitCommand(args);
  const run = await exec({
    command,
    cwd,
    env,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { status: run.code, stdout: run.stdout, stderr: run.stderr, timedOut: run.timedOut };
}

/**
 * The real one. A shell, because the Program's commands are shell — same trust
 * level as a `package.json` script, which is the spec's decided posture.
 *
 * NEVER REJECTS. A caller mid-lifecycle needs an outcome it can record, not an
 * exception that unwinds a background promise and takes the daemon down
 * (`state.ts:2112-2126`). A spawn that fails to start is exit 127 with the
 * reason on stderr, which is exactly what a shell would have reported anyway.
 */
export const defaultLoomExec: LoomExec = (input) =>
  new Promise<LoomExecResult>((resolve) => {
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout: truncate(stdout), stderr: truncate(stderr), timedOut });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(input.command, {
        cwd: input.cwd,
        shell: true,
        env: { ...process.env, ...(input.env ?? {}) },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false });
      return;
    }

    // Kept unbounded in memory only up to the cap: past it we stop appending
    // rather than buffer a gigabyte we are about to throw away.
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < OUTPUT_CAP * 2) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < OUTPUT_CAP * 2) stderr += chunk.toString("utf8");
    });

    const onAbort = (): void => {
      child.kill("SIGTERM");
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) onAbort();

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    // The daemon must be able to exit with a gate still running; the gate's own
    // timeout is what bounds it, not the event loop staying alive for it.
    timer.unref?.();

    child.on("error", (error) => {
      stderr += `\n${error instanceof Error ? error.message : String(error)}`;
      finish(127);
    });
    child.on("close", (code, signal) => {
      // A killed process reports `null`; the shell's own convention for that is
      // 128+signal, and reporting `0` would read as a pass.
      finish(typeof code === "number" ? code : signal ? 128 : 1);
    });
  });
