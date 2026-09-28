/**
 * AN EXTERNAL PLUGIN AS THE HOST SEES IT — the same `PluginEngineModule` and
 * `PluginToolModule` a bundled plugin is, built from a manifest and a process.
 *
 *   engine module   lifecycle, settings validation, and every route verb —
 *                   each forwarded to the process as `telar/route`. The
 *                   reserved session verb `tool` forwards a declared tool's
 *                   call as MCP `tools/call`.
 *   tool module     the wall, from the manifest's DECLARED tools, registered
 *                   under `mcp__telar__<prefix>_*` like every other plugin's.
 *                   Each call reaches the process through the generic session
 *                   door, so the host's gate (Mac, then project) applies.
 *
 * NEVER READ-RATIFIED. The manifest cannot claim a tool is a read (`readTools`
 * is always empty) and `HOST_RATIFIED_READ_TOOLS` names no external id, so
 * every tool here parks for approval under the ordinary mode ladder.
 */
import { z } from "zod";
import { PLUGIN_API_VERSION, type ExternalPluginManifest, type PluginMeta } from "@telar/engine-client";
import { err, json, type ToolFactory } from "../../tool-kit";
import type { PluginEngineModule, PluginInitContext } from "../contract";
import type { PluginMachineRoutes, PluginProjectRoutes, PluginRouteRequest } from "../routes";
import type { PluginToolModule } from "../tool-module";
import { isSymlink } from "./installer";
import type { LoadedExternalPlugin } from "./manifest";
import { ExternalPluginProcess, type ExternalProcessOptions } from "./process";

/** The session verb a tool call travels under. Not a verb a manifest may declare. */
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
    // A CLAIM AN EXTERNAL PLUGIN CANNOT MAKE — see the header.
    readTools: [],
    ...(manifest.briefing ? { briefing: manifest.briefing } : {}),
    eventKinds: [],
    ...(manifest.panels.length > 0 ? { panels: manifest.panels } : {}),
    // One section per scope it has settings for, so Projects and Plugins list it.
    settings: [
      { id: "settings", scope: "project" as const, label: manifest.name },
      ...(manifest.machineSettingsSchema ? [{ id: "defaults", scope: "machine" as const, label: manifest.name }] : []),
    ],
  };
}

/** A JSON Schema object as the zod the host validates writes with. Lenient on
 *  a schema zod cannot read: the plugin then validates its own settings. */
function zodFrom(schema: Record<string, unknown> | undefined): z.ZodType<unknown> | undefined {
  if (!schema) return undefined;
  try {
    return z.fromJSONSchema(schema as never) as z.ZodType<unknown>;
  } catch {
    return z.record(z.string(), z.unknown());
  }
}

/** A declared tool's arguments as the raw zod shape a `ToolFactory` takes. */
function shapeOf(schema: Record<string, unknown>): Record<string, unknown> {
  try {
    const parsed = z.fromJSONSchema(schema as never);
    return parsed instanceof z.ZodObject ? (parsed.shape as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export type ExternalPluginDeps = {
  /** The generic session gate — throws when the Mac or the project has it off. */
  resolve: (sessionId: string) => { projectId: string; sessionId: string };
  /** Does any project on this Mac still have it on? When none does, it stops. */
  enabledAnywhere: () => boolean;
  /**
   * The settings in force: the Mac's defaults, with a project's own over them
   * when there is a project. Sent with every call, so the plugin never has to
   * ask and never holds a stale copy.
   */
  settings: (projectId: string | undefined) => Record<string, unknown>;
  /** Test seams for the process: spawn and timers. */
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
      // Only what the manifest declared, and so what the approval was about.
      if (!manifest.tools.some((tool) => tool.name === name)) throw new Error(`${manifest.id} has no tool ${name}`);
      const { sessionId, projectId } = capability as { sessionId: string; projectId: string };
      // Where the call comes from and the settings in force, in MCP's `_meta`.
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
    /**
     * NOTHING IS SPAWNED HERE. The process starts on first use — a tool call
     * or a route — so a plugin no project has turned on costs nothing, and a
     * broken one cannot delay the engine's start. What `init` registers is the
     * stop.
     */
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
      // The last project turned it off and its work is done: stop the process.
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

/** Was this wall built from an installed plugin's manifest (rather than bundled)? */
export const isExternalToolModule = (module: PluginToolModule) => EXTERNAL_TOOL_MODULES.has(module);

/** The worker's half: the declared tools, each a call through the session door. */
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
            // An MCP result passes through; anything else is shown as JSON.
            return Array.isArray(answer?.content) ? { content: answer.content, ...(answer.isError ? { isError: true } : {}) } : json(answer);
          } catch (error) {
            return err(error instanceof Error ? error.message : String(error));
          }
        }),
      );
    },
  };
}
