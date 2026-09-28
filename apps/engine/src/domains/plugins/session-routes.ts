import type http from "node:http";
import type { PluginEngineModule } from "./contract";
import { body, HttpError } from "../../platform/http/http";
import { ok, sessionRoute, type Route } from "../../platform/http/route";
import { EngineStateError } from "../../platform/kernel";

type Door = {
  unavailable: (pluginId: string) => string;
  missing: (pluginId: string, verb: string) => string;
  failure: (pluginId: string, message: string) => HttpError;
};

const generic: Door = {
  unavailable: (pluginId) => `no plugin ${pluginId}`,
  missing: (pluginId, verb) => `plugin ${pluginId} has no ${verb}`,
  failure: (pluginId, message) => new HttpError(400, "plugin_error", `${pluginId}: ${message}`),
};

const alias = (name: string, label: string): Door => ({
  unavailable: () => `${name} is unavailable`,
  missing: (_pluginId, verb) => `no ${label} method ${verb}`,
  failure: (_pluginId, message) => new HttpError(400, "invalid_request", message),
});

/**
 * The generic `/plugins/<id>/<verb>` door, plus `/ds/` and `/latex/`, which released clients still call.
 * The body is read only once the verb resolves, so an unknown plugin or verb answers 404 whatever was sent.
 */
export function pluginSessionRoutes(ready: (pluginId: string) => PluginEngineModule | undefined): Route[] {
  const call = async (door: Door, pluginId: string, verb: string, sessionId: string, request: http.IncomingMessage) => {
    const module = ready(pluginId);
    if (!module) throw new HttpError(404, "not_found", door.unavailable(pluginId));
    const route = module.routes?.[verb];
    if (!route) throw new HttpError(404, "not_found", door.missing(pluginId, verb));
    const input = await body(request);
    try {
      return ok((await route(input, module.resolve?.(sessionId))) ?? {});
    } catch (error) {
      if (error instanceof HttpError || error instanceof EngineStateError) throw error;
      throw door.failure(pluginId, error instanceof Error ? error.message : String(error));
    }
  };
  return [
    {
      method: "POST",
      path: sessionRoute("/ds/([a-z]+(?:/[a-z]+)?)"),
      auth: "engine",
      body: "raw",
      handle: ({ params: [sessionId, verb], request }) => call(alias("data science", "data-science"), "data-science", verb!, sessionId!, request),
    },
    {
      method: "POST",
      path: sessionRoute("/latex/([a-z]+)"),
      auth: "engine",
      body: "raw",
      handle: ({ params: [sessionId, verb], request }) => call(alias("latex", "latex"), "latex", verb!, sessionId!, request),
    },
    {
      method: "POST",
      path: sessionRoute("/plugins/([a-z][a-z0-9-]*)/([a-z][a-z0-9-]*(?:/[a-z][a-z0-9-]*)?)"),
      auth: "engine",
      body: "raw",
      handle: ({ params: [sessionId, pluginId, verb], request }) => call(generic, pluginId!, verb!, sessionId!, request),
    },
  ];
}
