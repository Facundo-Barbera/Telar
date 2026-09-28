import path from "node:path";
import { PluginInstallInput } from "@telar/engine-client";
import { HttpError } from "../../platform/http/http";
import { ok, type Route } from "../../platform/http/route";
import { installPluginFolder, PluginInstallError, removePluginFolder } from "./external/installer";
import { BUNDLED_RESERVATIONS, type LoadedExternalPlugin } from "./external/manifest";
import type { PluginEngineModule } from "./contract";
import type { PluginHost } from "./host";
import type { EngineStore } from "../../state";
import type { InstalledPlugins } from "./installed";

type PluginFolders = { dir: string; installed: InstalledPlugins; moduleFor(loaded: LoadedExternalPlugin): PluginEngineModule };

function validMachineEntries(input: Record<string, unknown>, host: PluginHost): Record<string, unknown> {
  if (!input.plugins || typeof input.plugins !== "object" || Array.isArray(input.plugins)) throw new HttpError(400, "invalid_request", "plugins must be an object");
  const entries = input.plugins as Record<string, unknown>;
  for (const [id, value] of Object.entries(entries)) {
    if (value === null) continue;
    if (typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_request", `plugins.${id} must be an object or null`);
    const config = value as { enabled?: unknown; settings?: unknown };
    if (typeof config.enabled !== "boolean") throw new HttpError(400, "invalid_request", `plugins.${id}.enabled must be a boolean`);
    // Mac-wide defaults are a different shape from a project's; a plugin without a machine schema is checked against its project one.
    const module = host.ready(id);
    const schema = module?.machineSettingsSchema ?? module?.settingsSchema;
    if (schema && config.settings !== undefined && !schema.safeParse(config.settings).success) {
      throw new HttpError(400, "invalid_request", `plugins.${id}.settings is not valid for ${id}`);
    }
  }
  return entries;
}

/** What this Mac allows, and installing or removing a plugin folder. Declared before the machine door, which would read `installed` as a plugin id. */
export function pluginRoutes(store: EngineStore, host: PluginHost, folders: PluginFolders): Route[] {
  const { installed } = folders;
  return [
    { method: "GET", path: "/v2/plugins", auth: "engine", handle: () => ok({ plugins: host.statuses(), machine: store.toolchains.machine() }) },
    {
      method: "PATCH",
      path: "/v2/plugins",
      auth: "engine",
      // Turning a plugin off drains it everywhere: running work finishes, nothing is killed.
      handle({ body }) {
        const entries = validMachineEntries(body, host);
        const machine = store.toolchains.updateMachine(entries as Parameters<EngineStore["updateMachinePlugins"]>[0]);
        for (const [id, value] of Object.entries(entries)) {
          const off = value === null || (value as { enabled?: boolean }).enabled === false;
          for (const project of store.projectRegistry.list()) {
            if (off) void host.drainProject(id, project.id);
            else host.cancelDrain(id, project.id);
          }
        }
        return ok({ machine });
      },
    },
    {
      method: "POST",
      path: "/v2/plugins/installed",
      auth: "engine",
      async handle({ body }) {
        const parsed = PluginInstallInput.safeParse(body);
        if (!parsed.success) throw new HttpError(400, "invalid_request", "path must be a folder and mode copy or link");
        let loaded: LoadedExternalPlugin;
        try {
          loaded = installPluginFolder(folders.dir, parsed.data.path, parsed.data.mode, {
            ids: new Set([...BUNDLED_RESERVATIONS.ids, ...installed.loaded.keys()]),
            prefixes: new Set([...BUNDLED_RESERVATIONS.prefixes, ...installed.prefixes()]),
          });
        } catch (error) {
          if (error instanceof PluginInstallError) throw new HttpError(400, "invalid_request", error.message);
          throw error;
        }
        installed.loaded.set(loaded.manifest.id, loaded);
        installed.sync();
        return ok({ plugin: await host.add(folders.moduleFor(loaded)) });
      },
    },
    {
      method: "DELETE",
      path: /^\/v2\/plugins\/installed\/([a-z][a-z0-9-]*)$/,
      auth: "engine",
      body: "raw",
      // Stopped first, so its process is gone before its folder is.
      async handle({ params: [id] }) {
        const folder = installed.loaded.get(id!)?.dir ?? installed.refused.get(id!);
        if (!folder) throw new HttpError(404, "not_found", `no installed plugin ${id}`);
        await host.remove(id!);
        installed.loaded.delete(id!);
        installed.refused.delete(id!);
        installed.sync();
        removePluginFolder(folders.dir, path.basename(folder));
        return ok({ removed: true });
      },
    },
  ];
}
