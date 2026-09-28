import type { PluginPanel, PluginStatus } from "@telar/engine-client";

export type PluginPanelSource = { plugin: string; pluginName: string; panel: PluginPanel };

export function pluginPanelSources(statuses: readonly PluginStatus[], enabled: readonly string[]): PluginPanelSource[] {
  const on = new Set(enabled);
  return statuses.flatMap((status) =>
    status.state === "ready" && on.has(status.meta.id)
      ? (status.meta.panels ?? []).map((panel) => ({ plugin: status.meta.id, pluginName: status.meta.name, panel }))
      : [],
  );
}

export const panelSourceKey = (source: PluginPanelSource) => `${source.plugin}/${source.panel.id}`;
