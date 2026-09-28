"use client";

import { useState } from "react";
import { BlocksIcon, CircleAlertIcon } from "lucide-react";
import type { PluginStatus, Project, ProjectPlugins } from "@telar/engine-client";
import { machineAllows, pluginEnabled, readProjectPlugins } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { Badge } from "@/ui/badge";
import { Switch } from "@/ui/switch";
import { Row } from "@/features/settings";
import { projectPluginSections } from "../sections";
import { pluginIcon } from "./generated-settings";
import { PluginBrowser, type PluginListItem } from "./plugin-browser";
import { machineOffReason, PluginSettings } from "./plugin-settings";
import { projectPaneFor, projectTogglePatch } from "./settings-panes";

const api = createEngineApi();

type ScopedProject = Project & { hostId?: string; hostName?: string };

function projectPluginPage(status: PluginStatus, project: Project, machine: ProjectPlugins | undefined, onChange: (project: Project) => void) {
  const entries = projectPluginSections([status]);
  const machineOff = !machineAllows(machine, status.meta.id);
  const Pane = !machineOff && pluginEnabled(readProjectPlugins(project).plugins, status.meta.id) ? projectPaneFor(status.meta.id) : undefined;
  if (Pane) return <Pane project={project} onChange={onChange} />;
  const machineSettings = machine?.entries[status.meta.id]?.settings;
  return (
    <>
      {entries.map((entry) => (
        <PluginSettings
          key={entry.key}
          entry={entry}
          project={project}
          onChange={onChange}
          machineOff={machineOff}
          {...(machineSettings ? { machineSettings } : {})}
        />
      ))}
    </>
  );
}

export function ProjectPluginList({
  project,
  plugins,
  machine,
  onChange,
}: {
  project?: ScopedProject;
  plugins?: readonly PluginStatus[];
  machine?: ProjectPlugins;
  onChange?: (project: Project) => void;
}) {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const local = project && !project.hostId ? project : undefined;

  const toggle = async (pluginId: string, next: boolean) => {
    if (!local) return;
    setBusy(pluginId);
    setError(undefined);
    try {
      const answer = await api.updateProject(local.id, projectTogglePatch(local, pluginId, next));
      onChange?.(answer.project);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const items = (plugins ?? []).map((status): PluginListItem => {
    const { id, name } = status.meta;
    const failed = status.state === "failed";
    const reason = !project
      ? `Select a project to turn ${name} on for it.`
      : project.hostId
        ? `Registered on ${project.hostName ?? "another Mac"}. Change it in that Mac's own settings.`
        : failed
          ? (status.error ?? "This plugin did not start, so turning it on would do nothing.")
          : !machineAllows(machine, id)
            ? machineOffReason(name)
            : undefined;
    return {
      id,
      name,
      icon: pluginIcon(status.meta.icon),
      hint: status.meta.blurb ?? "Sessions in this project get its tools; turning it off lets running work finish.",
      control: (
        <Switch
          checked={project ? pluginEnabled(readProjectPlugins(project).plugins, id) : false}
          onCheckedChange={(next: boolean) => void toggle(id, next)}
          aria-label={`${name} for this project`}
        />
      ),
      ...(busy === id ? { status: <Badge variant="outline">Saving</Badge> } : {}),
      ...(reason ? { unavailable: reason } : {}),
      ...(local && onChange
        ? { page: projectPluginPage(status, local, machine, onChange) }
        : {}),
    };
  });

  return (
    <PluginBrowser
      key={project?.id}
      title="Plugins"
      description="Which of this Mac's plugins this project has opted into."
      items={items}
      empty={<Row icon={BlocksIcon} label="No plugins registered" control={<Badge variant="outline">None</Badge>} />}
      footer={error && <Row icon={CircleAlertIcon} label="Could not save" hint={error} control={<Badge variant="outline">Error</Badge>} />}
    />
  );
}
