"use client";

/**
 * USAGE PROVIDERS — the hubs Telar reads pooled quota from.
 *
 * ON THE PROVIDERS PANE, BELOW THE LOGINS, because it answers the same question
 * from the other side. A login is an account this machine runs turns AS; a hub
 * is a service that runs them on accounts this machine never signs in as. Both
 * are "where does my capacity come from", and splitting them across two panes
 * would make that one question two.
 *
 * ADDING A HUB IS NOT ADOPTING A LOGIN. The logins group above deliberately has
 * no credential field — Telar points at folders a CLI already authenticated. A
 * hub is the opposite case: it is a service with an API, its management key is
 * the only way in, and there is no folder to point at. So this one group does
 * take a secret, and it is stored the way the provider registry's sensitive
 * environment values are — a 0600 file of its own, never returned on a read,
 * and a row saved back with the redacted key keeps the stored one.
 */

import { useCallback, useEffect, useState } from "react";
import { PlusIcon, ServerIcon, Trash2Icon } from "lucide-react";
import type { UsageLimitSource } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/lib/engine/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Row, SettingsGroup } from "./settings-shell";

const api = createEngineApi();

/** The permanent key a stored management key is filed under, derived from the
 *  label the way a login's routing key is — so nobody is asked to make a
 *  permanent decision about a string before the temporary one about a name. */
export function suggestSourceId(label: string, taken: readonly string[]): string {
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
            <span className="mt-1 block text-[0.6875rem] text-muted-foreground">
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
            {/* Said at the moment it is typed, which is the one moment it
                changes what a person does with it. */}
            <span className="mt-1 block text-[0.6875rem] text-muted-foreground">
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

  /**
   * A save is the whole round trip: PUT, then re-read — the rule the logins
   * group above follows. The engine normalises what it stores (it canonicalises
   * the URL and withholds the key), so a row keeping an optimistic copy would
   * keep showing an edit that was refused.
   */
  const patch = async (next: { enabled?: boolean }) => {
    setError(null);
    try {
      // The key is deliberately NOT sent: absent leaves the stored one alone,
      // which is what makes toggling a hub off and on again non-destructive.
      await api.saveUsageLimitSource({ id: source.id, ...next });
    } catch (cause) {
      setError(cause instanceof EngineApiError ? cause.message : "That change was not saved.");
    }
    onChange();
  };

  const remove = async () => {
    // TODO(confirmations): a `window.confirm`, like the logins group's own
    // remove. The Confirmations pass owns turning these into a central
    // "ask before removing" toggle; until then it stays a browser dialog.
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
      // A hub with no key stored cannot be read, and the row says so rather
      // than letting the Usage page be the first place anybody finds out.
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
    // Deferred by a timeout rather than awaited in the effect body, like every
    // other section here — see providers-section.tsx.
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
            hint="Without one, Usage reports what this Mac spent and nothing about how much of a pooled plan is left."
          />
        ) : (
          sources.map((source) => <HubRow key={source.id} source={source} onChange={() => void load()} />)
        )}
      </SettingsGroup>

      <AddHubDialog open={adding} onOpenChange={setAdding} taken={(sources ?? []).map((source) => source.id)} onAdded={() => void load()} />
    </>
  );
}
