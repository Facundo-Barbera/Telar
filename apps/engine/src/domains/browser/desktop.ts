import type { BrowserTab } from "@telar/engine-client";
import { browserOperation } from "./helpers";
import { BrowserToolInputError, BrowserToolResult, parseBrowserToolInput } from "./tools";

export type DesktopBrowserConfig = {
  port: number;
  token: string;
  fetchImpl?: typeof fetch;
  probeTtlMs?: number;
};

export function desktopBrowserFromEnv(env: NodeJS.ProcessEnv = process.env): DesktopBrowserClient | undefined {
  const port = Number.parseInt(env.TELAR_DESKTOP_BROWSER_CONTROL_PORT?.trim() ?? "", 10);
  const token = env.TELAR_DESKTOP_BROWSER_CONTROL_TOKEN?.trim();
  if (!Number.isFinite(port) || port <= 0 || !token) return undefined;
  return new DesktopBrowserClient({ port, token });
}

export type DesktopBrowserState = {
  provider: "attached";
  running: boolean;
  tabs: BrowserTab[];
  controller: "agent" | "human" | "idle";
};

export type DesktopProfileBinding = {
  scopeKey: string;
  profileKey: string | null;
  partition: string;
  profileId?: string;
  label?: string;
  account?: string;
};

export type BrowserProfileIdentity = { id: string; label?: string; account?: string };

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
    if (name === "browser_fill_secret") {
      return errorResult("browser_fill_secret is handled by the session socket, not the browser host.");
    }
    let normalized: { name: string; args: Record<string, unknown> };
    try {
      normalized = browserOperation(name, parseBrowserToolInput(name, args));
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
      this.probe = { at: Date.now(), ok: false };
      return errorResult("The desktop browser host did not answer.");
    }
  }

  async bind(scopeKey: string, profileKey: string): Promise<DesktopProfileBinding> {
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
    return payload as DesktopProfileBinding;
  }

  async openForHuman(scopeKey: string, url = "about:blank"): Promise<DesktopBrowserState> {
    const response = await this.fetchImpl(this.url("/open"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ scopeKey, url }),
    });
    return this.parseState(response);
  }

  async release(scopeKey: string): Promise<boolean> {
    const response = await this.fetchImpl(this.url("/release"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ scopeKey }),
    });
    if (!response.ok) return false;
    const payload: unknown = await response.json().catch(() => undefined);
    return payload !== null && typeof payload === "object" && (payload as { released?: unknown }).released === true;
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
