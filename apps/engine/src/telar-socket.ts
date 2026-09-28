/**
 * THE `telar` WALL, AS ONE WORKER-HOSTED MCP SOCKET — the single registration
 * all three providers consume.
 *
 * Codex and OpenCode take MCP servers as CONFIG and cannot be handed an
 * in-process server, so before this no core tool reached them at all. The
 * socket registers under `telar`, the key those tools already ship under, so
 * not one stored approval moves and there is exactly one registration per turn.
 *
 * BOUND ONCE PER SESSION RUNTIME, COLLECTED PER REQUEST. The handlers close
 * over capability GETTERS, so a query that outlives its turn still dispatches
 * to the current one; the token stays stable so a reused query keeps working.
 * Nothing here decides approvals — that is the engine's ladder on every wire.
 */
import crypto from "node:crypto";
import http from "node:http";
import { TELAR_MCP_SERVER } from "@telar/engine-client";
import { bearerIsValid } from "./platform/http/auth";
import { collectTools, handleSocketMessage, readSocketBody, type SocketTool } from "./mcp-socket";
import type { ToolFactory } from "./tool-kit";
import { displayTools } from "./display/tools";
import { notesTools } from "./domains/notes";
import { pluginToolModules } from "./plugins/bundled";
import { promptsTools } from "./domains/prompts";
import { runTools } from "./run/tools";
import { sessionsTools } from "./sessions-tools/tools";

export type TelarSocketLease = {
  url: string;
  token: string;
  /** Non-secret name for this lease: every binding shares one url, so this is what tells two apart. */
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

/** What one turn carries onto the `telar` wall. An absent field is no tools. */
export type TelarCapabilities = {
  sessions?: unknown;
  notes?: unknown;
  prompts?: unknown;
  display?: unknown;
  run?: unknown;
  /** Every enabled plugin's capability, by id. */
  plugins?: Record<string, unknown>;
};

/**
 * THE ONE PARTS LIST for the `telar` wall, whichever transport serves it. It
 * used to be written out three times — the socket in the driver, its
 * in-process twin, and the worker's lease — and the copies drifted: Claude
 * lost `prompts_*` and Codex/OpenCode lost `display_*`. A toolkit added here
 * is on every provider by construction.
 */
export function telarWall(caps: () => TelarCapabilities | undefined): TelarWallPart[] {
  return [
    { name: "sessions", build: sessionsTools as never, capability: () => caps()?.sessions },
    { name: "notes", build: notesTools as never, capability: () => caps()?.notes },
    { name: "prompts", build: promptsTools as never, capability: () => caps()?.prompts },
    { name: "display", build: displayTools as never, capability: () => caps()?.display },
    { name: "run", build: runTools as never, capability: () => caps()?.run },
    // Every plugin on the same key: a plugin tool must have one qualified name.
    ...pluginToolModules().map((module) => ({
      name: `plugin:${module.meta.id}`,
      build: (tool: ToolFactory, capability: never) => module.tools(tool, capability),
      capability: () => caps()?.plugins?.[module.meta.id],
    })),
  ];
}

/**
 * A capability that reads through to THE CURRENT TURN'S instance on every
 * property access. The in-process tools are registered once per session
 * runtime, but each turn arrives with its own capability object — one
 * captured at creation would call back into a turn that has already settled.
 */
export function delegatingCapability<T extends object>(get: () => T | undefined): T {
  return new Proxy({} as T, {
    get(_, prop) {
      const current = get();
      if (!current) throw new Error("this capability is not bound to a running turn");
      return Reflect.get(current, prop);
    },
    has(_, prop) {
      const current = get();
      return current ? Reflect.has(current, prop) : false;
    },
  });
}

/**
 * The same wall for Claude's in-process SDK server. Which parts exist is fixed
 * now (the driver's fingerprint cold-starts on a changed set); each handler
 * then dispatches to whatever the current turn carries.
 */
export function toSdkTools(parts: readonly TelarWallPart[], tool: ToolFactory): unknown[] {
  return parts
    .filter((part) => part.capability() !== undefined)
    .flatMap((part) => part.build(tool, delegatingCapability(part.capability as () => object | undefined) as never));
}

export class TelarToolSocket {
  private server: http.Server | undefined;
  private listening: Promise<string> | undefined;
  private boundUrl: string | undefined;
  private readonly bindings = new Map<string, () => SocketTool[]>();
  private generations = 0;
  /** Set by `close`; checked on both sides of the listener await, so a bind racing a close mints nothing. */
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
