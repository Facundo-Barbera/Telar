/**
 * ONE EXTERNAL PLUGIN'S PROCESS, SUPERVISED — started when first needed, kept
 * alive while it is wanted, restarted with backoff when it dies, and stopped
 * when nobody uses it any more.
 *
 * ── THE WIRE: NEWLINE-DELIMITED JSON-RPC 2.0 ON STDIO ───────────────────────
 * The simplest channel there is: no port to allocate, no socket file to clean
 * up, and it dies with the process. One JSON object per line each way.
 *
 *   initialize   MCP's handshake, once per start (`protocolVersion`, `clientInfo`)
 *   tools/call   MCP's, for the tools the manifest declares
 *   telar/route  Telar's, for a route verb: `{ scope, verb, input, query?,
 *                params?, sessionId?, projectId?, settings }` → any JSON value
 *
 * A `tools/call` carries `_meta.telar = { sessionId, projectId, settings }`.
 *
 * stderr is the plugin's log: captured, kept as a short tail in memory for
 * Settings, and appended to `<stateDir>/log.txt`.
 *
 * ── NOT A SANDBOX ────────────────────────────────────────────────────────────
 * External plugins are the owner's own code for now. The child gets a minimal
 * environment (no engine token, no provider keys), its own folder as cwd and a
 * state directory; it can still do anything the user can. Isolation is a later
 * design, and nothing here pretends otherwise.
 */
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

/** The part of a child process this needs — so a test can hand in its own. */
export type PluginChild = {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
};

export type PluginTimers = {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
};

export type ExternalProcessOptions = {
  id: string;
  dir: string;
  command: readonly string[];
  /** Where the plugin may keep state, and where its log is appended. */
  stateDir: string;
  spawn?: (command: string, args: readonly string[], options: { cwd: string; env: Record<string, string> }) => PluginChild;
  timers?: PluginTimers;
  /** A request that has not answered by then is refused. */
  requestTimeoutMs?: number;
  /** How long `initialize` may take before the start counts as failed. */
  startTimeoutMs?: number;
};

export type ExternalProcessState = "stopped" | "starting" | "running" | "backoff";

/** 1s, 2s, 4s … capped — and reset once a start has stayed up this long. */
export const RESTART_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
export const STABLE_AFTER_MS = 60_000;
const LOG_TAIL = 200;

