"use client";

/**
 * OTHER MACS — the cockpits this one is paired WITH, as opposed to the
 * devices paired with IT (remote-section.tsx, just above).
 *
 * Pairing runs the other way round from a phone's: paste the link the OTHER
 * Mac shows in its own Remote access pane, and this cockpit exchanges the
 * one-time token server-side (app/api/hosts/route.ts). From then on that
 * Mac's conversations sit in the rail beside the local ones, marked with its
 * name, and everything on them works through this cockpit's own proxy. Over
 * there, this desktop shows up in the Devices list, where it can be renamed,
 * demoted or revoked — this side can only forget.
 */

import { useCallback, useEffect, useState } from "react";
import { MonitorIcon, XIcon } from "lucide-react";
import { createEngineApi, EngineApiError } from "@/lib/engine/client";
import type { PublicHost } from "@/lib/hosts/store";
import { forgetRows, readSidebarCache, writeSidebarCache } from "@/lib/sidebar-cache";
import { snapshotStore } from "@/lib/snapshot-cache";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Row, SettingsGroup } from "./settings-shell";

const api = createEngineApi();

export function OtherMacsSection() {
  const [hosts, setHosts] = useState<PublicHost[] | null>(null);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setHosts((await api.hosts()).hosts);
    } catch {
      setHosts([]);
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const add = async () => {
    const pairingUrl = link.trim();
    if (!pairingUrl) return;
    setBusy(true);
    setError(null);
    try {
      await api.addHost({ pairingUrl });
      setLink("");
      await load();
    } catch (cause) {
      setError(cause instanceof EngineApiError ? cause.message : "Could not pair with that Mac.");
    } finally {
      setBusy(false);
    }
  };

  const rename = async (id: string, name: string) => {
    await api.renameHost(id, name).catch(() => undefined);
    await load();
  };

  const remove = async (id: string) => {
    await api.removeHost(id).catch(() => undefined);
    // FORGETTING A MAC FORGETS WHAT IT SAID. Its remembered rail rows and its
    // recorded session snapshots go with the pairing — kept, they would sit
    // dimmed forever for a host that can never answer again.
    writeSidebarCache(forgetRows(readSidebarCache(), id));
    const store = snapshotStore();
    if (store) {
      void store
        .keys(`${id}:`)
        .then((keys) => Promise.all(keys.map((key) => store.remove(key))))
        .catch(() => undefined);
    }
    await load();
  };

  return (
    <SettingsGroup
      title="Other Macs"
      description="Another Telar's conversations, in this rail. On the other Mac, open Settings → Remote access, turn on pairing, and paste its pairing link here. That Mac then lists this one under its devices, where it can revoke the access."
    >
      {hosts?.map((host) => (
        <HostRow key={host.id} host={host} onRename={(name) => void rename(host.id, name)} onRemove={() => void remove(host.id)} />
      ))}
      <Row
        label="Add a Mac"
        hint={error ?? "Its pairing link looks like http://mini.tail:3000/pair#token=48129037"}
        control={
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void add();
            }}
          >
            <Input
              value={link}
              onChange={(event) => setLink(event.target.value)}
              placeholder="Paste the pairing link"
              aria-label="Pairing link from the other Mac"
              className="h-8 w-72 text-sm"
              disabled={busy}
            />
            <Button type="submit" size="sm" disabled={busy || !link.trim()}>
              {busy ? "Pairing…" : "Pair"}
            </Button>
          </form>
        }
      />
    </SettingsGroup>
  );
}

function HostRow({ host, onRename, onRemove }: { host: PublicHost; onRename: (name: string) => void; onRemove: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(host.name);

  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== host.name) onRename(draft);
  };

  return (
    <Row
      icon={MonitorIcon}
      label={
        editing ? (
          <Input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit();
              if (event.key === "Escape") {
                setDraft(host.name);
                setEditing(false);
              }
            }}
            className="h-6 w-48 px-1.5 text-sm"
          />
        ) : (
          <button
            type="button"
            className="cursor-text hover:underline decoration-dotted underline-offset-2"
            title="Rename"
            onClick={() => {
              setDraft(host.name);
              setEditing(true);
            }}
          >
            {host.name}
          </button>
        )
      }
      hint={host.baseUrl}
      control={
        <Button variant="ghost" size="icon-sm" aria-label={`Forget ${host.name}`} title="Forget this Mac (its own Devices list keeps the access until revoked there)" onClick={onRemove}>
          <XIcon className="size-3.5" />
        </Button>
      }
    />
  );
}
