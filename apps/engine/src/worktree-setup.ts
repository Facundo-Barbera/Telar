/**
 * ══ A NEW WORKTREE'S SETUP, IN THE BACKGROUND ══
 *
 * `setup.command` from the project's workspace config runs in the new
 * checkout while the agent starts reading. Only `blocking: true` makes the
 * first turn wait (the store keeps `preparation` at `preparing` until this
 * ends). Everything else about it is Run's discipline, reused rather than
 * re-derived: the same launcher (a detached process group one signal reaches
 * whole), the same shell resolution, the same `taskkill /T` on Windows.
 *
 * ONE PER SESSION, AND RE-RUNNABLE. A second start while one runs is refused;
 * after it ends, a start runs it again — a setup command is expected to be
 * idempotent (`bun install --frozen-lockfile` twice is a no-op), and the log
 * of the new run replaces the old one.
 *
 * ON DISK, BESIDE THE SESSION: `setup.json` (the status) and `setup.log` (the
 * output), so a restarted engine still shows what happened. A run that was
 * going when the engine went away is `interrupted`, never `running` — nothing
 * is holding it any more, and claiming otherwise would be a lie with a spinner.
 */
import fs from "node:fs";
import path from "node:path";
import type { WorkspaceConfig } from "@telar/engine-client";
import { atomicWrite } from "./atomic";
import type { RunHandle, RunLauncher } from "./run/launcher";
import { resolveShell } from "./run/shell";

export type SetupState = "running" | "succeeded" | "failed" | "timed-out" | "stopped" | "interrupted";

export type SetupStatus = {
  state: SetupState;
  command: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  signal?: string;
  /** Why it did not run to an exit code — a spawn failure, a timeout. */
  detail?: string;
};

export type SetupLine = { at: number; text: string };

/** Ten minutes: long enough for a cold install on a slow disk, short enough
 *  that a hung one is noticed the same session. `setup.timeoutMs` overrides. */
export const DEFAULT_SETUP_TIMEOUT_MS = 10 * 60 * 1000;

const MAX_LINES = 2000;
const MAX_LINE_CHARS = 4000;
/** How long a stopped setup's group gets between SIGTERM and SIGKILL — the
 *  grace its launcher is built with. Longer than a terminal's second: an
 *  installer interrupted mid-write deserves the time to clean up. */
export const SETUP_STOP_GRACE_MS = 5000;

type Live = {
  status: SetupStatus;
  handle?: RunHandle;
  lines: SetupLine[];
  /** Absolute index of `lines[0]`, so a cursor survives the ring dropping. */
  first: number;
  partial: string;
  timer?: ReturnType<typeof setTimeout>;
  stopping?: "stopped" | "timed-out";
  done: Promise<SetupStatus>;
  resolve: (status: SetupStatus) => void;
};

export type SetupDeps = {
  /** The session's own directory in the store. */
  directoryOf: (sessionId: string) => string;
  launcher: RunLauncher;
  platform?: NodeJS.Platform;
  now?: () => number;
  /** Told on every state change, so the session row can say "Setting up". */
  onChange?: (sessionId: string, status: SetupStatus) => void;
};

export class WorktreeSetups {
  private readonly live = new Map<string, Live>();
  private readonly now: () => number;

  constructor(private readonly deps: SetupDeps) {
    this.now = deps.now ?? Date.now;
  }

  private files(sessionId: string) {
    const directory = this.deps.directoryOf(sessionId);
    return { status: path.join(directory, "setup.json"), log: path.join(directory, "setup.log") };
  }

  /** What the last setup did, from memory or from disk. */
  status(sessionId: string): SetupStatus | undefined {
    const running = this.live.get(sessionId);
    if (running) return { ...running.status };
    try {
      const stored = JSON.parse(fs.readFileSync(this.files(sessionId).status, "utf8")) as SetupStatus;
      return stored.state === "running" ? { ...stored, state: "interrupted" } : stored;
    } catch {
      return undefined;
    }
  }

  /** Lines after `after` (an absolute line number), and the cursor to resume from. */
  output(sessionId: string, after = 0): { lines: SetupLine[]; cursor: number } {
    const running = this.live.get(sessionId);
    if (running) {
      const start = Math.max(after, running.first);
      return { lines: running.lines.slice(start - running.first), cursor: running.first + running.lines.length };
    }
    let text = "";
    try {
      text = fs.readFileSync(this.files(sessionId).log, "utf8");
    } catch {
      return { lines: [], cursor: 0 };
    }
    const all = text.split("\n").filter((line, index, list) => index < list.length - 1 || line.length > 0);
    return { lines: all.slice(after).map((line) => ({ at: 0, text: line })), cursor: all.length };
  }

  isRunning(sessionId: string): boolean {
    return this.live.has(sessionId);
  }

