/**
 * WHICH COMPONENT DRAWS A PLUGIN'S SETTINGS, keyed by plugin id — the React
 * half of `lib/plugins/registry.ts`, and the one place the settings pages ask
 * "does this plugin bring its own pane?" instead of naming Data Science or
 * LaTeX.
 *
 * TWO SCOPES. `project` is the plugin's editor on a project's page, drawn once
 * the project has turned it on (`ProjectPluginPanes`). `machine` is its group of
 * Mac-wide defaults on the Plugins page (`PluginsPage`).
 *
 * NOT A DENYLIST. A plugin absent from here is still shown: on a project's page
 * it gets the generic enable/configure pane (`PluginSettings`), and on the
 * Plugins page it contributes no defaults group. The entries are stated rather
 * than inferred because dropping one would silently replace a working
 * environment picker with a checkbox.
 *
 * See docs/design/plugins-contract.md, contribution point 4.
 */
import type { ComponentType } from "react";
import type { Project, ProjectPlugins } from "@telar/engine-client";
import { DataScienceMachineSettings } from "@/components/settings/data-science-machine-settings";
import { DataScienceSection } from "@/components/settings/data-science-section";
import { LatexMachineSettings } from "@/components/settings/latex-machine-settings";
import { LatexSection } from "@/components/settings/latex-section";

export type ProjectSettingsPane = ComponentType<{ project: Project; onChange: (project: Project) => void }>;
export type MachineSettingsPane = ComponentType<{ machine?: ProjectPlugins; onChange: (machine: ProjectPlugins) => void }>;

export type PluginSettingsPanes = { project?: ProjectSettingsPane; machine?: MachineSettingsPane };

export const SETTINGS_PANES: Readonly<Record<string, PluginSettingsPanes>> = {
  "data-science": { project: DataScienceSection, machine: DataScienceMachineSettings },
  latex: { project: LatexSection, machine: LatexMachineSettings },
};

/** Own keys only, so an id like `constructor` never resolves to Object's. */
function panesFor(pluginId: string): PluginSettingsPanes | undefined {
  return Object.hasOwn(SETTINGS_PANES, pluginId) ? SETTINGS_PANES[pluginId] : undefined;
}

/** The plugin's own project editor, or `undefined` for the generic pane. */
export function projectPaneFor(pluginId: string): ProjectSettingsPane | undefined {
  return panesFor(pluginId)?.project;
}

/** The plugin's Mac-wide defaults group, or `undefined` for none. */
export function machinePaneFor(pluginId: string): MachineSettingsPane | undefined {
  return panesFor(pluginId)?.machine;
}
