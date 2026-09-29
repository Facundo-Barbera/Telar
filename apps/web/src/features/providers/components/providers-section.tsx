"use client";

import { useState } from "react";
import { PlusIcon, RotateCwIcon } from "lucide-react";
import type { ProviderDriverKind } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/platform/engine";
import { cn } from "@/ui/utils";
import { displayNameOf, DRIVER_LABEL, DRIVERS, isDefaultInstance, isValidInstanceId, providerSummary, signInCommand, suggestInstanceId, versionLabel } from "../provider-instances";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { ProviderIcon } from "./provider-icon";
import { ProviderInstanceCard } from "./provider-instance-card";
import { instanceStatus, ProviderMark } from "./provider-instance-header";
import { Switch } from "@/ui/switch";
import { binaryKey, useProviderInstances, type UpdateReport } from "../hooks/use-provider-instances";
import { announceProviderInstancesChanged } from "../provider-instance-cache";
import { MasterDetail, Row, SettingsGroup, type MasterDetailItem } from "@/features/settings";

const api = createEngineApi();

function AddInstanceDialog({
  open,
  onOpenChange,
  taken,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  taken: readonly string[];
  onAdded: (added: { id: string; stoppedInheriting?: string[] }) => void;
}) {
  const [driver, setDriver] = useState<ProviderDriverKind>("claude");
  const [name, setName] = useState("");
  const [configDir, setConfigDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const id = suggestInstanceId(driver, name, taken);

  const reset = () => {
    setName("");
    setConfigDir("");
    setError(null);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const answer = await api.saveProviderInstance({
        id,
        driver,
        ...(name.trim() ? { displayName: name.trim() } : {}),
        ...(configDir.trim() ? { configDir: configDir.trim() } : {}),
      });
      reset();
      onOpenChange(false);
      onAdded({ id, ...(answer.stoppedInheriting ? { stoppedInheriting: answer.stoppedInheriting } : {}) });
    } catch (cause) {
      setError(cause instanceof EngineApiError ? cause.message : "That login could not be added.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a login</DialogTitle>
          <DialogDescription>
            Point Telar at a config folder you have already signed in with. It never signs in for you, and tokens stay where the CLI put them.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <span className="text-xs font-medium text-foreground">Provider</span>
            <div className="mt-1.5 flex gap-1.5">
              {DRIVERS.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setDriver(option)}
                  aria-pressed={driver === option}
                  className={
                    driver === option
                      ? "flex items-center gap-1.5 rounded-md border border-ring bg-accent px-2.5 py-1 text-xs font-medium"
                      : "flex items-center gap-1.5 rounded-md border border-input px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  }
                >
                  <ProviderIcon provider={option} size={13} />
                  {DRIVER_LABEL[option]}
                </button>
              ))}
            </div>
          </div>

          <label className="block">
            <span className="text-xs font-medium text-foreground">Name</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Day job"
              className="mt-1.5 h-8 text-xs"
            />
            <span className="mt-1 block text-2xs text-muted-foreground">
              Routing key: <code className="font-mono">{id}</code> — permanent.
            </span>
          </label>

          <label className="block">
            <span className="text-xs font-medium text-foreground">
              {driver === "opencode" ? "OpenCode config folder (shared CLI login)" : driver === "codex" ? "CODEX_HOME folder" : "CLAUDE_CONFIG_DIR folder"}
            </span>
            <Input
              value={configDir}
              onChange={(event) => setConfigDir(event.target.value)}
              placeholder={driver === "opencode" ? "~/.config/opencode-work" : driver === "codex" ? "~/.codex-work" : "~/.claude-work"}
              className="mt-1.5 h-8 font-mono text-xs"
              spellCheck={false}
              autoComplete="off"
            />
            <span className="mt-1 block text-2xs text-muted-foreground">
              Sign in there first —{" "}
              <code className="font-mono">
                {signInCommand({ driver, ...(configDir.trim() ? { configDir: configDir.trim() } : {}) })}
              </code>
            </span>
          </label>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <DialogClose
            render={
              <Button variant="ghost" size="sm">
                Cancel
              </Button>
            }
          />
          <Button size="sm" disabled={busy || !isValidInstanceId(id)} onClick={() => void submit()}>
            <PlusIcon />
            Add login
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


function UpdateReportCard({ report }: { report: UpdateReport }) {
  return (
    <div className="mb-6 space-y-1.5 rounded-lg border border-border/70 bg-muted/20 p-3">
      <div className="flex items-center gap-2">
        <span className={cn("size-2 shrink-0 rounded-full", report.run?.ok ? "bg-success" : "bg-destructive")} />
        <span className="text-xs font-medium text-foreground">
          {report.label} — {report.error ?? report.run?.message}
        </span>
      </div>
      {report.run && <code className="block truncate font-mono text-2xs text-muted-foreground">{report.run.command}</code>}
      {report.run?.output && (
        <details className="text-2xs text-muted-foreground">
          <summary className="cursor-pointer select-none text-muted-foreground/80 hover:text-foreground">Installer output</summary>
          <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2 font-mono text-3xs leading-snug">
            {report.run.output}
          </pre>
        </details>
      )}
    </div>
  );
}

export function ProvidersSection() {
  const providers = useProviderInstances();
  const { instances, probes, inheritance, updating, errors, rechecking, updateReport, setInherited } = providers;
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<string>();

  const probeFor = (id: string) => probes.find((probe) => probe.instanceId === id);

  const items = (providers.unreachable ? [] : (instances ?? [])).map((instance): MasterDetailItem => {
    const probe = probeFor(instance.id);
    const title = displayNameOf(instance);
    return {
      id: instance.id,
      label: title,
      icon: <ProviderMark instance={instance} status={instanceStatus(instance, probe)} />,
      description: [providerSummary(probe), versionLabel(probe?.version)].filter(Boolean).join(" · "),
      dimmed: !instance.enabled,
      control: (
        <Switch checked={instance.enabled} onCheckedChange={(checked) => void providers.patch(instance, { enabled: Boolean(checked) })} aria-label={`Enable ${title}`} />
      ),
      detail: (
        <>
          {probe && !probe.installed && (
            <SettingsGroup>
              <Row
                label={`${DRIVER_LABEL[probe.driver]} is not installed`}
                hint={probe.message ?? "Install the CLI to use this login."}
                control={<Badge variant="outline">Missing</Badge>}
              />
            </SettingsGroup>
          )}
          <ProviderInstanceCard
          instance={instance}
          {...(probe ? { probe } : {})}
          signInCommand={signInCommand(instance)}
          onPatch={(next) => void providers.patch(instance, next)}
          {...(inheritance[instance.id]?.length
            ? {
                inheritance: {
                  names: inheritance[instance.id]!,
                  onCarryOver: () => void providers.carryOver(instance, inheritance[instance.id]!),
                  onDismiss: () => setInherited(instance.id, undefined),
                },
              }
            : {})}
          {...(isDefaultInstance(instance) ? {} : { onRemove: () => void providers.remove(instance) })}
          onUpdateCli={() => void providers.runUpdate(instance)}
          updating={updating === binaryKey(instance)}
          error={errors[instance.id] ?? null}
          />
        </>
      ),
    };
  });

  return (
    <>
      {updateReport && <UpdateReportCard report={updateReport} />}

      <MasterDetail
        title="Logins"
        description="Each row is one configured login."
        param="provider"
        {...(added ? { select: added } : {})}
        items={items}
        empty={
          providers.unreachable ? (
            <Row label="The engine did not answer" hint="Start it with the launcher, using the same TELAR_HOME." control={<Badge variant="outline">Offline</Badge>} />
          ) : (
            <Row label="Loading" control={<Badge variant="outline">…</Badge>} />
          )
        }
        footer={
          <div className="flex flex-wrap items-center gap-2 py-3">
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <PlusIcon />
              Add a login
            </Button>
            <Button size="sm" variant="ghost" disabled={rechecking} onClick={() => void providers.recheck()}>
              <RotateCwIcon className={rechecking ? "animate-spin" : ""} />
              Re-check
            </Button>
          </div>
        }
      />
      <AddInstanceDialog
        open={adding}
        onOpenChange={setAdding}
        taken={(instances ?? []).map((instance) => instance.id)}
        onAdded={(next) => {
          if (next.stoppedInheriting?.length) setInherited(next.id, next.stoppedInheriting);
          setAdded(next.id);
          void providers.load();
          announceProviderInstancesChanged();
        }}
      />
    </>
  );
}
