import { z } from "zod";
import {
  DataScienceBootstrap,
  DataScienceConfig,
  DataScienceCreateEnvironment,
  DataScienceMachineSettings,
  DataScienceMachineSettingsWrite,
  PLUGIN_API_VERSION,
  type PluginMeta,
} from "@telar/engine-client";
import type { EngineStore } from "../../../state";
import { jobCursor, PluginInputError, requiredString, type PluginMachineRoutes, type PluginProjectRoutes } from "../scoped-routes";
import type { DsCapability } from "./capability";
import { KernelHost, type KernelHostOptions } from "./kernel-host";
import { clientDsCapability } from "./client-capability";
import { dsTools } from "./ds-tools";
import { notebookTools } from "./notebook-tools";
import type { PluginEngineModule, PluginInitContext } from "../contract";
import type { PluginToolModule } from "../tool-module";

export { DataScienceMachineSettings };

export const DataScienceSettings = DataScienceConfig.omit({ enabled: true });
export type DataScienceSettings = z.infer<typeof DataScienceSettings>;

export const dataScienceMeta: PluginMeta = {
  id: "data-science",
  api: PLUGIN_API_VERSION,
  name: "Data science",
  version: "1.0.0",
  blurb: "A Python kernel per session: cells, notebooks, plots and snapshots.",
  icon: "FlaskConical",
  toolPrefixes: ["ds", "notebook"],
  readTools: ["ds_packages", "ds_kernel"],
  briefing: [
    "This project has data science on: a Python kernel per session, in the session's own directory.",
    "`notebook_*` opens, edits and runs `.ipynb` cells in that kernel; `ds_*` works with its state (vars, plots, snapshots, packages).",
    "Prefer these over shelling out to Python, and read each tool's description for its contract.",
  ].join(" "),
  eventKinds: ["kernel.state.changed"],
  sessionStateDir: "ds",
  gitignore: {
    rule: ".telar/ds/",
    why: "kernel state and snapshots from Telar's cells",
    alreadyCovered: [".telar/", ".telar", "/.telar/", ".telar/ds/"],
  },
  settings: [
    {
      id: "environment",
      scope: "project",
      label: "Data science",
      blurb: "The Python environment this project's kernel runs in.",
      icon: "FlaskConical",
    },
    {
      id: "defaults",
      scope: "machine",
      label: "Data science defaults",
      blurb: "What a project on this Mac inherits when it has not chosen for itself.",
      icon: "FlaskConical",
    },
  ],
};

export const dataScienceToolModule: PluginToolModule = {
  meta: dataScienceMeta,
  capability: (call) => clientDsCapability(call),
  tools: (tool, capability) => [
    ...notebookTools(tool, capability as DsCapability),
    ...dsTools(tool, capability as DsCapability),
  ],
};

export type DataSciencePluginDeps = {
  resolve: (sessionId: string) => DsCapability;
  kernelHost?: {
    options: KernelHostOptions;
    attach(host: KernelHost): void;
  };
  projectOf: (sessionId: string) => string | undefined;
  settings: Pick<
    EngineStore,
    | "dataScienceEnvironments"
    | "dataScienceCreateEnvironment"
    | "dataSciencePackages"
    | "dataScienceInstall"
    | "dataScienceProbe"
    | "dataScienceBootstrap"
    | "dataScienceToolchain"
    | "dataScienceJob"
    | "dataScienceCancelJob"
  >;
};

function dataScienceScopedRoutes(settings: DataSciencePluginDeps["settings"]): {
  project: PluginProjectRoutes;
  machine: PluginMachineRoutes;
} {
  const list = (input: Record<string, unknown>, key: string) =>
    Array.isArray(input[key]) ? (input[key] as unknown[]).map(String) : undefined;
  return {
    project: {
      "GET environments": { beforeEnable: true, handle: (_request, { projectId }) => settings.dataScienceEnvironments(projectId) },
      "POST environments": {
        status: 202,
        beforeEnable: true,
        handle: ({ input }, { projectId }) => {
          const parsed = DataScienceCreateEnvironment.safeParse(input);
          if (!parsed.success) throw new PluginInputError("not a valid environment request");
          return settings.dataScienceCreateEnvironment(projectId, parsed.data);
        },
      },
      "POST probe": {
        beforeEnable: true,
        handle: async ({ input }, { projectId }) => ({
          probe: await settings.dataScienceProbe(projectId, requiredString(input.path, "python path")),
        }),
      },
      "GET packages": { handle: (_request, { projectId }) => settings.dataSciencePackages(projectId) },
      "POST packages": {
        status: 202,
        handle: ({ input }, { projectId }) =>
          settings.dataScienceInstall(projectId, {
            ...(list(input, "add") ? { add: list(input, "add")! } : {}),
            ...(list(input, "remove") ? { remove: list(input, "remove")! } : {}),
            ...(typeof input.requirements === "string"
              ? { requirements: input.requirements as Parameters<typeof settings.dataScienceInstall>[1]["requirements"] }
              : {}),
          }),
      },
    },
    machine: {
      "POST bootstrap": {
        status: 202,
        handle: ({ input }) => {
          const parsed = DataScienceBootstrap.safeParse(input);
          if (!parsed.success) throw new PluginInputError("not a valid bootstrap request");
          return settings.dataScienceBootstrap(parsed.data);
        },
      },
      "GET toolchain": { handle: async ({ query }) => ({ toolchain: await settings.dataScienceToolchain(query.get("fresh") === "1") }) },
      "GET jobs/:id": { handle: ({ query, params }) => ({ job: settings.dataScienceJob(params.id!, jobCursor(query)) }) },
      "DELETE jobs/:id": {
        handle: ({ params }) => {
          settings.dataScienceCancelJob(params.id!);
          return {};
        },
      },
    },
  };
}

