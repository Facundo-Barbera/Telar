"use client";

/**
 * PROVIDERS: one list, one row per configured login.
 *
 * Ported from t3 code's `ProviderSettingsPanel` — the same shape `apps/web_old`
 * carried, because that surface was modelled on this one. What the pane replaces
 * here was three static rows of prose saying sign-in happens elsewhere; true,
 * and useless, because there was nothing to configure and no way to tell whether
 * anything worked.
 *
 * TELAR ADOPTS LOGINS, IT DOES NOT CREATE THEM. There is no login panel and no
 * route behind one. Adding an instance is ADOPTING: the config folder must
 * already exist and already hold a login, and a row that cannot prove one hands
 * over the command to run in a terminal.
 *
 * ONE LIST, NOT TWO. A provider and an account are not separate things to
 * configure — an account IS a configured instance of a provider. The first row
 * for each driver is its built-in slot; every extra row is another login of the
 * same driver.
 */

import { useCallback, useEffect, useState } from "react";
import { PlusIcon, RotateCwIcon } from "lucide-react";
import type { ProviderDriverKind, ProviderInstance, ProviderProbe, ProviderUpdateRun } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/lib/engine/client";
import { cn } from "@/lib/utils";
import { displayNameOf, DRIVER_LABEL, DRIVERS, isDefaultInstance, isValidInstanceId, signInCommand, sortInstances, suggestInstanceId } from "@/lib/provider-instances";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ProviderIcon } from "@/components/session/provider-icon";
import { ProviderInstanceCard, type InstancePatch } from "@/components/settings/provider-instance-card";
import { Row, SettingsGroup } from "./settings-shell";

const api = createEngineApi();

/**
 * Adding an instance is POINTING AT A LOGIN THAT ALREADY EXISTS.
 *
 * The dialog asks for a driver, a name and a folder, and derives the permanent
 * routing key from the name — the id is what every session stores for ever, and
 * making that a required field would ask somebody to make a permanent decision
 * about a string before they have made the temporary one about a label.
 */
function AddInstanceDialog({
  open,
  onOpenChange,
  taken,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  taken: readonly string[];
  onAdded: () => void;
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
      await api.saveProviderInstance({
        id,
        driver,
        ...(name.trim() ? { displayName: name.trim() } : {}),
        ...(configDir.trim() ? { configDir: configDir.trim() } : {}),
      });
      reset();
      onOpenChange(false);
      onAdded();
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
            Point Telar at a config folder you have already signed in with. It never signs in for you.
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
            {/* The permanent key, shown as it is derived rather than asked for.
                It is what every session stores and it never changes. */}
            <span className="mt-1 block text-[0.6875rem] text-muted-foreground">
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
            <span className="mt-1 block text-[0.6875rem] text-muted-foreground">
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
  /** Which BINARY is updating, expressed as the driver plus the pin that
   *  selects it — so every row resolving to that executable goes busy together
   *  and a row pinned to a different one stays pressable. */
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
    // Deferred by a timeout rather than awaited in the effect body: setting
    // state synchronously inside an effect is what `react-hooks/set-state-in-effect`
    // refuses, and the first paint has nothing to show anyway.
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  /**
   * A save is the whole round trip: PUT, then re-read.
   *
   * RE-READING IS NOT REDUNDANT. The engine normalises what it stores — it
   * redacts secrets, trims names, and refuses a config folder outside the
   * allowed shapes — so a card that kept its own optimistic copy would keep
   * showing an edit that was rejected as if it had saved.
   */
  const patch = async (instance: ProviderInstance, next: InstancePatch) => {
    setErrors((current) => ({ ...current, [instance.id]: null }));
    try {
      await api.saveProviderInstance({ id: instance.id, ...next });
    } catch (cause) {
      setErrors((current) => ({
        ...current,
        [instance.id]: cause instanceof EngineApiError ? cause.message : "That change was not saved.",
      }));
    }
    await load();
  };

  const remove = async (instance: ProviderInstance) => {
    // Removing a login forgets how it was configured. It does not touch the
    // folder, and it does not sign anything out — which is why the question is
    // short and the sessions naming it keep working (they fall back to the
    // driver's built-in slot).
    if (!window.confirm(`Remove "${instance.displayName || instance.id}"? Its login on disk is left untouched.`)) return;
    try {
      await api.removeProviderInstance(instance.id);
    } catch (cause) {
      setErrors((current) => ({
        ...current,
        [instance.id]: cause instanceof EngineApiError ? cause.message : "That login could not be removed.",
      }));
    }
    await load();
  };

  const recheck = async () => {
    setRechecking(true);
    // Costs a subprocess per driver, which is fine for a gesture and wrong for
    // a repaint — so it is a button and never a timer.
    await load(true);
    setRechecking(false);
  };

  /**
   * Update the CLI behind one login.
   *
   * NO COMMAND IS SENT. The instance id is the whole request; the engine
   * resolves which binary that login runs, derives what would update it from
   * the install it finds, and refuses with a sentence when it cannot — no
   * install, an install it does not recognise, a package manager that is not
   * here, or a version pinned to this build's pairing.
   *
   * THE ANSWER CARRIES FRESH PROBES, so the version on screen is the one that
   * is now installed rather than the one that was. The alternative — re-reading
   * afterwards — would race the engine's own caches and could paint the old
   * number for a minute, which reads exactly like an update that did nothing.
   */
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
      <SettingsGroup
        title="Logins"
        description="Each row is one configured login. Telar runs the CLIs already on this machine and never signs you in — the base login is detected, and additional ones are config folders you point it at. Tokens stay where the CLI put them."
      >
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
              // No delete on the built-in slot: a session on that driver would
              // have nothing left to route to.
              {...(isDefaultInstance(instance) ? {} : { onRemove: () => void remove(instance) })}
              onUpdateCli={() => void runUpdate(instance)}
              // Busy on the BINARY, so other logins pointing at the same one go
              // busy too rather than offering a second press at one executable.
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

      {/* WHAT THE INSTALLER ACTUALLY SAID, kept after the run rather than
          replaced by a green tick. A package manager that exits non-zero has
          usually explained itself, and the explanation is the only thing that
          helps — "the update failed" on its own sends people to re-press the
          button that just failed. Collapsed by default, because a successful
          `npm install -g` also prints a screenful nobody needs. */}
      {updateReport && (
        <div className="mb-6 space-y-1.5 rounded-lg border border-border/70 bg-muted/20 p-3">
          <div className="flex items-center gap-2">
            <span className={cn("size-2 shrink-0 rounded-full", updateReport.run?.ok ? "bg-success" : "bg-destructive")} />
            <span className="text-xs font-medium text-foreground">
              {updateReport.label} — {updateReport.error ?? updateReport.run?.message}
            </span>
          </div>
          {updateReport.run && <code className="block truncate font-mono text-[0.6875rem] text-muted-foreground">{updateReport.run.command}</code>}
          {updateReport.run?.output && (
            <details className="text-[0.6875rem] text-muted-foreground">
              <summary className="cursor-pointer select-none text-muted-foreground/80 hover:text-foreground">Installer output</summary>
              <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2 font-mono text-[0.625rem] leading-snug">
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

      <AddInstanceDialog open={adding} onOpenChange={setAdding} taken={(instances ?? []).map((instance) => instance.id)} onAdded={() => void load()} />
    </>
  );
}
