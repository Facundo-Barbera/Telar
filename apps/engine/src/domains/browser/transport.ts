import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { OWN_GROUP, signalGroup } from "../../platform/process/group";
import { browserErrorText, textOf } from "./helpers";
import { BrowserToolResult } from "./tools";

const BROWSER_RPC_TIMEOUT_MS = 30_000;
const BROWSER_KILL_GRACE_MS = 2_000;
export const MCP_PROTOCOL_VERSION = "2025-06-18";

const STDERR_RING_BYTES = 8_000;
const MAX_LINE_BYTES = 64 * 1024 * 1024;

export type BrowserProcess = {
  write(frame: string): void;
  onStdout(listener: (chunk: string) => void): void;
  onStderr(listener: (chunk: string) => void): void;
  onClosed(listener: (reason: string | null) => void): void;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
};

export type SpawnBrowserProcess = (command: string, args: readonly string[]) => BrowserProcess;

const spawnBrowserProcess: SpawnBrowserProcess = (command, args) => {
  const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], detached: OWN_GROUP });
  return {
    write: (frame) => {
      child.stdin.write(frame);
    },
    onStdout: (listener) => child.stdout.on("data", (chunk: Buffer) => listener(String(chunk))),
    onStderr: (listener) => child.stderr.on("data", (chunk: Buffer) => listener(String(chunk))),
    onClosed: (listener) => {
      child.once("error", (error: Error) => listener(error.message));
      child.once("exit", (code: number | null, signal: NodeJS.Signals | null) =>
        listener(signal ? `killed by ${signal}` : code ? `exited with code ${code}` : null),
      );
    },
    kill: (signal) => signalGroup(child, signal),
  };
};

function resolvePlaywrightMcpCli(startDir?: string): string {
  const override = process.env.TELAR_PLAYWRIGHT_MCP_BIN?.trim();
  if (override) return override;
  return (
    walkUpForPlaywrightMcpCli(startDir !== undefined ? startDir : import.meta.dirname) ??
    walkUpForPlaywrightMcpCli(process.cwd()) ??
    "playwright-mcp"
  );
}

function walkUpForPlaywrightMcpCli(startDir: string | undefined): string | null {
  let dir = startDir;
  for (let i = 0; i < 8 && typeof dir === "string" && dir !== "" && dir !== path.dirname(dir); i++) {
    const candidates = [
      path.join(dir, "node_modules/@playwright/mcp/cli.js"),
      path.join(dir, "node_modules/.bin/playwright-mcp"),
    ];
    for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
    const store = path.join(dir, "node_modules", ".bun");
    try {
      const hit = fs.readdirSync(store).find((name) => name.startsWith("@playwright+mcp@"));
      if (hit) {
        const cli = path.join(store, hit, "node_modules/@playwright/mcp/cli.js");
        if (fs.existsSync(cli)) return cli;
      }
    } catch {
    }
    dir = path.dirname(dir);
  }
  return null;
}

export type BrowserTransportOptions = {
  spawn?: SpawnBrowserProcess;
  browser?: string;
  viewportSize?: string;
  requestTimeoutMs?: number;
  killGraceMs?: number;
  cliPath?: string;
  userDataDir?: string;
};

type RpcMessage = {
  id?: number;
  result?: unknown;
  error?: { message?: string };
};

type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type LiveChild = {
  process: BrowserProcess;
  exited: Promise<void>;
  settle: () => void;
  closed: boolean;
};

export class PlaywrightMcpTransport {
  private readonly spawnProcess: SpawnBrowserProcess;
  private readonly options: Required<Omit<BrowserTransportOptions, "spawn" | "cliPath" | "userDataDir">> & { cliPath?: string; userDataDir?: string };
  private child: LiveChild | null = null;
  private starting: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stdoutBuffer = "";
  private stderrRing = "";
  private lastFailure: string | null = null;
  private inFlight = 0;

  constructor(options: BrowserTransportOptions = {}) {
    this.spawnProcess = options.spawn ?? spawnBrowserProcess;
    this.options = {
      browser: options.browser ?? "chromium",
      viewportSize: options.viewportSize ?? "1280x800",
      requestTimeoutMs: options.requestTimeoutMs ?? BROWSER_RPC_TIMEOUT_MS,
      killGraceMs: options.killGraceMs ?? BROWSER_KILL_GRACE_MS,
      ...(options.cliPath ? { cliPath: options.cliPath } : {}),
      ...(options.userDataDir ? { userDataDir: options.userDataDir } : {}),
    };
  }

  get running(): boolean {
    return this.child !== null;
  }

  get busy(): boolean {
    return this.inFlight > 0 || this.starting !== null || this.pending.size > 0;
  }

  get lastError(): string | null {
    return this.lastFailure;
  }

  get diagnostics(): string {
    return this.stderrRing;
  }

