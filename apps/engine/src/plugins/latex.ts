/**
 * LATEX, AS A PLUGIN — the first migration onto the host, and the one that
 * decides what "migrated" means for the two toolkits that shipped before the
 * host existed.
 *
 * ── WHAT MOVES, AND WHAT DELIBERATELY DOES NOT ──────────────────────────────
 * MOVES: lifecycle (init/dispose, bounded), the drain-on-disable semantics, the
 * per-session release the store used to call by name, the settings SCHEMA, and
 * the HTTP verbs — which stop being a hand-written switch in `daemon.ts` and
 * become a `routes` table like every other plugin's.
 *
 * DOES NOT MOVE: the TOOL WALL's registration. `latex_compile` ships today as
 * `mcp__telar__latex_compile`, and that string is the identity of every
 * remembered approval a user has granted it. Serving it from the plugin socket
 * would rename it to `mcp__telar-plugins__latex_compile` — a different tool as
 * far as every stored grant is concerned. Migrating those grants would mean
 * rewriting a user's recorded decisions on their behalf; NOT migrating them
 * would silently ask again for something already allowed. Neither is a thing a
 * refactor gets to do quietly, so the wall stays exactly where it is.
 *
 * ── WHY THAT IS NOT A HALF-MIGRATION ────────────────────────────────────────
 * The host contract already splits `PluginEngineModule` (lifecycle, routes,
 * settings — the daemon's half) from `PluginToolModule` (the wall — the
 * worker's half). A migrated toolkit supplies the first and keeps the second
 * where it already is. Nothing about the plugin host requires those two halves
 * to travel together; `hello` happens to ship both because it is new and has no
 * grants to preserve.
 *
 * The honest cost, stated: LaTeX's tools remain unreachable from Codex, exactly
 * as they were before this change. That gap is the pre-existing "no in-process
 * `telar` server reaches a Codex turn" one — this migration neither closes nor
 * widens it, and closing it means moving the whole `telar` key onto a socket
 * (core toolkits included), which is its own piece of work with its own
 * compatibility decision.
 */
import { z } from "zod";
import { PLUGIN_API_VERSION, type PluginMeta } from "@telar/engine-client";
import type { LatexCapability } from "../latex/capability";
import type { PluginEngineModule, PluginInitContext } from "./contract";

/**
 * WHAT THE PROJECT STORES. Deliberately the same shape the legacy
 * `Project.latex` block holds, because `pluginConfigFromLegacy` maps one to the
 * other field for field — a settings schema that disagreed with the mirror
 * would make a rollback lossy.
 */
export const LatexSettings = z.object({
  /** The chosen toolchain, as the machine reported it. */
  toolchain: z
    .object({
      kind: z.string().min(1),
      path: z.string().min(1),
      engine: z.string().min(1).optional(),
    })
    .optional(),
  /** The document a bare `latex_compile` builds. */
  mainFile: z.string().min(1).optional(),
});
export type LatexSettings = z.infer<typeof LatexSettings>;

/**
 * `readTools` IS EMPTY, and that is a preserved behaviour rather than an
 * oversight.
 *
 * `latex_status`, `latex_log`, `latex_packages` and `latex_toolchain` do only
 * look, and an earlier draft of this manifest claimed all four. The host
 * refused them — `policy.ts` has `latex: []` — and that refusal is CORRECT for
 * this change: ratifying them would stop those tools parking an approval card,
 * which is a real widening of what LaTeX may do without asking. A migration is
 * not the place to make that decision, so the manifest now says what is
 * actually true today. Ratification is a separate, deliberate change to
 * `HOST_RATIFIED_READ_TOOLS`.
 *
 * `sessionStateDir` is absent: LaTeX keeps its build products under the
 * session's own tree (the out-dir beside the document), not under
 * `sessions/<id>/`, and inventing a directory to match the host's vocabulary
 * would move a live user's files for no reason.
 */
export const latexMeta: PluginMeta = {
  id: "latex",
  api: PLUGIN_API_VERSION,
  name: "LaTeX",
  version: "1.0.0",
  blurb: "Compile TeX documents, read the log, and manage packages.",
  icon: "FileText",
  toolPrefixes: ["latex"],
  readTools: [],
  eventKinds: ["latex.compile.state"],
  settings: [
    {
      id: "toolchain",
      scope: "machine",
      label: "TeX distribution",
      blurb: "Which TeX install this Mac compiles with.",
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

/**
 * What the daemon must supply. `resolve` is the store's existing
 * `store.latex(sessionId)` — the SAME capability the HTTP arm and the tool wall
 * already use, so migrating the door cannot change what is behind it.
 *
 * `jobs` is the compile/tlmgr subprocess registry the store owns. The host needs
 * it for exactly two things the switch statement never did: knowing whether a
 * project is still busy after a drain, and giving the processes back on dispose.
 */
export type LatexPluginDeps = {
  resolve: (sessionId: string) => LatexCapability;
  /**
   * The store's compile/tlmgr registry. Typed structurally against the two
   * `JobRunner` methods this needs, so the plugin does not drag the runner's
   * whole surface — or the store — into its own tests.
   */
  jobs: {
    list(): { status: string }[];
    disposeAll(): void;
  };
};

export function latexPlugin(deps: LatexPluginDeps): PluginEngineModule<LatexSettings> {
  return {
    meta: latexMeta,
    settingsSchema: LatexSettings,

    /**
     * Nothing is ACQUIRED here — the job registry is the store's and outlives
     * any one plugin registration. What `init` registers is the cleanup, so a
     * shutdown gives the subprocesses back through the host's bounded teardown
     * rather than through a hand-written line in `daemon.ts`.
     */
    init(context: PluginInitContext) {
      context.onDispose("latex jobs", () => deps.jobs.disposeAll());
    },

    hooks: {
      /**
       * DISABLE MEANS DRAIN. Unticking "LaTeX" while a 40-second compile is
       * running has not asked to kill it — the host refuses new work at the
       * GATE (`store.latex` throws the moment the project's entry is gone, so
       * no further compile can start), waits for `busy` to go false, and only
       * then releases. Cancelling remains a separate, explicit user action.
       *
       * `drain` is therefore a no-op rather than a missing hook: the refusal
       * already happened in `resolve`, and writing a second one here would be
       * two places to get the same rule wrong.
       */
      drain: () => undefined,

      /**
       * BUSY IS DELIBERATELY COARSE — "is any LaTeX job running", not "is one
       * running for this project".
       *
       * A compile's lock is its TeX bin directory, which is a property of the
       * machine rather than of a project, so the runner has no per-project
       * attribution to give and inventing one here would be a guess. Erring
       * toward busy delays a release; erring toward idle would tear a running
       * compile's process group out from under it. Only one of those is
       * recoverable.
       */
      busy: () => deps.jobs.list().some((job) => job.status === "running"),
    },

    /**
     * THE HTTP DOOR, AS DATA. One entry per verb the cockpit calls, replacing
     * the switch in `daemon.ts` — which stays only as an ALIAS so a released
     * client pointed at this daemon keeps working. The daemon parses the body
     * and writes the response; a refusal thrown here becomes `plugin_error`
     * carrying `latex`, so a broken toolchain reads as LaTeX's failure rather
     * than the engine's.
     */
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
      clean: (input, capability) => (capability as LatexCapability).clean({ ...(input.pdf === true ? { pdf: true } : {}) }),
    },

    resolve: (sessionId) => deps.resolve(sessionId),
  };
}
