"use client";

/**
 * THE GENERIC PLUGIN PANE — enable, disable, and read what a plugin says about
 * itself. The pane a feature gets when nobody has written it a bespoke one.
 *
 * AND, ONCE ON, ITS SETTINGS — generated from the schema the engine publishes
 * for it (`GeneratedSettingsRows`): toggles, choices, text, paths and numbers,
 * each project field offering "Inherit (<Mac value>)" where the plugin names a
 * Mac default. Not a JSON textarea and not a guess: the same schema validates
 * the write at the engine. Fields it cannot draw (lists, nested choices) are a
 * bespoke block's job, registered beside the pane.
 *
 * A FAILED PLUGIN SAYS SO. `EngineHealth` carries the startup error, and a
 * toggle that silently does nothing because the plugin never started is worse
 * than a disabled toggle with the reason beside it.
 */

import { useState, type ReactNode } from "react";
import { CircleAlertIcon, PlugIcon } from "lucide-react";
import type { Project } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { enablePatch, type PluginSectionEntry } from "@/lib/plugins/sections";
import { pluginEnabled, pluginSettings, readProjectPlugins } from "@telar/engine-client";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { GeneratedSettingsRows } from "@/components/plugins/generated-settings";
import { settingsFields } from "@/lib/plugins/settings-form";
import { Row, SettingsGroup } from "./settings-shell";

const api = createEngineApi();

/**
 * Why a project cannot use a plugin this Mac has switched off. A plain anchor,
 * not a client-side link: Settings reads `?section=` on mount only.
 */
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
  /** This Mac's settings for the plugin — what an unset project field inherits. */
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
      // ONE WRITE, through the generic arm. The engine drains on disable —
      // running work finishes rather than being killed — so this returns as
      // soon as new work is refused, not when the last cell ends.
      const answer = await api.updateProject(project.id, enablePatch(entry.pluginId, next));
      onChange(answer.project);
    } catch (cause) {
      // The plugin's own sentence, with its id on it, rather than a generic
      // failure — see `plugin_error` in the protocol.
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
            // The same generic arm as the switch, keeping it on.
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
