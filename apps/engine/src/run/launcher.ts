/**
 * HOW A RUN GETS A PROCESS — a port, because there are now two answers.
 *
 * Run shipped spawning a child with pipes and capturing redacted lines, which
 * the cockpit polled. The owner's decision for #198 is that RUN IS NOT A BUTTON
 * WITH A LOG PANE: it is a detached session in an integrated terminal, and the
 * terminal is a first-class surface Run is one client of. The pseudo-terminal
 * for that lives in Electron main (`apps/desktop/terminal-host.js` says why),
 * so the engine reaches it over a wire instead of holding it.
 *
 * BOTH ANSWERS STAY, AND THAT IS NOT A TRANSITION ARTEFACT. The engine also
 * runs as `bun run src/main.ts` with no Electron anywhere — no shell, no
 * channel, no PTY. A run there still has to work, so the pipe launcher is the
 * floor rather than the old way.
 *
 * WHAT THE PORT IS SHAPED AROUND IS THE FATE MODEL, not the plumbing. Four
 * callbacks, and the difference between two of them is the whole feature:
 *
 *   exited   an end was OBSERVED, with a code. The slot may be freed.
 *   failed   the launch itself threw; no process was ever created.
 *   lost     we stopped being able to vouch. `unknown`, and THE SLOT STAYS
 *            HELD. A channel that dies, goes quiet, or is torn down lands here
 *            — never in `exited`, whatever the reason was.
 *   output   captured bytes.
 *
 * A LAUNCHER HANDS BACK A HANDLE, NOT A PID. `manager.ts` could previously say
 * "the pid is only ever used while our own `ChildProcess` has not yet fired
 * exit"; over a wire the equivalent is an id the host honours only while it
 * still holds what the id names. `stop` therefore belongs to the handle, so no
 * caller is ever in a position to aim a signal at a number by itself.
 */
import { spawn } from "node:child_process";
import type { RunProcessGroup } from "./platform";
import type { RunTerminalClient, TerminalEnding } from "./terminal-client";

export type RunLaunchRequest = {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
  /** The PTY's size. Ignored by the pipe launcher, which has no geometry. */
  cols?: number;
  rows?: number;
};

export type RunLaunchEvents = {
  output(stream: "stdout" | "stderr", chunk: string): void;
  /** An observed end, with a code. The ONLY route to a terminal status. */
  exited(detail: { exitCode?: number; signal?: string }): void;
  /** No process was created at all. */
  failed(reason: string): void;
  /** We can no longer vouch. `unknown`, and the project's slot stays held. */
  lost(reason: string): void;
};

/**
 * What is holding a run's process, while something still is.
 *
 * `stop` throws the way `process.kill` does — in particular with `code: "ESRCH"`
 * when there was nothing left to stop, which the manager reads as success.
 */
export type RunHandle = {
  readonly pid: number | undefined;
  /**
   * THE HOST'S NAME FOR THIS PTY, when the run is on one — and the reason it is
   * published rather than kept private is that the cockpit needs to point at it.
   *
   * A run and a person's shell are the same kind of thing now (#890): both are
   * terminals the desktop holds, and the strip draws them side by side. To draw
   * a run the renderer has to be able to say WHICH terminal, and the only name
   * that survives the trip is the host's id — a pid is reused by the kernel and
   * an id is not. Absent for the pipe launcher, which has no terminal at all.
   */
  readonly terminalId?: string;
  /**
   * `signal` REPLACES THE POLITE ATTEMPT AND NEVER THE FORCEFUL ONE. Ctrl-C
   * semantics matter to a dev server that traps TERM to drain connections
   * (#890), so a caller may ask for SIGINT — but a `force` stop stays SIGKILL,
   * because a stop that can be refused is not what a second attempt is for.
   */
  stop(force: boolean, signal?: NodeJS.Signals): void;
  /**
   * KEYSTROKES, AND THEY ARE OPTIONAL BECAUSE ONE LAUNCHER GENUINELY HAS NO
   * KEYBOARD.
   *
   * A pipe-launched run is spawned with `stdio: ["ignore", …]` — its stdin is
   * /dev/null, and the honest answer for `bun run src/main.ts` or CI is "there
   * is nothing to type into", not a write that silently goes nowhere. The
   * manager refuses with `conflict` and says which shape it got, rather than
   * this port pretending both shapes are the same.
   *
   * Answers whether the bytes reached a process. `false` is the ordinary race
   * against an exit, not an error — see `terminal-client.ts`.
   */
  write?(data: string): Promise<boolean>;
  /** The geometry the surface drawing it is using. Same optionality, same
   *  reason: a pipe has no columns. */
  resize?(cols: number, rows: number): Promise<boolean>;
  /**
   * THE REDACTED BYTES, BACK TO WHOEVER IS HOLDING THE TERMINAL (#890).
   *
   * Only the terminal handle has one, and that is the whole of the asymmetry:
   * a PTY held by the desktop shell has a SECOND audience — the cockpit's
   * Terminal strip — reading the same device over IPC, and what that audience
   * must see is the output of `manager.ts`'s redactor rather than the raw
   * frames the host fans. A pipe-launched run has no such audience: there is no
   * shell, no IPC and no chip, so there is nothing to mirror to.
   *
   * FIRE AND FORGET, AND DELIBERATELY SO. See `terminal-client.ts`: a repaint
   * is not worth a run's slot.
   */
  mirror?(data: string, cursor: number): void;
};

