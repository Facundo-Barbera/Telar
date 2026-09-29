import type { ComponentType } from "react";
import type { Project, ProjectPlugins } from "@telar/engine-client";
import { DataSciencePackagesRow } from "../data-science/machine-settings";
import { DataScienceSection, dataScienceToggle } from "../data-science/data-science-section";
import { LatexDistributionSettings } from "../latex/machine-settings";
import { LatexSection, latexToggle } from "../latex/latex-section";
import { blockPatch, enablePatch } from "../sections";

export type ProjectSettingsPane = ComponentType<{ project: Project; onChange: (project: Project) => void }>;
type MachineSettingsBlock = ComponentType<{ machine?: ProjectPlugins; onChange: (machine: ProjectPlugins) => void }>;
type ProjectToggle = (project: Project, next: boolean) => { enabled: boolean; [setting: string]: unknown } | null;

export type PluginSettingsPanes = {
  project?: ProjectSettingsPane;
  projectToggle?: ProjectToggle;
  machineGroups?: MachineSettingsBlock;
  machineRows?: MachineSettingsBlock;
};

export const SETTINGS_PANES: Readonly<Record<string, PluginSettingsPanes>> = {
  "data-science": { project: DataScienceSection, projectToggle: dataScienceToggle, machineRows: DataSciencePackagesRow },
  latex: { project: LatexSection, projectToggle: latexToggle, machineGroups: LatexDistributionSettings },
};

function panesFor(pluginId: string): PluginSettingsPanes | undefined {
  return Object.hasOwn(SETTINGS_PANES, pluginId) ? SETTINGS_PANES[pluginId] : undefined;
}

export function projectPaneFor(pluginId: string): ProjectSettingsPane | undefined {
  return panesFor(pluginId)?.project;
}

export function projectTogglePatch(project: Project, pluginId: string, next: boolean) {
  const toggle = panesFor(pluginId)?.projectToggle;
  return toggle ? blockPatch(pluginId, toggle(project, next)) : enablePatch(pluginId, next);
}

export function machineBlocksFor(pluginId: string): Pick<PluginSettingsPanes, "machineGroups" | "machineRows"> {
  const panes = panesFor(pluginId);
  return {
    ...(panes?.machineGroups ? { machineGroups: panes.machineGroups } : {}),
    ...(panes?.machineRows ? { machineRows: panes.machineRows } : {}),
  };
}
