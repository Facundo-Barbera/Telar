/**
 * The `codex app-server` transport: one subprocess speaking newline-delimited
 * JSON-RPC 2.0 over stdio, and the two rules that make it safe to drive.
 *
 * RULE ONE — NOTHING IN THE STDOUT READER MAY AWAIT. Every line the app-server
 * writes arrives on one readline callback. An `await` in there does not just
 * delay that line, it delays every line behind it, including the turn's own
 * text deltas. The legacy bridge learned this by answering approvals inline and
 * watching a session freeze until the human clicked. So `onServerRequest`
 * returns a plain `boolean`, not a promise: the type makes the mistake
 * unspellable, and a handler that needs to think does it detached.
 *
 * RULE TWO — EVERY SERVER→CLIENT REQUEST IS ANSWERED. A JSON-RPC request the
 * app-server sends us and never hears back about does not time out; it waits,
 * and the turn waits with it. Anything the handler declines to take is answered
 * here with `-32601` rather than dropped.
 *
 * This file owns all wire-format knowledge below the notification stream; the
 * driver above it never sees a raw JSON-RPC envelope.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { requireCli } from "../cli-resolution";
import { ProviderUnavailableError } from "../driver";

/** A notification: a method with no id, so nothing is owed in reply. */
export type CodexNotification = { method: string; params: Record<string, unknown> };

/** A server→client REQUEST: it has an id, so it is owed exactly one reply. */
export type CodexServerRequest = { id: string | number; method: string; params: Record<string, unknown> };

type JsonRpcMessage = {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

/**
 * A pull-based channel: `push` from the readline callback, `next` from the
 * driver's loop. The buffer is the point — a burst of `item/started` lines can
 * arrive faster than the consumer drains them, and dropping the overflow would
 * lose timeline rows.
 */
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** One `codex app-server` subprocess for the lifetime of one turn. */
export class CodexAppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<string | number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private closed = false;
  private closeError: Error | null = null;

  readonly notifications = new AsyncChannel<CodexNotification>();

  /**
   * Offered every server→client request. Returning `false` means "not mine",
   * and the transport answers `-32601` so the app-server is never left waiting.
   * SYNCHRONOUS BY TYPE — see RULE ONE in this file's header.
   */
  onServerRequest?: (request: CodexServerRequest) => boolean;

  constructor(bin: string, env: Record<string, string>) {
    // EXACTLY ONE ARGUMENT, FOREVER. Config travels in request params instead,
    // because an argv is world-readable through `ps` to every process running
    // as this user — including the sandboxed shells of the agent sessions.
    this.child = spawn(bin, ["app-server"], {
      env: env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // A binary that is not there fails here, asynchronously, rather than at the
    // spawn call — without this the first `request()` would hang until the exit
    // handler fired, and report an exit code instead of a missing CLI.
    this.child.on("error", (error) => this.close(error));

    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.consume(line));
    // stderr is logs, not protocol. Drained so the pipe never backs up and
    // blocks the child mid-turn; never parsed.
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
      return; // stdout is protocol-only per spec; do not die on a stray line
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
      const taken =
        this.onServerRequest?.({ id: message.id, method: message.method, params: asRecord(message.params) }) ?? false;
      // RULE TWO. An unhandled request answered with silence hangs the turn.
      if (!taken) {
        this.respondError(message.id, -32601, `Method not supported by telar's codex client: ${message.method}`);
      }
      return;
    }

    if (message.method !== undefined) {
      this.notifications.push({ method: message.method, params: asRecord(message.params) });
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

  private write(message: Record<string, unknown>, onFlush?: () => void): void {
    if (this.closed) {
      onFlush?.();
      return;
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`, () => onFlush?.());
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(this.closeError ?? new Error("codex app-server is closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  /** Answer a server→client request. `onFlush` fires once the bytes have left
   *  this process — the only safe moment to kill the child after replying. */
  respond(id: string | number, result: unknown, onFlush?: () => void): void {
    this.write({ jsonrpc: "2.0", id, result }, onFlush);
  }

  respondError(id: string | number, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  kill(): void {
    if (!this.closed) this.child.kill();
  }
}

/**
 * WHERE THE CODEX CLI ACTUALLY IS.
 *
 * THIS USED TO BE THE CANDIDATE LIST ITSELF — a transcription of core's
 * `cli-resolution.ts`, written because `apps/engine` deliberately does not
 * depend on `@telar/core`, and ending with a note that it was waiting for a
 * resolver of its own. `./cli-resolution.ts` is that resolver: the engine now
 * has one candidate order, one version cache and one refusal shape, shared with
 * Claude, rather than two lists that can drift apart the next time somebody
 * learns where an installer puts things.
 *
 * The behaviour it kept: `CODEX_BIN` still wins, and a CODEX_BIN THAT POINTS
 * NOWHERE IS STILL LOUD rather than merely skipped — a typo falling through to
 * a different binary produces a session running against something the operator
 * did not choose, and never says so.
 */
export function resolveCodexBinary(): string {
  try {
    return requireCli("codex");
  } catch (error) {
    throw new ProviderUnavailableError(error instanceof Error ? error.message : String(error));
  }
}
