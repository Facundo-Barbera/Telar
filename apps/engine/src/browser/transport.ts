/**
 * The JSON-RPC-over-stdio client for `@playwright/mcp`.
 *
 * Ported from `apps/web_old/lib/server/browser-runtime.ts` (the transport half,
 * roughly lines 281-366), which worked and is the only piece of that file with
 * no Next.js, no React and no desktop-host coupling in it.
 *
 * WHAT CHANGED, AND WHY EACH ONE MATTERS FOR A DETACHED SESSION:
 *
 *  - The subprocess is behind an injectable seam (`SpawnBrowserProcess`), the
 *    same shape `createClaudeDriver(loadSdk)` uses in `../driver.ts`. Without it
 *    every test of this file downloads a Chromium.
 *  - Framing is done here rather than by `readline`. readline needs a real
 *    Node stream, which is exactly the thing the seam exists to avoid, and it
 *    silently drops a trailing fragment that never gets its newline.
 *  - `close()` escalates SIGTERM to SIGKILL and AWAITS. The legacy code called
 *    `child.kill()` and returned; a Chromium wedged on a modal dialog or a
 *    beforeunload handler ignores SIGTERM, so the daemon "closed" the browser
 *    and left a process holding the profile lock. The next session for that
 *    scope then failed to launch for a reason with no visible cause.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { browserErrorText, textOf } from "./helpers";
import { BrowserToolResult } from "./tools";

/** Playwright MCP is slow on a cold navigation but not minutes-slow. A request
 *  that has not answered in 30s has lost the browser, not queued behind it. */
export const BROWSER_RPC_TIMEOUT_MS = 30_000;
/** How long SIGTERM gets before SIGKILL. Chromium normally exits in well under
 *  a second; this is generous enough that a busy machine is not mistaken for a
 *  wedged one, and short enough not to stall daemon shutdown. */
export const BROWSER_KILL_GRACE_MS = 2_000;
/** The MCP revision the legacy runtime negotiated and @playwright/mcp 0.0.77
 *  speaks. Sending a version the server does not know fails the handshake, so
 *  this is pinned rather than tracking the newest published spec. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

const STDERR_RING_BYTES = 8_000;
/** A response carrying a full-page screenshot is genuinely megabytes. The cap
 *  exists only so a peer that never emits a newline cannot grow this buffer
 *  until the daemon is OOM-killed — an unbounded accumulator in a process that
 *  lives for weeks is a crash with no stack trace pointing here. */
const MAX_LINE_BYTES = 64 * 1024 * 1024;

// ── the subprocess seam ────────────────────────────────────────────────────

/**
 * The engine's view of the browser subprocess: four callbacks and a kill.
 *
 * DELIBERATELY NOT `ChildProcessWithoutNullStreams`. Structural typing against
 * Node's overloaded `on`/`once` signatures is fragile, and a fake that has to
 * impersonate a Readable is a fake nobody writes. This shape is small enough
 * that a test double is a dozen lines — which is the difference between this
 * file having tests and not.
 */
export type BrowserProcess = {
  /** Write one already-newline-terminated frame to the child's stdin. */
  write(frame: string): void;
  onStdout(listener: (chunk: string) => void): void;
  onStderr(listener: (chunk: string) => void): void;
  /** Spawn failure and exit are ONE event. Both mean "there is no browser any
   *  more"; every caller of the legacy code handled them identically, and
   *  keeping them separate only created a path where one was forgotten. */
  onClosed(listener: (reason: string | null) => void): void;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
};

export type SpawnBrowserProcess = (command: string, args: readonly string[]) => BrowserProcess;

