/**
 * THE BROWSER, AS A SESSION-SCOPED MCP SOCKET — the transport that closes the
 * "Codex cannot reach in-process tools" gap (`docs/spool-port.md` stage I).
 *
 * ── HOSTED BY THE WORKER, NOT THE DAEMON ────────────────────────────────────
 * The worker process is the only one that owns a `BrowserRuntime` (the
 * out-of-process worker builds its own; the daemon's `AttachedBrowser` exposes
 * `release` and `state`, never `call`). So the socket listens here, on
 * loopback, and both drivers are pointed at it: Claude as an `http` entry in
 * `mcpServers`, Codex through `thread/start`'s `config.mcp_servers` overlay.
 * One tool surface, two providers, zero in-process special cases.
 *
 * ── PER-RUN TOKENS, NOT A PERSISTED SECRET ──────────────────────────────────
 * Unlike the spool socket (one wall, master scope, one secret on disk), this
 * socket is a different credential per CLAIMED TURN. The token is handed to a
 * provider subprocess, and the binding it unlocks carries the run's browser
 * scope, its approval gate and its observation sink — facts about a run, not a
 * session. Released when the turn settles; a released token is a 401, which is
 * the whole revocation story. Nothing rests on disk and nothing needs a reaper.
 *
 * ── NO CONNECT CARD, NO DISCOVERY ROUTE, ON PURPOSE ─────────────────────────
 * Nothing outside the worker ever needs this URL: the worker mints the lease
 * and hands `{url, token}` to the driver it is about to run. The spool socket's
 * `mcp-info` precedent is deliberately not copied here — a human-facing door
 * would be surface with no user.
 */
import crypto from "node:crypto";
import http from "node:http";
import type { BrowserProvider, BrowserTab } from "@telar/engine-client";
import { bearerIsValid } from "../http-auth";
import { handleSocketMessage, type SocketTool } from "../mcp-socket";

/** The engine's browser, narrowed to what the socket may do with it. The same
 *  shape `driver.ts` used to consume in-process — see `browserCapability` in
 *  `drivers.ts`, which is still the one assembly site. */
export type BrowserSocketCapability = {
  call(scopeKey: string, name: string, args?: Record<string, unknown>): Promise<{ content: unknown[]; isError?: boolean }>;
  isReadOnly(name: string, args?: Record<string, unknown>): boolean;
  tools: readonly { name: string; description: string; input: unknown }[];
  /** What the browser is looking at now, WITHOUT launching one. Optional
   *  because a capability assembled by a test has no browser to describe. */
  state?(scopeKey: string): Promise<{ provider: BrowserProvider; tabs: BrowserTab[] }>;
  /** Bind a scope to its project's browser profile before its tools run. */
  bindProfile?(scopeKey: string, profileKey: string): Promise<void>;
};

/** What one claimed turn binds to its token. */
export type BrowserRunBinding = {
  /** Sessions are the browser's natural boundary: two sessions must not share
   *  a tab, and a session's tabs must survive between its turns. */
  scopeKey: string;
  /**
   * The turn's approval gate. THE SOCKET IS THE ONE ENFORCEMENT POINT — both
   * drivers' native gates are suppressed for this server so one click yields
   * one card. Absent means no gate at all, which is the `full-access` shape
   * and what the tests use.
   */
  gate?(input: { name: string; args: Record<string, unknown>; readOnly: boolean }): Promise<boolean>;
  /**
   * The credential-fill handler, `browser_fill_secret`'s whole implementation
   * — see `secret-fill.ts`. Provided by the worker (it owns the `op` adapter
   * and the engine gate); the socket hands it a scope-bound `callBrowser` so
   * the fill drives the same browser this binding is leased to. ABSENT MEANS
   * THE TOOL ANSWERS "not available" rather than being hidden: a model that
   * read the tool list should get a sentence, not a vanishing tool.
   */
  fillSecret?(
    args: Record<string, unknown>,
    callBrowser: (name: string, args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }>,
  ): Promise<{ content: unknown[]; isError?: boolean }>;
  /**
   * Fired with fresh state after any successful call that CHANGED the tab set
   * — the socket re-reads after every success and reports only when the tabs
   * differ from the last report, so a read-only-only session still surfaces
   * its pages. The reads are SEQUENCED by the socket, per binding: a page that
   * redirects produces several mutating calls in quick succession, and two
   * overlapping `state()` reads would report the intermediate page after the
   * final one. Failures are swallowed — a browser panel that cannot be
   * described must not fail the tool call that moved it.
   */
  onNavigated?(state: { provider: BrowserProvider; tabs: BrowserTab[] }): void;
};

