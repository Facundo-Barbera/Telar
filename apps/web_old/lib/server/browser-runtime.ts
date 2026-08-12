import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { createInterface } from "readline";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { resolvePlaywrightMcpBin } from "@telar/core/verifier";
import type {
  BrowserAgentPresence,
  BrowserRuntimeEvent,
  ControlledBrowserState,
  ControlledBrowserTab,
} from "@/lib/browser-runtime-contract";
import { desktopBrowserHost } from "@/lib/server/desktop-browser-host";

type RpcMessage = {
  id?: number;
  result?: unknown;
  error?: { message?: string };
};

export type BrowserToolResult = Awaited<ReturnType<SdkMcpToolDefinition["handler"]>>;
export type { BrowserRuntimeEvent } from "@/lib/browser-runtime-contract";

const RPC_TIMEOUT_MS = 30_000;
const MAX_FALLBACK_SCOPES = 6;

export type ScopedRuntimeResource = {
  isBusy: () => boolean;
  dispose: (reason: string) => void;
};

/** Small LRU for heavyweight per-session browser processes. Busy resources are
 * never evicted: a background agent keeps its browser even while another chat
 * is selected. If every retained resource is busy the pool may temporarily
 * exceed its limit, then a later acquisition reclaims the oldest idle entry. */
export class ScopedRuntimePool<T extends ScopedRuntimeResource> {
  private entries = new Map<string, { resource: T; usedAt: number }>();
  private clock = 0;

  constructor(private readonly limit: number) {}

  acquire(scopeKey: string, create: () => T): T {
    const existing = this.entries.get(scopeKey);
    if (existing) {
      existing.usedAt = ++this.clock;
      return existing.resource;
    }
    if (this.entries.size >= this.limit) {
      const candidate = [...this.entries.entries()]
        .filter(([, entry]) => !entry.resource.isBusy())
        .sort(([, a], [, b]) => a.usedAt - b.usedAt)[0];
      if (candidate) {
        const [key, entry] = candidate;
        this.entries.delete(key);
        entry.resource.dispose("The inactive browser session was reclaimed.");
      }
    }
    const resource = create();
    this.entries.set(scopeKey, { resource, usedAt: ++this.clock });
    return resource;
  }

  peek(scopeKey: string): T | null {
    return this.entries.get(scopeKey)?.resource ?? null;
  }

  get size(): number {
    return this.entries.size;
  }
}

const MUTATING_TOOLS = new Set([
  "browser_navigate",
  "browser_navigate_back",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_press_key",
  "browser_hover",
  "browser_select_option",
  "browser_tabs",
]);

const DEFAULT_BROWSER_ENGINE = "chromium";

function desktopControlConfig() {
  const port = process.env.TELAR_DESKTOP_BROWSER_CONTROL_PORT?.trim();
  const token = process.env.TELAR_DESKTOP_BROWSER_CONTROL_TOKEN?.trim();
  return port && token ? { origin: `http://127.0.0.1:${port}`, token } : null;
}

