import { resolveMcpServers, type ProviderDriverKind } from "@telar/engine-client";
import { HttpError } from "../../platform/http/http";
import { positiveParam, stringValue } from "../../platform/http/params";
import { ok, type Route } from "../../platform/http/route";
import type { EngineStore } from "../../state";
import { runCliUpdate, type CliUpdateRun } from "./cli-updates";
import { createProviderProber, type VersionProbe } from "./instances";
import { runStructuredForPolicy } from "./textgen";

type ProviderRouteDeps = {
  now: () => number;
  probeVersion?: (driver: ProviderDriverKind, binaryPath: string | undefined, force: boolean) => Promise<VersionProbe>;
  runUpdate?: (driver: ProviderDriverKind, binaryPath: string | undefined) => Promise<CliUpdateRun>;
};

const only = (input: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(keys.filter((key) => key in input).map((key) => [key, input[key]]));

function textGenComplete(store: EngineStore): Route {
  return {
    method: "POST",
    path: "/v2/textgen/complete",
    auth: "engine",
    // A failed completion is a 502: the caller asked for an answer and the harness did not give one.
    async handle({ body, response }) {
      const { prompt, schema, model, effort } = body;
      if (typeof prompt !== "string" || prompt.trim().length === 0) throw new HttpError(400, "invalid_request", "prompt must be a non-empty string");
      if (prompt.length > 20_000) throw new HttpError(400, "invalid_request", "prompt must be under 20000 characters");
      if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
        throw new HttpError(400, "invalid_request", "schema must be a JSON schema object");
      }
      if (model !== undefined && (typeof model !== "string" || model.trim().length === 0)) {
        throw new HttpError(400, "invalid_request", "model must be a non-empty string when given");
      }
      if (effort !== undefined && effort !== "low" && effort !== "medium" && effort !== "high") {
        throw new HttpError(400, "invalid_request", "effort must be low, medium or high when given");
      }
      // A caller that hangs up kills the harness child rather than leaving it to its timeout.
      const abort = new AbortController();
      response.on("close", () => abort.abort());
      const result = await runStructuredForPolicy(store, {
        prompt,
        schema,
        ...(typeof model === "string" ? { model } : {}),
        ...(typeof effort === "string" ? { effort } : {}),
        signal: abort.signal,
      });
      if (abort.signal.aborted) return undefined;
      if (result === undefined) throw new HttpError(502, "textgen_failed", "the harness did not answer");
      return ok({ result });
    },
  };
}

function modelRoutes(store: EngineStore): Route[] {
  return [
    {
      method: "GET",
      path: "/v2/models",
      auth: "engine",
      // No instance means the driver's built-in slot; the instance only selects the overlay.
      handle: async ({ query }) => {
        const instanceId = query.get("instanceId");
        return ok({
          catalogue: await store.modelCatalogue((query.get("driver") ?? "claude") as "claude" | "codex", {
            force: query.get("refresh") === "1",
            ...(instanceId ? { instanceId } : {}),
          }),
        });
      },
    },
    {
      method: "GET",
      path: "/v2/claude/conversations",
      auth: "engine",
      handle: async ({ query }) => {
        const instanceId = query.get("instanceId")?.trim();
        const cwd = query.get("cwd")?.trim();
        return ok({
          conversations: await store.listAdoptableClaudeConversations({
            ...(instanceId ? { instanceId } : {}),
            ...(cwd ? { cwd } : {}),
            limit: positiveParam(query.get("limit"), 100, 500, "limit"),
          }),
        });
      },
    },
    { method: "GET", path: "/v2/textgen", auth: "engine", handle: () => ok({ textGen: store.getTextGenPolicy() }) },
    {
      method: "PATCH",
      path: "/v2/textgen",
      auth: "engine",
      handle: ({ body }) => ok({ textGen: store.setTextGenPolicy(only(body, ["titles", "renameBranches", "driver", "model"])) }),
    },
    textGenComplete(store),
  ];
}

const PROJECT_MCP_SLOT = /^\/v2\/projects\/([^/]+)\/mcp-servers\/([A-Za-z0-9_-]+)$/;
const GLOBAL_MCP_SLOT = /^\/v2\/mcp-servers\/([A-Za-z0-9_-]+)$/;

