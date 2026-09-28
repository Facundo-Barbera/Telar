import type http from "node:http";
import { machineAllows } from "@telar/engine-client";
import { EngineStateError } from "../../platform/kernel/errors";
import { body, HttpError } from "../../platform/http/http";
import type { Route, RouteAnswer } from "../../platform/http/route";
import type { PluginHost } from "./host";
import { matchPluginRoute, PluginInputError, type PluginRouteMethod, type PluginScopedRoute } from "./scoped-routes";
import type { EngineStore } from "../../state";

type ScopedInput = { pluginId: string; scope: "project" | "machine"; projectId?: string; verb: string; legacy?: boolean };

/**
 * One server for every plugin's project and machine verbs. `legacy` is the alias mode: no enablement gate,
 * a plugin's unexpected throw is not relabelled, and an unknown verb answers `undefined` (the path falls through).
 */
async function answerScoped(store: EngineStore, host: PluginHost, input: ScopedInput, request: http.IncomingMessage, query: URLSearchParams): Promise<RouteAnswer | undefined> {
  const module = host.ready(input.pluginId);
  const table: Record<string, PluginScopedRoute<never>> | undefined = input.scope === "project" ? module?.projectRoutes : module?.machineRoutes;
  const method = request.method as PluginRouteMethod;
  const matched = matchPluginRoute(table, method, input.verb);
  if (!matched) {
    if (input.legacy) return undefined;
    if (!module) throw new HttpError(404, "not_found", `no plugin ${input.pluginId}`);
    throw new HttpError(404, "not_found", `plugin ${input.pluginId} has no ${method} ${input.verb}`);
  }
  const { route, params } = matched;
  if (!input.legacy) {
    if (!machineAllows(store.machinePlugins(), input.pluginId)) throw new EngineStateError("invalid_request", `${input.pluginId} is turned off for this Mac`);
    if (input.projectId !== undefined) {
      const project = store.getProject(input.projectId);
      if (route.beforeEnable !== true && !store.pluginRuns(project, input.pluginId)) {
        throw new EngineStateError("invalid_request", `${input.pluginId} is not enabled for this project`);
      }
    }
  }
  const routeRequest = { input: method === "POST" ? await body(request) : {}, query, params };
  let answer: unknown;
  try {
    answer = await (route.handle as (request: typeof routeRequest, scope: unknown) => unknown)(routeRequest, input.projectId !== undefined ? { projectId: input.projectId } : {});
  } catch (error) {
    if (input.legacy || error instanceof HttpError || error instanceof EngineStateError || error instanceof PluginInputError) throw error;
    throw new HttpError(400, "plugin_error", `${input.pluginId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { status: route.status ?? 200, body: answer ?? {} };
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
// Verbs stay percent-encoded: `matchPluginRoute` decodes its own params.
const segments = (request: http.IncomingMessage) => new URL(request.url ?? "/", "http://127.0.0.1").pathname.split("/");

/**
 * `/v2/projects/:id/plugins/<plugin>/<verb>` (gated on Mac and project), `/v2/plugins/<plugin>/<verb>` (gated on Mac),
 * and the ungated old aliases under `data-science` and `latex`, which a released client still calls.
 */
export function pluginScopedRoutes(store: EngineStore, host: PluginHost): Route[] {
  const serve = (input: ScopedInput, request: http.IncomingMessage, query: URLSearchParams) => answerScoped(store, host, input, request, query);
  const declined = (answer: RouteAnswer | undefined): RouteAnswer => {
    if (!answer) throw new HttpError(404, "not_found", "engine endpoint does not exist");
    return answer;
  };
  return METHODS.flatMap((method): Route[] => [
    {
      method,
      path: /^\/v2\/projects\/([^/]+)\/plugins\/[a-z][a-z0-9-]*\/[A-Za-z0-9_.%-]+(?:\/[A-Za-z0-9_.%-]+)*$/,
      auth: "engine",
      body: "raw",
      handle: ({ params, query, request }) => {
        const [pluginId, ...verb] = segments(request).slice(5);
        return serve({ pluginId: pluginId!, scope: "project", projectId: params[0]!, verb: verb.join("/") }, request, query);
      },
    },
    {
      method,
      path: /^\/v2\/plugins\/[a-z][a-z0-9-]*\/[A-Za-z0-9_.%-]+(?:\/[A-Za-z0-9_.%-]+)*$/,
      auth: "engine",
      body: "raw",
      handle: ({ query, request }) => {
        const [pluginId, ...verb] = segments(request).slice(3);
        return serve({ pluginId: pluginId!, scope: "machine", verb: verb.join("/") }, request, query);
      },
    },
    {
      method,
      path: /^\/v2\/projects\/([^/]+)\/(data-science|latex)\/[^/]+(?:\/[^/]+)*$/,
      auth: "engine",
      body: "raw",
      handle: async ({ params, query, request }) =>
        declined(await serve({ pluginId: params[1]!, scope: "project", projectId: params[0]!, verb: segments(request).slice(5).join("/"), legacy: true }, request, query)),
    },
    {
      method,
      path: /^\/v2\/(data-science|latex)\/[^/]+(?:\/[^/]+)*$/,
      auth: "engine",
      body: "raw",
      handle: async ({ params, query, request }) =>
        declined(await serve({ pluginId: params[0]!, scope: "machine", verb: segments(request).slice(3).join("/"), legacy: true }, request, query)),
    },
  ]);
}
