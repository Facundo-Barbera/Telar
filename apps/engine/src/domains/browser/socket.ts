import crypto from "node:crypto";
import http from "node:http";
import type { BrowserProvider, BrowserTab } from "@telar/engine-client";
import { bearerIsValid } from "../../platform/http/auth";
import { handleSocketMessage, readSocketBody, type SocketTool } from "../agent-tools";
import { boundBrowserResult } from "./bounds";
import { browserOperation, fileUrlViolation } from "./helpers";

export type BrowserSocketCapability = {
  call(scopeKey: string, name: string, args?: Record<string, unknown>): Promise<{ content: unknown[]; isError?: boolean }>;
  isReadOnly(name: string, args?: Record<string, unknown>): boolean;
  tools: readonly { name: string; description: string; input: unknown }[];
  state?(scopeKey: string): Promise<{ provider: BrowserProvider; tabs: BrowserTab[] }>;
  bindProfile?(scopeKey: string, profileKey: string): Promise<void>;
  profileIdentity?(scopeKey: string): Promise<{ id: string; label?: string; account?: string } | null>;
  passwordManagerEnabled?(): Promise<boolean>;
};

export type BrowserRunBinding = {
  scopeKey: string;
  workspaceRoot?: string;
  gate?(input: { name: string; args: Record<string, unknown>; readOnly: boolean }): Promise<boolean>;
  fillSecret?(
    args: Record<string, unknown>,
    callBrowser: (name: string, args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }>,
    profile?: () => Promise<{ id: string; label?: string; account?: string } | null>,
  ): Promise<{ content: unknown[]; isError?: boolean }>;
  onNavigated?(state: { provider: BrowserProvider; tabs: BrowserTab[] }): void | Promise<void>;
};

export type BrowserSocketLease = {
  url: string;
  token: string;
  release(): void;
  drain(): Promise<void>;
};

const SOCKET_PATH = "/v2/browser/mcp";
const PASSWORD_MANAGER_OFF = "The password manager is turned off in Settings → Browser, so browser_fill_secret cannot fill credentials. Ask the person to turn it on there.";

type Binding = {
  binding: BrowserRunBinding;
  tools: SocketTool[];
  stateQueue: Promise<void>;
  lastReported?: string;
};

export class BrowserToolSocket {
  private server: http.Server | undefined;
  private listening: Promise<string> | undefined;
  private readonly bindings = new Map<string, Binding>();

  constructor(private readonly capability: BrowserSocketCapability) {}

  get url(): string | undefined {
    return this.boundUrl;
  }
  private boundUrl: string | undefined;

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
        this.boundUrl = `http://127.0.0.1:${address.port}${SOCKET_PATH}`;
        resolve(this.boundUrl);
      });
      server.listen(0, "127.0.0.1");
    });
    return this.listening;
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const writeJson = (status: number, payload: unknown): void => {
      const text = JSON.stringify(payload);
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(text);
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
      const answer = await handleSocketMessage(bound.tools, message, { name: "telar-browser", version: "1.0.0" });
      if (answer === undefined) {
        response.writeHead(202).end();
        return;
      }
      writeJson(200, answer);
    } catch (error) {
      if (response.headersSent) return void response.destroy();
      writeJson(500, { error: { code: "internal_error", message: error instanceof Error ? error.message : "browser socket failed" } });
    }
  }

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
      shape: ((definition.input as { shape?: Record<string, unknown> }).shape ?? {}) as Record<string, unknown>,
      run: async (args) => {
        if (definition.name === "browser_fill_secret") {
          if (!binding.fillSecret) {
            return { content: [{ type: "text", text: "Credential fill is not available for this session." }], isError: true };
          }
          if (this.capability.passwordManagerEnabled && !(await this.capability.passwordManagerEnabled())) {
            return { content: [{ type: "text", text: PASSWORD_MANAGER_OFF }], isError: true };
          }
          const identity = this.capability.profileIdentity;
          const result = await binding.fillSecret(
            args,
            (name, callArgs) => this.capability.call(binding.scopeKey, name, callArgs),
            identity ? () => identity.call(this.capability, binding.scopeKey) : undefined,
          );
          if (!result.isError) await this.reportState(binding.scopeKey);
          return result;
        }
        const fenced = fileUrlViolation(definition.name, args, binding.workspaceRoot);
        if (fenced) return { content: [{ type: "text", text: fenced }], isError: true };
        const readOnly = this.capability.isReadOnly(definition.name, args);
        if (binding.gate && !(await this.consultGate(binding, definition.name, args, readOnly))) {
          return { content: [{ type: "text", text: "The human declined this browser action." }], isError: true };
        }
        const result = boundBrowserResult(
          browserOperation(definition.name, args).name,
          await this.capability.call(binding.scopeKey, definition.name, args),
        );
        if (!result.isError) await this.reportState(binding.scopeKey);
        return result;
      },
    }));
  }

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

  private async reportState(scopeKey: string): Promise<void> {
    const read = this.capability.state;
    if (!read) return;
    const reports: Promise<void>[] = [];
    for (const bound of this.bindings.values()) {
      if (bound.binding.scopeKey !== scopeKey || !bound.binding.onNavigated) continue;
      bound.stateQueue = bound.stateQueue
        .then(async () => {
          const state = await read.call(this.capability, scopeKey);
          const signature = `${state.provider}:${JSON.stringify(state.tabs)}`;
          if (bound.lastReported === signature) return;
          await bound.binding.onNavigated?.(state);
          bound.lastReported = signature;
        })
        .catch(() => undefined);
      reports.push(bound.stateQueue);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(reports),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 1_000); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
