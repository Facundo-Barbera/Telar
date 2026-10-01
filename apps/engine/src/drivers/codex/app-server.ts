import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { requireCli } from "../../domains/providers";
import { OWN_GROUP, stopGroup } from "../../platform/process/group";
import { ProviderUnavailableError } from "../contract";
import { record } from "./items";

type CodexNotification = { method: string; params: Record<string, unknown> };

export type CodexServerRequest = { id: string | number; method: string; params: Record<string, unknown> };

type JsonRpcMessage = {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

class AsyncChannel<T> {
  private readonly buffer: T[] = [];
  private readonly waiting: Array<(value: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value, done: false });
    else this.buffer.push(value);
  }

  end(): void {
    this.ended = true;
    while (this.waiting.length) this.waiting.shift()!({ value: undefined as never, done: true });
  }

  next(): Promise<IteratorResult<T>> {
    const buffered = this.buffer.shift();
    if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false });
    if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((resolve) => this.waiting.push(resolve));
  }
}

/** One `codex app-server` subprocess (newline-delimited JSON-RPC over stdio) for one turn. */
export class CodexAppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<string | number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private closed = false;
  private killed = false;
  private closeError: Error | null = null;

  readonly notifications = new AsyncChannel<CodexNotification>();

  // Synchronous by type: an await in the stdout reader stalls every line behind it.
  // Returning false answers -32601, because an unanswered server request hangs the turn.
  onServerRequest?: (request: CodexServerRequest) => boolean;

  constructor(bin: string, env: Record<string, string | undefined>) {
    // Exactly one argument: argv is readable through `ps` by every process of this user.
    this.child = spawn(bin, ["app-server"], {
      env: Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      detached: OWN_GROUP,
    });
    this.child.on("error", (error) => this.close(error));

    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.consume(line));
    this.child.stderr.resume();
    this.child.on("exit", (code, signal) =>
      this.close(new Error(`codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`)),
    );
  }

  private consume(line: string): void {
    if (!line.trim()) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
      return;
    }

    if (message.method !== undefined && message.id !== undefined) {
      const taken = this.onServerRequest?.({ id: message.id, method: message.method, params: record(message.params) }) ?? false;
      if (!taken) {
        this.respondError(message.id, -32601, `Method not supported by telar's codex client: ${message.method}`);
      }
      return;
    }

    if (message.method !== undefined) {
      this.notifications.push({ method: message.method, params: record(message.params) });
    }
  }

  private close(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    this.notifications.end();
  }

  private write(message: Record<string, unknown>): void {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed) return Promise.reject(this.closeError ?? new Error("codex app-server is closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server did not answer ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      const settle = <V>(done: (value: V) => void) => (value: V) => {
        clearTimeout(timer);
        done(value);
      };
      this.pending.set(id, { resolve: settle(resolve as (value: unknown) => void), reject: settle(reject) });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  respond(id: string | number, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id: string | number, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    stopGroup(this.child);
  }
}

export function resolveCodexBinary(binaryPath?: string): string {
  try {
    return requireCli("codex", binaryPath ? { binaryPath } : {});
  } catch (error) {
    throw new ProviderUnavailableError(error instanceof Error ? error.message : String(error));
  }
}
