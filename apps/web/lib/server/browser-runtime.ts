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

class BrowserRuntime {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private fallbackScopeKey: string | null = null;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private listeners = new Set<(event: BrowserRuntimeEvent) => void>();
  private lastError: string | null = null;
  private stderr = "";
  private _version = 0;

  constructor() {
    desktopBrowserHost().subscribe(() => this.emit());
  }

  get version() {
    return this._version;
  }

  get running() {
    return this.child !== null;
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

  private stopFallback(reason = "The browser session changed.") {
    const child = this.child;
    this.child = null;
    this.fallbackScopeKey = null;
    if (child) child.kill();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private async start(scopeKey: string) {
    if (this.child && this.fallbackScopeKey === scopeKey) return;
    if (this.child) this.stopFallback();
    if (this.starting) {
      await this.starting;
      if (this.child && this.fallbackScopeKey === scopeKey) return;
      if (this.child) this.stopFallback();
    }
    this.starting = this.startInner();
    try {
      await this.starting;
      this.fallbackScopeKey = scopeKey;
    } finally {
      this.starting = null;
    }
  }

  private async startInner() {
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
    this.child = child;
    this.lastError = null;
    this.stderr = "";

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        return;
      }
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? "Browser runtime error."));
      else pending.resolve(message.result);
    });
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-8_000);
    });
    const onClosed = () => {
      if (this.child !== child) return;
      this.child = null;
      const reason = browserErrorText(this.stderr) || "The controlled browser stopped unexpectedly.";
      this.lastError = reason;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(reason));
      }
      this.pending.clear();
      this.emit();
    };
    child.once("error", onClosed);
    child.once("exit", onClosed);

    try {
      await this.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "telar", version: "0.1.0" },
      });
      this.notify("notifications/initialized");
    } catch (error) {
      if (this.child === child) this.child = null;
      child.kill();
      throw error;
    }
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    if (!this.child) return Promise.reject(new Error("Browser runtime is not running."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`Controlled browser timed out while calling ${method}.`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private notify(method: string, params: unknown = {}) {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
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
      this.lastError = browserErrorText(error instanceof Error ? error.message : error);
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
    await this.start(scopeKey);
    try {
      const result = await this.request<BrowserToolResult>("tools/call", {
        name: runtimeName,
        arguments: runtimeArgs,
      });
      const failure = result.isError ? browserErrorText(textOf(result)) || "Browser action failed." : null;
      this.lastError = failure;
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
      this.lastError = browserErrorText(error instanceof Error ? error.message : error);
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
        running: this.running,
        provider: "playwright",
        tabs,
        screenshot,
        error: tabsResult.isError ? browserErrorText(textOf(tabsResult)) : this.lastError,
        version: this.version,
      };
    } catch (error) {
      return {
        scopeKey,
        available: false,
        running: this.running,
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
const GLOBAL_KEY = Symbol.for("telar.controlled-browser-runtime.v3");
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
