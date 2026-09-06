/**
 * The desktop browser host, as the engine sees it.
 *
 * `apps/desktop/browser-control-server.js` has served the Electron-hosted
 * tabs over loopback since the day it shipped — and until now NOTHING in the
 * engine read `TELAR_DESKTOP_BROWSER_CONTROL_{PORT,TOKEN}`, so the visible
 * browser (agent cursor, persistent partition, the page a human can click)
 * sat orphaned while every agent got headless Chromium. This client closes
 * that gap: the same wire the desktop already speaks — `GET /state?scopeKey=`
 * and `POST /tool {scopeKey, name, args}`, bearer-authed — consumed from the
 * engine side.
 *
 * REACHABILITY IS A FACT THAT CHANGES. The desktop app can quit while a
 * detached session browses on. Every routed call re-asks (behind a short
 * cache) rather than deciding at construction, so losing the host degrades to
 * headless instead of to errors.
 */
import type { BrowserTab } from "@telar/engine-client";
import { normalizeBrowserToolCall } from "./helpers";
import { BrowserToolInputError, BrowserToolResult, parseBrowserToolInput } from "./tools";

export type DesktopBrowserConfig = {
  port: number;
  token: string;
  /** Injected by tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** How long one reachability answer is trusted. Short on purpose: the cost
   *  of asking is one loopback GET, the cost of a stale "yes" is a browser
   *  call failing against a quit app. */
  probeTtlMs?: number;
};

/** Read the desktop host's address from the environment the shell exports to
 *  the engine child (`apps/desktop/main.js`). Absent or malformed → no host. */
export function desktopBrowserFromEnv(env: NodeJS.ProcessEnv = process.env): DesktopBrowserClient | undefined {
  const port = Number.parseInt(env.TELAR_DESKTOP_BROWSER_CONTROL_PORT?.trim() ?? "", 10);
  const token = env.TELAR_DESKTOP_BROWSER_CONTROL_TOKEN?.trim();
  if (!Number.isFinite(port) || port <= 0 || !token) return undefined;
  return new DesktopBrowserClient({ port, token });
}

/** The manager's `state()` answer, narrowed to what the engine consumes. */
export type DesktopBrowserState = {
  provider: "attached";
  running: boolean;
  tabs: BrowserTab[];
  /** The scope's controller — the shared-browser control model (§6). */
  controller: "agent" | "human" | "idle";
};

