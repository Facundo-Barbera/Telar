/**
 * PANELS AN INSTALLED PLUGIN DRAWS FROM BLOCKS — which ones a project offers.
 *
 * A bundled plugin ships React components (`registry.ts`); an installed one
 * declares panels in its manifest and answers each with blocks. They share one
 * right-panel tab, "Plugins", shown only while an enabled plugin has a panel.
 */
import type { PluginPanel, PluginStatus } from "@telar/engine-client";

export type PluginPanelSource = { plugin: string; pluginName: string; panel: PluginPanel };

/** The enabled, running plugins' panels, in the order the engine lists them. */
export function pluginPanelSources(statuses: readonly PluginStatus[], enabled: readonly string[]): PluginPanelSource[] {
  const on = new Set(enabled);
  return statuses.flatMap((status) =>
    status.state === "ready" && on.has(status.meta.id)
      ? (status.meta.panels ?? []).map((panel) => ({ plugin: status.meta.id, pluginName: status.meta.name, panel }))
      : [],
  );
}

export const panelSourceKey = (source: PluginPanelSource) => `${source.plugin}/${source.panel.id}`;
