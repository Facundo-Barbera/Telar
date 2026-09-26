/**
 * HOW A RUN GETS A TERMINAL — a port, because there are two answers.
 *
 * On the desktop a run is a pseudo-terminal the shell holds in Electron main
 * (`apps/desktop/terminal-host.js` says why it lives there), reached over a
 * wire. Without Electron — `bun run src/main.ts`, a test, a headless host —
 * there is no PTY to reach, so a run is a detached child with pipes. BOTH
 * STAY, and the pipe launcher is the floor rather than the old way: multiple
 * instances, no chip, the same byte path.
 *
 * WHAT THE PORT IS SHAPED AROUND IS WHAT THE HOST CAN TELL US, and since "Run
 * = a new terminal" that is all the engine records — no liveness of its own:
 *
 *   exited   an end was OBSERVED, with a code (and, when the host was closing
 *            it, why).
 *   failed   the launch itself threw; no process was ever created.
 *   gone     the host no longer holds it and we did not hear it end — it was
 *            closed while the engine was not listening.
 *   output   captured bytes.
 *
 * There used to be a fourth, `lost`, which turned a dropped channel into an
 * `unknown` run holding its project's slot. A dropped channel now reconnects
 * (`terminal-client.ts`) and nothing holds anything.
 *
 * A LAUNCHER HANDS BACK A HANDLE, NOT A PID. Over the wire the handle is an id
 * the host honours only while it still holds what the id names, so `close`
 * belongs to the handle and no caller can aim a signal at a number by itself.
 */
import { spawn } from "node:child_process";
import type { RunProcessGroup } from "./platform";
import type { RunTerminalClient, TerminalEnding, TerminalFacts } from "./terminal-client";
import { newPipeTerminalId, type RunOrigin } from "./types";

export type RunLaunchRequest = {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
  /** The PTY's size. Ignored by the pipe launcher, which has no geometry. */
  cols?: number;
  rows?: number;
  /** Who owns the terminal and what its tab says. Ignored by the pipe launcher,
   *  which has no tab and no host to tell — and absent for a worktree's setup
   *  command, which borrows this launcher without being a terminal anybody
   *  opened. */
  sessionId?: string;
  origin?: RunOrigin;
  title?: string;
};

/** Why the host was ending a terminal, when it was the host that did. */
export type RunCloseReason = NonNullable<TerminalEnding["closed"]>;

export type RunLaunchEvents = {
  output(stream: "stdout" | "stderr", chunk: string): void;
  /** An observed end, with a code. */
  exited(detail: { exitCode?: number; signal?: string; closed?: RunCloseReason }): void;
  /** No process was created at all. */
  failed(reason: string): void;
  /** The host no longer holds it, and we did not hear how it ended. */
  gone(reason: string): void;
};

/**
 * What is holding a terminal's process, while something still is.
 */
export type RunHandle = {
  readonly pid: number | undefined;
  /**
   * THE TERMINAL'S NAME — the host's id on a PTY, a minted `pipe_…` id with no
   * Electron. It is the identity of the whole record, which is why it is not
   * optional: a caller names a terminal by it whether or not a host exists.
   */
  readonly terminalId: string;
  /**
   * CLOSE IT, WHICH ENDS WHAT RUNS IN IT. Resolves once the escalation is over
   * — SIGTERM, then SIGKILL after a grace — not necessarily once the exit has
   * been reported; that still arrives through `exited`. Rejects only when the
   * close could not even be asked for (the host is out of reach).
   */
  close(): Promise<void>;
  /**
   * One polite signal to the whole tree, before a close — SIGINT for a server
   * that only stops the way Ctrl-C stops it. Throws like `process.kill`.
   */
  signal(signal: NodeJS.Signals): Promise<void>;
  /**
   * KEYSTROKES, AND THEY ARE OPTIONAL BECAUSE ONE LAUNCHER GENUINELY HAS NO
   * KEYBOARD. A pipe-launched child's stdin is /dev/null; the honest answer
   * there is "nothing to type into", not a write that silently goes nowhere.
   */
  write?(data: string): Promise<boolean>;
  /** The geometry the surface drawing it is using. Same optionality. */
  resize?(cols: number, rows: number): Promise<boolean>;
  /**
   * THE REDACTED BYTES, BACK TO WHOEVER IS HOLDING THE TERMINAL (#890). Only a
   * PTY has a second audience — the cockpit's strip — and what it must see is
   * the output of `manager.ts`'s redactor rather than the raw frames the host
   * fans. FIRE AND FORGET: a repaint is not worth failing a terminal over.
   */
  mirror?(data: string, cursor: number): void;
};