/** Spawn through Node's `child_process`. The default; tests replace it. */
export const spawnBrowserProcess: SpawnBrowserProcess = (command, args) => {
  const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
  return {
    write: (frame) => {
      // A dead stdin throws EPIPE asynchronously on some platforms and
      // synchronously on others; the caller's timeout is the real backstop, so
      // this must not become the failure the user sees.
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
    kill: (signal) => {
      child.kill(signal);
    },
  };
};

// ── locating @playwright/mcp ───────────────────────────────────────────────

/**
 * Resolve the installed `@playwright/mcp` CLI by walking up from this module,
 * then from the working directory.
 *
 * A SECOND COPY OF `@telar/core`'s `resolvePlaywrightMcpBin`, on purpose:
 * `apps/engine` does not depend on `@telar/core` and must not start to for a
 * path lookup — the engine is the process that has to boot when the rest of the
 * repo is broken. The environment override is spelled the same so one variable
 * still points both at the same install.
 */
export function resolvePlaywrightMcpCli(startDir?: string): string {
  const override = process.env.TELAR_PLAYWRIGHT_MCP_BIN?.trim();
  if (override) return override;
  return (
    walkUpForPlaywrightMcpCli(startDir !== undefined ? startDir : import.meta.dirname) ??
    walkUpForPlaywrightMcpCli(process.cwd()) ??
    // Last resort: a PATH lookup. Never a machine-specific path in source.
    "playwright-mcp"
  );
}

function walkUpForPlaywrightMcpCli(startDir: string | undefined): string | null {
  let dir = startDir;
  // Bounded, and guarded on `dir` being a real string: some bundlers leave
  // `import.meta.dirname` undefined, and `path.dirname(undefined)` throws.
  for (let i = 0; i < 8 && typeof dir === "string" && dir !== "" && dir !== path.dirname(dir); i++) {
    const candidates = [
      path.join(dir, "node_modules/@playwright/mcp/cli.js"),
      path.join(dir, "node_modules/.bin/playwright-mcp"),
    ];
    for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
    // bun's hoisted store, which is where a workspace install actually puts it:
    // node_modules/.bun/@playwright+mcp@<ver>/node_modules/@playwright/mcp/cli.js
    const store = path.join(dir, "node_modules", ".bun");
    try {
      const hit = fs.readdirSync(store).find((name) => name.startsWith("@playwright+mcp@"));
      if (hit) {
        const cli = path.join(store, hit, "node_modules/@playwright/mcp/cli.js");
        if (fs.existsSync(cli)) return cli;
      }
    } catch {
      /* no store at this level */
    }
    dir = path.dirname(dir);
  }
  return null;
}

// ── the transport ──────────────────────────────────────────────────────────

export type BrowserTransportOptions = {
  spawn?: SpawnBrowserProcess;
  /** Chromium unless overridden. Firefox and WebKit work but are not what
   *  Telar's snapshots and screenshots were tuned against. */
  browser?: string;
  viewportSize?: string;
  requestTimeoutMs?: number;
  killGraceMs?: number;
  /** Explicit path to `@playwright/mcp`'s cli.js; resolved when absent. */
  cliPath?: string;
  /**
   * A persistent Chromium profile directory. Set ⇒ the browser launches
   * WITHOUT `--isolated`, so cookies and logins survive between launches —
   * the session-persistence half of the browser-v2 plan (§2 item 3). Absent
   * ⇒ the old ephemeral behaviour, which is what every test wants.
   */
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
  /** Resolves when the child reports it is gone. `close()` awaits this rather
   *  than assuming a signal was honoured. */
  exited: Promise<void>;
  settle: () => void;
  closed: boolean;
};

/**
 * One browser process and the JSON-RPC session on it. A `BrowserRuntime` owns
 * one of these per scope; this class knows nothing about scopes, sessions or
 * pooling, which is what makes it testable on its own.
 */
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

  /** In-flight calls, a handshake in progress, or a queued request. The pool
   *  reads this to decide what it may evict. */
  get busy(): boolean {
    return this.inFlight > 0 || this.starting !== null || this.pending.size > 0;
  }

  /** The last thing that went wrong, already stripped of MCP's error framing.
   *  Null once a call succeeds — this is the current state, not a log. */
  get lastError(): string | null {
    return this.lastFailure;
  }

  /** The tail of the child's stderr. The only diagnosis available when a launch
   *  fails, because a browser that never handshakes says nothing on stdout. */
  get diagnostics(): string {
    return this.stderrRing;
  }

  /** Launch and handshake. Idempotent, and concurrent callers share one launch
   *  — two `tools/call`s arriving together must not race two Chromiums onto the
   *  same isolated profile. */
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
      // Ephemeral by default; a configured profile dir makes logins durable.
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
    // Run the JS entrypoint through the CURRENT runtime rather than executing
    // the package bin. The bin's shebang is `/usr/bin/env node`, which is absent
    // on a perfectly valid Bun-only install of Telar — this is the difference
    // between the browser working and "spawn node ENOENT" on a clean machine.
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
      // MCP requires this notification before any tool call; a server that has
      // not seen it answers `tools/call` with a protocol error rather than
      // running the tool.
      this.notify("notifications/initialized");
    } catch (error) {
      // Detach FIRST so the kill's exit event cannot re-enter as a spurious
      // "browser stopped unexpectedly" against a runtime that already failed.
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

  /** Newline-delimited JSON framing over a chunked byte stream. */
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
      // Server-side notifications and stray log lines both land here. Neither
      // is ours to answer, and throwing would kill a working browser.
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
        // `delete` returning false means the response landed in the same tick
        // the timer fired; the promise is already settled and rejecting again
        // would be a no-op that reads like a bug in a stack trace.
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

  /**
   * Call one browser tool. Starts the browser if it is not running.
   *
   * The result is PARSED, not cast. It crossed a process boundary from a
   * package we do not control, and `textOf`/`imageDataUrlOf` downstream would
   * otherwise read `undefined` off a shape that changed and report it as an
   * empty page.
   */
  async call(name: string, args: Record<string, unknown> = {}): Promise<BrowserToolResult> {
    this.inFlight += 1;
    try {
      await this.start();
      const raw = await this.request<unknown>("tools/call", { name, arguments: args });
      const parsed = BrowserToolResult.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`The controlled browser returned an unreadable result for ${name}.`);
      }
      // An `isError` result is a tool that RAN and failed, so it is returned
      // rather than thrown — the agent needs to read why. It is still recorded
      // as the transport's last error so `state()` can surface it.
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

  /**
   * Stop the browser: SIGTERM, then SIGKILL if it is still there after the
   * grace period. Safe to call twice, and safe to call on a runtime that never
   * started.
   */
  async close(reason = "The browser session was closed."): Promise<void> {
    const inFlight = this.starting;
    this.starting = null;
    const child = this.child;
    this.child = null;
    this.rejectAllPending(reason);
    // A launch in progress will reject into whoever is awaiting `start()`; that
    // is theirs to handle, but an unhandled rejection here would be ours.
    if (inFlight) await inFlight.catch(() => {});
    if (!child || child.closed) return;
    child.process.kill("SIGTERM");
    if (await raceTimeout(child.exited, this.options.killGraceMs)) return;
    child.process.kill("SIGKILL");
    await raceTimeout(child.exited, this.options.killGraceMs);
  }

  /**
   * Synchronous, unconditional SIGKILL. For `process.on("exit")` ONLY, where no
   * promise will ever be awaited and a graceful stop is a graceful stop that
   * does not happen. Leaving a headless Chromium orphaned when the daemon dies
   * is the failure this exists to prevent.
   */
  killNow(): void {
    const child = this.child;
    this.child = null;
    if (child && !child.closed) child.process.kill("SIGKILL");
  }
}