function errorResult(text: string): BrowserToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export class DesktopBrowserClient {
  private readonly fetchImpl: typeof fetch;
  private readonly probeTtlMs: number;
  private probe: { at: number; ok: boolean } | undefined;

  constructor(private readonly config: DesktopBrowserConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.probeTtlMs = config.probeTtlMs ?? 3_000;
  }

  private url(path: string): string {
    return `http://127.0.0.1:${this.config.port}${path}`;
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.config.token}`, "content-type": "application/json" };
  }

  /**
   * Is the host answering, right now (modulo the short cache)?
   *
   * The probe is a real `/state` read for a throwaway scope — the cheapest
   * request the server accepts — so "reachable" means the whole path works:
   * port open, token valid, manager constructed. A 401 is UNREACHABLE, not an
   * error to surface: a token mismatch and an absent host both mean "route
   * headless".
   */
  async reachable(): Promise<boolean> {
    const now = Date.now();
    if (this.probe && now - this.probe.at < this.probeTtlMs) return this.probe.ok;
    let ok = false;
    try {
      const response = await this.fetchImpl(this.url("/state?scopeKey=__telar_probe__"), { headers: this.headers() });
      ok = response.ok;
    } catch {
      ok = false;
    }
    this.probe = { at: now, ok };
    return ok;
  }

  async call(scopeKey: string, name: string, args: Record<string, unknown> = {}): Promise<BrowserToolResult> {
    // The one engine-defined tool the host must never see — same guard as the
    // headless runtime, for the same reason: its arguments on the wire may
    // only ever contain refs, and the socket handles it above both.
    if (name === "browser_fill_secret") {
      return errorResult("browser_fill_secret is handled by the session socket, not the browser host.");
    }
    // Normalized and validated HERE, exactly like the headless path: the host
    // speaks `browser_tabs {action:"list"}`, not Telar's read-only alias, and
    // a rejection on this side of the wire names the field instead of costing
    // a round trip.
    let normalized: { name: string; args: Record<string, unknown> };
    try {
      const call = normalizeBrowserToolCall(name, args);
      normalized = { name: call.name, args: parseBrowserToolInput(call.name, call.args) };
    } catch (error) {
      if (error instanceof BrowserToolInputError) return errorResult(error.message);
      throw error;
    }
    try {
      const response = await this.fetchImpl(this.url("/tool"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ scopeKey, name: normalized.name, args: normalized.args }),
      });
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
            ? (payload as { error: string }).error
            : `The desktop browser host answered ${response.status}.`;
        return errorResult(message);
      }
      const parsed = BrowserToolResult.safeParse(payload);
      return parsed.success ? parsed.data : errorResult("The desktop browser host answered with an unexpected shape.");
    } catch {
      // The host quit between the probe and the call. An error RESULT, never a
      // throw: the router's next probe will route headless.
      this.probe = { at: Date.now(), ok: false };
      return errorResult("The desktop browser host did not answer.");
    }
  }

  /**
   * Open a tab AS THE HUMAN. The cockpit's "open a browser" lands here rather
   * than on `browser_tabs {new}` so the host stamps it `openedBy: "human"` —
   * the agent's tool path has no opener argument and must not grow one.
   */
  /**
   * BIND A SCOPE TO ITS PROJECT'S BROWSER PROFILE. The host refuses to open
   * any tab for a scope nobody bound — cookies are per project, and a scope
   * without a declared project is exactly the leak this prevents. Called
   * before a turn's first browser tool with the claim's project id, and by
   * the cockpit before the panel shows. `profileKey` is a project id or the
   * explicit `none` for a projectless session.
   */
  async bind(scopeKey: string, profileKey: string): Promise<{ scopeKey: string; profileKey: string; partition: string }> {
    const response = await this.fetchImpl(this.url("/bind"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ scopeKey, profileKey }),
    });
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message = payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string" ? (payload as { error: string }).error : `The desktop browser host answered ${response.status}.`;
      throw new Error(message);
    }
    return payload as { scopeKey: string; profileKey: string; partition: string };
  }

  async openForHuman(scopeKey: string, url = "about:blank"): Promise<DesktopBrowserState> {
    const response = await this.fetchImpl(this.url("/open"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ scopeKey, url }),
    });
    return this.parseState(response);
  }

  async state(scopeKey: string): Promise<DesktopBrowserState> {
    const response = await this.fetchImpl(this.url(`/state?scopeKey=${encodeURIComponent(scopeKey)}`), {
      headers: this.headers(),
    });
    return this.parseState(response);
  }

  private async parseState(response: Response): Promise<DesktopBrowserState> {
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => undefined);
      const message = payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string" ? (payload as { error: string }).error : undefined;
      throw new Error(message ?? `The desktop browser host answered ${response.status}.`);
    }
    const payload = (await response.json()) as {
      running?: unknown;
      controller?: unknown;
      tabs?: { index?: unknown; title?: unknown; url?: unknown; active?: unknown }[];
    };
    const controller = payload.controller === "human" || payload.controller === "agent" ? payload.controller : "idle";
    return {
      provider: "attached",
      running: payload.running !== false,
      controller,
      // The index IS the id, matching the headless runtime's positional
      // convention — the model addresses `browser_tabs {index}` on both.
      tabs: (Array.isArray(payload.tabs) ? payload.tabs : []).map((tab, position) => {
        const raw = tab as { controller?: unknown; openedBy?: unknown; loading?: unknown };
        const controller = raw.controller === "human" || raw.controller === "agent" || raw.controller === "idle" ? raw.controller : undefined;
        const openedBy = raw.openedBy === "human" || raw.openedBy === "agent" ? raw.openedBy : undefined;
        return {
          id: String(typeof tab.index === "number" ? tab.index : position),
          url: typeof tab.url === "string" ? tab.url : "about:blank",
          title: typeof tab.title === "string" ? tab.title : "",
          active: tab.active === true,
          ...(raw.loading === true ? { loading: true } : {}),
          ...(controller ? { controller } : {}),
          ...(openedBy ? { openedBy } : {}),
        };
      }),
    };
  }
}