const realTimers: PluginTimers = {
  setTimeout: (handler, ms) => {
    const timer = setTimeout(handler, ms);
    timer.unref?.();
    return timer;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: unknown };

export class ExternalPluginProcess {
  private child: PluginChild | undefined;
  private starting: Promise<void> | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = "";
  private readonly tail: string[] = [];
  private wanted = false;
  private restartTimer: unknown;
  private startedAt = 0;
  private failures = 0;
  /** Starts after the first, for the status line. */
  restarts = 0;
  state: ExternalProcessState = "stopped";
  lastError: string | undefined;

  private readonly timers: PluginTimers;
  private readonly spawnChild: NonNullable<ExternalProcessOptions["spawn"]>;

  constructor(private readonly options: ExternalProcessOptions) {
    this.timers = options.timers ?? realTimers;
    this.spawnChild =
      options.spawn ??
      ((command, args, spawnOptions) =>
        nodeSpawn(command, [...args], { cwd: spawnOptions.cwd, env: spawnOptions.env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] }) as PluginChild);
  }

  /** The last lines the plugin wrote to stderr, oldest first. */
  logs(): readonly string[] {
    return this.tail;
  }

  /** Start if needed and wait until `initialize` has answered. */
  ensureStarted(): Promise<void> {
    this.wanted = true;
    if (this.state === "running") return Promise.resolve();
    this.starting ??= this.start().finally(() => (this.starting = undefined));
    return this.starting;
  }

  /** One JSON-RPC request, starting the process first if it is not running. */
  async request(method: string, params: unknown): Promise<unknown> {
    await this.ensureStarted();
    return this.send(method, params);
  }

  /** Stop and stay stopped: no restart, every in-flight request refused. */
  async stop(): Promise<void> {
    this.wanted = false;
    if (this.restartTimer !== undefined) this.timers.clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const child = this.child;
    this.child = undefined;
    this.state = "stopped";
    this.failAll(new Error(`${this.options.id} stopped`));
    if (!child) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      if (!child.kill("SIGTERM")) resolve();
    });
  }

  /** Whether any request is in flight — the host's `busy`. */
  get busy(): boolean {
    return this.pending.size > 0;
  }

  private async start(): Promise<void> {
    this.state = "starting";
    const [program, ...args] = this.options.command;
    const command = program!.startsWith("./") ? path.join(this.options.dir, program!) : program!;
    fs.mkdirSync(this.options.stateDir, { recursive: true });
    const child = this.spawnChild(command, args, {
      cwd: this.options.dir,
      // MINIMAL ON PURPOSE: the plugin needs a PATH and a HOME to run, and its
      // own two directories — not the engine's token or a provider's key.
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        TELAR_PLUGIN_ID: this.options.id,
        TELAR_PLUGIN_DIR: this.options.dir,
        TELAR_PLUGIN_STATE: this.options.stateDir,
      },
    });
    this.child = child;
    this.buffer = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.receive(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => this.log(chunk));
    child.once("error", (error) => this.exited(child, error.message));
    child.once("exit", (code, signal) => this.exited(child, `exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`));
    try {
      await this.send(
        "initialize",
        { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "telar", version: "1" } },
        this.options.startTimeoutMs ?? 10_000,
      );
      this.notify("notifications/initialized");
      this.state = "running";
      this.startedAt = this.timers.now();
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      child.kill("SIGKILL");
      throw new Error(`${this.options.id} did not start: ${this.lastError}`);
    }
  }

  private send(method: string, params: unknown, timeoutMs = this.options.requestTimeoutMs ?? 60_000): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin) return Promise.reject(new Error(`${this.options.id} is not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.options.id} did not answer ${method} in time`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private notify(method: string): void {
    this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!line) continue;
      let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
      try {
        message = JSON.parse(line);
      } catch {
        // Not a protocol line — something the plugin printed. Keep it as log.
        this.log(`${line}\n`);
        continue;
      }
      const waiting = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
      if (!waiting) continue;
      this.pending.delete(message.id as number);
      this.timers.clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new Error(String(message.error.message ?? "plugin error")));
      else waiting.resolve(message.result);
    }
  }

  private exited(child: PluginChild, why: string): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.lastError = why;
    this.failAll(new Error(`${this.options.id} ${why}`));
    if (!this.wanted) {
      this.state = "stopped";
      return;
    }
    // A start that stayed up long enough was healthy; the next crash starts
    // the backoff over rather than waiting thirty seconds for a one-off.
    if (this.startedAt && this.timers.now() - this.startedAt >= STABLE_AFTER_MS) this.failures = 0;
    const delay = RESTART_BACKOFF_MS[Math.min(this.failures, RESTART_BACKOFF_MS.length - 1)]!;
    this.failures += 1;
    this.state = "backoff";
    this.log(`[telar] ${this.options.id} ${why}; restarting in ${delay}ms\n`);
    this.restartTimer = this.timers.setTimeout(() => {
      this.restartTimer = undefined;
      if (!this.wanted) return;
      this.restarts += 1;
      this.ensureStarted().catch(() => undefined);
    }, delay);
  }

  private failAll(error: Error): void {
    for (const [id, waiting] of this.pending) {
      this.timers.clearTimeout(waiting.timer);
      waiting.reject(error);
      this.pending.delete(id);
    }
  }

  private log(text: string): void {
    for (const line of text.split("\n")) if (line) this.tail.push(line);
    if (this.tail.length > LOG_TAIL) this.tail.splice(0, this.tail.length - LOG_TAIL);
    try {
      fs.appendFileSync(path.join(this.options.stateDir, "log.txt"), text);
    } catch {
      // A log that cannot be written costs the log, never the plugin.
    }
  }
}
