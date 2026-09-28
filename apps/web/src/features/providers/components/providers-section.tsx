"use client";

import { useCallback, useEffect, useState } from "react";
import { PlusIcon, RotateCwIcon } from "lucide-react";
import type { ProviderDriverKind, ProviderInstance, ProviderProbe, ProviderUpdateRun } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/platform/engine";
import { cn } from "@/ui/utils";
import { displayNameOf, DRIVER_LABEL, DRIVERS, isDefaultInstance, isValidInstanceId, signInCommand, sortInstances, suggestInstanceId } from "../provider-instances";
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
import { ProviderInstanceCard, type InstancePatch } from "./provider-instance-card";
import { announceProviderInstancesChanged } from "../provider-instance-cache";
import { Row, SettingsGroup } from "@/features/settings";

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

export function ProvidersSection() {
  const [instances, setInstances] = useState<ProviderInstance[]>();
  const [probes, setProbes] = useState<ProviderProbe[]>([]);
  const [unreachable, setUnreachable] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [adding, setAdding] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [inheritance, setInheritance] = useState<Record<string, string[] | undefined>>({});
  const [updating, setUpdating] = useState<string | null>(null);
  const [updateReport, setUpdateReport] = useState<{ label: string; run?: ProviderUpdateRun; error?: string } | null>(null);

  const binaryKey = (instance: ProviderInstance): string => `${instance.driver} ${instance.binaryPath ?? ""}`;

  const load = useCallback(async (refresh = false) => {
    try {
      const answer = await api.providerInstances(refresh ? { refresh: true } : {});
      setInstances(sortInstances(answer.providerInstances));
      setProbes(answer.probes);
      setUnreachable(false);
    } catch {
      setUnreachable(true);
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const patch = async (instance: ProviderInstance, next: InstancePatch) => {
    setErrors((current) => ({ ...current, [instance.id]: null }));
    try {
      const answer = await api.saveProviderInstance({ id: instance.id, ...next });
      if (answer.stoppedInheriting?.length) {
        setInheritance((current) => ({ ...current, [instance.id]: answer.stoppedInheriting }));
      }
    } catch (cause) {
      setErrors((current) => ({
        ...current,
        [instance.id]: cause instanceof EngineApiError ? cause.message : "That change was not saved.",
      }));
    }
    await load();
    announceProviderInstancesChanged();
  };

  const carryOver = async (instance: ProviderInstance, names: readonly string[]) => {
    setErrors((current) => ({ ...current, [instance.id]: null }));
    try {
      await api.saveProviderInstance({ id: instance.id, carryOverInherited: [...names] });
      setInheritance((current) => ({ ...current, [instance.id]: undefined }));
    } catch (cause) {
      setErrors((current) => ({
        ...current,
        [instance.id]: cause instanceof EngineApiError ? cause.message : "Those variables could not be carried over.",
      }));
    }
    await load();
    announceProviderInstancesChanged();
  };

  const remove = async (instance: ProviderInstance) => {
    if (!window.confirm(`Remove "${instance.displayName || instance.id}"? Its login on disk is left untouched, and sessions fall back to the built-in slot.`)) return;
    try {
      await api.removeProviderInstance(instance.id);
    } catch (cause) {
      setErrors((current) => ({
        ...current,
        [instance.id]: cause instanceof EngineApiError ? cause.message : "That login could not be removed.",
      }));
    }
    await load();
    announceProviderInstancesChanged();
  };

  const recheck = async () => {
    setRechecking(true);
    await load(true);
    setRechecking(false);
  };

  const runUpdate = async (instance: ProviderInstance) => {
    const label = displayNameOf(instance);
    setUpdating(binaryKey(instance));
    setUpdateReport(null);
    try {
      const answer = await api.updateProviderCli(instance.id);
      setInstances(sortInstances(answer.providerInstances));
      setProbes(answer.probes);
      setUpdateReport({ label, run: answer.result });
    } catch (cause) {
      setUpdateReport({
        label,
        error: cause instanceof EngineApiError ? cause.message : "That update could not be run.",
      });
    } finally {
      setUpdating(null);
    }
  };

  const probeFor = (id: string) => probes.find((probe) => probe.instanceId === id);
  const missing = probes.filter((probe) => !probe.installed);

  return (
    <>
      <SettingsGroup title="Logins" description="Each row is one configured login.">
        {unreachable ? (
          <Row label="The engine did not answer" hint="Start it with the launcher, using the same TELAR_HOME." control={<Badge variant="outline">Offline</Badge>} />
        ) : instances === undefined ? (
          <Row label="Loading" control={<Badge variant="outline">…</Badge>} />
        ) : (
          instances.map((instance) => (
            <ProviderInstanceCard
              key={instance.id}
              instance={instance}
              {...(probeFor(instance.id) ? { probe: probeFor(instance.id)! } : {})}
              signInCommand={signInCommand(instance)}
              expanded={Boolean(expanded[instance.id])}
              onExpandedChange={(next) => setExpanded((current) => ({ ...current, [instance.id]: next }))}
              onPatch={(next) => void patch(instance, next)}
              {...(inheritance[instance.id]?.length
                ? {
                    inheritance: {
                      names: inheritance[instance.id]!,
                      onCarryOver: () => void carryOver(instance, inheritance[instance.id]!),
                      onDismiss: () => setInheritance((current) => ({ ...current, [instance.id]: undefined })),
                    },
                  }
                : {})}
              {...(isDefaultInstance(instance) ? {} : { onRemove: () => void remove(instance) })}
              onUpdateCli={() => void runUpdate(instance)}
              updating={updating === binaryKey(instance)}
              error={errors[instance.id] ?? null}
            />
          ))
        )}
      </SettingsGroup>

      <div className="mb-6 flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <PlusIcon />
          Add a login
        </Button>
        <Button size="sm" variant="ghost" disabled={rechecking} onClick={() => void recheck()}>
          <RotateCwIcon className={rechecking ? "animate-spin" : ""} />
          Re-check
        </Button>
      </div>

      {updateReport && (
        <div className="mb-6 space-y-1.5 rounded-lg border border-border/70 bg-muted/20 p-3">
          <div className="flex items-center gap-2">
            <span className={cn("size-2 shrink-0 rounded-full", updateReport.run?.ok ? "bg-success" : "bg-destructive")} />
            <span className="text-xs font-medium text-foreground">
              {updateReport.label} — {updateReport.error ?? updateReport.run?.message}
            </span>
          </div>
          {updateReport.run && <code className="block truncate font-mono text-2xs text-muted-foreground">{updateReport.run.command}</code>}
          {updateReport.run?.output && (
            <details className="text-2xs text-muted-foreground">
              <summary className="cursor-pointer select-none text-muted-foreground/80 hover:text-foreground">Installer output</summary>
              <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2 font-mono text-3xs leading-snug">
                {updateReport.run.output}
              </pre>
            </details>
          )}
        </div>
      )}

      {missing.length > 0 && (
        <SettingsGroup title="Not on this machine">
          {missing.map((probe) => (
            <Row
              key={probe.instanceId}
              label={`${DRIVER_LABEL[probe.driver]} is not installed`}
              hint={probe.message ?? "Install the CLI to use this login."}
              control={<Badge variant="outline">Missing</Badge>}
            />
          ))}
        </SettingsGroup>
      )}

      <AddInstanceDialog
        open={adding}
        onOpenChange={setAdding}
        taken={(instances ?? []).map((instance) => instance.id)}
        onAdded={(added) => {
          if (added.stoppedInheriting?.length) {
            setInheritance((current) => ({ ...current, [added.id]: added.stoppedInheriting }));
            setExpanded((current) => ({ ...current, [added.id]: true }));
          }
          void load();
          announceProviderInstancesChanged();
        }}
      />
    </>
  );
}
