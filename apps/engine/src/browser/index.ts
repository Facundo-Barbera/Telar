/**
 * The engine-owned headless browser.
 *
 * WHY THIS LIVES IN THE ENGINE AT ALL. A detached session has no UI client, and
 * a browser that lives in a UI process can only act while somebody is watching.
 * t3 code brokers automation to a connected desktop host and simply fails when
 * none is attached; the frozen cockpit's runtime already solved the headless
 * half (`apps/web_old/lib/server/browser-runtime.ts`) but hung it off a Next.js
 * server. Moving it behind the engine is what lets `browser.state.changed` in
 * `@telar/engine-client` name `headless` as the DEFAULT provider rather than a
 * fallback: a session can drive a page with nothing attached to it.
 *
 * WHAT THIS CLASS IS NOT. The legacy runtime was reachable only through
 * `controlledBrowserRuntime()`, a `Symbol.for("telar.controlled-browser-
 * runtime.v4")` slot on `globalThis`. That was a workaround for Next.js hot
 * reload, and it made the runtime un-instantiable (one per process, so two
 * tests share a browser and each other's state) and un-teardown-able (nothing
 * owns it, so nothing may close it). Here the daemon constructs one, holds it,
 * and closes it. Ownership is the feature.
 */
import nodePath from "node:path";
import type { BrowserProvider, BrowserTab } from "@telar/engine-client";
import {
  browserErrorText,
  imageDataUrlOf,
  isBrowserNotInstalled,
  isReadOnlyBrowserCall,
  normalizeBrowserToolCall,
  parseBrowserTabs,
  textOf,
} from "./helpers";
import type { DesktopBrowserClient } from "./desktop";
import { ScopedRuntimePool, type ScopedRuntimeResource } from "./pool";
import { installBrowser, PlaywrightMcpTransport, type BrowserTransportOptions } from "./transport";
import { BrowserToolResult, parseBrowserToolInput } from "./tools";

export * from "./desktop";
export * from "./helpers";
export * from "./pool";
export * from "./socket";
export * from "./tools";
export * from "./transport";

/**
 * How many browsers may be resident at once. Each is a Chromium; six is roughly
 * the point where a laptop running detached sessions starts swapping. Busy
 * scopes are never evicted, so this is a target rather than a hard ceiling —
 * see `ScopedRuntimePool`.
 */
export const MAX_BROWSER_SCOPES = 6;

/** What a client needs to render the browser panel for one scope. */
export type BrowserState = {
  scopeKey: string;
  provider: BrowserProvider;
  running: boolean;
  tabs: BrowserTab[];
  /** A data URL, or null. Never a file path — a detached session has nobody to
   *  clean up a screenshot directory. */
  screenshot: string | null;
  error: string | null;
};

