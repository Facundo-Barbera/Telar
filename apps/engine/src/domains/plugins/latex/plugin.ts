import { z } from "zod";
import { LatexBootstrap, LatexMachineSettings, LatexMachineSettingsWrite, PLUGIN_API_VERSION, type PluginMeta } from "@telar/engine-client";
import type { PluginToolchains } from "../toolchains";
import type { LatexOps } from "./operations";
import { jobCursor, PluginInputError, type PluginMachineRoutes, type PluginProjectRoutes } from "../scoped-routes";
import type { LatexCapability } from "./capability";
import { clientLatexCapability } from "./client-capability";
import { latexTools } from "./latex-tools";
import type { PluginEngineModule, PluginInitContext } from "../contract";
import type { PluginToolModule } from "../tool-module";

export { LatexMachineSettings };

export const LatexSettings = z.object({
  toolchain: z
    .object({
      kind: z.string().min(1),
      path: z.string().min(1),
      engine: z.string().min(1).optional(),
    })
    .optional(),
  mainFile: z.string().min(1).optional(),
});
export type LatexSettings = z.infer<typeof LatexSettings>;

export const latexMeta: PluginMeta = {
  id: "latex",
  api: PLUGIN_API_VERSION,
  name: "LaTeX",
  version: "1.0.0",
  blurb: "Compile TeX documents, read the log, and manage packages.",
  icon: "FileText",
  toolPrefixes: ["latex"],
  readTools: [],
  briefing: [
    "This project has LaTeX on.",
    "`latex_compile` builds the project's main document (or a path you name) and `latex_log` reads the log around an error;",
    "`latex_packages` and `latex_install` manage the distribution's packages. Compile with these rather than invoking TeX from the shell.",
  ].join(" "),
  eventKinds: ["latex.compile.state"],
  settings: [
    {
      id: "toolchain",
      scope: "machine",
      label: "Compiling",
      blurb: "How a compile runs here, unless the project says otherwise.",
      icon: "HardDrive",
    },
    {
      id: "document",
      scope: "project",
      label: "LaTeX",
      blurb: "The document a compile builds, for this project.",
      icon: "FileText",
    },
  ],
};

export const latexToolModule: PluginToolModule = {
  meta: latexMeta,
  capability: (call) => clientLatexCapability(call),
  tools: (tool, capability) => latexTools(tool, capability as LatexCapability),
};

export type LatexPluginDeps = {
  resolve: (sessionId: string) => LatexCapability;
  jobs: {
    list(): { status: string }[];
    disposeAll(): void;
  };
  settings: Pick<LatexOps, "distributions" | "packages" | "install" | "bootstrap" | "toolchain" | "job" | "cancelJob">;
  managed: Pick<PluginToolchains, "managedStatus" | "installManaged">;
};

function latexScopedRoutes({ settings, managed }: LatexPluginDeps): { project: PluginProjectRoutes; machine: PluginMachineRoutes } {
  return {
    project: {
      "GET distributions": { beforeEnable: true, handle: (_request, { projectId }) => settings.distributions(projectId) },
      "GET packages": { handle: (_request, { projectId }) => settings.packages(projectId) },
      "POST packages": {
        status: 202,
        handle: ({ input }, { projectId }) => {
          const list = (key: string) => (Array.isArray(input[key]) ? (input[key] as unknown[]).map(String) : undefined);
          return settings.install(projectId, {
            ...(list("add") ? { add: list("add")! } : {}),
            ...(list("remove") ? { remove: list("remove")! } : {}),
          });
        },
      },
    },
    machine: {
      "POST bootstrap": {
        status: 202,
        handle: ({ input }) => {
          const parsed = LatexBootstrap.safeParse(input);
          if (!parsed.success) throw new PluginInputError("not a valid bootstrap request");
          return settings.bootstrap(parsed.data);
        },
      },
      "GET toolchain": { handle: async ({ query }) => ({ toolchain: await settings.toolchain(query.get("fresh") === "1") }) },
      "GET managed": { handle: () => ({ managed: managed.managedStatus() }) },
      "POST managed": { status: 202, handle: async () => ({ managed: await managed.installManaged() }) },
      "GET jobs/:id": {
        handle: ({ query, params }) => ({ job: settings.job(params.id!, jobCursor(query)) }),
      },
      "DELETE jobs/:id": {
        handle: ({ params }) => {
          settings.cancelJob(params.id!);
          return {};
        },
      },
    },
  };
}

export function latexPlugin(deps: LatexPluginDeps): PluginEngineModule<LatexSettings> {
  const scoped = latexScopedRoutes(deps);
  return {
    meta: latexMeta,
    settingsSchema: LatexSettings,
    machineSettingsSchema: LatexMachineSettingsWrite,

    init(context: PluginInitContext) {
      context.onDispose("latex jobs", () => deps.jobs.disposeAll());
    },

    hooks: {
      drain: () => undefined,

      busy: () => deps.jobs.list().some((job) => job.status === "running"),
    },

    routes: {
      toolchain: (_input, capability) => (capability as LatexCapability).toolchain(),
      compile: (input, capability) =>
        (capability as LatexCapability).compile({
          ...(typeof input.path === "string" ? { path: input.path } : {}),
          ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
        }),
      status: (_input, capability) => (capability as LatexCapability).status(),
      log: (input, capability) =>
        (capability as LatexCapability).log({
          ...(typeof input.tail === "number" ? { tail: input.tail } : {}),
          ...(typeof input.around === "number" ? { around: input.around } : {}),
          ...(typeof input.find === "string" ? { find: input.find } : {}),
        }),
      packages: (_input, capability) => (capability as LatexCapability).packages(),
      install: (input, capability) =>
        (capability as LatexCapability).install({
          ...(Array.isArray(input.add) ? { add: input.add.map(String) } : {}),
          ...(Array.isArray(input.remove) ? { remove: input.remove.map(String) } : {}),
        }),
      clean: (input, capability) => (capability as LatexCapability).clean(input.pdf === true ? { pdf: true } : {}),
    },

    projectRoutes: scoped.project,
    machineRoutes: scoped.machine,

    resolve: (sessionId) => deps.resolve(sessionId),
  };
}
