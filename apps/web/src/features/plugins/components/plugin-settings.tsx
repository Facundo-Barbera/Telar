"use client";

import { useState, type ReactNode } from "react";
import { CircleAlertIcon, PlugIcon } from "lucide-react";
import type { Project } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { enablePatch, type PluginSectionEntry } from "../sections";
import { pluginEnabled, pluginSettings, readProjectPlugins } from "@telar/engine-client";
import { Badge } from "@/ui/badge";
import { Switch } from "@/ui/switch";
import { GeneratedSettingsRows } from "./generated-settings";
import { settingsFields } from "../settings-form";
import { Row, SettingsGroup } from "@/features/settings";

const api = createEngineApi();

export function machineOffReason(label: string): ReactNode {
  return (
    <>
      {label} is off for every project on this Mac.{" "}
      <a href="/settings?section=plugins" className="underline underline-offset-2">
        Turn it on in Plugins
      </a>
      .
    </>
  );
}

export function PluginSettings({
  entry,
  project,
  onChange,
  machineOff = false,
  machineSettings,
}: {
  entry: PluginSectionEntry;
  project: Project;
  onChange: (project: Project) => void;
  machineOff?: boolean;
  machineSettings?: Record<string, unknown>;
}) {
  const { plugins } = readProjectPlugins(project);
  const enabled = pluginEnabled(plugins, entry.pluginId);
  const fields = settingsFields(entry.settingsSchema);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const toggle = async (next: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      const answer = await api.updateProject(project.id, enablePatch(entry.pluginId, next));
      onChange(answer.project);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const failed = entry.state === "failed";

  return (
    <SettingsGroup title={entry.label} description={entry.blurb}>
      <Row
        icon={PlugIcon}
        label={`${entry.label} for this project`}
        hint={
          failed
            ? "This plugin did not start, so turning it on would do nothing."
            : "Sessions in this project get its tools; turning it off lets running work finish."
        }
        {...(machineOff && !failed ? { unavailable: { reason: machineOffReason(entry.label) } } : {})}
        control={
          <Switch
            checked={enabled}
            disabled={busy || failed}
            onCheckedChange={(next: boolean) => void toggle(next)}
            aria-label={`${entry.label} enabled`}
          />
        }
      />

      {enabled && !machineOff && !failed && fields.length > 0 && (
        <GeneratedSettingsRows
          fields={fields}
          values={pluginSettings(plugins, entry.pluginId)}
          inherited={machineSettings ?? {}}
          onWrite={async (settings) => {
            onChange((await api.updateProject(project.id, enablePatch(entry.pluginId, true, settings))).project);
          }}
        />
      )}

      {failed && (
        <Row
          icon={CircleAlertIcon}
          label="Did not start"
          hint={entry.error ?? "The engine reported no reason."}
          control={<Badge variant="outline">Failed</Badge>}
        />
      )}

      {error && (
        <Row icon={CircleAlertIcon} label="Could not save" hint={error} control={<Badge variant="outline">Error</Badge>} />
      )}
    </SettingsGroup>
  );
}
