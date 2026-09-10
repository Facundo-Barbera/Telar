"use client";

/**
 * THE GENERIC PLUGIN PANE — enable, disable, and read what a plugin says about
 * itself. The pane a feature gets when nobody has written it a bespoke one.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: render a settings FORM. A plugin's settings
 * blob is opaque to the protocol and validated by the plugin's own schema at the
 * engine, so a generic editor here would either be a JSON textarea — which is
 * not a settings page, it is a way to write invalid config — or a guess at
 * shapes it cannot see. Enabling is the part that is genuinely generic; a
 * plugin that needs fields ships a pane, exactly as Data science and LaTeX do.
 *
 * A FAILED PLUGIN SAYS SO. `EngineHealth` carries the startup error, and a
 * toggle that silently does nothing because the plugin never started is worse
 * than a disabled toggle with the reason beside it.
 */

import { useState } from "react";
import { CircleAlertIcon, PlugIcon } from "lucide-react";
import type { Project } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { enablePatch, type PluginSectionEntry } from "@/lib/plugins/sections";
import { pluginEnabled, readProjectPlugins } from "@telar/engine-client";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Row, SettingsGroup } from "./settings-shell";

const api = createEngineApi();

export function PluginSettings({
  entry,
  project,
  onChange,
}: {
  entry: PluginSectionEntry;
  project: Project;
  onChange: (project: Project) => void;
}) {
  const enabled = pluginEnabled(readProjectPlugins(project).plugins, entry.pluginId);
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
        label={enabled ? "Enabled for this project" : "Not enabled"}
        hint={
          failed
            ? "This plugin did not start, so turning it on would do nothing."
            : "Sessions in this project get its tools; turning it off lets running work finish."
        }
        control={
          <Switch
            checked={enabled}
            disabled={busy || failed}
            onCheckedChange={(next: boolean) => void toggle(next)}
            aria-label={`${entry.label} enabled`}
          />
        }
      />

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