async function desktopControlRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T | null> {
  const config = desktopControlConfig();
  if (!config) return null;
  const response = await fetch(`${config.origin}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${config.token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(value.error || `Desktop browser host returned ${response.status}.`);
  return value;
}

function controlledBrowserEngine() {
  return process.env.TELAR_BROWSER_ENGINE?.trim() || DEFAULT_BROWSER_ENGINE;
}

function browserErrorText(value: unknown) {
  return String(value)
    .replace(/^\s*#{1,6}\s*Error\s*/i, "")
    .replace(/^\s*Error:\s*/i, "")
    .trim();
}

function textOf(result: BrowserToolResult): string {
  const chunks: string[] = [];
  for (const part of result.content) {
    if (part.type === "text") chunks.push(part.text);
  }
  return chunks.join("\n");
}

export function normalizeBrowserToolCall(
  name: string,
  args: Record<string, unknown>,
): { name: string; args: Record<string, unknown> } {
  return name === "browser_list_tabs"
    ? { name: "browser_tabs", args: { action: "list" } }
    : { name, args };
}

export function shouldRevealBrowserCall(
  name: string,
  args: Record<string, unknown>,
  notify = true,
): boolean {
  return notify &&
    MUTATING_TOOLS.has(name) &&
    !(name === "browser_tabs" && args.action === "list");
}

export function browserToolPhase(name: string): BrowserAgentPresence["phase"] {
  if (name === "browser_click") return "click";
  if (name === "browser_hover") return "move";
  if (name === "browser_type" || name === "browser_fill_form" || name === "browser_press_key") {
    return "type";
  }
  if (name === "browser_navigate" || name === "browser_navigate_back" || name === "browser_tabs") {
    return "navigate";
  }
  return "inspect";
}

export function parseBrowserTabs(text: string): ControlledBrowserTab[] {
  const tabs: ControlledBrowserTab[] = [];
  for (const line of text.split("\n")) {
    // Playwright MCP renders tabs as:
    //   - 0: (current) [Page title](http://localhost:3000/)
    // Keep a small legacy fallback for older versions that placed the current
    // marker at the end, but do not infer URLs from arbitrary prose.
    const match = line.match(/^\s*[-*]?\s*(?:Tab\s+)?(\d+)\s*[:.]\s*(\((?:current|active)\)\s*)?(?:\[([^\]]*)\]\(([^)]+)\)|(.+?)\s+-\s+(https?:\/\/\S+|about:blank))\s*(\[(?:current|active)\]|\((?:current|active)\))?\s*(?:\[crashed\])?\s*$/i);
    if (!match) continue;
    const index = Number(match[1]);
    const title = (match[3] ?? match[5] ?? `Tab ${index + 1}`).trim();
    const url = (match[4] ?? match[6] ?? "about:blank").trim();
    tabs.push({
      index,
      title: title.replace(/\s*\((?:current|active)\)\s*$/i, "") || `Tab ${index + 1}`,
      url,
      active: Boolean(match[2] || match[7]),
    });
  }
  return tabs;
}

type FallbackSession = ScopedRuntimeResource & {
  scopeKey: string;
  child: ChildProcessWithoutNullStreams | null;
  starting: Promise<void> | null;
  nextId: number;
  activeCalls: number;
  pending: Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
  lastError: string | null;
  stderr: string;
};

class BrowserRuntime {
  private fallbacks = new ScopedRuntimePool<FallbackSession>(MAX_FALLBACK_SCOPES);
  private listeners = new Set<(event: BrowserRuntimeEvent) => void>();
  private _version = 0;

  constructor() {
    desktopBrowserHost().subscribe(() => this.emit());
  }

  get version() {
    return this._version;
  }

  subscribe(listener: (event: BrowserRuntimeEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(
    reveal = false,
    scopeKey?: string,
    presence?: BrowserAgentPresence,
    stateChanged = true,
  ) {
    this._version += 1;
    const event = {
      version: this._version,
      reveal,
      stateChanged,
      ...(scopeKey ? { scopeKey } : {}),
      ...(presence ? { presence } : {}),
    };
    for (const listener of this.listeners) listener(event);
  }

  private stopFallback(session: FallbackSession, reason: string) {
    const child = session.child;
    session.child = null;
    if (child) child.kill();
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    session.pending.clear();
  }

  private fallback(scopeKey: string): FallbackSession {
    return this.fallbacks.acquire(scopeKey, () => {
      let session: FallbackSession;
      session = {
        scopeKey,
        child: null,
        starting: null,
        nextId: 1,
        activeCalls: 0,
        pending: new Map(),
        lastError: null,
        stderr: "",
        isBusy: () => Boolean(
          session.activeCalls > 0 || session.starting || session.pending.size > 0,
        ),
        dispose: (reason) => this.stopFallback(session, reason),
      };
      return session;
    });
  }

  private async start(scopeKey: string): Promise<FallbackSession> {
    const session = this.fallback(scopeKey);
    if (session.child) return session;
    if (session.starting) {
      await session.starting;
      return session;
    }
    session.starting = this.startInner(session);
    try {
      await session.starting;
      return session;
    } finally {
      session.starting = null;
    }
  }

  private async startInner(session: FallbackSession) {
    const bin = resolvePlaywrightMcpBin();
    const args = [
      "--headless",
      "--isolated",
      "--browser", controlledBrowserEngine(),
      "--output-mode", "stdout",
      "--image-responses", "allow",
      "--viewport-size", "1280x800",
    ];
    // Run the JS entrypoint through Telar's current runtime. Executing the
    // package bin directly depends on `/usr/bin/env node`, which is absent on
    // valid Bun-only Telar installations.
    const child = spawn(process.execPath, [bin, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    session.child = child;
    session.lastError = null;
    session.stderr = "";

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        return;
      }
      if (message.id === undefined) return;
      const pending = session.pending.get(message.id);
      if (!pending) return;
      session.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? "Browser runtime error."));
      else pending.resolve(message.result);
    });
    child.stderr.on("data", (chunk) => {
      session.stderr = `${session.stderr}${String(chunk)}`.slice(-8_000);
    });
    const onClosed = () => {
      if (session.child !== child) return;
      session.child = null;
      const reason = browserErrorText(session.stderr) || "The controlled browser stopped unexpectedly.";
      session.lastError = reason;
      for (const pending of session.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(reason));
      }
      session.pending.clear();
      this.emit(false, session.scopeKey);
    };
    child.once("error", onClosed);
    child.once("exit", onClosed);

    try {
      await this.request(session, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "telar", version: "0.1.0" },
      });
      this.notify(session, "notifications/initialized");
    } catch (error) {
      if (session.child === child) session.child = null;
      child.kill();
      throw error;
    }
  }

  private request<T>(session: FallbackSession, method: string, params: unknown): Promise<T> {
    if (!session.child) return Promise.reject(new Error("Browser runtime is not running."));
    const id = session.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!session.pending.delete(id)) return;
        reject(new Error(`Controlled browser timed out while calling ${method}.`));
      }, RPC_TIMEOUT_MS);
      session.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      session.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private notify(session: FallbackSession, method: string, params: unknown = {}) {
    session.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async call(
    name: string,
    args: Record<string, unknown> = {},
    options: { notify?: boolean; scopeKey?: string } = {},
  ): Promise<BrowserToolResult> {
    const scopeKey = options.scopeKey?.trim();
    if (!scopeKey) throw new Error("A browser session scope is required.");
    const normalized = normalizeBrowserToolCall(name, args);
    const runtimeName = normalized.name;
    const runtimeArgs = normalized.args;
    const startedAt = new Date().toISOString();
    const notifyPresence = options.notify !== false;
    if (notifyPresence) {
      this.emit(false, options.scopeKey, {
        status: "acting",
        scopeKey: options.scopeKey,
        tool: runtimeName,
        phase: browserToolPhase(runtimeName),
        startedAt,
      }, false);
    }
    const desktop = desktopBrowserHost();
    try {
      const controlResult = await desktopControlRequest<BrowserToolResult>("/tool", {
        method: "POST",
        body: JSON.stringify({ scopeKey, name: runtimeName, args: runtimeArgs }),
      });
      const result = controlResult ?? (desktop.online()
        ? await desktop.call(scopeKey, runtimeName, runtimeArgs)
        : null);
      if (result) {
        const reveal =
          !result.isError &&
          shouldRevealBrowserCall(runtimeName, runtimeArgs, notifyPresence);
        if (notifyPresence) {
          this.emit(reveal, options.scopeKey, {
            status: "settling",
            scopeKey: options.scopeKey,
            tool: runtimeName,
            phase: browserToolPhase(runtimeName),
            startedAt,
            lastActionAt: new Date().toISOString(),
          });
        }
        return result;
      }
    } catch (error) {
      if (notifyPresence) {
        this.emit(false, options.scopeKey, {
          status: "settling",
          scopeKey: options.scopeKey,
          tool: runtimeName,
          phase: browserToolPhase(runtimeName),
          startedAt,
          lastActionAt: new Date().toISOString(),
        }, false);
      }
      throw error;
    }
    // Take the scope lease BEFORE awaiting process startup. Without this tiny
    // ordering rule, another conversation could hit the LRU in the gap between
    // `start()` resolving and `tools/call` registering its pending RPC.
    const session = this.fallback(scopeKey);
    session.activeCalls += 1;
    try {
      await this.start(scopeKey);
      const result = await this.request<BrowserToolResult>(session, "tools/call", {
        name: runtimeName,
        arguments: runtimeArgs,
      });
      const failure = result.isError ? browserErrorText(textOf(result)) || "Browser action failed." : null;
      session.lastError = failure;
      const reveal =
        !result.isError &&
        shouldRevealBrowserCall(runtimeName, runtimeArgs, notifyPresence);
      if (notifyPresence) {
        this.emit(reveal, options.scopeKey, {
          status: "settling",
          scopeKey: options.scopeKey,
          tool: runtimeName,
          phase: browserToolPhase(runtimeName),
          startedAt,
          lastActionAt: new Date().toISOString(),
        });
      }
      return result;
    } catch (error) {
      session.lastError = browserErrorText(error instanceof Error ? error.message : error);
      if (notifyPresence) {
        this.emit(false, options.scopeKey, {
          status: "settling",
          scopeKey: options.scopeKey,
          tool: runtimeName,
          phase: browserToolPhase(runtimeName),
          startedAt,
          lastActionAt: new Date().toISOString(),
        }, false);
      }
      throw error;
    } finally {
      session.activeCalls = Math.max(0, session.activeCalls - 1);
    }
  }

  async state(scopeKey: string): Promise<ControlledBrowserState> {
    try {
      const controlState = await desktopControlRequest<ControlledBrowserState>(
        `/state?scopeKey=${encodeURIComponent(scopeKey)}`,
      );
      if (controlState) return controlState;
    } catch (error) {
      return {
        scopeKey,
        available: false,
        running: false,
        provider: "desktop",
        tabs: [],
        screenshot: null,
        error: browserErrorText(error instanceof Error ? error.message : error),
        version: this.version,
      };
    }
    const desktopState = desktopBrowserHost().state(scopeKey);
    if (desktopState) return desktopState;
    try {
      const tabsResult = await this.call("browser_tabs", { action: "list" }, { notify: false, scopeKey });
      const tabs = parseBrowserTabs(textOf(tabsResult));
      let screenshot: string | null = null;
      if (!tabsResult.isError && tabs.length > 0) {
        const shot = await this.call(
          "browser_take_screenshot",
          { type: "jpeg", scale: "css" },
          { notify: false, scopeKey },
        );
        for (const part of shot.content) {
          if (part.type !== "image") continue;
          screenshot = `data:${part.mimeType || "image/jpeg"};base64,${part.data}`;
          break;
        }
      }
      return {
        scopeKey,
        available: !tabsResult.isError,
        running: Boolean(this.fallbacks.peek(scopeKey)?.child),
        provider: "playwright",
        tabs,
        screenshot,
        error: tabsResult.isError
          ? browserErrorText(textOf(tabsResult))
          : this.fallbacks.peek(scopeKey)?.lastError ?? null,
        version: this.version,
      };
    } catch (error) {
      return {
        scopeKey,
        available: false,
        running: Boolean(this.fallbacks.peek(scopeKey)?.child),
        provider: "playwright",
        tabs: [],
        screenshot: null,
        error: browserErrorText(error instanceof Error ? error.message : error),
        version: this.version,
      };
    }
  }
}

// Bump this key when the runtime launch contract changes. Next.js preserves
// global values through server hot reloads, so reusing an older instance would
// otherwise keep stale launch flags and errors until the dev server restarts.
const GLOBAL_KEY = Symbol.for("telar.controlled-browser-runtime.v4");
const runtimeGlobal = globalThis as typeof globalThis & { [GLOBAL_KEY]?: BrowserRuntime };

export function controlledBrowserRuntime(): BrowserRuntime {
  return runtimeGlobal[GLOBAL_KEY] ??= new BrowserRuntime();
}

let installPromise: Promise<string> | null = null;

export function installControlledBrowser(): Promise<string> {
  if (installPromise) return installPromise;
  const operation = new Promise<string>((resolve, reject) => {
    const bin = resolvePlaywrightMcpBin();
    const child = spawn(process.execPath, [bin, "install-browser", controlledBrowserEngine()], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    child.stdout.on("data", (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000); });
    child.stderr.on("data", (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve(output.trim() || "Controlled browser installed.");
      else reject(new Error(output.trim() || `Browser installer exited with code ${code}.`));
    });
  });
  installPromise = operation.finally(() => { installPromise = null; });
  return installPromise;
}
