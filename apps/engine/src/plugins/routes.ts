/**
 * A PLUGIN'S PROJECT AND MACHINE DOORS, AS DATA — the scoped half of `routes`.
 *
 * The session table (`PluginEngineModule.routes`) is POST-only and hands a
 * handler the session's capability. The settings pages need more than that:
 * reads (`GET`), cancels (`DELETE`), a job id in the path, `202` for work
 * started, and no session at all. So a scoped table is keyed by METHOD AND
 * PATH — `"GET environments"`, `"DELETE jobs/:id"` — and the daemon matches,
 * gates, parses and writes; the plugin only returns a value.
 *
 * Served at `/v2/projects/:id/plugins/<plugin>/<verb>` and
 * `/v2/plugins/<plugin>/<verb>`. See docs/design/plugins-contract.md.
 */

export type PluginRouteMethod = "GET" | "POST" | "DELETE";

export type PluginRouteRequest = {
  /** The parsed JSON body for a POST; `{}` otherwise. */
  input: Record<string, unknown>;
  query: URLSearchParams;
  /** The `:name` segments of the matched key. */
  params: Record<string, string>;
};

export type PluginScopedRoute<Scope> = {
  /** 202 for a verb that starts work and answers with a job. */
  status?: 200 | 202;
  /**
   * ANSWERS BEFORE THE PROJECT TURNS THE PLUGIN ON. Only meaningful at project
   * scope: the reads a person uses to CHOOSE what to turn on with (which
   * environment, which distribution) cannot require it to be on already. The
   * Mac-wide switch still refuses these — "off for this Mac" means every door.
   */
  beforeEnable?: boolean;
  handle(request: PluginRouteRequest, scope: Scope): unknown | Promise<unknown>;
};

export type PluginProjectRoutes = Record<string, PluginScopedRoute<{ projectId: string }>>;
export type PluginMachineRoutes = Record<string, PluginScopedRoute<Record<string, never>>>;

/**
 * Find the entry for `method` + `verb` (`"jobs/job_1"`). Keys are
 * `"<METHOD> <path>"`, where a path segment `:name` captures one segment.
 * Exact segments win over captures only by declaration order, so a table
 * should not declare both shapes for one position.
 */
export function matchPluginRoute<Route>(
  table: Record<string, Route> | undefined,
  method: string,
  verb: string,
): { route: Route; params: Record<string, string> } | undefined {
  if (!table) return undefined;
  const segments = verb.split("/");
  for (const [key, route] of Object.entries(table)) {
    const [keyMethod, pattern] = key.split(" ") as [string, string | undefined];
    if (keyMethod !== method || pattern === undefined) continue;
    const parts = pattern.split("/");
    if (parts.length !== segments.length) continue;
    const params: Record<string, string> = {};
    const matched = parts.every((part, index) => {
      const segment = segments[index]!;
      if (part.startsWith(":")) {
        params[part.slice(1)] = decodeURIComponent(segment);
        return segment.length > 0;
      }
      return part === segment;
    });
    if (matched) return { route, params };
  }
  return undefined;
}

/** A string field, refused in the daemon's own words when it is not one. */
export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new PluginInputError(`${label} must be a string`);
  return value;
}

/** A refusal about the REQUEST, which the daemon answers as 400 `invalid_request`. */
export class PluginInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginInputError";
  }
}

/** `?after=` as the job routes have always read it: a number, else 0. */
export function jobCursor(query: URLSearchParams): number {
  const after = Number(query.get("after") ?? "0");
  return Number.isFinite(after) ? after : 0;
}
