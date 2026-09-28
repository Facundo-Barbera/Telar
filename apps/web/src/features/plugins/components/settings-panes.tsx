import type { ComponentType } from "react";
import type { Project, ProjectPlugins } from "@telar/engine-client";
import { DataSciencePackagesRow } from "../data-science/machine-settings";
import { DataScienceSection } from "../data-science/data-science-section";
import { LatexDistributionSettings } from "../latex/machine-settings";
import { LatexSection } from "../latex/latex-section";

export type ProjectSettingsPane = ComponentType<{ project: Project; onChange: (project: Project) => void }>;
type MachineSettingsBlock = ComponentType<{ machine?: ProjectPlugins; onChange: (machine: ProjectPlugins) => void }>;

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