export type RunLauncher = {
  /**
   * WHICH SHAPE THE CAPTURED BYTES ARRIVE IN, because redaction differs.
   *
   * `pipes` gives two streams with a line discipline, redacted line by line
   * (`stream.ts`). `pty` gives ONE stream with no reliable newlines and escape
   * sequences in it, redacted by `pty-stream.ts` — which also means stdout and
   * stderr are not separable there, because a pseudo-terminal genuinely is one
   * device and nothing downstream can un-merge them.
   */
  readonly kind: "pipes" | "pty";
  launch(request: RunLaunchRequest, events: RunLaunchEvents): Promise<RunHandle>;
};

/**
 * The original: a detached child with two pipes.
 *
 * `detached` comes from the platform — a POSIX group leader one signal reaches
 * whole, and on Windows nothing of the sort, which is why stopping there is
 * `taskkill /T`. The stdio tuple must stay a tuple or `stdout`/`stderr` come
 * back nullable under one of the two `@types/node` this file is compiled by.
 */
export function pipeLauncher(group: RunProcessGroup): RunLauncher {
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

      // LISTENERS FIRST, VERDICT SECOND. A spawn that fails emits `error`
      // asynchronously, and an `error` on a ChildProcess with no listener is an
      // unhandled exception that takes the daemon down — so nothing may return
      // from here before both handlers are attached.
      child.on("error", (error) => events.failed(error.message));
      child.on("exit", (code, signal) => {
        events.exited({ ...(code === null ? {} : { exitCode: code }), ...(signal ? { signal } : {}) });
      });
      for (const [stream, source] of [
        ["stdout", child.stdout],
        ["stderr", child.stderr],
      ] as const) {
        if (!source) continue;
        source.setEncoding("utf8");
        source.on("data", (chunk: string) => events.output(stream, chunk));
      }

      return Promise.resolve({
        get pid() {
          return child.pid;
        },
        stop(force: boolean, signal?: NodeJS.Signals) {
          if (child.pid === undefined) return;
          group.stop(child.pid, force, signal);
        },
      });
    },
  };
}

/**
 * A run on a real pseudo-terminal, held by the desktop shell.
 *
 * THE HOST'S VOCABULARY MAPS ONTO THE PORT'S ONE FOR ONE, and the mapping is
 * where `unknown` survives the wire: the host's `exited` — which only node-pty's
 * own exit event produces — is the only thing that becomes `exited` here.
 * Everything else the host can say, plus everything the CHANNEL can do to us,
 * becomes `lost`.
 *
 * NO GEOMETRY IS GUESSED. A PTY with no size reports 0×0 and every full-screen
 * program draws nothing, so a default is supplied — but it is a default for a
 * detached run nobody is looking at yet, and the surface that eventually shows
 * it is what resizes it.
 */
export function terminalLauncher(client: RunTerminalClient, defaults: { cols?: number; rows?: number } = {}): RunLauncher {
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
        },
        {
          data: (chunk) => events.output("stdout", chunk),
          ending: (ending) => deliver(ending, events),
        },
      );
      if (opened.ending) {
        deliver(opened.ending, events);
        return { pid: opened.pid, stop: () => {} };
      }
      return {
        pid: opened.pid,
        terminalId: opened.id,
        write: (data: string) => client.write(opened.id, data),
        resize: (cols: number, rows: number) => client.resize(opened.id, cols, rows),
        mirror: (data: string, cursor: number) => {
          // SWALLOWED, unlike `stop`'s rejection. A kill nobody answered must
          // become `unknown`; a repaint nobody answered is a repaint, and the
          // scrollback the chip re-reads on its next attach is the recovery.
          void client.mirror(opened.id, data, cursor).catch(() => {});
        },
        stop(force: boolean, signal?: NodeJS.Signals) {
          // BY ID, AND FIRE-AND-FORGET IS NOT AN OPTION. A kill whose request
          // never lands must not read as a kill that did, so a rejection is
          // re-raised into the manager's `stopGroup`, which turns it into
          // `unknown` — the slot stays held rather than being freed on a
          // request nobody answered.
          void client.kill(opened.id, force ? "SIGKILL" : (signal ?? "SIGTERM")).catch((error: unknown) => {
            events.lost(
              `Telar could not ask its terminal host to stop this run: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        },
      };
    },
  };
}

function deliver(ending: TerminalEnding, events: RunLaunchEvents): void {
  if (ending.fate === "exited") {
    events.exited({
      ...(typeof ending.exitCode === "number" ? { exitCode: ending.exitCode } : {}),
      ...(ending.signal ? { signal: ending.signal } : {}),
    });
    return;
  }
  if (ending.fate === "failed") {
    events.failed(ending.error ?? "Telar's terminal host could not start this run");
    return;
  }
  events.lost(ending.reason ?? "Telar's terminal host can no longer vouch for this run's process");
}
