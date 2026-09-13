/**
 * DATA SCIENCE, AS A PLUGIN — the second migration, and the one with a runtime.
 *
 * LaTeX migrated a job registry; this migrates a KERNEL: a long-lived process
 * per session that a project can turn off while a cell is still running. So
 * `busy`, `releaseProject` and `releaseSession` are all load-bearing here.
 *
 * TWO PREFIXES, ONE PLUGIN. `ds` and `notebook` are both this plugin's — that
 * is why `toolPrefixes` is a list. Renaming either to match the id would split
 * every approval granted to it, for a tidier string.
 */
import { z } from "zod";
import { DataScienceMachineSettings, DataScienceMachineSettingsWrite, PLUGIN_API_VERSION, type PluginMeta } from "@telar/engine-client";
import type { DsCapability } from "../ds/capability";
import type { PluginEngineModule, PluginInitContext } from "./contract";

/** The lenient reader, for the store's own resolve. See `protocol/plugins.ts`. */
export { DataScienceMachineSettings };

/**
 * WHAT THE PROJECT STORES. The same shape the legacy `Project.dataScience`
 * block holds, field for field, because `pluginConfigFromLegacy` maps one onto
 * the other and a schema that disagreed with the mirror would make a rollback
 * lossy.
 */
export const DataScienceSettings = z.object({
  /** The interpreter the kernel runs. Absolute, checked on disk at resolve. */
  pythonPath: z.string().min(1).optional(),
});
export type DataScienceSettings = z.infer<typeof DataScienceSettings>;

/**
 * `readTools` names what the HOST has already ratified for this plugin —
 * `ds_packages` and `ds_kernel`, which only look. It is still a CLAIM:
 * `policy.ts` intersects it with the host's own table and with this plugin's
 * namespace, so editing this list cannot widen anything.
 *
 * `sessionStateDir` is `ds` rather than `data-science`, and deliberately so: a
 * live user's kernel state lives under `sessions/<id>/ds/` today, and renaming
 * the directory to match the plugin id would move their files for nothing.
 */
export const dataScienceMeta: PluginMeta = {
  id: "data-science",
  api: PLUGIN_API_VERSION,
  name: "Data science",
  version: "1.0.0",
  blurb: "A Python kernel per session: cells, notebooks, plots and snapshots.",
  icon: "FlaskConical",
  toolPrefixes: ["ds", "notebook"],
  readTools: ["ds_packages", "ds_kernel"],
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
    /**
     * THE MAC-WIDE DEFAULTS. Declared as a machine section so the Plugins pane
     * renders them beside LaTeX's; what they mean is "what a project that has
     * not chosen gets", never "what every project uses".
     */
    {
      id: "defaults",
      scope: "machine",
      label: "Data science",
      blurb: "The Python and packages a project inherits on this Mac.",
      icon: "FlaskConical",
    },
  ],
};

/**
 * What the daemon supplies. `resolve` is the store's existing
 * `store.dataScience(sessionId)` — the SAME capability the `/ds/` arm and the
 * tool wall already use, so migrating the door cannot change what is behind it.
 *
 * `kernels` is the host of the live Python processes. Typed structurally
 * against the four methods this needs, so the plugin does not drag the whole
 * kernel host — or the store — into its own tests.
 */
export type DataSciencePluginDeps = {
  resolve: (sessionId: string) => DsCapability;
  kernels: {
    /** Every live kernel, so `busy` can answer per project. */
    list(): { sessionId: string; state: string; projectId?: string }[];
    dispose(sessionId: string, reason: string): Promise<void> | void;
    disposeAll(reason: string): Promise<void> | void;
  };
  /** Which project a session belongs to, for per-project `busy` and release. */
  projectOf: (sessionId: string) => string | undefined;
};

