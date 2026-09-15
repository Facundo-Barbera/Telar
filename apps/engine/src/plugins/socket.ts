/**
 * EVERY ENABLED PLUGIN'S TOOL WALL, AS ONE SESSION-SCOPED MCP SOCKET — the
 * transport that makes the plugin host provider-neutral instead of a Claude
 * feature wearing a plugin-shaped comment.
 *
 * ── WHY A SOCKET AND NOT AN IN-PROCESS REGISTRATION ─────────────────────────
 * Codex takes MCP servers as CONFIG: a url and a header, put into
 * `thread/start`'s `config.mcp_servers` overlay. There is no way to hand it an
 * in-process server, which is why `codex-driver.ts` today carries only
 * `telar-browser` and `telar-sessions` and no in-process `telar` server reaches
 * a Codex turn at all. A plugin registered in-process would therefore exist on
 * Claude and silently not exist on Codex — the same tool, the same project
 * setting, two different worlds. This socket is the sanctioned answer, and it
 * is the SAME one `../browser/socket.ts` and `../sessions-tools/run-socket.ts`
 * already give their walls.
 *
 * ── ONE KEY, BOTH PROVIDERS, ONE NAME ───────────────────────────────────────
 * Claude consumes this as an http entry exactly as Codex does — that is what
 * `telar-browser` does too, and it is what keeps `hello_ping` from being
 * `mcp__telar__hello_ping` under one provider and `mcp__telar-plugins__hello_ping`
 * under the other. One qualified name means one remembered approval and one
 * groupable journal row.
 *
 * ── ONE SOCKET FOR ALL PLUGINS, NOT ONE PER PLUGIN ──────────────────────────
 * A port per enabled plugin would be a port per project setting. The BINDING is
 * per session and carries every plugin that session's project turned on; a
 * plugin the project did not enable contributes no tools, so absence at the
 * gate is absence in `tools/list` by construction rather than by a check.
 *
 * ── NO GATE HERE, DELIBERATELY ──────────────────────────────────────────────
 * Nothing in this file decides approvals. On Claude the call answers to the
 * engine's ordinary mode ladder through `canUseTool`; on Codex the same call
 * arrives as an MCP elicitation the driver routes to the SAME engine gate. The
 * host still owns classification (`policy.ts`) — a gate here would put two
 * cards in front of one click, and a gate here that DISAGREED with the host
 * would be a plugin granting itself authority.
 *
 * ── PER-SESSION TOKENS, NEVER PERSISTED ─────────────────────────────────────
 * Minted per bound session, handed only to that session's provider subprocess,
 * dropped on release. There is no on-disk secret for this door: unlike the
 * sessions wall's and the notebook's outward sockets, nothing outside a running
 * turn has any business holding a plugin's tools.
 */
import crypto from "node:crypto";
import http from "node:http";
import { TELAR_PLUGINS_MCP_SERVER } from "@telar/engine-client";
import { bearerIsValid } from "../http-auth";
import { collectTools, handleSocketMessage, readSocketBody, type SocketTool } from "../mcp-socket";
import type { PluginToolModule } from "./tool-module";

export type PluginSocketLease = {
  url: string;
  token: string;
  /**
   * A NON-SECRET NAME FOR THIS LEASE, and the reason it exists is a bug that
   * shipped in the first draft of this file.
   *
   * All bindings share ONE url — one listener, many tokens — so a driver
   * fingerprint keyed on the url cannot tell lease A from lease B. Rebinding
   * when a project's enabled set changed therefore revoked the old token while
   * the provider kept the query it was started with, and every subsequent
   * plugin call 401'd with nothing in the fingerprint to explain why.
   *
   * The generation is what makes a rebind VISIBLE to that fingerprint. It is
   * deliberately not the token: a fingerprint is compared, logged and reasoned
   * about, and a credential has no business in one.
   */
  generation: string;
  release(): void;
};

const SOCKET_PATH = "/v2/plugins/mcp";

/** How this socket introduces itself in `initialize` — the same key both
 *  drivers register it under, so the two cannot disagree. */
