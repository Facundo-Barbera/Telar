"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PlusIcon, ServerIcon, StethoscopeIcon, Trash2Icon } from "lucide-react";
import type { UsageLimitSource } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/platform/engine";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Switch } from "@/ui/switch";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Row, SettingsGroup } from "@/features/settings";

const api = createEngineApi();

function suggestSourceId(label: string, taken: readonly string[]): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const base = /^[a-z]/.test(slug) ? slug : `hub${slug ? `-${slug}` : ""}`;
  if (!taken.includes(base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function AddHubDialog({
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
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("http://localhost:8317");
  const [managementKey, setManagementKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const id = suggestSourceId(label, taken);

  const reset = () => {
    setLabel("");
    setUrl("http://localhost:8317");
    setManagementKey("");
    setError(null);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.saveUsageLimitSource({
        id,
        ...(label.trim() ? { label: label.trim() } : {}),
        url: url.trim(),
        managementKey,
      });
      reset();
      onOpenChange(false);
      onAdded();
    } catch (cause) {
      setError(cause instanceof EngineApiError ? cause.message : "That hub could not be added.");
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
          <DialogTitle>Add a hub</DialogTitle>
          <DialogDescription>
            A CLIProxyAPI hub pools several subscription logins. Telar reads its accounts&apos; remaining quota and shows it on the Usage page; it never
            routes turns through it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <label className="block">
            <span className="text-xs font-medium text-foreground">Name</span>
            <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Home hub" className="mt-1.5 h-8 text-xs" />
            <span className="mt-1 block text-2xs text-muted-foreground">
              Key: <code className="font-mono">{id}</code> — permanent. Blank uses the hub&apos;s host.
            </span>
          </label>

          <label className="block">
            <span className="text-xs font-medium text-foreground">Management API</span>
            <Input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="http://localhost:8317"
              className="mt-1.5 h-8 font-mono text-xs"
              spellCheck={false}
              autoComplete="off"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-foreground">Management key</span>
            <Input
              type="password"
              value={managementKey}
              onChange={(event) => setManagementKey(event.target.value)}
              placeholder="From the hub's config.yaml"
              className="mt-1.5 h-8 font-mono text-xs"
              spellCheck={false}
              autoComplete="off"
            />
            <span className="mt-1 block text-2xs text-muted-foreground">
              Kept in the engine&apos;s own 0600 file. It is never sent back to this page and never logged.
            </span>
          </label>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="sm">Cancel</Button>} />
          <Button size="sm" disabled={busy || !url.trim() || !managementKey} onClick={() => void submit()}>
            <PlusIcon />
            Add hub
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function HubRow({ source, onChange }: { source: UsageLimitSource; onChange: () => void }) {
  const [error, setError] = useState<string | null>(null);

  const patch = async (next: { enabled?: boolean }) => {
    setError(null);
    try {
      // Omitting the key keeps the stored one.
      await api.saveUsageLimitSource({ id: source.id, ...next });
    } catch (cause) {
      setError(cause instanceof EngineApiError ? cause.message : "That change was not saved.");
    }
    onChange();
  };

  const remove = async () => {
    if (!window.confirm(`Remove "${source.label ?? source.url}"? Its management key is forgotten with it.`)) return;
    setError(null);
    try {
      await api.removeUsageLimitSource(source.id);
    } catch (cause) {
      setError(cause instanceof EngineApiError ? cause.message : "That hub could not be removed.");
    }
    onChange();
  };

  return (
    <Row
      id={`providers-usage-hub-${source.id}`}
      icon={ServerIcon}
      label={source.label ?? source.url}
      hint={source.url}
      status={source.keyRedacted ? undefined : <Badge variant="outline">No key</Badge>}
      error={error}
      control={
        <div className="flex items-center gap-2">
          <Switch
            checked={source.enabled}
            onCheckedChange={(next: boolean) => void patch({ enabled: next })}
            aria-label={`Read quota from ${source.label ?? source.url}`}
          />
          <Button size="icon-sm" variant="ghost" aria-label={`Remove ${source.label ?? source.url}`} onClick={() => void remove()}>
            <Trash2Icon />
          </Button>
        </div>
      }
    />
  );
}

export function UsageProvidersSection() {
  const [sources, setSources] = useState<UsageLimitSource[]>();
  const [unreachable, setUnreachable] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      setSources((await api.usageLimitSources()).sources);
      setUnreachable(false);
    } catch {
      setUnreachable(true);
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  return (
    <>
      <SettingsGroup
        title="Usage providers"
        description="Hubs that pool subscription accounts. Their remaining quota shows under Limits on the Usage page."
        {...(adding
          ? {}
          : {
              action: (
                <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
                  <PlusIcon className="size-3.5" />
                  Add hub
                </Button>
              ),
            })}
      >
        {unreachable ? (
          <Row label="The engine did not answer" hint="Start it with the launcher, using the same TELAR_HOME." control={<Badge variant="outline">Offline</Badge>} />
        ) : sources === undefined ? (
          <Row label="Loading" control={<Badge variant="outline">…</Badge>} />
        ) : sources.length === 0 ? (
          <Row
            icon={ServerIcon}
            label="No hubs configured"
            hint="Without one, Usage reports what this computer spent and nothing about how much of a pooled plan is left."
          />
        ) : (
          sources.map((source) => <HubRow key={source.id} source={source} onChange={() => void load()} />)
        )}
      </SettingsGroup>

      <SettingsGroup title="Diagnosis">
        <Row
          icon={StethoscopeIcon}
          label="Diagnose usage"
          hint="An agent reads this computer's usage in the background, read-only, and explains what drives it."
          control={
            <Button size="sm" variant="outline" render={<Link href="/usage#diagnose" />}>
              Open Usage
            </Button>
          }
        />
      </SettingsGroup>

      <AddHubDialog open={adding} onOpenChange={setAdding} taken={(sources ?? []).map((source) => source.id)} onAdded={() => void load()} />
    </>
  );
}
