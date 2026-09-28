import { z } from "zod";
import { PLUGIN_API_VERSION, type ExternalPluginManifest, type PluginMeta } from "@telar/engine-client";
import { err, json, type ToolFactory } from "../../agent-tools";
import type { PluginEngineModule, PluginInitContext } from "../contract";
import type { PluginMachineRoutes, PluginProjectRoutes, PluginRouteRequest } from "../scoped-routes";
import type { PluginToolModule } from "../tool-module";
import { isSymlink } from "./installer";
import type { LoadedExternalPlugin } from "./manifest";
import { ExternalPluginProcess, type ExternalProcessOptions } from "./process";

const TOOL_VERB = "tool";

export function externalMeta(manifest: ExternalPluginManifest): PluginMeta {
  return {
    id: manifest.id,
    api: PLUGIN_API_VERSION,
    name: manifest.name,
    version: manifest.version,
    ...(manifest.description ? { blurb: manifest.description } : {}),
    ...(manifest.icon ? { icon: manifest.icon } : {}),
    toolPrefixes: manifest.toolPrefix ? [manifest.toolPrefix] : [],
    readTools: [],
    ...(manifest.briefing ? { briefing: manifest.briefing } : {}),
    eventKinds: [],
    ...(manifest.panels.length > 0 ? { panels: manifest.panels } : {}),
    settings: [
      { id: "settings", scope: "project" as const, label: manifest.name },
      ...(manifest.machineSettingsSchema ? [{ id: "defaults", scope: "machine" as const, label: manifest.name }] : []),
    ],
  };
}

function zodFrom(schema: Record<string, unknown> | undefined): z.ZodType<unknown> | undefined {
  if (!schema) return undefined;
  try {
    return z.fromJSONSchema(schema as never) as z.ZodType<unknown>;
  } catch {
    return z.record(z.string(), z.unknown());
  }
}

function shapeOf(schema: Record<string, unknown>): Record<string, unknown> {
  try {
    const parsed = z.fromJSONSchema(schema as never);
    return parsed instanceof z.ZodObject ? (parsed.shape as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export type ExternalPluginDeps = {
  resolve: (sessionId: string) => { projectId: string; sessionId: string };
  enabledAnywhere: () => boolean;
  settings: (projectId: string | undefined) => Record<string, unknown>;
  process?: Pick<ExternalProcessOptions, "spawn" | "timers" | "requestTimeoutMs" | "startTimeoutMs">;
};

export function externalPlugin(loaded: LoadedExternalPlugin, deps: ExternalPluginDeps): PluginEngineModule & { process(): ExternalPluginProcess | undefined } {
  const { manifest, dir } = loaded;
  let child: ExternalPluginProcess | undefined;
  const running = (): ExternalPluginProcess => {
    if (!child) throw new Error(`${manifest.id} is not initialised`);
    return child;
  };
  const route = (scope: "session" | "project" | "machine", verb: string, request: Partial<PluginRouteRequest> & Record<string, unknown>) =>
    running().request("telar/route", {
      scope,
      verb,
      input: request.input ?? {},
      ...(request.query ? { query: Object.fromEntries(request.query) } : {}),
      ...(request.params ? { params: request.params } : {}),
      ...(typeof request.sessionId === "string" ? { sessionId: request.sessionId } : {}),
      ...(typeof request.projectId === "string" ? { projectId: request.projectId } : {}),
      settings: deps.settings(typeof request.projectId === "string" ? request.projectId : undefined),
    });

  const sessionRoutes: NonNullable<PluginEngineModule["routes"]> = {
    [TOOL_VERB]: async (input, capability) => {
      const name = String(input.name ?? "");
      if (!manifest.tools.some((tool) => tool.name === name)) throw new Error(`${manifest.id} has no tool ${name}`);
      const { sessionId, projectId } = capability as { sessionId: string; projectId: string };
      return running().request("tools/call", {
        name,
        arguments: input.arguments ?? {},
        _meta: { telar: { sessionId, projectId, settings: deps.settings(projectId) } },
      });
    },
    ...Object.fromEntries(
      manifest.routes.session.map((verb) => [
        verb,
        (input: Record<string, unknown>, capability: unknown) => route("session", verb, { input, ...(capability as object) }),
      ]),
    ),
  };
  const projectRoutes: PluginProjectRoutes = Object.fromEntries(
    manifest.routes.project.map((key) => [key, { handle: (request, scope) => route("project", key, { ...request, projectId: scope.projectId }) }]),
  );
  const machineRoutes: PluginMachineRoutes = Object.fromEntries(
    manifest.routes.machine.map((key) => [key, { handle: (request) => route("machine", key, request) }]),
  );

  const settingsSchema = zodFrom(manifest.settingsSchema);
  const machineSettingsSchema = zodFrom(manifest.machineSettingsSchema);
  return {
    meta: externalMeta(manifest),
    ...(settingsSchema ? { settingsSchema } : {}),
    ...(machineSettingsSchema ? { machineSettingsSchema } : {}),
    ...(manifest.settingsSchema ? { publishedSettingsSchema: manifest.settingsSchema } : {}),
    ...(manifest.machineSettingsSchema ? { publishedMachineSettingsSchema: manifest.machineSettingsSchema } : {}),
    installed: { linked: isSymlink(dir) },
    init(context: PluginInitContext) {
      const created = new ExternalPluginProcess({
        id: manifest.id,
        dir,
        command: manifest.command,
        stateDir: context.stateDir,
        ...deps.process,
      });
      child = created;
      context.onDispose(`${manifest.id} process`, () => created.stop());
    },
    hooks: {
      drain: () => undefined,
      busy: () => child?.busy ?? false,
      releaseProject: async () => {
        if (!deps.enabledAnywhere()) await child?.stop();
      },
    },
    routes: sessionRoutes,
    projectRoutes,
    machineRoutes,
    resolve: (sessionId) => deps.resolve(sessionId),
    process: () => child,
  };
}

const EXTERNAL_TOOL_MODULES = new WeakSet<PluginToolModule>();

export const isExternalToolModule = (module: PluginToolModule) => EXTERNAL_TOOL_MODULES.has(module);

export function externalToolModule(loaded: LoadedExternalPlugin): PluginToolModule {
  const module = buildExternalToolModule(loaded);
  EXTERNAL_TOOL_MODULES.add(module);
  return module;
}

function buildExternalToolModule(loaded: LoadedExternalPlugin): PluginToolModule {
  const { manifest } = loaded;
  return {
    meta: externalMeta(manifest),
    capability: (call) => ({ call }),
    tools(tool: ToolFactory, capability: unknown) {
      const { call } = capability as { call: <T>(verb: string, body?: unknown) => Promise<T> };
      return manifest.tools.map((declared) =>
        tool(declared.name, declared.description, shapeOf(declared.inputSchema), async (args) => {
          try {
            const answer = await call<{ content?: unknown[]; isError?: boolean }>(TOOL_VERB, { name: declared.name, arguments: args });
            return Array.isArray(answer?.content) ? { content: answer.content, ...(answer.isError ? { isError: true } : {}) } : json(answer);
          } catch (error) {
            return err(error instanceof Error ? error.message : String(error));
          }
        }),
      );
    },
  };
}
