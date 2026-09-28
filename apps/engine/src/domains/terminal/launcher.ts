import { type RunOrigin } from "@telar/engine-client";
import { spawn } from "node:child_process";
import type { RunProcessGroup } from "./platform";
import type { RunTerminalClient, TerminalEnding, TerminalFacts } from "./terminal-client";
import { newPipeTerminalId } from "./types";

export type RunLaunchRequest = {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
  cols?: number;
  rows?: number;
  sessionId?: string;
  origin?: RunOrigin;
  title?: string;
};

type RunCloseReason = NonNullable<TerminalEnding["closed"]>;

export type RunLaunchEvents = {
  output(stream: "stdout" | "stderr", chunk: string): void;
  exited(detail: { exitCode?: number; signal?: string; closed?: RunCloseReason }): void;
  failed(reason: string): void;
  gone(reason: string): void;
};

export type RunHandle = {
  readonly pid: number | undefined;
  readonly terminalId: string;
  close(): Promise<void>;
  signal(signal: NodeJS.Signals): Promise<void>;
  write?(data: string): Promise<boolean>;
  resize?(cols: number, rows: number): Promise<boolean>;
  mirror?(data: string, cursor: number): void;
};

export type RunLauncher = {
  readonly kind: "pipes" | "pty";
  launch(request: RunLaunchRequest, events: RunLaunchEvents): Promise<RunHandle>;
  held?(): Promise<TerminalFacts[]>;
  adopt?(facts: TerminalFacts, events: RunLaunchEvents): Promise<RunHandle>;
  closeSession?(sessionId: string): Promise<number>;
  sessionCounts?(): Promise<Record<string, number>>;
  detach?(): void;
};

const PIPE_CLOSE_GRACE_MS = 1000;

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
        windowsVerbatimArguments: request.windowsVerbatimArguments,
        stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
      });

      let ended = false;
      const exit = new Promise<void>((resolve) => {
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
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      };

      return Promise.resolve({
        get pid() {
          return child.pid;
        },
        terminalId: newPipeTerminalId(),
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

export function terminalLauncher(client: RunTerminalClient, defaults: { cols?: number; rows?: number } = {}): RunLauncher {
  const handleFor = (id: string, pid: number | undefined): RunHandle => ({
    pid,
    terminalId: id,
    write: (data: string) => client.write(id, data),
    resize: (cols: number, rows: number) => client.resize(id, cols, rows),
    mirror: (data: string, cursor: number) => {
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
  events.gone(ending.reason ?? "Telar's terminal host stopped holding this terminal");
}