const PLUGINS_SERVER = { name: TELAR_PLUGINS_MCP_SERVER, version: "1.0.0" };

/**
 * THE WALLS, COLLECTED. One module contributes its own `tools()` against its own
 * capability — the same seam the in-process registration and the bare-harness
 * tests drive, so what a socket advertises and what a plugin wrote cannot drift.
 *
 * A module whose capability is missing from the map is SKIPPED rather than bound
 * to `undefined`: the project did not enable it, and a tool that answered for a
 * runtime it cannot see would report that answer as the truth.
 */
export function collectPluginWallTools(modules: readonly PluginToolModule[], capabilities: Record<string, unknown>): SocketTool[] {
  const collected: SocketTool[] = [];
  for (const module of modules) {
    const capability = capabilities[module.meta.id];
    if (!capability) continue;
    collected.push(...collectTools((tool, cap) => module.tools(tool, cap) as unknown[], capability));
  }
  return collected;
}

export class PluginToolSocket {
  private server: http.Server | undefined;
  private listening: Promise<string> | undefined;
  private boundUrl: string | undefined;
  private readonly bindings = new Map<string, SocketTool[]>();
  /** Counts leases, so each one has a name the fingerprint can hold. */
  private generations = 0;
  /**
   * Set by `close`. THE RACE THIS EXISTS FOR: `bind` awaits the listener, and a
   * worker stopping during that await would clear its lease map and then be
   * handed a lease it no longer tracks — a live binding nobody can release.
   * Checked again after the await so the binding is never recorded at all.
   */
  private closed = false;

  /** Test seam: the endpoint URL, once the listener exists. */
  get url(): string | undefined {
    return this.boundUrl;
  }

  /**
   * Bind one session's enabled plugins to a fresh token. LAZY: the listener is
   * created on the first bind, so a deployment whose projects enable no plugins
   * opens no port at all.
   *
   * Binding with NO tools is refused rather than served empty — an MCP server
   * advertising nothing is a server the provider spends a round trip on for no
   * reason, and the caller has a cheaper answer available (do not pass a socket).
   */
  async bind(modules: readonly PluginToolModule[], capabilities: Record<string, unknown>): Promise<PluginSocketLease | undefined> {
    const tools = collectPluginWallTools(modules, capabilities);
    if (tools.length === 0) return undefined;
    if (this.closed) return undefined;
    const url = await this.ensureListening();
    // Re-checked AFTER the await: see `closed`. Returning undefined rather than
    // throwing keeps a shutting-down worker's last turn on the same path as a
    // session that enabled no plugins.
    if (this.closed) return undefined;
    const token = crypto.randomBytes(32).toString("base64url");
    this.bindings.set(token, tools);
    this.generations += 1;
    const generation = `g${this.generations}`;
    return {
      url,
      token,
      generation,
      release: () => void this.bindings.delete(token),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
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
          reject(new Error("plugin socket did not bind a TCP port"));
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
      const tools = this.resolveBearer(request.headers.authorization);
      if (!tools) {
        writeJson(401, { error: { code: "engine_unauthorized", message: "this socket takes its own per-session bearer token" } });
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
      const message = await readSocketBody(request);
      if (message === undefined) {
        writeJson(400, { error: { code: "invalid_request", message: "request body must be a JSON object under 1MB" } });
        return;
      }
      const answer = await handleSocketMessage(tools, message, PLUGINS_SERVER);
      if (answer === undefined) {
        response.writeHead(202).end();
        return;
      }
      writeJson(200, answer);
    } catch (error) {
      writeJson(500, { error: { code: "internal_error", message: error instanceof Error ? error.message : "plugin socket failed" } });
    }
  }

  /** Look the bearer up across live bindings. Each comparison is timing-safe;
   *  the scan is over a handful of live sessions, not a user table. */
  private resolveBearer(header: string | undefined): SocketTool[] | undefined {
    for (const [token, tools] of this.bindings) {
      if (bearerIsValid(header, token)) return tools;
    }
    return undefined;
  }
}