/**
 * The `process.on("exit")` seam. Injected so a test can assert the handler is
 * REMOVED on close: Node warns at eleven listeners on one event and then says
 * nothing, so a runtime per session that never unregisters looks fine right up
 * to the point where the daemon is holding every browser it ever opened.
 */
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
  /**
   * Where per-scope persistent Chromium profiles live. Set ⇒ each scope gets
   * `<profileRoot>/<scopeKey>` as `--user-data-dir`, so a session's logins
   * survive turns, evictions and daemon restarts. Absent ⇒ `--isolated`, the
   * pre-PR4 behaviour and what tests want.
   */
  profileRoot?: string;
  maxScopes?: number;
  exitHooks?: ExitHooks;
  /** Set false to own teardown entirely (a supervisor that already kills its
   *  process group). Default true. */
  installExitHandler?: boolean;
  /** The seam for the one-shot binary download. Injected so a test can prove
   *  the retry happens without downloading a hundred megabytes of Chromium. */
  install?: (browser?: string) => Promise<string>;
  /** Set false on a machine that provisions the browser itself. Default true. */
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
  /** One attempt per runtime. A second failure after a successful install is
   *  something else — a broken cache, a missing shared library — and retrying
   *  the download forever would hide it behind a slow loop. */
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

  /** Scopes with a resident browser, running or not. */
  get scopeKeys(): string[] {
    return this.scopes.keys();
  }

  isRunning(scopeKey: string): boolean {
    return this.scopes.peek(scopeKey)?.transport.running ?? false;
  }

  /** Whether the engine may run this call without asking a human. The routing
   *  answer, exported here so the driver has one import for the browser. */
  isReadOnly(name: string, args: Record<string, unknown> = {}): boolean {
    return isReadOnlyBrowserCall(name, args);
  }

  /**
   * Run one browser tool for one scope, launching a browser if needed.
   *
   * `scopeKey` IS REQUIRED AND IS NOT DEFAULTED. It is what keeps two sessions
   * off each other's pages, and a default value would make the one bug that
   * matters — every session sharing one browser — the quiet outcome of
   * forgetting an argument.
   */
  async call(scopeKey: string, name: string, args: Record<string, unknown> = {}): Promise<BrowserToolResult> {
    const scope = scopeKey.trim();
    if (!scope) throw new Error("A browser session scope is required.");
    if (this.closed) throw new Error("The browser runtime is closed.");

    // The one engine-defined tool the transport must never see: it is handled
    // entirely above this runtime (socket → secret-fill), and Playwright MCP
    // would answer "unknown tool" with the arguments echoed back — arguments
    // that, on THIS name, may only ever contain refs, never values. Refused
    // here so a future caller cannot route it low by mistake.
    if (name === "browser_fill_secret") {
      return {
        content: [{ type: "text", text: "browser_fill_secret is handled by the session socket, not the browser runtime." }],
        isError: true,
      };
    }
    const normalized = normalizeBrowserToolCall(name, args);
    // Validated before the lease so a typo cannot spawn a Chromium.
    const input = parseBrowserToolInput(normalized.name, normalized.args);
    // `tabId` is the DESKTOP host's read-addressing (per-tab control); the
    // headless runtime has no human to share with and Playwright MCP would
    // reject the unknown parameter, so it is accepted-and-dropped here.
    delete input.tabId;

    // Take the scope's lease BEFORE any await. Without this ordering another
    // scope's acquisition can hit the LRU in the gap between `start()`
    // resolving and `tools/call` registering its pending RPC, and evict the
    // browser out from under a call that was about to look idle.
    const resource = this.scopeFor(scope);
    const result = await resource.transport.call(normalized.name, input);
    if (!result.isError || !this.install || this.installAttempted) return result;

    /**
     * THE ONE FAILURE A DETACHED SESSION CANNOT RECOVER FROM ON ITS OWN.
     *
     * A machine that has never run Playwright answers every browser call with
     * "Browser is not installed. Run npx @playwright/mcp install-browser" — an
     * instruction addressed to a human who, by construction, is not there. The
     * engine downloads it and retries once, which turns a permanently broken
     * capability into a slow first call.
     *
     * The flag is set BEFORE the await: two concurrent calls both seeing the
     * error must not both queue an install. `installBrowser` is single-flight
     * process-wide as well, because the Playwright cache is shared across
     * every runtime in the process.
     */
    if (!isBrowserNotInstalled(textOf(result))) return result;
    this.installAttempted = true;
    try {
      await this.install(this.transportOptions.browser);
    } catch (error) {
      // The install itself failing is reported as the ORIGINAL call's failure
      // with the reason appended: the agent asked to browse, not to install.
      return {
        ...result,
        content: [{ type: "text", text: `${textOf(result)}\n\nTelar could not install the browser: ${browserErrorText(error instanceof Error ? error.message : error)}` }],
      };
    }
    if (this.closed) return result;
    return this.scopeFor(scope).transport.call(normalized.name, input);
  }

  /**
   * The browser panel's view of one scope.
   *
   * DOES NOT LAUNCH A BROWSER BY DEFAULT, which is the opposite of the legacy
   * behaviour. Legacy `state()` went straight to `browser_tabs`, so any client
   * polling for a state — which is what a browser panel does — started a
   * Chromium for every session it rendered. Pass `{ start: true }` when the
   * caller genuinely wants one.
   */
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
        // jpeg + css scale: a png at device scale is several megabytes per
        // poll, and this crosses an HTTP boundary as base64.
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

  /**
   * Free one scope's browser. THE CALL THE LEGACY RUNTIME DID NOT HAVE — this
   * is what a session's terminal transition invokes, and without it a machine
   * running detached sessions accumulates Chromiums until it is restarted.
   */
  async release(scopeKey: string, reason?: string): Promise<boolean> {
    return this.scopes.release(scopeKey, reason);
  }

  /** Close every browser. The runtime is unusable afterwards; construct another
   *  rather than reviving this one, so a use-after-close is loud. */
  async close(reason = "The browser runtime was shut down."): Promise<void> {
    this.closed = true;
    this.exitHooks?.off("exit", this.onProcessExit);
    await this.scopes.clear(reason);
  }

  /** Synchronous teardown for `process.on("exit")`, where nothing async runs. */
  private killAllNow(): void {
    for (const key of this.scopes.keys()) this.scopes.peek(key)?.transport.killNow();
  }

  private scopeFor(scopeKey: string): BrowserScope {
    return this.scopes.acquire(scopeKey, () => {
      const transport = new PlaywrightMcpTransport({
        ...this.transportOptions,
        // The scope key is a session id (assertId-shaped), so it is path-safe;
        // the replace is belt for a future scope naming scheme, not policy.
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

/** Playwright MCP addresses tabs by position, so the index IS the id. It is
 *  stable only within one listing, which is why a client must re-list rather
 *  than cache these across an action that opens or closes a tab. */
function toProtocolTab(tab: { index: number; title: string; url: string; active: boolean }): BrowserTab {
  return { id: String(tab.index), url: tab.url, title: tab.title, active: tab.active };
}

/**
 * What the daemon attaches and the socket serves: the runtime itself, or the
 * router below. One shape so `drivers.ts` has a single assembly site whichever
 * browser a deployment actually has.
 */
export type EngineBrowser = {
  call(scopeKey: string, name: string, args?: Record<string, unknown>): Promise<BrowserToolResult>;
  isReadOnly(name: string, args?: Record<string, unknown>): boolean;
  state(scopeKey: string, options?: { start?: boolean; screenshot?: boolean }): Promise<BrowserState>;
  release(scopeKey: string, reason?: string): Promise<boolean>;
  close(reason?: string): Promise<void>;
};

/**
 * PREFER THE BROWSER A HUMAN CAN SEE. When the desktop shell is up, its
 * Electron-hosted tabs (agent cursor, persistent partition, a page the human
 * can click) serve every call; when it is not — a detached machine, the app
 * quit mid-session — the engine's own headless Chromium keeps the session
 * browsing. Decided PER CALL behind a short-lived probe, because the desktop
 * app's lifetime is not the session's.
 *
 * THE SEAM IS DELIBERATELY STICKY-FREE. A session that browsed on the desktop
 * and falls back headless starts from empty tabs — the two hosts do not share
 * a profile, and pretending continuity would show the model tabs it cannot
 * touch. The journalled `browser.state.changed` history still says what was
 * open where.
 */
export class BrowserRouter implements EngineBrowser {
  constructor(
    private readonly headless: BrowserRuntime,
    private readonly desktop?: DesktopBrowserClient,
  ) {}

  private async useDesktop(): Promise<boolean> {
    return this.desktop ? this.desktop.reachable() : false;
  }

  isReadOnly(name: string, args: Record<string, unknown> = {}): boolean {
    return isReadOnlyBrowserCall(name, args);
  }

  async call(scopeKey: string, name: string, args: Record<string, unknown> = {}): Promise<BrowserToolResult> {
    if (await this.useDesktop()) return this.desktop!.call(scopeKey, name, args);
    return this.headless.call(scopeKey, name, args);
  }

  async state(scopeKey: string, options: { start?: boolean; screenshot?: boolean } = {}): Promise<BrowserState> {
    if (!(await this.useDesktop())) return this.headless.state(scopeKey, options);
    try {
      const state = await this.desktop!.state(scopeKey);
      let screenshot: string | null = null;
      if (state.tabs.length > 0 && options.screenshot !== false) {
        // Same economics as the headless read: jpeg, css scale, because this
        // crosses two HTTP boundaries as base64 on every panel poll.
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

  release(scopeKey: string, reason?: string): Promise<boolean> {
    // The desktop host owns its own tab lifecycle (hibernation, LRU); the
    // engine releases only what it launched.
    return this.headless.release(scopeKey, reason);
  }

  close(reason?: string): Promise<void> {
    return this.headless.close(reason);
  }
}
