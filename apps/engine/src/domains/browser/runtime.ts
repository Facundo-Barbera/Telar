import nodePath from "node:path";
import type { BrowserProvider, BrowserTab } from "@telar/engine-client";
import {
  browserErrorText,
  headlessBrowserToolCall,
  imageDataUrlOf,
  isBrowserNotInstalled,
  isReadOnlyBrowserCall,
  parseBrowserTabs,
  textOf,
} from "./helpers";
import type { BrowserProfileIdentity, DesktopBrowserClient, DesktopBrowserState } from "./desktop";
import { headlessCanvasCall } from "./canvas";
import { ScopedRuntimePool, type ScopedRuntimeResource } from "./pool";
import { installBrowser, PlaywrightMcpTransport, type BrowserTransportOptions } from "./transport";
import { BrowserToolResult, parseBrowserToolInput } from "./tools";


const MAX_BROWSER_SCOPES = 6;

export type BrowserState = {
  scopeKey: string;
  provider: BrowserProvider;
  running: boolean;
  tabs: BrowserTab[];
  screenshot: string | null;
  error: string | null;
};

export type ExitHooks = {
  on(event: "exit", listener: () => void): void;
  off(event: "exit", listener: () => void): void;
};

const nodeExitHooks: ExitHooks = {
  on: (event, listener) => {
    process.on(event, listener);
  },
  off: (event, listener) => {
    process.off(event, listener);
  },
};

export type BrowserRuntimeOptions = BrowserTransportOptions & {
  profileRoot?: string;
  maxScopes?: number;
  exitHooks?: ExitHooks;
  installExitHandler?: boolean;
  install?: (browser?: string) => Promise<string>;
  autoInstall?: boolean;
};

type BrowserScope = ScopedRuntimeResource & {
  scopeKey: string;
  transport: PlaywrightMcpTransport;
};

export class BrowserRuntime {
  private readonly scopes: ScopedRuntimePool<BrowserScope>;
  private readonly transportOptions: BrowserTransportOptions;
  private readonly exitHooks: ExitHooks | null;
  private readonly onProcessExit = () => this.killAllNow();
  private closed = false;
  private readonly install: ((browser?: string) => Promise<string>) | null;
  private readonly profileRoot: string | undefined;
  private installAttempted = false;

  constructor(options: BrowserRuntimeOptions = {}) {
    const { maxScopes, exitHooks, installExitHandler, install, autoInstall, profileRoot, ...transportOptions } = options;
    this.profileRoot = profileRoot;
    this.scopes = new ScopedRuntimePool<BrowserScope>(maxScopes ?? MAX_BROWSER_SCOPES);
    this.transportOptions = transportOptions;
    this.exitHooks = installExitHandler === false ? null : (exitHooks ?? nodeExitHooks);
    this.exitHooks?.on("exit", this.onProcessExit);
    this.install =
      autoInstall === false
        ? null
        : (install ??
          ((browser) =>
            installBrowser({
              ...(browser ? { browser } : {}),
              ...(transportOptions.cliPath ? { cliPath: transportOptions.cliPath } : {}),
            })));
  }

  get scopeKeys(): string[] {
    return this.scopes.keys();
  }

  isRunning(scopeKey: string): boolean {
    return this.scopes.peek(scopeKey)?.transport.running ?? false;
  }

  isReadOnly(name: string, args: Record<string, unknown> = {}): boolean {
    return isReadOnlyBrowserCall(name, args);
  }

  async call(scopeKey: string, name: string, args: Record<string, unknown> = {}): Promise<BrowserToolResult> {
    const scope = scopeKey.trim();
    if (!scope) throw new Error("A browser session scope is required.");
    if (this.closed) throw new Error("The browser runtime is closed.");

    if (name === "browser_fill_secret") {
      return {
        content: [{ type: "text", text: "browser_fill_secret is handled by the session socket, not the browser runtime." }],
        isError: true,
      };
    }
    const normalized = headlessBrowserToolCall(name, args);
    const input = parseBrowserToolInput(normalized.name, normalized.args);
    delete input.tabId;
    const wire = headlessCanvasCall(normalized.name, input);
    if ("refusal" in wire) return { content: [{ type: "text", text: wire.refusal }], isError: true };

    const resource = this.scopeFor(scope);
    const result = await resource.transport.call(wire.name, wire.args);
    if (!result.isError || !this.install || this.installAttempted) return result;

    if (!isBrowserNotInstalled(textOf(result))) return result;
    this.installAttempted = true;
    try {
      await this.install(this.transportOptions.browser);
    } catch (error) {
      return {
        ...result,
        content: [{ type: "text", text: `${textOf(result)}\n\nTelar could not install the browser: ${browserErrorText(error instanceof Error ? error.message : error)}` }],
      };
    }
    if (this.closed) return result;
    return this.scopeFor(scope).transport.call(wire.name, wire.args);
  }

