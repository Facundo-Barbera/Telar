import type { PluginStatus, ProjectPlugins } from "@telar/engine-client";
import { machineAllows, pluginConfigFromLegacy } from "@telar/engine-client";

export type PluginSectionEntry = {
  key: string;
  pluginId: string;
  sectionId: string;
  label: string;
  blurb?: string;
  icon?: string;
  scope: "project" | "machine";
  state: PluginStatus["state"];
  error?: string;
  settingsSchema?: Record<string, unknown>;
};

export function projectPluginSections(plugins: readonly PluginStatus[] | undefined): PluginSectionEntry[] {
  const entries: PluginSectionEntry[] = [];
  for (const status of plugins ?? []) {
    const sections = status.meta.settings.filter((section) => section.scope === "project");
    const declared =
      sections.length > 0
        ? sections
        : [{ id: "general", scope: "project" as const, label: status.meta.name, ...(status.meta.blurb ? { blurb: status.meta.blurb } : {}), ...(status.meta.icon ? { icon: status.meta.icon } : {}) }];
    for (const [index, section] of declared.entries()) {
      entries.push({
        key: index === 0 ? status.meta.id : `${status.meta.id}:${section.id}`,
        pluginId: status.meta.id,
        sectionId: section.id,
        label: section.label,
        ...(section.blurb ? { blurb: section.blurb } : {}),
        ...(section.icon ? { icon: section.icon } : {}),
        scope: "project",
        state: status.state,
        ...(status.error ? { error: status.error } : {}),
        ...(index === 0 && status.settingsSchema ? { settingsSchema: status.settingsSchema } : {}),
      });
    }
  }
  return entries;
}

export function enablePatch(pluginId: string, enabled: boolean, settings?: Record<string, unknown>) {
  return {
    plugins: {
      [pluginId]: enabled ? { enabled: true, ...(settings ? { settings } : {}) } : null,
    },
  };
}

export function blockPatch(pluginId: string, block: { enabled: boolean; [setting: string]: unknown } | null) {
  return { plugins: { [pluginId]: block && pluginConfigFromLegacy(block) } };
}

export function machineSettingsPatch(machine: ProjectPlugins | undefined, pluginId: string, settings: Record<string, unknown>) {
  return { [pluginId]: { enabled: machineAllows(machine, pluginId), settings } };
}