export function dataSciencePlugin(deps: DataSciencePluginDeps): PluginEngineModule<DataScienceSettings> {
  let kernels: KernelHost | undefined;
  const live = () => kernels?.list() ?? [];
  const sessionsOf = (projectId: string): string[] =>
    live()
      .map((kernel) => kernel.sessionId)
      .filter((sessionId) => deps.projectOf(sessionId) === projectId);
  const scoped = dataScienceScopedRoutes(deps.settings);

  return {
    meta: dataScienceMeta,
    settingsSchema: DataScienceSettings,
    machineSettingsSchema: DataScienceMachineSettingsWrite,

    init(context: PluginInitContext) {
      if (!deps.kernelHost) return;
      const host = new KernelHost(deps.kernelHost.options);
      kernels = host;
      context.onDispose("data science kernels", () => host.disposeAll("engine shutting down"));
      deps.kernelHost.attach(host);
    },

    hooks: {
      drain: () => undefined,

      busy: (projectId) =>
        live().some((kernel) => deps.projectOf(kernel.sessionId) === projectId && kernel.state === "busy"),

      releaseProject: async (projectId) => {
        await Promise.all(sessionsOf(projectId).map((sessionId) => kernels?.dispose(sessionId, "data science disabled")));
      },

      releaseSession: (sessionId, reason) => void kernels?.dispose(sessionId, reason),
    },

    routes: {
      kernel: (_input, capability) => (capability as DsCapability).kernel(),
      execute: (input, capability) =>
        (capability as DsCapability).execute({
          code: String(input.code ?? ""),
          ...(typeof input.cellId === "string" ? { cellId: input.cellId } : {}),
          ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
          ...(typeof input.producer === "string" ? { producer: input.producer } : {}),
        }),
      interrupt: (_input, capability) => (capability as DsCapability).interrupt(),
      restart: (_input, capability) => (capability as DsCapability).restart(),
      vars: (input, capability) => (capability as DsCapability).vars(typeof input.limit === "number" ? input.limit : undefined),
      inspect: (input, capability) =>
        (capability as DsCapability).inspect(String(input.name ?? ""), typeof input.depth === "number" ? input.depth : undefined),
      "notebook/read": (input, capability) =>
        (capability as DsCapability).notebookRead(String(input.path ?? ""), {
          ...(typeof input.from === "number" ? { from: input.from } : {}),
          ...(typeof input.to === "number" ? { to: input.to } : {}),
          ...(input.withOutputs === true ? { withOutputs: true } : {}),
        }),
      "notebook/edit": (input, capability) =>
        (capability as DsCapability).notebookEdit(String(input.path ?? ""), input.edit as Parameters<DsCapability["notebookEdit"]>[1]),
      "notebook/run": (input, capability) =>
        (capability as DsCapability).notebookRun(String(input.path ?? ""), {
          ...(typeof input.cellId === "string" ? { cellId: input.cellId } : {}),
          ...(input.all === true ? { all: true } : {}),
          ...(typeof input.stopOnError === "boolean" ? { stopOnError: input.stopOnError } : {}),
        }),
      plot: (input, capability) =>
        (capability as DsCapability).plot({
          code: String(input.code ?? ""),
          ...(typeof input.title === "string" ? { title: input.title } : {}),
        }),
      snapshot: (input, capability) =>
        (capability as DsCapability).snapshot(
          String(input.name ?? ""),
          Array.isArray(input.vars) ? input.vars.map(String) : undefined,
        ),
      snapshots: (_input, capability) => (capability as DsCapability).snapshots(),
      diff: (input, capability) => (capability as DsCapability).diff(String(input.from ?? ""), String(input.to ?? "")),
      checkpoint: (input, capability) =>
        (capability as DsCapability).checkpoint({
          action: String(input.action ?? "list") as "save" | "restore" | "list",
          ...(typeof input.name === "string" ? { name: input.name } : {}),
        }),
      lineage: (input, capability) =>
        (capability as DsCapability).lineage(typeof input.of === "string" ? input.of : undefined),
      watches: (_input, capability) => (capability as DsCapability).watches(),
      watch: (input, capability) =>
        (capability as DsCapability).watch({
          name: String(input.name ?? ""),
          ...(typeof input.assert === "string" ? { assert: input.assert } : {}),
          ...(input.remove === true ? { remove: true } : {}),
        }),
      env: (input, capability) =>
        (capability as DsCapability).environment(typeof input.use === "string" ? { use: input.use } : {}),
      packages: (_input, capability) => (capability as DsCapability).packages(),
      install: (input, capability) =>
        (capability as DsCapability).install({
          ...(Array.isArray(input.add) ? { add: input.add.map(String) } : {}),
          ...(Array.isArray(input.remove) ? { remove: input.remove.map(String) } : {}),
          ...(typeof input.requirements === "string" ? { requirements: input.requirements } : {}),
        }),
      experiment: (input, capability) =>
        (capability as DsCapability).experiment({
          action: String(input.action ?? "list") as "start" | "log" | "end" | "list",
          ...(typeof input.name === "string" ? { name: input.name } : {}),
          ...(input.params && typeof input.params === "object" ? { params: input.params as Record<string, unknown> } : {}),
          ...(input.metrics && typeof input.metrics === "object" ? { metrics: input.metrics as Record<string, number> } : {}),
        }),
    },

    projectRoutes: scoped.project,
    machineRoutes: scoped.machine,

    resolve: (sessionId) => deps.resolve(sessionId),
  };
}