  /** Resolves when the current run ends; the last status when none is running. */
  wait(sessionId: string): Promise<SetupStatus | undefined> {
    return this.live.get(sessionId)?.done ?? Promise.resolve(this.status(sessionId));
  }

  /**
   * Run the command. Resolves once the run has STARTED (or was refused);
   * `wait` is for its end. `undefined` when the config has no setup.
   */
  async start(
    sessionId: string,
    input: { worktree: string; config: WorkspaceConfig; env?: Record<string, string> },
  ): Promise<SetupStatus | undefined> {
    const setup = input.config.setup;
    if (!setup) return undefined;
    if (this.live.has(sessionId)) return { ...this.live.get(sessionId)!.status };

    const files = this.files(sessionId);
    fs.mkdirSync(path.dirname(files.log), { recursive: true });
    fs.writeFileSync(files.log, "");
    let resolve!: (status: SetupStatus) => void;
    const done = new Promise<SetupStatus>((settle) => (resolve = settle));
    const run: Live = {
      status: { state: "running", command: setup.command, startedAt: this.now() },
      lines: [],
      first: 0,
      partial: "",
      done,
      resolve,
    };
    this.live.set(sessionId, run);
    this.persist(sessionId, run);

    this.append(sessionId, run, `$ ${setup.command}\n`);
    const shell = resolveShell({ command: setup.command }, this.deps.platform ?? process.platform, process.env);
    try {
      run.handle = await this.deps.launcher.launch(
        {
          file: shell.file,
          args: shell.args,
          cwd: input.worktree,
          env: { ...process.env, ...input.config.env, ...input.env },
          ...(shell.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        },
        {
          output: (_stream, chunk) => this.append(sessionId, run, chunk),
          exited: ({ exitCode, signal }) =>
            this.finish(sessionId, run, {
              state: run.stopping ?? (exitCode === 0 ? "succeeded" : "failed"),
              ...(exitCode === undefined ? {} : { exitCode }),
              ...(signal ? { signal } : {}),
            }),
          failed: (reason) => this.finish(sessionId, run, { state: "failed", detail: reason }),
          gone: (reason) => this.finish(sessionId, run, { state: "interrupted", detail: reason }),
        },
      );
    } catch (error) {
      this.finish(sessionId, run, { state: "failed", detail: error instanceof Error ? error.message : String(error) });
      return { ...run.status };
    }
    const timeoutMs = setup.timeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS;
    run.timer = setTimeout(() => this.halt(sessionId, "timed-out"), timeoutMs);
    run.timer.unref?.();
    return { ...run.status };
  }

  /** Stop a running setup: the polite signal, then SIGKILL after a grace. */
  stop(sessionId: string): boolean {
    return this.halt(sessionId, "stopped");
  }

  private halt(sessionId: string, why: "stopped" | "timed-out"): boolean {
    const run = this.live.get(sessionId);
    if (!run) return false;
    run.stopping ??= why;
    if (why === "timed-out") this.append(sessionId, run, `\n[telar] setup timed out; stopping it\n`);
    // The handle's close is the polite signal, the grace, then SIGKILL — the
    // escalation this used to spell out with its own timer.
    void run.handle?.close().catch(() => {
      /* already gone: its exit is on the way */
    });
    return true;
  }

  private append(sessionId: string, run: Live, chunk: string): void {
    const text = run.partial + chunk;
    const pieces = text.split("\n");
    run.partial = pieces.pop() ?? "";
    if (pieces.length === 0) return;
    const at = this.now();
    const lines = pieces.map((line) => ({ at, text: line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line }));
    run.lines.push(...lines);
    const excess = run.lines.length - MAX_LINES;
    if (excess > 0) {
      run.lines.splice(0, excess);
      run.first += excess;
    }
    try {
      fs.appendFileSync(this.files(sessionId).log, lines.map((line) => line.text).join("\n") + "\n");
    } catch {
      // A session deleted mid-setup has nowhere to log to.
    }
  }

  private finish(sessionId: string, run: Live, end: Partial<SetupStatus> & { state: SetupState }): void {
    if (this.live.get(sessionId) !== run) return;
    if (run.partial) this.append(sessionId, run, "\n");
    if (run.timer) clearTimeout(run.timer);
    run.status = { ...run.status, ...end, endedAt: this.now() };
    this.live.delete(sessionId);
    this.persist(sessionId, run);
    run.resolve({ ...run.status });
  }

  private persist(sessionId: string, run: Live): void {
    try {
      atomicWrite(this.files(sessionId).status, run.status);
    } catch {
      // Same as the log.
    }
    this.deps.onChange?.(sessionId, { ...run.status });
  }

  /** Stop everything on the way out, so no setup outlives its engine. */
  stopAll(): void {
    for (const sessionId of [...this.live.keys()]) this.stop(sessionId);
  }
}