// ── installing the browser binary ──────────────────────────────────────────

/** A one-shot child process: run it, collect everything it said, report how it
 *  exited. Separate from `SpawnBrowserProcess` because an install has no
 *  protocol — only an exit code and a wall of progress output. */
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

/** Module-level, and that is the point — see `installBrowser`. */
let installInFlight: Promise<string> | null = null;

/**
 * Download the browser binary `@playwright/mcp` will launch.
 *
 * NEEDED BECAUSE THE FAILURE IS OTHERWISE UNRECOVERABLE FROM INSIDE A DETACHED
 * SESSION. A machine without it answers every browser call with `isError:
 * "Browser … is not installed. Run npx @playwright/mcp install-browser …"`, and
 * an agent with no human attached has nobody to run that for it.
 *
 * SINGLE-FLIGHT ACROSS THE WHOLE PROCESS, not per runtime or per scope. Two
 * sessions discovering the missing browser at the same moment would otherwise
 * run two downloads into the same shared Playwright cache directory, which is a
 * corrupted install rather than a slow one. This is the one piece of the
 * browser stack that is legitimately process-global, because the thing it
 * guards — that cache — is too.
 */
export function installBrowser(
  options: { browser?: string; cliPath?: string; run?: RunOnce } = {},
): Promise<string> {
  if (installInFlight) return installInFlight;
  const run = options.run ?? runOnce;
  const cli = options.cliPath ?? resolvePlaywrightMcpCli();
  // The SAME browser word the transport launches with. @playwright/mcp maps
  // `chromium` onto its own `chrome-for-testing` download, so anything that
  // second-guesses the name installs a browser nothing then launches.
  const browser = options.browser ?? "chromium";
  const operation = run(process.execPath, [cli, "install-browser", browser]).then(({ code, output }) => {
    const text = output.trim();
    if (code === 0) return text || "Controlled browser installed.";
    throw new Error(text || `The browser installer exited with code ${code}.`);
  });
  installInFlight = operation.finally(() => {
    installInFlight = null;
  });
  // `finally` returns a promise that rejects with the same reason; nothing
  // else observes it, so an install that fails must not also surface as an
  // unhandled rejection from the cached handle.
  installInFlight.catch(() => {});
  return installInFlight;
}

/** Resolves true if `promise` settled first, false on timeout. Always clears
 *  its timer — a leaked 2s handle per closed browser keeps a shutting-down
 *  daemon alive past the moment it reported being done. */
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