export function dataSciencePlugin(deps: DataSciencePluginDeps): PluginEngineModule<DataScienceSettings> {
  /** Sessions whose kernel belongs to a project, resolved fresh each time. */
  const sessionsOf = (projectId: string): string[] =>
    deps.kernels
      .list()
      .map((kernel) => kernel.sessionId)
      .filter((sessionId) => deps.projectOf(sessionId) === projectId);

  return {
    meta: dataScienceMeta,
    settingsSchema: DataScienceSettings,
    /**
     * THE MAC-WIDE DEFAULTS — a different shape from the project's, and
     * deliberately so. A project stores `pythonPath`, which may be RELATIVE so
     * a worktree resolves its own `.venv`; a machine default cannot be relative
     * to a checkout it knows nothing about, so `python` is absolute. Sharing one
     * schema would have made each half accept the other's lie.
     *
     * THE STRICT VARIANT, because this is the WRITE path — see LaTeX's.
     */
    machineSettingsSchema: DataScienceMachineSettingsWrite,

    /**
     * The kernel host is the STORE'S and outlives any one registration, so
     * nothing is acquired here. What `init` registers is the cleanup, so
     * shutdown gives every kernel back through the host's bounded teardown
     * rather than a hand-written line in `daemon.ts`.
     */
    init(context: PluginInitContext) {
      context.onDispose("data science kernels", () => deps.kernels.disposeAll("engine shutting down"));
    },

    hooks: {
      /**
       * DISABLE MEANS DRAIN, and here that matters more than anywhere else.
       *
       * Unticking "Data science" while a 20-minute training cell is running has
       * not asked to kill it. New work is already refused at the GATE —
       * `store.dataScience` throws the moment the project's entry is gone — so
       * this is a no-op rather than a missing hook: writing a second refusal
       * would be two places to get one rule wrong. The host then polls `busy`
       * and only releases once nothing is executing.
       */
      drain: () => undefined,

      /**
       * PER PROJECT, unlike LaTeX's. A kernel belongs to a session and a session
       * belongs to a project, so "is this project still working" is answerable
       * exactly rather than approximately.
       */
      busy: (projectId) =>
        deps.kernels.list().some((kernel) => deps.projectOf(kernel.sessionId) === projectId && kernel.state === "busy"),

      /** Every idle kernel this project owns, once `busy` has gone false. */
      releaseProject: async (projectId) => {
        await Promise.all(sessionsOf(projectId).map((sessionId) => deps.kernels.dispose(sessionId, "data science disabled")));
      },

      /**
       * A session went away. REPLACES the store's hardcoded
       * `releaseDataScience` call — the store now announces a departure and the
       * host decides who cares, which is the line that stops `state.ts` naming
       * features one by one.
       */
      releaseSession: (sessionId, reason) => void deps.kernels.dispose(sessionId, reason),
    },

    /**
     * THE HTTP DOOR, AS DATA. One entry per verb the cockpit calls, replacing
     * the switch in `daemon.ts` — which stays only as an ALIAS so a released
     * client keeps working. A refusal thrown here becomes `plugin_error`
     * carrying `data-science`, so a dead kernel reads as this plugin's failure
     * rather than the engine's.
     */
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
      /**
       * THE NOTEBOOK VERBS, KEYED AS THE WIRE SPELLS THEM. `notebook` is this
       * plugin's second tool prefix, and both doors deliver the two-segment
       * name — so a table keyed on the first segment routes nothing.
       */
      "notebook/read": (input, capability) =>
        (capability as DsCapability).notebookRead(String(input.path ?? ""), {
          ...(typeof input.from === "number" ? { from: input.from } : {}),
          ...(typeof input.to === "number" ? { to: input.to } : {}),
          ...(input.withOutputs === true ? { withOutputs: true } : {}),
        }),
      /** `edit` is the capability's own union — create, insert, set, delete,
       *  move, clearOutputs — validated there rather than flattened here. */
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
        (capability as DsCapability).environment({ ...(typeof input.use === "string" ? { use: input.use } : {}) }),
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

    resolve: (sessionId) => deps.resolve(sessionId),
  };
}
