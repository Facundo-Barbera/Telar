import { FlaskConicalIcon, PuzzleIcon, SigmaIcon, type LucideIcon } from "lucide-react";
import type { CommandId } from "@/features/commands/index";

export type PluginSurface = { id: string; label: string; icon: LucideIcon; blurb: string; wide?: boolean };

type PluginViewer = "notebook" | "table";

export type PluginWebContribution = {
  surfaces?: readonly PluginSurface[];
  viewers?: readonly PluginViewer[];
  commands?: readonly { id: CommandId; surface: string }[];
};

export const PLUGIN_WEB = {
  "data-science": {
    surfaces: [{ id: "data", label: "Data", icon: FlaskConicalIcon, blurb: "Plots, variables and the Python environment", wide: true }],
    viewers: ["notebook", "table"],
    commands: [{ id: "open-data", surface: "data" }],
  },
  latex: {
    surfaces: [{ id: "latex", label: "LaTeX", icon: SigmaIcon, blurb: "Compile status, errors and the log" }],
    commands: [{ id: "open-latex", surface: "latex" }],
  },
} as const satisfies Record<string, PluginWebContribution>;

const PLUGIN_PANELS_SURFACE = {
  id: "plugin-panels",
  label: "Plugins",
  icon: PuzzleIcon,
  blurb: "Panels from the plugins you installed",
} as const satisfies PluginSurface;

export type PluginSurfaceId = (typeof PLUGIN_WEB)[keyof typeof PLUGIN_WEB]["surfaces"][number]["id"] | typeof PLUGIN_PANELS_SURFACE.id;

const REGISTRY: Readonly<Record<string, PluginWebContribution>> = PLUGIN_WEB;

const contributions = (enabled: readonly string[]): PluginWebContribution[] =>
  enabled.flatMap((id) => (REGISTRY[id] ? [REGISTRY[id]] : []));

export const PLUGIN_SURFACES: readonly (PluginSurface & { id: PluginSurfaceId })[] = [
  ...Object.values(REGISTRY).flatMap((entry) => (entry.surfaces ?? []) as readonly (PluginSurface & { id: PluginSurfaceId })[]),
  PLUGIN_PANELS_SURFACE,
];

export function pluginSurfaces(enabled: readonly string[], hasPanels = false): (PluginSurface & { id: PluginSurfaceId })[] {
  const on = new Set(enabled);
  return [
    ...Object.entries(REGISTRY).flatMap(([id, entry]) =>
      on.has(id) ? [...((entry.surfaces ?? []) as readonly (PluginSurface & { id: PluginSurfaceId })[])] : [],
    ),
    ...(hasPanels ? [PLUGIN_PANELS_SURFACE] : []),
  ];
}

export function isPluginSurface(id: string): id is PluginSurfaceId {
  return PLUGIN_SURFACES.some((surface) => surface.id === id);
}

export function viewerAvailable(viewer: string | undefined, enabled: readonly string[]): boolean {
  if (viewer === undefined) return false;
  const owned = Object.values(REGISTRY).some((entry) => entry.viewers?.includes(viewer as PluginViewer));
  return !owned || contributions(enabled).some((entry) => entry.viewers?.includes(viewer as PluginViewer));
}

export function pluginCommands(enabled: readonly string[]): { id: CommandId; surface: string }[] {
  return contributions(enabled).flatMap((entry) => [...(entry.commands ?? [])]);
}
