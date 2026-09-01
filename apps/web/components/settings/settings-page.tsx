"use client";

/**
 * Settings, on the frozen app's settings frame.
 *
 * A fixed side-nav beside an internally-scrolling pane with a sticky sub-header,
 * and rows on one shared `SettingsGroup`/`Row` grammar rather than per-section
 * markup.
 *
 * THE ENGINE PANE IS GONE, and this is what replaced it. It reported the daemon
 * id, the protocol version, the worker lease and the launch command — four facts
 * about a subprocess, on a screen that is packaged as an application. None of
 * them is actionable by the person reading it: a fresh daemon id tells you the
 * engine restarted, and there is nothing here to do about that. What survives is
 * the part that stays true in a shipped app — which build this is, where its
 * state lives, and whether the engine answered at all — and it is one short
 * section rather than a pane of its own.
 *
 * PROVIDERS IS THE ACCOUNT REGISTRY NOW. It used to be three rows of prose
 * saying sign-in happens elsewhere. True, and useless: there was nothing to
 * configure and no way to tell whether anything worked. See
 * components/settings/providers-section.tsx.
 */

import { useCallback, useEffect, useState } from "react";
import { DownloadIcon, InboxIcon, InfoIcon, PaletteIcon, PlugIcon, ShieldCheckIcon, SmartphoneIcon, SparklesIcon, WrenchIcon } from "lucide-react";
import type { EngineHealth } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { Badge } from "@/components/ui/badge";
import { ThemeControl } from "@/components/theme-control";
import { InboxSection } from "./inbox-section";
import { McpSection } from "./mcp-section";
import { PermissionsSection } from "./permissions-section";
import { ProvidersSection } from "./providers-section";
import { RemoteSection } from "./remote-section";
import { TextGenSection } from "./textgen-section";
import { UpdatesSection } from "./updates-section";
import { Row, SettingsGroup, SettingsShell, type SettingsSection } from "./settings-shell";
import { useSectionFromUrl } from "./use-section-from-url";

const api = createEngineApi();

const SECTIONS: SettingsSection[] = [
  { id: "appearance", label: "Appearance", icon: PaletteIcon, group: "Cockpit" },
  /**
   * UNDER "COCKPIT" RATHER THAN "RUNTIME", because settling changes what you
   * are shown and nothing about what runs. It sits beside Appearance for that
   * reason and not because they are alike — the split in this nav is between
   * decisions about the surface and decisions about the machine.
   */
  { id: "inbox", label: "Inbox", icon: InboxIcon, group: "Cockpit" },
  /**
   * UNDER "COCKPIT": pairing decides who may reach THIS INSTALL's surface —
   * a fact about the install, like Updates, not about the machine that runs
   * turns (the engine stays loopback either way).
   */
  { id: "remote", label: "Remote access", icon: SmartphoneIcon, group: "Cockpit" },
  { id: "providers", label: "Providers", icon: PlugIcon, group: "Runtime" },
  /**
   * UNDER "RUNTIME": it decides which harness process runs and spends tokens,
   * which is a fact about the machine, not about what this window shows.
   */
  { id: "textgen", label: "Text generation", icon: SparklesIcon, group: "Runtime" },
  { id: "mcp", label: "MCP servers", icon: WrenchIcon, group: "Runtime" },
  /**
   * UNDER "RUNTIME": the macOS grants agent capabilities stand on — computer
   * use today — are facts about the machine that runs turns, not about what
   * this window shows.
   */
  { id: "permissions", label: "Permissions", icon: ShieldCheckIcon, group: "Runtime" },
  /**
   * UNDER "COCKPIT", beside About, because an update is a fact about THIS
   * INSTALL — its channel, its version, its feed — and nothing about the
   * machine the sessions run on.
   */
  { id: "updates", label: "Updates", icon: DownloadIcon, group: "Cockpit" },
  { id: "about", label: "About", icon: InfoIcon, group: "Cockpit" },
];

/** A figure the engine reported, in the register the rest of the app uses for
 *  machine-supplied values. */
function Mono({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{children}</code>;
}

function AboutSection({
  about,
  health,
  unreachable,
}: {
  about?: { appVersion: string; stateRoot?: string };
  health?: EngineHealth;
  unreachable: boolean;
}) {
  return (
    <SettingsGroup title="This build" description="What is running, and where it keeps its state.">
      <Row label="Version" control={<Mono>{about ? about.appVersion : "—"}</Mono>} />
      {/*
        THE ONE ENGINE FACT WORTH KEEPING. Not the daemon id or the worker
        lease — whether the thing that runs turns is answering, because that is
        the difference between "my message is queued" and "my message is lost",
        and it is the only one of the four a reader can act on.
      */}
      <Row
        label="Engine"
        hint={unreachable ? "Nothing is claiming turns; a message sent now stays queued." : undefined}
        control={
          unreachable ? (
            <Badge variant="outline">Not answering</Badge>
          ) : health?.worker.registered ? (
            <Badge variant="secondary">Running</Badge>
          ) : (
            <Badge variant="outline">No worker</Badge>
          )
        }
      />
      <Row
        label="State"
        hint="Sessions, transcripts, worktrees and settings."
        control={<Mono>{about?.stateRoot ?? "—"}</Mono>}
      />
    </SettingsGroup>
  );
}

const SECTION_IDS = SECTIONS.map((section) => section.id);

export function SettingsPage() {
  // `?section=mcp` is how a sign-in gets the user back to the pane they left —
  // see use-section-from-url.ts for the failure that made this necessary.
  const [active, setActive] = useSectionFromUrl("appearance", SECTION_IDS);
  const [about, setAbout] = useState<{ appVersion: string; stateRoot?: string }>();
  const [health, setHealth] = useState<EngineHealth>();
  const [unreachable, setUnreachable] = useState(false);

  const load = useCallback(async () => {
    // Independently: the engine being down is exactly when the build and state
    // facts matter, so one failing must not take the other with it.
    void api
      .about()
      .then(setAbout)
      .catch(() => undefined);
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
    <SettingsShell title="Settings" subtitle="cockpit" sections={SECTIONS} active={active} onSelect={setActive} backHref="/">
      {active === "appearance" && (
        <SettingsGroup title="Theme" description="Applied before first paint.">
          <Row label="Colour scheme" hint="System follows the OS setting." control={<ThemeControl />} />
        </SettingsGroup>
      )}

      {active === "inbox" && <InboxSection />}

      {active === "remote" && <RemoteSection />}

      {active === "providers" && <ProvidersSection />}

      {active === "textgen" && <TextGenSection />}

      {active === "mcp" && <McpSection />}

      {active === "permissions" && <PermissionsSection />}

      {active === "updates" && <UpdatesSection />}

      {active === "about" && <AboutSection {...(about ? { about } : {})} {...(health ? { health } : {})} unreachable={unreachable} />}
    </SettingsShell>
  );
}
