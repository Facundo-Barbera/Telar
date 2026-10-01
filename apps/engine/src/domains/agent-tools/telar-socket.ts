import crypto from "node:crypto";
import http from "node:http";
import { TELAR_MCP_SERVER } from "@telar/engine-client";
import { bearerIsValid } from "../../platform/http/auth";
import { collectTools, handleSocketMessage, readSocketBody, type SocketTool } from "./mcp-socket";
import { z } from "zod";
import { checkArgs } from "./strict-args";
import { err, type ToolFactory } from "./tool-kit";
import { displayTools } from "./display-tools";
import { notesTools } from "../notes";
import { pluginToolModules } from "../plugins";
import { promptsTools } from "../prompts";
import { runTools } from "../terminal";
import { sessionsTools } from "../sessions";

export type TelarSocketLease = {
  url: string;
  token: string;
  generation: string;
  release(): void;
};

const SOCKET_PATH = "/v2/telar/mcp";

const TELAR_SERVER = { name: TELAR_MCP_SERVER, version: "2.0.0" };

export type TelarWallPart = {
  name: string;
  build: (tool: ToolFactory, capability: never) => unknown[];
  capability: () => unknown;
};

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

export type TelarCapabilities = {
  sessions?: unknown;
  notes?: unknown;
  prompts?: unknown;
  display?: unknown;
  run?: unknown;
  plugins?: Record<string, unknown>;
};

export function telarWall(caps: () => TelarCapabilities | undefined): TelarWallPart[] {
  return [
    { name: "sessions", build: sessionsTools as never, capability: () => caps()?.sessions },
    { name: "notes", build: notesTools as never, capability: () => caps()?.notes },
    { name: "prompts", build: promptsTools as never, capability: () => caps()?.prompts },
    { name: "display", build: displayTools as never, capability: () => caps()?.display },
    { name: "run", build: runTools as never, capability: () => caps()?.run },
    ...pluginToolModules().map((module) => ({
      name: `plugin:${module.meta.id}`,
      build: (tool: ToolFactory, capability: never) => module.tools(tool, capability),
      capability: () => caps()?.plugins?.[module.meta.id],
    })),
  ];
}

function delegatingCapability<T extends object>(get: () => T | undefined): T {
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

/** The SDK strips undeclared keys before a handler sees them, so it is handed a loose object and the handler refuses them. */
export function toSdkTools(parts: readonly TelarWallPart[], tool: ToolFactory): unknown[] {
  const strict: ToolFactory = (name, description, shape, handler) =>
    tool(name, description, z.looseObject(shape as Record<string, z.ZodType>) as never, async (args, context) => {
      const checked = checkArgs(name, shape, args);
      return checked.ok ? handler(checked.args, context) : err(checked.message);
    });
  return parts
    .filter((part) => part.capability() !== undefined)
    .flatMap((part) => part.build(strict, delegatingCapability(part.capability as () => object | undefined) as never));
}

export class TelarToolSocket {
  private server: http.Server | undefined;
  private listening: Promise<string> | undefined;
  private boundUrl: string | undefined;
  private readonly bindings = new Map<string, () => SocketTool[]>();
  private generations = 0;
  private closed = false;

  get url(): string | undefined {
    return this.boundUrl;
  }

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
