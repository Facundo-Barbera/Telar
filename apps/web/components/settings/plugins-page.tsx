"use client";

/**
 * EVERY PLUGIN THIS MAC HAS, in one destination.
 *
 * The list is the ENGINE's answer (`GET /v2/plugins`), so a plugin appears here
 * by registering rather than by an edit to this file — including one that
 * failed to start, with its reason, because a missing row is indistinguishable
 * from a feature that was removed.
 *
 * WHAT THE SWITCH HERE MEANS. It is a CEILING for this Mac, not a value that
 * replaces each project's: turning a plugin off makes it unavailable
 * everywhere and touches no project's settings, so turning it back on restores
 * exactly what each project had. The engine enforces that at every door — the
 * generic plugin route, the legacy aliases, the claim a worker builds its tools
 * from — and running work is drained rather than killed.
 *
 * MACHINE SETTINGS, not project ones. A TeX distribution is a property of this
 * Mac; the document a compile builds is a property of a checkout, and lives on
 * the project's page.
 *
 * ── WHAT A GLOBAL CONFIGURATION GROUP IS ────────────────────────────────────
 * Under the switches, each plugin that has Mac-wide settings contributes its
 * own group: LaTeX's distribution, engine and package behaviour; data science's
 * default interpreter and packages. Every field in them answers ONE question —
 * "what does a project that has not chosen get" — so they are DEFAULTS a
 * project inherits and never values that override what a project picked. The
 * engine resolves them as a fallback chain (`resolveLatex`,
 * `resolveDataScience`), which is what makes them behaviour rather than
 * preferences stored for nobody.
 *
 * WHICH GROUPS APPEAR IS DERIVED, not listed: a plugin declares a `machine`
 * section in its manifest and gets one. The mapping from that section to the
 * component that renders it is the only hand-written part, and it is stated
 * once below for the same reason `BESPOKE_PLUGIN_PANES` is — a machine section
 * with no pane would otherwise render as nothing at all.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { BlocksIcon, CircleAlertIcon } from "lucide-react";
import type { PluginStatus, ProjectPlugins } from "@telar/engine-client";
import { machineAllows } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { DataScienceMachineSettings } from "./data-science-machine-settings";
import { LatexMachineSettings } from "./latex-machine-settings";
import { Row, SettingsGroup } from "./settings-shell";

const api = createEngineApi();

/**
 * Which plugin renders which global configuration group.
 *
 * NOT A DENYLIST and not a feature flag: a plugin absent from here simply has
 * no Mac-wide fields worth a form, and contributes no group. A plugin that
 * declares a `machine` section and is missing here would declare a destination
 * that renders nothing, so the two are checked against each other below rather
 * than assumed to agree.
 */
const MACHINE_PANES: Record<
  string,
  (props: { machine?: ProjectPlugins; onChange: (machine: ProjectPlugins) => void }) => ReactNode
> = {
  latex: LatexMachineSettings,
  "data-science": DataScienceMachineSettings,
};

export function PluginsPage() {
  const [plugins, setPlugins] = useState<PluginStatus[]>();
  const [machine, setMachine] = useState<ProjectPlugins>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();

  const load = useCallback(async () => {
    try {
      const answer = await api.machinePlugins();
      setPlugins(answer.plugins);
      setMachine(answer.machine);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const toggle = async (id: string, enabled: boolean) => {
    setBusy(id);
    setError(undefined);
    try {
      const answer = await api.updateMachinePlugins({ [id]: { enabled } });
      setMachine(answer.machine);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  };

  if (error) {
    return (
      <SettingsGroup title="Plugins">
        <Row icon={CircleAlertIcon} label="Could not read plugins" hint={error} control={<Badge variant="outline">Error</Badge>} />
      </SettingsGroup>
    );
  }

  if (!plugins) {
    return (
      <SettingsGroup title="Plugins">
        <Row label="Loading" control={<Badge variant="outline">…</Badge>} />
      </SettingsGroup>
    );
  }

  return (
    <>
      {/* ONE SENTENCE, AND IT IS THE CONSEQUENCE OF THE SWITCH. The header used
          to carry the whole ceiling model — off everywhere, project settings
          preserved, running work drained — which is three facts for a reader
          who has come to flip one toggle. Only the first changes what they see
          after pressing it; the other two are why the switch is SAFE, and they
          are written out in this file's doc comment for whoever maintains it. */}
      <SettingsGroup title="Plugins" description="Turning one off here makes it unavailable in every project on this Mac.">
        {plugins.length === 0 && <Row icon={BlocksIcon} label="No plugins registered" control={<Badge variant="outline">None</Badge>} />}
        {plugins.map((status) => {
          const allowed = machineAllows(machine, status.meta.id);
          const failed = status.state === "failed";
          return (
            <Row
              key={status.meta.id}
              icon={BlocksIcon}
              label={status.meta.name}
              hint={failed ? (status.error ?? "This plugin did not start.") : status.meta.blurb}
              control={
                // WHAT TURNING IT OFF DOES NOT DESTROY, on the switch itself.
                // Each project's own setting survives — so this is a ceiling,
                // and putting it back restores exactly what every project had.
                // The tooltip, rather than a second hint sentence, because the
                // hint slot belongs to the plugin's blurb and this sentence is
                // identical on every row.
                <Switch
                  checked={allowed && !failed}
                  disabled={busy === status.meta.id || failed}
                  onCheckedChange={(next: boolean) => void toggle(status.meta.id, next)}
                  title="Each project keeps its own setting, and running work finishes before anything is released."
                  aria-label={`${status.meta.name} enabled on this Mac`}
                />
              }
            />
          );
        })}
      </SettingsGroup>

      {/* GLOBAL CONFIGURATION, per plugin. Driven by the manifest: a plugin
          appears here because it DECLARED a machine-scoped section, not because
          this file names it — so the day a third plugin has Mac-wide defaults,
          the only edit is the pane itself and its row in `MACHINE_PANES`.

          A FAILED PLUGIN CONTRIBUTES NOTHING. Its fields would all write into a
          runtime that did not start, and the switch above already says why. */}
      {plugins
        .filter((status) => status.state !== "failed" && status.meta.settings.some((section) => section.scope === "machine"))
        .map((status) => {
          const Pane = MACHINE_PANES[status.meta.id];
          return Pane ? <Pane key={status.meta.id} machine={machine} onChange={setMachine} /> : null;
        })}
    </>
  );
}
