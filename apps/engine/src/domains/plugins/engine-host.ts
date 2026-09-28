import path from "node:path";
import { BUNDLED_PLUGIN_TOOL_PREFIXES, machineAllows, pluginSettings, readProjectPlugins } from "@telar/engine-client";
import { EngineStateError } from "../../platform/kernel/errors";
import type { EngineStore } from "../../state";
import { bundledPlugins } from "./bundled";
import { isSymlink } from "./external/installer";
import { loadInstalledPlugins, type LoadedExternalPlugin } from "./external/manifest";
import { externalPlugin } from "./external/module";
import { PluginHost } from "./host";
import { installedPlugins } from "./installed";

type EnginePluginOptions = { dir: string; daemonId: string; stateDir: string; withKernels: boolean };

/**
 * The engine's plugin host: the bundled plugins plus whatever is installed under `dir`. Every door and tool wall
 * reaches a plugin through `resolve`, the one gate that refuses a plugin turned off for the Mac or the project.
 */
export function createEnginePlugins(store: EngineStore, { dir, daemonId, stateDir, withKernels }: EnginePluginOptions) {
  const resolve = (pluginId: string, sessionId: string): { projectId: string; sessionId: string } => {
    const session = store.getSession(sessionId);
    if (!session.projectId) throw new EngineStateError("invalid_request", `${pluginId} needs a project`);
    const project = store.getProject(session.projectId);
    if (!store.pluginRuns(project, pluginId)) {
      const why = machineAllows(store.machinePlugins(), pluginId) ? `${pluginId} is not enabled for this session's project` : `${pluginId} is turned off for this Mac`;
      throw new EngineStateError("invalid_request", why);
    }
    return { projectId: project.id, sessionId };
  };
  const bundled = bundledPlugins({
    resolveHello: (sessionId) => resolve("hello", sessionId),
    latex: { resolve: (sessionId) => store.latex(sessionId), jobs: store.latexJobs, settings: store },
    dataScience: {
      resolve: (sessionId) => store.dataScience(sessionId),
      settings: store,
      // Kernels only on an engine that runs turns; outputs are journaled by the store, the host persists images.
      ...(withKernels
        ? {
            kernelHost: {
              options: {
                engineRoot: store.paths.root,
                sessionDir: (sessionId: string) => path.join(store.paths.sessions, sessionId),
                events: {
                  onState: (sessionId, state, reason) => store.recordKernelState(sessionId, state, reason),
                  persistImage: (sessionId, input) =>
                    store.putAttachment(sessionId, {
                      name: `${input.producer}.${input.mediaType === "image/svg+xml" ? "svg" : "png"}`,
                      mediaType: input.mediaType,
                      data: input.data,
                      tags: ["plot"],
                      producer: input.producer,
                      ...(input.title ? { title: input.title } : {}),
                    }).id,
                },
              },
              attach: (host) => store.attachKernels(host),
            },
          }
        : {}),
      projectOf: (sessionId) => {
        try {
          return store.getSession(sessionId).projectId;
        } catch {
          return undefined;
        }
      },
    },
  });
  const moduleFor = (loaded: LoadedExternalPlugin) =>
    externalPlugin(loaded, {
      resolve: (sessionId) => resolve(loaded.manifest.id, sessionId),
      enabledAnywhere: () => store.listProjects().some((project) => store.pluginRuns(project, loaded.manifest.id)),
      settings: (projectId) => {
        const machine = pluginSettings(store.machinePlugins(), loaded.manifest.id);
        if (projectId === undefined) return machine;
        try {
          return { ...machine, ...pluginSettings(readProjectPlugins(store.getProject(projectId)).plugins, loaded.manifest.id) };
        } catch {
          return machine;
        }
      },
    });
  const external = loadInstalledPlugins(dir);
  const installed = installedPlugins(external);
  const host = new PluginHost([...bundled, ...external.loaded.map(moduleFor)], {
    daemonId,
    stateDir,
    declaredPrefixes: [...BUNDLED_PLUGIN_TOOL_PREFIXES, ...installed.prefixes()],
    refused: external.refused.map(({ dir: folder, meta, error }) => ({ meta, error, installed: { linked: isSymlink(folder) } })),
    log: (message, detail) => console.warn(`[telar] ${message}${detail ? ` ${JSON.stringify(detail)}` : ""}`),
  });
  return { host, installed, moduleFor, dir };
}
