"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { BlocksIcon, CircleAlertIcon, FolderPlusIcon } from "lucide-react";
import type { PluginStatus, ProjectPlugins } from "@telar/engine-client";
import { machineAllows } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { chooseDirectory } from "@/platform/desktop/choose-directory";
import { Switch } from "@/ui/switch";
import { machineBlocksFor } from "./settings-panes";
import { GeneratedSettingsRows, pluginIcon } from "./generated-settings";
import { NothingToConfigure } from "./plugin-settings";
import { generatedGroupTitle, settingsFields } from "../settings-form";
import { machineSettingsPatch } from "../sections";
import { MasterDetail, Row, SettingsGroup, type MasterDetailItem } from "@/features/settings";

const api = createEngineApi();

const hasMachineSettings = (status: PluginStatus) => status.meta.settings.some((section) => section.scope === "machine");

export function machinePaneShown(status: PluginStatus, machine: ProjectPlugins | undefined): boolean {
  return status.state !== "failed" && machineAllows(machine, status.meta.id) && hasMachineSettings(status);
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

  const items = plugins.map((status): MasterDetailItem => {
    const allowed = machineAllows(machine, status.meta.id);
    const failed = status.state === "failed";
    const hint = failed ? (status.error ?? "This plugin did not start.") : status.meta.blurb;
    const control = (
      <Switch
        checked={allowed && !failed}
        disabled={busy === status.meta.id || failed}
        onCheckedChange={(next: boolean) => void toggle(status.meta.id, next)}
        title="Each project keeps its own setting, and running work finishes before anything is released."
        aria-label={`${status.meta.name} enabled on this computer`}
      />
    );
    const Icon = pluginIcon(status.meta.icon);
    return {
      id: status.meta.id,
      label: status.meta.name,
      icon: <Icon className="size-4" />,
      description: hint,
      control,
      detail: (
        <MachinePluginPage
          status={status}
          {...(status.installed
            ? {
                remove: (
                  <Button size="sm" variant="ghost" disabled={busy !== undefined} onClick={() => void remove(status)}>
                    Remove
                  </Button>
                ),
              }
            : {})}
          {...(machinePaneShown(status, machine)
            ? { settings: <MachinePluginSettings status={status} machine={machine} onMachine={setMachine} /> }
            : {})}
        />
      ),
    };
  });

  return (
    <MasterDetail
      title="Plugins"
      param="plugin"
      description="Turning one off here makes it unavailable in every project on this computer."
      items={items}
      empty={<Row icon={BlocksIcon} label="No plugins registered" control={<Badge variant="outline">None</Badge>} />}
      footer={<AddPluginRow notice={notice} disabled={busy !== undefined} onAdd={(mode) => void add(mode)} />}
    />
  );
}

function AddPluginRow({ notice, disabled, onAdd }: { notice?: string; disabled: boolean; onAdd: (mode: "copy" | "link") => void }) {
  return (
    <Row
      icon={FolderPlusIcon}
      label="Add plugin from folder"
      hint={notice ?? "Copy it in, or link it to keep editing it where it is."}
      control={
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => onAdd("copy")}>
            Copy…
          </Button>
          <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onAdd("link")}>
            Link…
          </Button>
        </div>
      }
    />
  );
}

function MachinePluginPage({ status, remove, settings }: { status: PluginStatus; remove?: ReactNode; settings?: ReactNode }) {
  return (
    <>
      {remove && (
        <SettingsGroup>
          <Row
            icon={FolderPlusIcon}
            label={status.installed?.linked ? "Linked from a folder" : "Copied from a folder"}
            hint={status.installed?.linked ? "Removing it drops the link; the folder stays." : "Removing it deletes Telar's copy."}
            control={remove}
          />
        </SettingsGroup>
      )}
      {settings ?? (
        <NothingToConfigure hint={hasMachineSettings(status) ? "Its defaults for this computer show once it is on." : "This plugin has no settings for this computer."} />
      )}
    </>
  );
}
