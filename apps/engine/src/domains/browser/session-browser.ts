import type { BrowserProvider, BrowserSnapshot, BrowserTab, Session } from "@telar/engine-client";
import { EngineStateError, type Kernel } from "../../platform/kernel";

/**
 * The daemon's browser as the store may see it. Optional parts keep Chromium's
 * transport out of every test; a store with none answers `provider: "none"`,
 * the same as a session that never browsed.
 */
export type AttachedBrowser = {
  release(scopeKey: string, reason?: string): Promise<boolean>;
  state?(
    scopeKey: string,
    options: { screenshot?: boolean; start?: boolean },
  ): Promise<{ provider: BrowserProvider; running: boolean; tabs: BrowserTab[]; screenshot?: string | null; error?: string | null }>;
  /** The desktop host refuses a scope with no profile bound. */
  bindProfile?(scopeKey: string, profileKey: string): Promise<void>;
  call?(scopeKey: string, name: string, args?: Record<string, unknown>): Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>;
};

type SessionBrowserDeps = {
  require: (sessionId: string) => void;
  getSession: (sessionId: string) => Session;
  runningRunId: (sessionId: string) => string | undefined;
};

/** A session's shared browser from the person's side: who holds it, what it shows, and opening a page. */
export class SessionBrowser {
  private browser?: AttachedBrowser;
  // Both dedupe maps only stop re-reports journalling identical rows, so memory is enough.
  private readonly journalSignature = new Map<string, string>();
  private readonly controlLast = new Map<string, string>();

  constructor(
    private readonly kernel: Kernel,
    private readonly deps: SessionBrowserDeps,
  ) {}

  attach(browser: AttachedBrowser): void {
    this.browser = browser;
  }

  release(sessionId: string, reason: string): Promise<boolean> | undefined {
    return this.browser?.release(sessionId, reason);
  }

  /** Reported per tab by the desktop shell, stamped with the running turn when there is one. */
  recordControl(sessionId: string, controller: "agent" | "human" | "idle", tabId?: string, interrupted = false): void {
    this.deps.require(sessionId);
    const key = `${sessionId}:${tabId ?? ""}`;
    if (this.controlLast.get(key) === controller) return;
    this.controlLast.set(key, controller);
    this.kernel.appendEvent(
      sessionId,
      { type: "browser.control.changed", controller, ...(tabId ? { tabId } : {}), ...(interrupted ? { interrupted: true } : {}) },
      this.deps.runningRunId(sessionId),
    );
  }

  /**
   * Answered from this process's browser: a separately-run worker drives its own,
   * which reports here as `provider: "none"`. Asking never starts a browser
   * unless `start` says so.
   */
  async state(sessionId: string, options: { screenshot?: boolean; start?: boolean } = {}): Promise<BrowserSnapshot> {
    const session = this.deps.getSession(sessionId);
    if (!this.browser?.state) return { scopeKey: sessionId, provider: "none", running: false, tabs: [], canStart: false };
    // The cockpit starts a browser before its surface can bind the profile.
    if (options.start && this.browser.bindProfile) await this.browser.bindProfile(sessionId, session.projectId ?? "none");
    const state = await this.browser.state(sessionId, {
      ...(options.screenshot === undefined ? {} : { screenshot: options.screenshot }),
      ...(options.start === undefined ? {} : { start: options.start }),
    });
    // No worker reports a hand-started browser, and the panel folds the journal, so this read journals its tabs.
    if (options.start && !state.error && state.running) {
      const signature = `${state.provider}:${JSON.stringify(state.tabs)}`;
      if (this.journalSignature.get(sessionId) !== signature) {
        this.journalSignature.set(sessionId, signature);
        this.kernel.appendEvent(sessionId, { type: "browser.state.changed", provider: state.provider, tabs: state.tabs });
      }
    }
    return {
      scopeKey: sessionId,
      provider: state.provider,
      running: state.running,
      tabs: state.tabs,
      ...(state.screenshot ? { screenshot: state.screenshot } : {}),
      ...(state.error ? { error: state.error } : {}),
      canStart: true,
    };
  }

  /** Opens a tab as the person, for clients with no desktop shell. Only http(s). */
  async open(sessionId: string, url: string): Promise<BrowserSnapshot> {
    const session = this.deps.getSession(sessionId);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new EngineStateError("invalid_request", "that is not a URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new EngineStateError("invalid_request", "only http and https pages can be opened");
    if (!this.browser?.call || !this.browser.state) throw new EngineStateError("invalid_request", "this engine has no browser to open pages in");
    if (this.browser.bindProfile) await this.browser.bindProfile(sessionId, session.projectId ?? "none");
    const result = await this.browser.call(sessionId, "browser_tabs", { action: "new", url: parsed.href });
    if (result.isError) {
      const text = result.content.find((part) => part.type === "text")?.text;
      throw new EngineStateError("invalid_request", text || "the browser could not open that page");
    }
    return this.state(sessionId, { start: true });
  }
}
