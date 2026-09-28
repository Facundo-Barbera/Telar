"use client";

import { useCallback, useEffect, useState } from "react";
import { BlocksIcon, CircleAlertIcon, FolderPlusIcon } from "lucide-react";
import type { PluginStatus, ProjectPlugins } from "@telar/engine-client";
import { machineAllows } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { chooseDirectory } from "@/platform/desktop/choose-directory";
import { Switch } from "@/ui/switch";
import { machineBlocksFor } from "./settings-panes";
import { GeneratedSettingsRows } from "./generated-settings";
import { generatedGroupTitle, settingsFields } from "../settings-form";
import { machineSettingsPatch } from "../sections";
import { Row, SettingsGroup } from "@/features/settings";

const api = createEngineApi();

export function machinePanePlugins(plugins: readonly PluginStatus[], machine: ProjectPlugins | undefined): PluginStatus[] {
  return plugins.filter(
    (status) =>
      status.state !== "failed" &&
      machineAllows(machine, status.meta.id) &&
      status.meta.settings.some((section) => section.scope === "machine"),
  );
}

function MachinePluginSettings({
  status,
  machine,
  onMachine,
}: {
  status: PluginStatus;
  machine: ProjectPlugins | undefined;
  onMachine: (machine: ProjectPlugins) => void;
}) {
  const { machineGroups: Groups, machineRows: Rows } = machineBlocksFor(status.meta.id);
  const fields = settingsFields(status.machineSettingsSchema);
  const section = status.meta.settings.find((entry) => entry.scope === "machine");
  return (
    <>
      {Groups && <Groups machine={machine} onChange={onMachine} />}
      {(fields.length > 0 || Rows) && (
        <SettingsGroup title={generatedGroupTitle(status, "machine")} {...(section?.blurb ? { description: section.blurb } : {})}>
          <GeneratedSettingsRows
            fields={fields}
            values={machine?.entries[status.meta.id]?.settings ?? {}}
            onWrite={async (settings) => {
              onMachine((await api.updateMachinePlugins(machineSettingsPatch(machine, status.meta.id, settings))).machine);
            }}
          />
          {Rows && <Rows machine={machine} onChange={onMachine} />}
        </SettingsGroup>
      )}
    </>
  );
}

export function PluginsPage() {
  const [plugins, setPlugins] = useState<PluginStatus[]>();
  const [machine, setMachine] = useState<ProjectPlugins>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();

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

  const add = async (mode: "copy" | "link") => {
    const chosen = await chooseDirectory({ title: "Choose a plugin folder" });
    if (!("path" in chosen)) {
      if ("unavailable" in chosen) setNotice(chosen.unavailable);
      return;
    }
    setBusy("add");
    setNotice(undefined);
    try {
      await api.installPlugin({ path: chosen.path, mode });
      await load();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const remove = async (status: PluginStatus) => {
    const what = status.installed?.linked ? "The link is removed; your folder stays where it is." : "Its folder is deleted.";
    if (!window.confirm(`Remove ${status.meta.name}? ${what}`)) return;
    setBusy(status.meta.id);
    setNotice(undefined);
    try {
      await api.uninstallPlugin(status.meta.id);
      await load();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
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
                <div className="flex items-center gap-2">
                  {status.installed && (
                    <Button size="sm" variant="ghost" disabled={busy !== undefined} onClick={() => void remove(status)}>
                      Remove
                    </Button>
                  )}
                  <Switch
                    checked={allowed && !failed}
                    disabled={busy === status.meta.id || failed}
                    onCheckedChange={(next: boolean) => void toggle(status.meta.id, next)}
                    title="Each project keeps its own setting, and running work finishes before anything is released."
                    aria-label={`${status.meta.name} enabled on this Mac`}
                  />
                </div>
              }
            />
          );
        })}
        <Row
          icon={FolderPlusIcon}
          label="Add plugin from folder"
          hint={notice ?? "Copy it in, or link it to keep editing it where it is."}
          control={
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" disabled={busy !== undefined} onClick={() => void add("copy")}>
                Copy…
              </Button>
              <Button size="sm" variant="ghost" disabled={busy !== undefined} onClick={() => void add("link")}>
                Link…
              </Button>
            </div>
          }
        />
      </SettingsGroup>

      {machinePanePlugins(plugins, machine).map((status) => (
        <MachinePluginSettings key={status.meta.id} status={status} machine={machine} onMachine={setMachine} />
      ))}
    </>
  );
}
