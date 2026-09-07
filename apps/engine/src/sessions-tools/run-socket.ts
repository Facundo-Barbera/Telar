/**
 * THE SESSIONS WALL, AS A SESSION-SCOPED MCP SOCKET — the transport that closes
 * the "Codex cannot reach in-process tools" gap for the `sessions_*` toolkit,
 * the same way `../browser/socket.ts` closed it for the browser.
 *
 * ── HOSTED BY THE WORKER, POINTED AT BY CODEX ONLY ──────────────────────────
 * Claude keeps its in-process registration under `telar` (`driver.ts`): those
 * names shipped, and renaming a shipped tool splits its identity. Codex takes
 * MCP servers as CONFIG (a url), so the worker binds each Codex session's own
 * capability here and hands the driver `{url, token}` to put in
 * `thread/start`'s `config.mcp_servers` overlay under `telar-sessions`.
 *
 * ── THE WALL RIDES ALONG WHOLE, PER BINDING ─────────────────────────────────
 * Each binding's tool list is `sessionsTools` itself, collected through the
 * same factory seam the daemon's outward socket and the tests drive — not a
 * second registry. Every absence the wall has (no accept, no merge, no
 * archive, no delete) is an absence here by construction, and `self` rides
 * the capability so a Codex session can subscribe and be woken like a Claude
 * one.
 *
 * ── NO GATE AT THE SOCKET, DELIBERATELY ─────────────────────────────────────
 * Unlike the browser socket, nothing here decides approvals. On the Claude
 * side the sessions tools answer to the engine's ordinary mode ladder through
 * `canUseTool`; on Codex the same call arrives as an MCP elicitation and the
 * driver routes it to the SAME engine gate (`codexApprovalRequest`). A gate
 * here would put two cards in front of one click.
 *
 * ── PER-SESSION TOKENS, NOT A PERSISTED SECRET ──────────────────────────────
 * Deliberately SEPARATE from the daemon's outward `/v2/sessions/mcp` socket
 * and its on-disk secret: that door is master-scope, addressed to the user's
 * own chat clients, and has no `self`. This one's token is minted per bound
 * session, handed only to that session's provider subprocess, and revoked at
 * worker stop — a leaked credential for one door must not open the other.
 */
import crypto from "node:crypto";
import http from "node:http";
import { bearerIsValid } from "../http-auth";
import { handleSocketMessage, readSocketBody, type SocketTool } from "../mcp-socket";
import { collectSessionsWallTools } from "./socket";
import type { SessionsCapability } from "./tools";

export type SessionsSocketLease = {
  url: string;
  token: string;
  release(): void;
};

const SOCKET_PATH = "/v2/sessions/mcp";

/** How this socket introduces itself in `initialize` — the server key Codex
 *  registers it under, so the two cannot disagree. */
const SESSIONS_RUN_SERVER = { name: "telar-sessions", version: "1.0.0" };

export class SessionsToolSocket {
  private server: http.Server | undefined;
  private listening: Promise<string> | undefined;
  private boundUrl: string | undefined;
  private readonly bindings = new Map<string, SocketTool[]>();

  /** Test seam: the endpoint URL, once the listener exists. */
  get url(): string | undefined {
    return this.boundUrl;
  }

  /**
   * Bind one session's capability to a fresh token. LAZY: the listener is
   * created on the first bind, so a deployment whose sessions never run Codex
   * opens no port at all. The capability closes over the session's own id and
   * the worker's client, both stable for the session's life — which is what
   * makes a per-SESSION lease sound where the browser's needed per-turn refs.
   */
  async bind(capability: SessionsCapability): Promise<SessionsSocketLease> {
    const url = await this.ensureListening();
    const token = crypto.randomBytes(32).toString("base64url");
    this.bindings.set(token, collectSessionsWallTools(capability));
    return {
      url,
      token,
      release: () => void this.bindings.delete(token),
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
          reject(new Error("sessions socket did not bind a TCP port"));
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
      const answer = await handleSocketMessage(tools, message, SESSIONS_RUN_SERVER);
      if (answer === undefined) {
        response.writeHead(202).end();
        return;
      }
      writeJson(200, answer);
    } catch (error) {
      writeJson(500, { error: { code: "internal_error", message: error instanceof Error ? error.message : "sessions socket failed" } });
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