  async start(): Promise<void> {
    if (this.child) return;
    if (this.starting) return this.starting;
    this.starting = this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private launch(): Promise<void> {
    const cli = this.options.cliPath ?? resolvePlaywrightMcpCli();
    const args = [
      cli,
      "--headless",
      "--caps",
      "vision",
      ...(this.options.userDataDir ? ["--user-data-dir", this.options.userDataDir] : ["--isolated"]),
      "--browser",
      this.options.browser,
      "--output-mode",
      "stdout",
      "--image-responses",
      "allow",
      "--viewport-size",
      this.options.viewportSize,
    ];
    return this.launchInner(process.execPath, args);
  }

  private async launchInner(command: string, args: readonly string[]): Promise<void> {
    let settle: () => void = () => {};
    const exited = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const child: LiveChild = { process: this.spawnProcess(command, args), exited, settle, closed: false };
    this.child = child;
    this.lastFailure = null;
    this.stdoutBuffer = "";
    this.stderrRing = "";

    child.process.onStdout((chunk) => this.ingest(chunk));
    child.process.onStderr((chunk) => {
      this.stderrRing = `${this.stderrRing}${chunk}`.slice(-STDERR_RING_BYTES);
    });
    child.process.onClosed((reason) => this.onChildClosed(child, reason));

    try {
      await this.request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "telar-engine", version: "0.1.0" },
      });
      this.notify("notifications/initialized");
    } catch (error) {
      if (this.child === child) this.child = null;
      child.process.kill("SIGKILL");
      const reason = browserErrorText(error instanceof Error ? error.message : error);
      this.lastFailure = this.stderrRing ? `${reason} — ${browserErrorText(this.stderrRing)}` : reason;
      throw new Error(this.lastFailure);
    }
  }

  private onChildClosed(child: LiveChild, reason: string | null): void {
    if (child.closed) return;
    child.closed = true;
    child.settle();
    if (this.child !== child) return;
    this.child = null;
    const failure =
      browserErrorText(this.stderrRing) ||
      browserErrorText(reason) ||
      "The controlled browser stopped unexpectedly.";
    this.lastFailure = failure;
    this.rejectAllPending(failure);
  }

  private ingest(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (let newline = this.stdoutBuffer.indexOf("\n"); newline >= 0; newline = this.stdoutBuffer.indexOf("\n")) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      this.dispatch(line);
    }
    if (this.stdoutBuffer.length > MAX_LINE_BYTES) {
      this.stdoutBuffer = "";
      const failure = "The controlled browser sent an unframed response.";
      this.lastFailure = failure;
      this.rejectAllPending(failure);
      void this.close(failure);
    }
  }

  private dispatch(line: string): void {
    if (line.trim().length === 0) return;
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message ?? "Browser runtime error."));
    else pending.resolve(message.result);
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    const child = this.child;
    if (!child) return Promise.reject(new Error(this.lastFailure ?? "The browser runtime is not running."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`The controlled browser timed out while calling ${method}.`));
      }, this.options.requestTimeoutMs);
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
      child.process.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private notify(method: string, params: unknown = {}): void {
    this.child?.process.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private rejectAllPending(reason: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<BrowserToolResult> {
    this.inFlight += 1;
    try {
      await this.start();
      const raw = await this.request<unknown>("tools/call", { name, arguments: args });
      const parsed = BrowserToolResult.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`The controlled browser returned an unreadable result for ${name}.`);
      }
      this.lastFailure = parsed.data.isError
        ? browserErrorText(textOf(parsed.data)) || "Browser action failed."
        : null;
      return parsed.data;
    } catch (error) {
      this.lastFailure = browserErrorText(error instanceof Error ? error.message : error);
      throw error;
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
    }
  }

  async close(reason = "The browser session was closed."): Promise<void> {
    const inFlight = this.starting;
    this.starting = null;
    const child = this.child;
    this.child = null;
    this.rejectAllPending(reason);
    if (inFlight) await inFlight.catch(() => {});
    if (!child || child.closed) return;
    child.process.kill("SIGTERM");
    if (await raceTimeout(child.exited, this.options.killGraceMs)) return;
    child.process.kill("SIGKILL");
    await raceTimeout(child.exited, this.options.killGraceMs);
  }

  killNow(): void {
    const child = this.child;
    this.child = null;
    if (child && !child.closed) child.process.kill("SIGKILL");
  }
}

export type RunOnce = (command: string, args: readonly string[]) => Promise<{ code: number | null; output: string }>;

const runOnce: RunOnce = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer) => {
      output = `${output}${String(chunk)}`.slice(-20_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, output }));
  });

let installInFlight: Promise<string> | null = null;

export function installBrowser(
  options: { browser?: string; cliPath?: string; run?: RunOnce } = {},
): Promise<string> {
  if (installInFlight) return installInFlight;
  const run = options.run ?? runOnce;
  const cli = options.cliPath ?? resolvePlaywrightMcpCli();
  const browser = options.browser ?? "chromium";
  const operation = run(process.execPath, [cli, "install-browser", browser]).then(({ code, output }) => {
    const text = output.trim();
    if (code === 0) return text || "Controlled browser installed.";
    throw new Error(text || `The browser installer exited with code ${code}.`);
  });
  installInFlight = operation.finally(() => {
    installInFlight = null;
  });
  installInFlight.catch(() => {});
  return installInFlight;
}

async function raceTimeout(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