  async state(scopeKey: string, options: { start?: boolean; screenshot?: boolean } = {}): Promise<BrowserState> {
    const existing = this.scopes.peek(scopeKey);
    if (!existing?.transport.running && options.start !== true) {
      return {
        scopeKey,
        provider: existing ? "headless" : "none",
        running: false,
        tabs: [],
        screenshot: null,
        error: existing?.transport.lastError ?? null,
      };
    }
    try {
      const tabsResult = await this.call(scopeKey, "browser_list_tabs");
      const tabs = parseBrowserTabs(textOf(tabsResult));
      let screenshot: string | null = null;
      if (!tabsResult.isError && tabs.length > 0 && options.screenshot !== false) {
        const shot = await this.call(scopeKey, "browser_take_screenshot", { type: "jpeg", scale: "css" });
        screenshot = imageDataUrlOf(shot);
      }
      return {
        scopeKey,
        provider: "headless",
        running: this.isRunning(scopeKey),
        tabs: tabs.map(toProtocolTab),
        screenshot,
        error: tabsResult.isError
          ? browserErrorText(textOf(tabsResult))
          : (this.scopes.peek(scopeKey)?.transport.lastError ?? null),
      };
    } catch (error) {
      return {
        scopeKey,
        provider: "headless",
        running: this.isRunning(scopeKey),
        tabs: [],
        screenshot: null,
        error: browserErrorText(error instanceof Error ? error.message : error),
      };
    }
  }

  async release(scopeKey: string, reason?: string): Promise<boolean> {
    return this.scopes.release(scopeKey, reason);
  }

  async close(reason = "The browser runtime was shut down."): Promise<void> {
    this.closed = true;
    this.exitHooks?.off("exit", this.onProcessExit);
    await this.scopes.clear(reason);
  }

  private killAllNow(): void {
    for (const key of this.scopes.keys()) this.scopes.peek(key)?.transport.killNow();
  }

  private scopeFor(scopeKey: string): BrowserScope {
    return this.scopes.acquire(scopeKey, () => {
      const transport = new PlaywrightMcpTransport({
        ...this.transportOptions,
        ...(this.profileRoot
          ? { userDataDir: nodePath.join(this.profileRoot, scopeKey.replace(/[^A-Za-z0-9._-]/g, "_")) }
          : {}),
      });
      return {
        scopeKey,
        transport,
        isBusy: () => transport.busy,
        dispose: (reason) => transport.close(reason),
      };
    });
  }
}

function toProtocolTab(tab: { index: number; title: string; url: string; active: boolean }): BrowserTab {
  return { id: String(tab.index), url: tab.url, title: tab.title, active: tab.active };
}

export type EngineBrowser = {
  call(scopeKey: string, name: string, args?: Record<string, unknown>): Promise<BrowserToolResult>;
  isReadOnly(name: string, args?: Record<string, unknown>): boolean;
  state(scopeKey: string, options?: { start?: boolean; screenshot?: boolean }): Promise<BrowserState>;
  bindProfile?(scopeKey: string, profileKey: string): Promise<void>;
  profileIdentity?(scopeKey: string): Promise<BrowserProfileIdentity | null>;
  release(scopeKey: string, reason?: string): Promise<boolean>;
  close(reason?: string): Promise<void>;
};

export class BrowserRouter implements EngineBrowser {
  private readonly profiles = new Map<string, string>();

  constructor(
    private readonly headless: BrowserRuntime,
    private readonly desktop?: DesktopBrowserClient,
  ) {}

  private async useDesktop(): Promise<boolean> {
    return this.desktop ? this.desktop.reachable() : false;
  }

