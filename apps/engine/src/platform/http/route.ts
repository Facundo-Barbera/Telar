export type RouteAnswer = { status: number; body: unknown; bytes?: Uint8Array; headers?: Record<string, string> };

type RouteInput = { body: Record<string, unknown>; params: string[]; query: URLSearchParams };

/** One `/v2` endpoint. `path` is exact, or a RegExp whose groups become `params`. */
export type Route = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string | RegExp;
  auth: "engine";
  handle(input: RouteInput): RouteAnswer | Promise<RouteAnswer>;
};

export const ok = (body: unknown): RouteAnswer => ({ status: 200, body });
export const fail = (status: number, code: string, message: string): RouteAnswer => ({ status, body: { error: { code, message } } });
