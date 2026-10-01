import type http from "node:http";
import { body, HttpError, writeError, writeJson } from "./http";
import type { Route } from "./route";

type RouterOptions = {
  /** Throws when the request may not reach a route with this auth. */
  authorize(auth: Route["auth"], request: http.IncomingMessage): void;
  errorFor(error: unknown): HttpError;
  /** What an unmatched request gets; by default an authenticated 404. */
  fallback?(request: http.IncomingMessage, response: http.ServerResponse, url: URL): Promise<void>;
  observe?<T>(operation: string, section: () => T): T;
};

/** Exact paths win over patterns, whatever the order; patterns are tried in declaration order. */
export function matchRoute(routes: readonly Route[], method: string, pathname: string): { route: Route; params: string[] } | undefined {
  const candidates = routes.filter((route) => route.method === method || route.method === "*");
  const exact = candidates.find((route) => route.path === pathname);
  if (exact) return { route: exact, params: [] };
  for (const route of candidates) {
    if (typeof route.path === "string") continue;
    const match = route.path.exec(pathname);
    if (match) return { route, params: match.slice(1).map((group) => (group === undefined ? group : decodeURIComponent(group))) as string[] };
  }
  return undefined;
}

export function router(routes: readonly Route[], options: RouterOptions): http.RequestListener {
  const fallback =
    options.fallback ??
    (async (request: http.IncomingMessage) => {
      options.authorize("engine", request);
      throw new HttpError(404, "not_found", "engine endpoint does not exist");
    });
  return async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const matched = matchRoute(routes, request.method ?? "GET", url.pathname);
      if (!matched) return await fallback(request, response, url);
      options.authorize(matched.route.auth, request);
      const parsed = request.method === "GET" || matched.route.body === "raw" ? {} : await body(request);
      const handle = () => matched.route.handle({ body: parsed, params: matched.params, query: url.searchParams, request, response });
      const answer = await (options.observe ? options.observe(`${request.method} ${url.pathname}`, handle) : handle());
      if (!answer) return;
      if (answer.bytes) response.writeHead(answer.status, answer.headers).end(answer.bytes);
      else writeJson(response, answer.status, answer.body, answer.headers);
    } catch (error) {
      writeError(response, options.errorFor(error));
    }
  };
}
