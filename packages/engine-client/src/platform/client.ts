import type { TurnAttachment } from "../protocol/common";
import type { EngineDiscovery, EngineErrorBody, EngineHealth, EventPage } from "../protocol/events";
import { queryOf, sessionPath } from "../sessions/client";
import type { LiveSessionsAnswer } from "../sessions/schema";
import { runBase } from "../terminal/client";
import { domainClients, type EngineDomainMethods } from "./domains";
import { EngineClientError, sanitizeTransportCause } from "./errors";
import type { EngineTransport } from "./transport";

export type FetchLike = typeof fetch;

type Conditional<T> = { unchanged: true; etag?: string } | { unchanged: false; payload: T; etag?: string };
type Stream = { url: string; headers: Record<string, string> };

export interface EngineClient extends EngineDomainMethods {}

export class EngineClient implements EngineTransport {
  constructor(
    readonly discovery: EngineDiscovery,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async request<T>(method: string, pathname: string, body?: unknown, signal?: AbortSignal, operation?: string): Promise<T> {
    const json = body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
    return this.parse<T>(await this.send(pathname, { method, ...json, ...(signal ? { signal } : {}) }, operation), operation);
  }

  async readBytes(pathAndQuery: string): Promise<{ data: Uint8Array; contentType: string }> {
    const response = await this.send(pathAndQuery, { method: "GET" });
    if (!response.ok) {
      const error = ((await response.json().catch(() => null)) as EngineErrorBody | null)?.error;
      throw new EngineClientError(error?.code ?? "engine_unavailable", error?.message ?? "engine request failed", response.status);
    }
    return { data: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get("content-type") ?? "application/octet-stream" };
  }

  health(): Promise<EngineHealth> {
    return this.request("GET", "/v2/health");
  }

  sessionsStream(): Stream {
    return this.stream("/v2/sessions/stream");
  }

  runStream(sessionId: string): Stream {
    return this.stream(`${runBase(sessionId)}/stream`);
  }

  ds<T>(sessionId: string, method: string, body?: unknown): Promise<T> {
    return this.request("POST", `${sessionPath(sessionId)}/ds/${method}`, body ?? {});
  }

  latex<T>(sessionId: string, method: string, body?: unknown): Promise<T> {
    return this.request("POST", `${sessionPath(sessionId)}/latex/${method}`, body ?? {});
  }

  plugin<T>(sessionId: string, pluginId: string, method: string, body?: unknown): Promise<T> {
    return this.request("POST", `${sessionPath(sessionId)}/plugins/${pluginId}/${method}`, body ?? {});
  }

  async liveSessionsMatching(
    options: { etag?: string; all?: boolean } = {},
  ): Promise<{ notModified: true; etag: string } | (LiveSessionsAnswer & { notModified?: false; etag?: string })> {
    const read = await this.conditional<LiveSessionsAnswer>(options.all ? "/v2/sessions/live?all=1" : "/v2/sessions/live", options.etag, "liveSessionsMatching");
    if (read.unchanged) return { notModified: true, etag: read.etag ?? options.etag ?? "" };
    return { ...read.payload, ...(read.etag === undefined ? {} : { etag: read.etag }) };
  }

  eventsIfChanged(sessionId: string, after = 0, limit?: number, etag?: string): Promise<Conditional<EventPage>> {
    return this.conditional<EventPage>(`${sessionPath(sessionId)}/events${queryOf({ after, limit })}`, etag);
  }

  async uploadAttachment(sessionId: string, file: { name: string; mediaType: string; data: ArrayBuffer | Uint8Array }): Promise<{ attachment: TurnAttachment }> {
    const response = await this.send(`${sessionPath(sessionId)}/attachments`, {
      method: "POST",
      headers: {
        "content-type": file.mediaType || "application/octet-stream",
        // Encoded: a filename may hold a newline, which would end the header block.
        "x-telar-attachment-name": encodeURIComponent(file.name),
      },
      // A fresh copy: `BodyInit` refuses a view whose buffer may be shared.
      body: new Uint8Array(file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data)) as unknown as BodyInit,
    });
    return this.parse(response);
  }

  private stream(pathname: string): Stream {
    return { url: `http://${this.discovery.host}:${this.discovery.port}${pathname}`, headers: { authorization: `Bearer ${this.discovery.token}` } };
  }

  private async send(pathname: string, init: RequestInit & { headers?: Record<string, string> }, operation?: string): Promise<Response> {
    const { url, headers } = this.stream(pathname);
    try {
      return await this.fetchImpl(url, { ...init, headers: { ...headers, ...init.headers } });
    } catch (cause) {
      // An abort is the caller hanging up, not the engine being away.
      if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
      const transport = sanitizeTransportCause(cause);
      throw new EngineClientError("engine_unavailable", "engine is unreachable", undefined, { ...(operation === undefined ? {} : { operation }), ...(transport ? { transport } : {}) });
    }
  }

  private async parse<T>(response: Response, operation?: string): Promise<T> {
    const named = operation === undefined ? {} : { operation };
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new EngineClientError("engine_unavailable", "engine returned an invalid response", response.status, { ...named, transport: "malformed_response" });
    }
    if (!response.ok) {
      const error = (payload as EngineErrorBody | null)?.error;
      throw new EngineClientError(error?.code ?? "engine_unavailable", error?.message ?? "engine request failed", response.status, named);
    }
    return payload as T;
  }

  private async conditional<T>(pathname: string, etag: string | undefined, operation?: string): Promise<Conditional<T>> {
    const response = await this.send(pathname, { method: "GET", headers: etag ? { "if-none-match": etag } : {} }, operation);
    const tag = response.headers.get("etag") ?? undefined;
    if (response.status === 304) return { unchanged: true, ...(tag ? { etag: tag } : {}) };
    return { unchanged: false, payload: await this.parse<T>(response, operation), ...(tag ? { etag: tag } : {}) };
  }
}

Object.assign(EngineClient.prototype, ...domainClients);