export type BrowserSocketLease = {
  url: string;
  token: string;
  release(): void;
  /** Await the binding's in-flight state reads. The worker drains BEFORE the
   *  turn settles — a report landing after `completeTurn` would be rejected as
   *  a conflict and the final page would silently go unjournalled. */
  drain(): Promise<void>;
};

const SOCKET_PATH = "/v2/browser/mcp";

type Binding = {
  binding: BrowserRunBinding;
  tools: SocketTool[];
  stateQueue: Promise<void>;
  /** The last tab set actually reported, so identical reads report nothing. */
  lastReported?: string;
};

/** The transport's own body cap, mirroring the daemon's `body()` — one guard,
 *  same number, stated where it applies. */
async function readBody(request: http.IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 1_000_000) return undefined;
    chunks.push(buffer);
  }
  if (total === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export class BrowserToolSocket {
  private server: http.Server | undefined;
  private listening: Promise<string> | undefined;
  private readonly bindings = new Map<string, Binding>();

  constructor(private readonly capability: BrowserSocketCapability) {}

  /** Test seam: the endpoint URL, once the listener exists. */
  get url(): string | undefined {
    return this.boundUrl;
  }
  private boundUrl: string | undefined;

  /**
   * Bind one run's identity to a fresh token. LAZY: the listener is created on
   * the first bind, so a deployment whose sessions never carry a browser opens
   * no port at all.
   */
  /**
   * The project profile a scope's browser runs in. Called by the worker
   * BEFORE `bind`, from the claim, so a tool invoked in the first turn — before
   * any cockpit ever opened the session — already lands in the right jar.
   */
  async bindProfile(scopeKey: string, profileKey: string): Promise<void> {
    if (this.capability.bindProfile) await this.capability.bindProfile(scopeKey, profileKey);
  }

  async bind(binding: BrowserRunBinding): Promise<BrowserSocketLease> {
    const url = await this.ensureListening();
    const token = crypto.randomBytes(32).toString("base64url");
    const bound: Binding = {
      binding,
      tools: this.toolsFor(binding),
      stateQueue: Promise.resolve(),
    };
    this.bindings.set(token, bound);
    return {
      url,
      token,
      release: () => void this.bindings.delete(token),
      drain: () => bound.stateQueue,
    };
  }

  async close(): Promise<void> {
    this.bindings.clear();
    const server = this.server;
    this.server = undefined;
    this.listening = undefined;
    this.boundUrl = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private ensureListening(): Promise<string> {
    if (this.listening) return this.listening;
    const server = http.createServer((request, response) => void this.handle(request, response));
    this.server = server;
    this.listening = new Promise<string>((resolve, reject) => {
      server.once("error", reject);
      server.once("listening", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("browser socket did not bind a TCP port"));
          return;
        }
        // Loopback is the first lock; the token is the second. Never 0.0.0.0.
        this.boundUrl = `http://127.0.0.1:${address.port}${SOCKET_PATH}`;
        resolve(this.boundUrl);
      });
      server.listen(0, "127.0.0.1");
    });
    return this.listening;
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const writeJson = (status: number, payload: unknown): void => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(payload));
    };
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== SOCKET_PATH) {
        writeJson(404, { error: { code: "not_found", message: "this socket serves one path" } });
        return;
      }
      const bound = this.resolveBearer(request.headers.authorization);
      if (!bound) {
        writeJson(401, { error: { code: "engine_unauthorized", message: "this socket takes its own per-turn bearer token" } });
        return;
      }
      if (request.method === "DELETE") {
        // Session teardown, in the spec's vocabulary. Stateless here.
        writeJson(200, {});
        return;
      }
      if (request.method !== "POST") {
        writeJson(405, { error: { code: "invalid_request", message: "MCP messages arrive as POST" } });
        return;
      }
      const message = await readBody(request);
      if (message === undefined) {
        writeJson(400, { error: { code: "invalid_request", message: "request body must be a JSON object under 1MB" } });
        return;
      }
      const answer = await handleSocketMessage(bound.tools, message, { name: "telar-browser", version: "1.0.0" });
      if (answer === undefined) {
        response.writeHead(202).end();
        return;
      }
      writeJson(200, answer);
    } catch (error) {
      writeJson(500, { error: { code: "internal_error", message: error instanceof Error ? error.message : "browser socket failed" } });
    }
  }

  /** Look the bearer up across live bindings. Each comparison is timing-safe;
   *  the scan is over a handful of concurrent turns, not a user table. */
  private resolveBearer(header: string | undefined): Binding | undefined {
    for (const [token, bound] of this.bindings) {
      if (bearerIsValid(header, token)) return bound;
    }
    return undefined;
  }

  private toolsFor(binding: BrowserRunBinding): SocketTool[] {
    return this.capability.tools.map((definition) => ({
      name: definition.name,
      description: definition.description,
      // The toolkit declares zod objects; the socket wants a raw shape.
      shape: ((definition.input as { shape?: Record<string, unknown> }).shape ?? {}) as Record<string, unknown>,
      run: async (args) => {
        if (definition.name === "browser_fill_secret") {
          /**
           * NOT GATED HERE, AND THAT IS THE POINT: the generic gate answers
           * yes/no about a tool call, while a credential fill needs a
           * `secret_access` request that also carries the human's item pick.
           * The handler opens that request itself; `autoResolution` refuses
           * to resolve the kind in EVERY mode, so there is no path from this
           * branch to a fill without a human. The values travel inside the
           * handler and never through this socket's results.
           */
          if (!binding.fillSecret) {
            return { content: [{ type: "text", text: "Credential fill is not available for this session." }], isError: true };
          }
          const result = await binding.fillSecret(args, (name, callArgs) => this.capability.call(binding.scopeKey, name, callArgs));
          if (!result.isError) this.reportState(binding.scopeKey);
          return result;
        }
        const readOnly = this.capability.isReadOnly(definition.name, args);
        if (binding.gate && !(await this.consultGate(binding, definition.name, args, readOnly))) {
          // A DECLINE IS A RESULT, NEVER A THROW. A thrown handler reads to the
          // model as a broken tool and it retries; an error result reads as
          // "you may not do that" and it adapts.
          return { content: [{ type: "text", text: "The human declined this browser action." }], isError: true };
        }
        const result = await this.capability.call(binding.scopeKey, definition.name, args);
        /**
         * EVERY successful call re-reads state, not just mutations. A session
         * whose agent only ever READS a page — snapshot, list tabs — used to
         * journal no `browser.state.changed` at all, so its pages never
         * appeared in the panel. The dedupe in `reportState` is what keeps
         * this cheap: an unchanged tab set reports nothing, so the cost of a
         * read-only call is one tab-list read, not a journal row.
         */
        if (!result.isError) this.reportState(binding.scopeKey);
        return result;
      },
    }));
  }

  /** A gate that throws is an answer — a decline — never a hang: the provider
   *  subprocess has no deadline on an unanswered tool call. */
  private async consultGate(
    bound: BrowserRunBinding,
    name: string,
    args: Record<string, unknown>,
    readOnly: boolean,
  ): Promise<boolean> {
    try {
      return await bound.gate!({ name, args, readOnly });
    } catch {
      return false;
    }
  }

  private reportState(scopeKey: string): void {
    const read = this.capability.state;
    if (!read) return;
    // Find the binding again by scope: the queue lives on the token entry, and
    // a released binding mid-flight simply drops its report.
    for (const bound of this.bindings.values()) {
      if (bound.binding.scopeKey !== scopeKey || !bound.binding.onNavigated) continue;
      bound.stateQueue = bound.stateQueue
        .then(async () => {
          const state = await read.call(this.capability, scopeKey);
          // An unchanged tab set is not news. Without this, every read-only
          // call would journal an identical `browser.state.changed` row.
          const signature = `${state.provider}:${JSON.stringify(state.tabs)}`;
          if (bound.lastReported === signature) return;
          bound.lastReported = signature;
          bound.binding.onNavigated?.(state);
        })
        .catch(() => undefined);
    }
  }
}