/** The machine's servers live at `/v2/mcp-servers`, one project's under `/v2/projects/:id/mcp-servers`. */
function mcpServerRoutes(store: EngineStore): Route[] {
  const save = (id: string, projectId: string | undefined, input: Record<string, unknown>) =>
    ok({
      mcpServer: store.saveMcpServer({
        id,
        ...(projectId === undefined ? {} : { projectId }),
        ...(input.label === undefined ? {} : { label: stringValue(input.label, "mcp server label")! }),
        ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
        spec: input.spec,
      }),
    });
  return [
    { method: "GET", path: "/v2/mcp-servers", auth: "engine", handle: () => ok({ mcpServers: store.listMcpServers({ projectId: null }) }) },
    {
      method: "GET",
      path: /^\/v2\/projects\/([^/]+)\/mcp-servers$/,
      auth: "engine",
      handle: ({ params }) =>
        ok({ mcpServers: store.listMcpServers({ projectId: params[0]! }), effective: resolveMcpServers(store.listMcpServers(), params[0]!) }),
    },
    { method: "PUT", path: PROJECT_MCP_SLOT, auth: "engine", handle: ({ body, params }) => save(params[1]!, params[0]!, body) },
    { method: "PUT", path: GLOBAL_MCP_SLOT, auth: "engine", handle: ({ body, params }) => save(params[0]!, undefined, body) },
    {
      method: "DELETE",
      path: PROJECT_MCP_SLOT,
      auth: "engine",
      body: "raw",
      handle: ({ params }) => ok({ removed: store.removeMcpServer(params[1]!, params[0]!) }),
    },
    { method: "DELETE", path: GLOBAL_MCP_SLOT, auth: "engine", body: "raw", handle: ({ params }) => ok({ removed: store.removeMcpServer(params[0]!, undefined) }) },
  ];
}

const INSTANCE = /^\/v2\/provider-instances\/([A-Za-z][A-Za-z0-9_-]*)$/;
const INSTANCE_MODELS = /^\/v2\/provider-instances\/([A-Za-z][A-Za-z0-9_-]*)\/models$/;
const INSTANCE_FIELDS = ["driver", "displayName", "accentColor", "contextNoticePercent", "autoCompact", "configDir", "binaryPath", "env", "carryOverInherited"];

/** The configured logins. Listed with their probes; sensitive environment values never come back. */
function providerInstanceRoutes(store: EngineStore, deps: ProviderRouteDeps): Route[] {
  const probeProviders = createProviderProber({ ...(deps.probeVersion ? { version: deps.probeVersion } : {}), now: deps.now });
  const updateProvider = deps.runUpdate ?? ((driver, binaryPath) => runCliUpdate(driver, binaryPath ? { binaryPath } : {}));
  return [
    {
      method: "GET",
      path: "/v2/provider-instances",
      auth: "engine",
      handle: async ({ query }) => {
        const providerInstances = store.listProviderInstances();
        return ok({ providerInstances, probes: await probeProviders(providerInstances, { force: query.get("refresh") === "1" }) });
      },
    },
    {
      method: "POST",
      path: /^\/v2\/provider-updates\/([A-Za-z][A-Za-z0-9_-]*)$/,
      auth: "engine",
      body: "raw",
      // The command is derived from the install on disk, never taken from the request.
      async handle({ params }) {
        const id = params[0]!;
        const instance = store.listProviderInstances().find((entry) => entry.id === id);
        if (!instance) throw new HttpError(404, "not_found", `unknown provider instance ${id}`);
        const result = await updateProvider(instance.driver, instance.binaryPath);
        const providerInstances = store.listProviderInstances();
        return ok({ result, providerInstances, probes: await probeProviders(providerInstances, { force: true }) });
      },
    },
    { method: "GET", path: INSTANCE_MODELS, auth: "engine", handle: ({ params }) => ok({ overlay: store.getModelOverlay(params[0]!) }) },
    {
      method: "PATCH",
      path: INSTANCE_MODELS,
      auth: "engine",
      // By key presence: `[]` clears a list, an absent key leaves it alone.
      handle: ({ body, params }) => ok({ overlay: store.setModelOverlay(params[0]!, only(body, ["favorites", "hidden", "order", "custom", "default"])) }),
    },
    {
      method: "PUT",
      path: INSTANCE,
      auth: "engine",
      // Fields pass through verbatim, `null` included: the store owns clear / keep / set.
      handle({ body, params }) {
        const saved = store.saveProviderInstance({
          id: params[0]!,
          ...Object.fromEntries(INSTANCE_FIELDS.filter((key) => body[key] !== undefined).map((key) => [key, body[key]])),
          ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
        });
        return ok({
          providerInstance: saved.instance,
          ...(saved.stoppedInheriting.length > 0 ? { stoppedInheriting: saved.stoppedInheriting } : {}),
        });
      },
    },
    { method: "DELETE", path: INSTANCE, auth: "engine", body: "raw", handle: ({ params }) => ok({ removed: store.removeProviderInstance(params[0]!) }) },
  ];
}

export function providersRoutes(store: EngineStore, deps: ProviderRouteDeps): Route[] {
  return [...modelRoutes(store), ...mcpServerRoutes(store), ...providerInstanceRoutes(store, deps)];
}
