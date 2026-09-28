export type PluginRouteMethod = "GET" | "POST" | "DELETE";

export type PluginRouteRequest = {
  input: Record<string, unknown>;
  query: URLSearchParams;
  params: Record<string, string>;
};

export type PluginScopedRoute<Scope> = {
  status?: 200 | 202;
  beforeEnable?: boolean;
  handle(request: PluginRouteRequest, scope: Scope): unknown | Promise<unknown>;
};

export type PluginProjectRoutes = Record<string, PluginScopedRoute<{ projectId: string }>>;
export type PluginMachineRoutes = Record<string, PluginScopedRoute<Record<string, never>>>;

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

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new PluginInputError(`${label} must be a string`);
  return value;
}

export class PluginInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginInputError";
  }
}

export function jobCursor(query: URLSearchParams): number {
  const after = Number(query.get("after") ?? "0");
  return Number.isFinite(after) ? after : 0;
}
