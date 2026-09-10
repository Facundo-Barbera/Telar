/**
 * THE `telar` WALL, AS ONE WORKER-HOSTED MCP SOCKET — the single registration
 * both providers consume, and the thing that makes a Telar tool a Telar tool on
 * Codex as well as on Claude.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Until now the `telar` key was an IN-PROCESS server built by the Claude
 * driver. Codex takes MCP servers as CONFIG — a url and a header — and cannot be
 * handed an in-process server at all, so `codex-driver.ts` carried only the
 * `telar-browser` and `telar-sessions` sockets and NO core tool reached a Codex
 * turn: no spool, no sessions, no display, no warp, no LaTeX, no data science.
 * That was not a plugin problem; it was the transport.
 *
 * ── ONE KEY, SAME NAMES ─────────────────────────────────────────────────────
 * This socket registers under `telar` — the key those tools already ship under.
 * `mcp__telar__latex_compile`, `mcp__telar__ds_execute`, `mcp__telar__spool_list_items`
 * are unchanged, so not one stored approval moves. There is exactly one `telar`
 * registration per turn: the in-process server is gone rather than duplicated,
 * because two servers under one key is a shadowing bug, not a fallback.
 *
 * ── THE WALL IS COLLECTED, NOT RE-DECLARED ──────────────────────────────────
 * Every core toolkit already takes its `tool` factory as an argument —
 * `spoolTools(tool, capability)`, `latexTools(tool, capability)`, and so on.
 * That is `collectTools`' shape exactly, so this file names WHICH walls to
 * build and never what a tool does. A tool that exists in the driver and not
 * here would be a tool this file forgot; there is no second declaration for one
 * to drift from.
 *
 * ── BOUND ONCE PER SESSION RUNTIME, READ LIVE ───────────────────────────────
 * The handlers close over CAPABILITY GETTERS, not capabilities. A query outlives
 * its turn, so the wall must read whatever the current turn bound — the same
 * `delegatingCapability` discipline the in-process registration used. Because
 * the binding is stable for the session runtime, the token is stable too, which
 * is what keeps a provider's baked-in Authorization header valid across turns.
 * (See `plugins/socket.ts` for what happens when a token rotates under a reused
 * query: it 401s, silently, until a fingerprint notices.)
 *
 * ── NO GATE HERE ────────────────────────────────────────────────────────────
 * Nothing in this file decides approvals. Claude's `canUseTool` sees these calls
 * — it already sees `telar-browser`'s, which is why that server has an explicit
 * arm there — and Codex's elicitations reach the same engine gate. A gate here
 * would be a second, disagreeing authority.
 */
import crypto from "node:crypto";
import http from "node:http";
import { TELAR_MCP_SERVER } from "@telar/engine-client";
import { bearerIsValid } from "./http-auth";
import { collectTools, handleSocketMessage, readSocketBody, type SocketTool } from "./mcp-socket";
import type { ToolFactory } from "./tool-kit";

export type TelarSocketLease = {
  url: string;
  token: string;
  /** Non-secret name for this lease, for a driver fingerprint. See `plugins/socket.ts`. */
  generation: string;
  release(): void;
};

const SOCKET_PATH = "/v2/telar/mcp";

/** How this socket introduces itself in `initialize` — the key both drivers use. */
const TELAR_SERVER = { name: TELAR_MCP_SERVER, version: "2.0.0" };

/**
 * ONE WALL TO BUILD. A toolkit's own builder paired with a GETTER for its
 * capability; a getter returning undefined means the turn does not carry that
 * capability and the wall is skipped entirely — absent, never present and
 * answering for a runtime it cannot see.
 */
export type TelarWallPart = {
  /** Stable label for this wall, used only for fingerprint identity. */
  name: string;
  build: (tool: ToolFactory, capability: never) => unknown[];
  capability: () => unknown;
};

