/**
 * WHAT EACH PLUGIN CONTRIBUTES TO THE WEB COCKPIT, keyed by plugin id — the
 * one place the panel, the Editor, the command handlers and the journal ask
 * "does a plugin own this?" instead of naming Data Science or LaTeX.
 *
 * DATA, NOT COMPONENTS. This file is imported by pure libraries (the journal
 * fold, the Editor's workspace), so it holds ids, labels and functions only.
 * The React half — which component draws a surface or a settings pane — is
 * `components/plugins/`, keyed by the same ids.
 *
 * GATED BY THE ENABLED IDS THE COCKPIT ALREADY HAS (`cockpitPlugins`). A plugin
 * with no entry here contributes nothing and breaks nothing: the proof plugin
 * `hello` is enabled in tests and draws no tab, opener or command.
 */
import { FlaskConicalIcon, PuzzleIcon, SigmaIcon, type LucideIcon } from "lucide-react";
import type { CommandId } from "@/lib/commands";

/** A right-panel tab a plugin owns. `wide` asks for the wide default width. */
export type PluginSurface = { id: string; label: string; icon: LucideIcon; blurb: string; wide?: boolean };

/**
 * A file viewer a plugin owns, by the viewer `fileKind` names. `pdf` is NOT
 * one: a document renders wherever it is opened from (the tree, the display
 * tool, a compile), so it is core and needs no plugin on.
 */
type PluginViewer = "notebook" | "table";

export type PluginWebContribution = {
  surfaces?: readonly PluginSurface[];
  viewers?: readonly PluginViewer[];
  /** A command that opens one of this plugin's surfaces, bound only while it is on. */
  commands?: readonly { id: CommandId; surface: string }[];
};

export const PLUGIN_WEB = {
  /**
   * ONE "Data" tab — plots, variables and the environment are three views of
   * one kernel, switched inside it (session/data-surface.tsx). And the two
   * file kinds that need that kernel to be worth more than text.
   */
  "data-science": {
    surfaces: [{ id: "data", label: "Data", icon: FlaskConicalIcon, blurb: "Plots, variables and the Python environment", wide: true }],
    viewers: ["notebook", "table"],
    commands: [{ id: "open-data", surface: "data" }],
  },
  /**
   * ONE "LaTeX" tab — compile status, structured errors, the log tail. The PDF
   * itself is a file, opened by the core viewer.
   */
  latex: {
    surfaces: [{ id: "latex", label: "LaTeX", icon: SigmaIcon, blurb: "Compile status, errors and the log" }],
    commands: [{ id: "open-latex", surface: "latex" }],
  },
} as const satisfies Record<string, PluginWebContribution>;

/**
 * THE ONE TAB EVERY INSTALLED PLUGIN'S PANELS SHARE (lib/plugins/panels.ts).
 * Installed plugins are not in `PLUGIN_WEB`: they bring blocks, not
 * components, so they need no entry — only a place to be drawn.
 */
const PLUGIN_PANELS_SURFACE = {
  id: "plugin-panels",
  label: "Plugins",
  icon: PuzzleIcon,
  blurb: "Panels from the plugins you installed",
} as const satisfies PluginSurface;

/** The id of a surface some plugin contributes — part of `PanelTab`'s vocabulary. */
export type PluginSurfaceId = (typeof PLUGIN_WEB)[keyof typeof PLUGIN_WEB]["surfaces"][number]["id"] | typeof PLUGIN_PANELS_SURFACE.id;

const REGISTRY: Readonly<Record<string, PluginWebContribution>> = PLUGIN_WEB;

const contributions = (enabled: readonly string[]): PluginWebContribution[] =>
  enabled.flatMap((id) => (REGISTRY[id] ? [REGISTRY[id]] : []));

/** Every surface any plugin could contribute — so a restored tab id still validates. */
export const PLUGIN_SURFACES: readonly (PluginSurface & { id: PluginSurfaceId })[] = [
  ...Object.values(REGISTRY).flatMap((entry) => (entry.surfaces ?? []) as readonly (PluginSurface & { id: PluginSurfaceId })[]),
  PLUGIN_PANELS_SURFACE,
];

/** The surfaces the enabled plugins contribute, in registry order, then the
 *  installed plugins' shared tab when one of them has a panel. */
export function pluginSurfaces(enabled: readonly string[], hasPanels = false): (PluginSurface & { id: PluginSurfaceId })[] {
  const on = new Set(enabled);
  return [
    ...Object.entries(REGISTRY).flatMap(([id, entry]) =>
      on.has(id) ? [...((entry.surfaces ?? []) as readonly (PluginSurface & { id: PluginSurfaceId })[])] : [],
    ),
    ...(hasPanels ? [PLUGIN_PANELS_SURFACE] : []),
  ];
}

/** Does a plugin own this surface id (whether or not it is on)? */
export function isPluginSurface(id: string): id is PluginSurfaceId {
  return PLUGIN_SURFACES.some((surface) => surface.id === id);
}

/** Is this viewer available? Core viewers always are; a plugin's only while it is on. */
export function viewerAvailable(viewer: string | undefined, enabled: readonly string[]): boolean {
  if (viewer === undefined) return false;
  const owned = Object.values(REGISTRY).some((entry) => entry.viewers?.includes(viewer as PluginViewer));
  return !owned || contributions(enabled).some((entry) => entry.viewers?.includes(viewer as PluginViewer));
}

/** The commands the enabled plugins bind, each naming the surface it opens. */
export function pluginCommands(enabled: readonly string[]): { id: CommandId; surface: string }[] {
  return contributions(enabled).flatMap((entry) => [...(entry.commands ?? [])]);
}
