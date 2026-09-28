import type http from "node:http";

export type RouteAnswer = { status: number; body: unknown; bytes?: Uint8Array; headers?: Record<string, string> };

type RouteInput = {
  body: Record<string, unknown>;
  params: string[];
  query: URLSearchParams;
  request: http.IncomingMessage;
  response: http.ServerResponse;
};

/**
 * One `/v2` endpoint. `path` is exact, or a RegExp whose groups become `params`.
 * `body: "raw"` leaves the request body unread for the handler; a handler that answers `undefined` has written the response itself.
 */
export type Route = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string | RegExp;
  auth: "engine";
  body?: "raw";
  handle(input: RouteInput): RouteAnswer | undefined | Promise<RouteAnswer | undefined>;
};

export const ok = (body: unknown): RouteAnswer => ({ status: 200, body });
export const fail = (status: number, code: string, message: string): RouteAnswer => ({ status, body: { error: { code, message } } });
export const notModified = (etag: string): RouteAnswer => ({ status: 304, body: null, bytes: new Uint8Array(), headers: { etag, "cache-control": "no-store" } });
