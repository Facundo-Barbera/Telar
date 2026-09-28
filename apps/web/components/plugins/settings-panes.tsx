/**
 * WHAT A PLUGIN ADDS TO ITS GENERATED SETTINGS, keyed by plugin id — the React
 * half of `lib/plugins/registry.ts`, and the one place the settings pages ask
 * "does this plugin bring its own UI?" instead of naming Data Science or LaTeX.
 *
 * THE GENERATED PANE IS THE DEFAULT (components/plugins/generated-settings.tsx):
 * every field of a plugin's schema that is a toggle, a choice, text, a path or a
 * number is drawn from the schema. What is registered here is only what that
 * cannot draw — a choice whose options come from probing the Mac, a list, an
 * installer:
 *
 *   project        the plugin's whole editor on a project's page, drawn once
 *                  the project has turned it on (`ProjectPluginPanes`). Data
 *                  Science's environments and LaTeX's distributions and main
 *                  file are all probed choices, so both keep theirs.
 *   machineGroups  whole groups on the Plugins page, drawn BEFORE the generated
 *                  group (LaTeX's distribution cards and managed install).
 *   machineRows    rows drawn INSIDE the generated group, after its fields
 *                  (Data Science's default packages list).
 *
 * A plugin absent from here gets the generated pane alone, at both scopes.
 */
import type { ComponentType } from "react";
import type { Project, ProjectPlugins } from "@telar/engine-client";
import { DataSciencePackagesRow } from "@/components/settings/data-science-machine-settings";
import { DataScienceSection } from "@/components/settings/data-science-section";
import { LatexDistributionSettings } from "@/components/settings/latex-machine-settings";
import { LatexSection } from "@/components/settings/latex-section";

export type ProjectSettingsPane = ComponentType<{ project: Project; onChange: (project: Project) => void }>;
export type MachineSettingsBlock = ComponentType<{ machine?: ProjectPlugins; onChange: (machine: ProjectPlugins) => void }>;

export type PluginSettingsPanes = {
  project?: ProjectSettingsPane;
  machineGroups?: MachineSettingsBlock;
  machineRows?: MachineSettingsBlock;
};

export const SETTINGS_PANES: Readonly<Record<string, PluginSettingsPanes>> = {
  "data-science": { project: DataScienceSection, machineRows: DataSciencePackagesRow },
  latex: { project: LatexSection, machineGroups: LatexDistributionSettings },
};

function panesFor(pluginId: string): PluginSettingsPanes | undefined {
  return Object.hasOwn(SETTINGS_PANES, pluginId) ? SETTINGS_PANES[pluginId] : undefined;
}

export function projectPaneFor(pluginId: string): ProjectSettingsPane | undefined {
  return panesFor(pluginId)?.project;
}

export function machineBlocksFor(pluginId: string): Pick<PluginSettingsPanes, "machineGroups" | "machineRows"> {
  const panes = panesFor(pluginId);
  return {
    ...(panes?.machineGroups ? { machineGroups: panes.machineGroups } : {}),
    ...(panes?.machineRows ? { machineRows: panes.machineRows } : {}),
  };
}
