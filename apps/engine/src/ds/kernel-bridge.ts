/**
 * The transport to one `bridge.py` process: newline-delimited JSON-RPC over
 * stdio. A near copy of `codex/app-server.ts`, and the differences are the
 * point:
 *
 *   - `write()` IS DRAIN-AWARE AND SERIALIZED. `notebook_run_all` posts many
 *     executes back to back; ignoring `false` from `stdin.write` (as the codex
 *     transport can afford to) would buffer a notebook's worth of source in
 *     this process while the kernel is busy with cell one.
 *   - Notifications are dispatched to a handler rather than queued. An output
 *     is an event to journal NOW; the caller waiting on `execute` collects its
 *     own by `execId`.
 *
 * NO RESTART LOGIC HERE. A dead bridge rejects everything; the host decides
 * whether to spawn a new one. Restarting the KERNEL is a protocol verb.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

type JsonRpc = { jsonrpc?: string; id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };

export type BridgeNotification = { method: string; params: Record<string, unknown> };

export type SpawnBridge = (python: string, script: string, options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;

export const defaultSpawnBridge: SpawnBridge = (python, script, options) =>
  spawn(python, ["-u", script], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });

export class KernelBridge {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private closed = false;
  private closeError: Error | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly stderrTail: string[] = [];

  onNotification?: (notification: BridgeNotification) => void;
  onClose?: (error: Error) => void;

  constructor(python: string, script: string, options: { cwd: string; env?: NodeJS.ProcessEnv; spawnImpl?: SpawnBridge }) {
    const spawnImpl = options.spawnImpl ?? defaultSpawnBridge;
    this.child = spawnImpl(python, script, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}), PYTHONUNBUFFERED: "1" } });
    this.child.on("error", (error) => this.close(error));
    createInterface({ input: this.child.stdout }).on("line", (line) => this.consume(line));
    // Kept, bounded, for the error a failed spawn produces — "ModuleNotFoundError:
    // jupyter_client" is the whole diagnosis and it only ever appears here.
    createInterface({ input: this.child.stderr }).on("line", (line) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
    });
    this.child.on("exit", (code, signal) =>
      this.close(new Error(`kernel bridge exited (code=${code ?? "null"}, signal=${signal ?? "null"})${this.stderrTail.length ? `\n${this.stderrTail.slice(-8).join("\n")}` : ""}`)),
    );
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get alive(): boolean {
    return !this.closed;
  }

  private consume(line: string): void {
    if (!line.trim()) return;
    let message: JsonRpc;
    try {
      message = JSON.parse(line) as JsonRpc;
    } catch {
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message);
        if (message.error.data) (error as Error & { data?: unknown }).data = message.error.data;
        waiter.reject(error);
      } else waiter.resolve(message.result);
      return;
    }
    if (message.method !== undefined) {
      const params = message.params && typeof message.params === "object" ? (message.params as Record<string, unknown>) : {};
      this.onNotification?.({ method: message.method, params });
    }
  }

  private close(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    this.onClose?.(error);
  }

  private write(message: Record<string, unknown>): Promise<void> {
    if (this.closed) return Promise.resolve();
    const line = `${JSON.stringify(message)}\n`;
    this.writeChain = this.writeChain.then(
      () =>
        new Promise<void>((resolve) => {
          if (this.closed) return resolve();
          const ok = this.child.stdin.write(line, () => resolve());
          if (!ok) this.child.stdin.once("drain", () => resolve());
        }),
    );
    return this.writeChain;
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(this.closeError ?? new Error("kernel bridge is closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      void this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  kill(): void {
    if (!this.closed) this.child.kill("SIGKILL");
  }
}
