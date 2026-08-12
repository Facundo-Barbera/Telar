"use client";

/**
 * Settings, on the frozen app's settings frame.
 *
 * The cockpit used to render three stacked Cards on a centred column, which is a
 * different screen from the rest of Telar: the donor's settings are a fixed
 * side-nav beside an internally-scrolling pane with a sticky sub-header, and its
 * rows are a shared `SettingsGroup`/`Row` grammar rather than per-section markup.
 *
 * THE SECTION LIST IS SHORT ON PURPOSE. The donor carries Accounts, Agent
 * defaults, CLIs, Doctor, MCP, Notifications, Provider instances and Updates —
 * every one of them backed by legacy state this cockpit deliberately does not
 * own. What remains is what the vNext engine can actually answer for, and each
 * absent section is stated as a fact rather than left as a gap.
 */

import { useCallback, useEffect, useState } from "react";
import { CircleAlertIcon, PaletteIcon, PlugIcon, ServerIcon } from "lucide-react";
import type { EngineHealth } from "@telar/engine-client";
import { createVNextApi } from "@/lib/vnext/client";
import { Badge } from "@/components/ui/badge";
import { ThemeControl } from "@/components/theme-control";
import { Row, SettingsGroup, SettingsShell, type SettingsSection } from "./settings-shell";

const api = createVNextApi();

const SECTIONS: SettingsSection[] = [
  { id: "appearance", label: "Appearance", icon: PaletteIcon, group: "Cockpit" },
  { id: "engine", label: "Engine", icon: ServerIcon, group: "Runtime" },
  { id: "providers", label: "Providers", icon: PlugIcon, group: "Runtime" },
];

/** A figure the engine reported, in the register the rest of the app uses for
 *  machine-supplied values. */
function Mono({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{children}</code>;
}

function EngineSection({ health, unreachable }: { health?: EngineHealth; unreachable: boolean }) {
  return (
    <>
      {unreachable && (
        <SettingsGroup title="Not connected" description="Everything below is the last thing this page managed to read.">
          <Row
            icon={CircleAlertIcon}
            label="The engine did not answer"
            hint="Start it with the launcher below, using the same TELAR_HOME."
            control={<Badge variant="outline">Offline</Badge>}
          />
        </SettingsGroup>
      )}

      <SettingsGroup title="Daemon" description="What this cockpit is talking to right now.">
        <Row label="Protocol version" hint="The contract this engine answers." control={<Mono>{health ? `v${health.version}` : "—"}</Mono>} />
        <Row
          label="Daemon"
          hint="A fresh id means the engine restarted since this page loaded."
          control={<Mono>{health ? health.daemonId.slice(0, 8) : "—"}</Mono>}
        />
        <Row
          label="Started"
          hint="When the current daemon process came up."
          control={<Mono>{health ? new Date(health.startedAt).toLocaleString() : "—"}</Mono>}
        />
      </SettingsGroup>

      <SettingsGroup title="Worker" description="Turns are claimed and run by a worker. Without one, a submitted turn stays queued for ever.">
        <Row
          label="Registered"
          hint="A worker holds a lease and heartbeats to keep it."
          control={
            health?.worker.registered ? <Badge variant="secondary">Live</Badge> : <Badge variant="outline">None</Badge>
          }
        />
        <Row label="Worker id" control={<Mono>{health?.worker.workerId?.slice(0, 24) ?? "—"}</Mono>} />
        <Row label="Active workers" control={<Mono>{health?.worker.activeWorkers ?? "—"}</Mono>} />
      </SettingsGroup>

      <SettingsGroup title="State" description="vNext runs against its own state root and never reads or writes the legacy one.">
        <Row
          label="Launch command"
          hint="Starts the local engine, its worker, and this app."
          control={<Mono>bun run dev:vnext</Mono>}
        />
        <Row label="State isolation" hint="Enforced before Next boots; a legacy TELAR_HOME is refused." control={<Badge variant="secondary">Protected</Badge>} />
      </SettingsGroup>
    </>
  );
}

export function SettingsPage() {
  const [active, setActive] = useState("appearance");
  const [health, setHealth] = useState<EngineHealth>();
  const [unreachable, setUnreachable] = useState(false);

  const load = useCallback(async () => {
    try {
      setHealth(await api.health());
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
    <SettingsShell title="Settings" subtitle="vNext cockpit" sections={SECTIONS} active={active} onSelect={setActive} backHref="/">
      {active === "appearance" && (
        <SettingsGroup title="Theme" description="Applied before first paint, so switching never flashes the other theme.">
          <Row label="Colour scheme" hint="System follows the OS setting and changes with it." control={<ThemeControl />} />
        </SettingsGroup>
      )}

      {active === "engine" && <EngineSection {...(health ? { health } : {})} unreachable={unreachable} />}

      {active === "providers" && (
        <>
          <SettingsGroup title="Provider configuration" description="This cockpit does not manage credentials.">
            <Row
              label="Sign-in lives outside Telar"
              hint="Authenticate Claude Code or Codex on this machine; the worker picks the session up from there."
              control={<Badge variant="outline">External</Badge>}
            />
            <Row
              label="Which provider runs a session"
              hint="Chosen when the session is created and fixed for its lifetime — the engine routes turns by provider instance."
              control={<Badge variant="secondary">Per session</Badge>}
            />
          </SettingsGroup>

          <SettingsGroup
            title="Not built yet"
            description="The frozen app configures these; the vNext engine does not model them, so there is nothing here to set."
          >
            <Row label="MCP servers" hint="User-configured servers are not modelled by the contract." control={<Badge variant="outline">Absent</Badge>} />
            <Row label="Attachments" hint="No attachment contract exists on the turn submission yet." control={<Badge variant="outline">Absent</Badge>} />
            <Row
              label="Per-turn model and effort"
              hint="Modelled on the submission and ignored by the engine, so the composer does not offer it."
              control={<Badge variant="outline">Absent</Badge>}
            />
          </SettingsGroup>
        </>
      )}
    </SettingsShell>
  );
}