  private readonly starting = new Map<string, Promise<DesktopBrowserState>>();
  private startOnce(scopeKey: string): Promise<DesktopBrowserState> {
    const inFlight = this.starting.get(scopeKey);
    if (inFlight) return inFlight;
    const run = (async () => {
      const fresh = await this.desktop!.state(scopeKey);
      return fresh.tabs.length > 0 ? fresh : this.desktop!.openForHuman(scopeKey);
    })().finally(() => this.starting.delete(scopeKey));
    this.starting.set(scopeKey, run);
    return run;
  }

  isReadOnly(name: string, args: Record<string, unknown> = {}): boolean {
    return isReadOnlyBrowserCall(name, args);
  }

  async call(scopeKey: string, name: string, args: Record<string, unknown> = {}): Promise<BrowserToolResult> {
    if (await this.useDesktop()) {
      await this.restoreProfile(scopeKey);
      return this.desktop!.call(scopeKey, name, args);
    }
    return this.headless.call(scopeKey, name, args);
  }

  async bindProfile(scopeKey: string, profileKey: string): Promise<void> {
    const previous = this.profiles.get(scopeKey);
    if (previous !== undefined && previous !== profileKey) throw new Error("Browser session is already bound to a different project profile.");
    this.profiles.set(scopeKey, profileKey);
    if (await this.useDesktop()) this.rememberIdentity(scopeKey, await this.desktop!.bind(scopeKey, profileKey));
  }

  async profileIdentity(scopeKey: string): Promise<BrowserProfileIdentity | null> {
    if (!(await this.useDesktop())) {
      return this.headless.isRunning(scopeKey) || this.profiles.has(scopeKey)
        ? { id: `headless:${scopeKey}`, label: "Headless session browser" }
        : null;
    }
    const profileKey = this.profiles.get(scopeKey);
    if (profileKey === undefined) return this.identities.get(scopeKey) ?? null;
    try {
      this.rememberIdentity(scopeKey, await this.desktop!.bind(scopeKey, profileKey));
    } catch {
      this.identities.delete(scopeKey);
    }
    return this.identities.get(scopeKey) ?? null;
  }

  private readonly identities = new Map<string, BrowserProfileIdentity>();

  private rememberIdentity(scopeKey: string, binding: { profileId?: string; label?: string; account?: string }): void {
    if (!binding.profileId) {
      this.identities.delete(scopeKey);
      return;
    }
    this.identities.set(scopeKey, {
      id: binding.profileId,
      ...(binding.label ? { label: binding.label } : {}),
      ...(binding.account ? { account: binding.account } : {}),
    });
  }

  private async restoreProfile(scopeKey: string): Promise<void> {
    const profile = this.profiles.get(scopeKey);
    if (profile !== undefined) this.rememberIdentity(scopeKey, await this.desktop!.bind(scopeKey, profile));
  }

  async state(scopeKey: string, options: { start?: boolean; screenshot?: boolean } = {}): Promise<BrowserState> {
    if (!(await this.useDesktop())) return this.headless.state(scopeKey, options);
    try {
      await this.restoreProfile(scopeKey);
      let state = await this.desktop!.state(scopeKey);
      if (options.start && state.tabs.length === 0) {
        state = await this.startOnce(scopeKey);
      }
      let screenshot: string | null = null;
      if (state.tabs.length > 0 && options.screenshot !== false) {
        const shot = await this.desktop!.call(scopeKey, "browser_take_screenshot", { type: "jpeg", scale: "css" });
        screenshot = shot.isError ? null : imageDataUrlOf(shot);
      }
      return { scopeKey, provider: "attached", running: state.running, tabs: state.tabs, screenshot, error: null };
    } catch (error) {
      return {
        scopeKey,
        provider: "attached",
        running: false,
        tabs: [],
        screenshot: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async release(scopeKey: string, reason?: string): Promise<boolean> {
    const desktop = (await this.useDesktop()) ? this.desktop!.release(scopeKey).catch(() => false) : Promise.resolve(false);
    const [headless, attached] = await Promise.all([this.headless.release(scopeKey, reason), desktop]);
    return headless || attached;
  }

  close(reason?: string): Promise<void> {
    this.profiles.clear();
    this.identities.clear();
    return this.headless.close(reason);
  }
}