/**
 * Collect a set of walls into one tool list, against a SNAPSHOT of each
 * capability taken now.
 *
 * ── WHY A SNAPSHOT AND NOT A LIVE PROXY ─────────────────────────────────────
 * The first draft handed each builder a proxy that re-read the getter on every
 * property access. That is wrong in a way that only shows up under load: a tool
 * whose handler touches the capability twice — `await cap.start(); await
 * cap.read()` — could bind the first call to this turn's object and the second
 * to the NEXT turn's, halfway through one logical operation. An in-flight call
 * must finish against the capability it started with.
 *
 * Freshness is not lost, because the CALLER re-collects: `TelarToolSocket.bind`
 * takes a thunk that is invoked per request, so each request snapshots again.
 * Freshness between requests, stability within one.
 *
 * A getter returning undefined means the turn does not carry that capability,
 * and its wall is skipped entirely — absent, never present and answering for a
 * runtime it cannot see.
 */
export function collectTelarWall(parts: readonly TelarWallPart[]): SocketTool[] {
  const collected: SocketTool[] = [];
  for (const part of parts) {
    const capability = part.capability();
    if (capability === undefined) continue;
    collected.push(
      ...collectTools(
        (tool, current) => (part.build as unknown as (t: ToolFactory, c: unknown) => unknown[])(tool as ToolFactory, current),
        capability,
      ),
    );
  }
  return collected;
}

/**
 * THE IDENTITY OF A WALL, for a driver fingerprint — the sorted names of the
 * parts a turn actually carries.
 *
 * A STABLE TOKEN IS NOT CATALOG COHERENCE, and conflating the two is the bug
 * this exists to prevent. Re-collecting per request fixes DISPATCH: a tool that
 * was turned off stops working immediately, server-side, whatever the provider
 * believes. It does NOT refresh a provider's CACHED tool catalog — a reused
 * query keeps advertising the list it was started with, so a model would still
 * see a tool it can no longer call, and would not see one that was just added.
 *
 * So the capability SET still has to move the fingerprint and cold-start the
 * provider. Token lifecycle and tool-set identity are different things with
 * different jobs: the token keeps a reused query authenticated, this keeps its
 * catalog honest.
 */
export function telarWallIdentity(parts: readonly TelarWallPart[]): string[] {
  return parts
    .filter((part) => part.capability() !== undefined)
    .map((part) => part.name)
    .sort();
}

export class TelarToolSocket {
  private server: http.Server | undefined;
  private listening: Promise<string> | undefined;
  private boundUrl: string | undefined;
  private readonly bindings = new Map<string, () => SocketTool[]>();
  private generations = 0;
  /** Set by `close`; checked on both sides of the listener await. See `plugins/socket.ts`. */
  private closed = false;

  get url(): string | undefined {
    return this.boundUrl;
  }

  /**
   * Bind one session runtime's wall. `tools` is a THUNK so a turn that changes
   * which capabilities it carries re-collects without rotating the token — the
   * provider's baked-in header stays valid while the advertised list follows the
   * turn.
   */
  async bind(tools: () => SocketTool[]): Promise<TelarSocketLease | undefined> {
    if (this.closed) return undefined;
    const url = await this.ensureListening();
    if (this.closed) return undefined;
    const token = crypto.randomBytes(32).toString("base64url");
    this.bindings.set(token, tools);
    this.generations += 1;
    const generation = `g${this.generations}`;
    return { url, token, generation, release: () => void this.bindings.delete(token) };
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
          reject(new Error("telar socket did not bind a TCP port"));
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
      // The thunk is read PER REQUEST, so the advertised list and the dispatch
      // target both follow whatever the current turn carries.
      const answer = await handleSocketMessage(tools(), message, TELAR_SERVER);
      if (answer === undefined) {
        response.writeHead(202).end();
        return;
      }
      writeJson(200, answer);
    } catch (error) {
      writeJson(500, { error: { code: "internal_error", message: error instanceof Error ? error.message : "telar socket failed" } });
    }
  }

  private resolveBearer(header: string | undefined): (() => SocketTool[]) | undefined {
    for (const [token, tools] of this.bindings) {
      if (bearerIsValid(header, token)) return tools;
    }
    return undefined;
  }
}