export type RunLauncher = {
  /**
   * WHICH SHAPE THE CAPTURED BYTES ARRIVE IN, because redaction differs: two
   * line-disciplined streams (`stream.ts`) or one PTY stream with escapes and
   * no reliable newlines (`pty-stream.ts`).
   */
  readonly kind: "pipes" | "pty";
  launch(request: RunLaunchRequest, events: RunLaunchEvents): Promise<RunHandle>;
  /**
   * WHAT THE HOST STILL HOLDS, for an engine re-listing its terminals after a
   * restart. Absent for pipes: a child of a previous engine is nobody's to
   * pick up.
   */
  held?(): Promise<TerminalFacts[]>;
  /** Follow a terminal the host kept from a previous engine. */
  adopt?(facts: TerminalFacts, events: RunLaunchEvents): Promise<RunHandle>;
  /**
   * CLOSE EVERY TERMINAL A SESSION OWNS, WHOEVER OPENED IT — the host's
   * `/close-session`, which also reaches the shells the person opened in that
   * session's panel. Answers how many the host closed. Absent for pipes: the
   * engine's own children are every terminal there is, and it closes those.
   */
  closeSession?(sessionId: string): Promise<number>;
  /**
   * HOW MANY TERMINALS EACH SESSION HOLDS, WHOEVER OPENED THEM — the host's
   * `GET /sessions` (#883). Absent for pipes, for `closeSession`'s reason.
   */
  sessionCounts?(): Promise<Record<string, number>>;
  /** The engine is going down: stop listening, close nothing. */
  detach?(): void;
};

/** How long a pipe child's group gets between SIGTERM and SIGKILL. The host's
 *  own close uses the same second (`CLOSE_GRACE_MS` in terminal-host.js). */
const PIPE_CLOSE_GRACE_MS = 1000;

/**
 * The fallback: a detached child with two pipes.
 *
 * `detached` comes from the platform — a POSIX group leader one signal reaches
 * whole, and on Windows nothing of the sort, which is why stopping there is
 * `taskkill /T`. The stdio tuple must stay a tuple or `stdout`/`stderr` come
 * back nullable under one of the two `@types/node` this file is compiled by.
 *
 * ITS CLOSE IS THE HOST'S CLOSE, REBUILT LOCALLY. SIGTERM to the group, a
 * grace, SIGKILL — and because this process holds the `ChildProcess`, the
 * exit it waits for is the real one rather than a guess.
 */
export function pipeLauncher(group: RunProcessGroup, options: { graceMs?: number } = {}): RunLauncher {
  const graceMs = options.graceMs ?? PIPE_CLOSE_GRACE_MS;
  return {
    kind: "pipes",
    launch(request, events) {
      const child = spawn(request.file, request.args, {
        cwd: request.cwd,
        env: request.env,
        shell: false,
        detached: group.detached,
        // `cmd.exe` parses its own command line, so node must hand the string
        // over unquoted; on every other path this is false and ignored.
        windowsVerbatimArguments: request.windowsVerbatimArguments,
        stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
      });

      let ended = false;
      const exit = new Promise<void>((resolve) => {
        // LISTENERS FIRST, VERDICT SECOND. A spawn that fails emits `error`
        // asynchronously, and an `error` on a ChildProcess with no listener is
        // an unhandled exception that takes the daemon down.
        child.on("error", (error) => {
          ended = true;
          events.failed(error.message);
          resolve();
        });
        child.on("exit", (code, signal) => {
          ended = true;
          events.exited({ ...(code === null ? {} : { exitCode: code }), ...(signal ? { signal } : {}) });
          resolve();
        });
      });
      for (const [stream, source] of [
        ["stdout", child.stdout],
        ["stderr", child.stderr],
      ] as const) {
        if (!source) continue;
        source.setEncoding("utf8");
        source.on("data", (chunk: string) => events.output(stream, chunk));
      }

      const within = (ms: number) =>
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(ended), ms);
          timer.unref?.();
          void exit.then(() => {
            clearTimeout(timer);
            resolve(true);
          });
        });
      const send = (force: boolean, signal?: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try {
          group.stop(child.pid, force, signal);
        } catch (error) {
          // ESRCH: already gone; its `exit` is on the way.
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      };

      return Promise.resolve({
        get pid() {
          return child.pid;
        },
        terminalId: newPipeTerminalId(),
        /**
         * THE SHELL LEAVING IS NOT THE GROUP LEAVING. A child that traps TERM
         * outlives the shell that obeyed it, so when the shell exits inside the
         * grace the group is asked ONCE whether it is empty — the single look
         * the host takes too — and SIGKILL goes to whatever is left. A group
         * seen empty is never signalled again.
         */
        async close() {
          if (ended) return;
          send(false);
          const exited = await within(graceMs);
          if (exited && child.pid !== undefined && group.emptied(child.pid)) return;
          send(true);
          if (!exited) await within(graceMs);
        },
        async signal(signal: NodeJS.Signals) {
          if (!ended) send(signal === "SIGKILL", signal);
        },
      });
    },
  };
}

