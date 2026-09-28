export type RouteAnswer = { status: number; body: unknown; bytes?: Uint8Array; headers?: Record<string, string> };

type RouteInput = { body: Record<string, unknown>; params: string[]; query: URLSearchParams };

/** One `/v2` endpoint. `path` is exact, or a RegExp whose groups become `params`. */
export type Route = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string | RegExp;
  auth: "engine";
  handle(input: RouteInput): RouteAnswer | Promise<RouteAnswer>;
};

export function matchRoute(routes: readonly Route[], method: string, pathname: string): { route: Route; params: string[] } | undefined {
  for (const route of routes) {
    if (route.method !== method) continue;
    if (typeof route.path === "string") {
      if (route.path === pathname) return { route, params: [] };
      continue;
    }
    const match = route.path.exec(pathname);
    if (match) return { route, params: match.slice(1).map(decodeURIComponent) };
  }
  return undefined;
}

export const ok = (body: unknown): RouteAnswer => ({ status: 200, body });
export const fail = (status: number, code: string, message: string): RouteAnswer => ({ status, body: { error: { code, message } } });