/**
 * A run on a real pseudo-terminal, held by the desktop shell.
 *
 * NO GEOMETRY IS GUESSED. A PTY with no size reports 0×0 and every full-screen
 * program draws nothing, so a default is supplied — for a terminal nobody is
 * looking at yet; the surface that shows it is what resizes it.
 */
export function terminalLauncher(client: RunTerminalClient, defaults: { cols?: number; rows?: number } = {}): RunLauncher {
  const handleFor = (id: string, pid: number | undefined): RunHandle => ({
    pid,
    terminalId: id,
    write: (data: string) => client.write(id, data),
    resize: (cols: number, rows: number) => client.resize(id, cols, rows),
    mirror: (data: string, cursor: number) => {
      // SWALLOWED: a repaint nobody answered is a repaint, and the scrollback
      // the chip re-reads on its next attach is the recovery.
      void client.mirror(id, data, cursor).catch(() => {});
    },
    async close() {
      await client.close(id);
    },
    async signal(signal: NodeJS.Signals) {
      await client.kill(id, signal);
    },
  });
  const sinkFor = (events: RunLaunchEvents) => ({
    data: (chunk: string) => events.output("stdout", chunk),
    ending: (ending: TerminalEnding) => deliver(ending, events),
    gone: (reason: string) => events.gone(reason),
  });
  return {
    kind: "pty",
    async launch(request, events) {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.env)) {
        if (typeof value === "string") env[key] = value;
      }
      const opened = await client.open(
        {
          shell: request.file,
          args: request.args,
          cwd: request.cwd,
          env,
          cols: request.cols ?? defaults.cols ?? 120,
          rows: request.rows ?? defaults.rows ?? 30,
          sessionId: request.sessionId,
          origin: request.origin,
          title: request.title,
        },
        sinkFor(events),
      );
      if (opened.ending) {
        deliver(opened.ending, events);
        return { pid: opened.pid, terminalId: opened.id, close: async () => {}, signal: async () => {} };
      }
      return handleFor(opened.id, opened.pid);
    },
    held: () => client.state(),
    async adopt(facts, events) {
      await client.adopt(facts.id, sinkFor(events));
      return handleFor(facts.id, facts.pid);
    },
    closeSession: (sessionId) => client.closeSession(sessionId),
    sessionCounts: () => client.sessionCounts(),
    detach: () => client.detach(),
  };
}

function deliver(ending: TerminalEnding, events: RunLaunchEvents): void {
  if (ending.fate === "exited") {
    events.exited({
      ...(typeof ending.exitCode === "number" ? { exitCode: ending.exitCode } : {}),
      ...(ending.signal ? { signal: ending.signal } : {}),
      ...(ending.closed ? { closed: ending.closed } : {}),
    });
    return;
  }
  if (ending.fate === "failed") {
    events.failed(ending.error ?? "Telar's terminal host could not start this terminal");
    return;
  }
  // A host older than this change can still say `unknown`. It holds nothing
  // now: the host has stopped holding the terminal, which is `gone`.
  events.gone(ending.reason ?? "Telar's terminal host stopped holding this terminal");
}
