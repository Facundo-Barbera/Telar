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
import { BlocksIcon, FolderKanbanIcon, GitPullRequestIcon, KeyboardIcon, PaletteIcon, PlugIcon, PlugZapIcon, SlidersHorizontalIcon, SmartphoneIcon, WrenchIcon } from "lucide-react";
import type { EngineHealth } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { Badge } from "@/components/ui/badge";
import { AppearanceSection } from "./appearance-section";
import { InboxSection } from "./inbox-section";
import { LinksSection } from "./links-section";
import { McpSection } from "./mcp-section";
import { IntegrationsPage } from "./integrations-page";
import { KeybindingsPage } from "./keybindings-page";
import { ProjectsPage } from "./projects-page";
import { PermissionsSection } from "./permissions-section";
import { ProvidersSection } from "./providers-section";
import { RemoteSection } from "./remote-section";
import { SourceControlPage } from "./source-control-page";
import { OtherMacsSection } from "./other-macs-section";
import { TextGenSection } from "./textgen-section";
import { PluginsPage } from "./plugins-page";
import { UpdatesSection } from "./updates-section";
import { WorkspaceSection } from "./workspace-section";
import { Row, SettingsGroup, SettingsShell, type SettingsSection } from "./settings-shell";
import { SETTINGS_SEARCH_INDEX } from "./settings-registry";
import { useSectionFromUrl } from "./use-section-from-url";

const api = createEngineApi();

/**
 * EIGHT PANES, FROM SIX AFTER A CULL OF NINE — Integrations and Projects were
 * added back deliberately, each for a destination the merged panes had no room
 * for. The nav split stays what it was — "Cockpit" is
 * decisions about this window, "Runtime" is decisions about the machine that
 * runs turns — but panes that held two rows each merged with their nearest
 * neighbour, because a side-nav where most destinations are one group deep
 * makes every setting harder to find, not easier:
 *
 *   - General = the old Sessions (Inbox + Text generation) plus the standing
 *     workspace choice. See below for why it is first.
 *   - Agent tools = the old MCP servers + Permissions. Both decide what a
 *     session's agent can reach beyond the repo.
 *   - Application = the old Updates + About. Both are facts about THIS
 *     INSTALL — its version, its channel, where its state lives.
 *
 * GENERAL IS FIRST, AND IS WHERE SETTINGS OPENS. The pane used to land on
 * Appearance, which put a theme editor in front of somebody who came here to
 * change how their work behaves — the most decorative screen in the app as the
 * answer to "settings". General is the ordinary set: what a new session is
 * built with, when one leaves your list, who names it. Appearance keeps its
 * pane and loses the front door.
 *
 * "SESSIONS" BECAME "GENERAL" rather than gaining a sibling. Its rows were
 * already the general ones, and a General pane beside a Sessions pane would
 * make every reader guess which of the two holds the row they want.
 */
const SECTIONS: SettingsSection[] = [
  { id: "general", label: "General", icon: SlidersHorizontalIcon, group: "Cockpit" },
  /**
   * UNDER "COCKPIT" rather than "Runtime": a project registration is this
   * install's list of places to work, not a property of the machine that runs
   * turns — the same engine serves whatever set of folders this cockpit has
   * registered, and a paired Mac keeps its own list.
   */
  { id: "projects", label: "Projects", icon: FolderKanbanIcon, group: "Cockpit" },
  { id: "appearance", label: "Appearance", icon: PaletteIcon, group: "Cockpit" },
  /**
   * UNDER "COCKPIT": a chord is a decision about this window and the shell
   * around it — the table is what builds the Mac app's own menu — not about
   * the machine that runs turns. Read-only today; see keybindings-page.tsx.
   */
  { id: "keybindings", label: "Keybindings", icon: KeyboardIcon, group: "Cockpit" },
  /**
   * UNDER "COCKPIT": pairing decides who may reach THIS INSTALL's surface —
   * a fact about the install, not about the machine that runs turns (the
   * engine stays loopback either way).
   */
  { id: "remote", label: "Remote access", icon: SmartphoneIcon, group: "Cockpit" },
  /**
   * ALSO "COCKPIT": the accounts THIS WINDOW browses and signs in as. A browser
   * profile is a set of cookies this install keeps, not a property of the machine
   * that runs turns — and it is where a remembered login is scoped, which is why
   * the two share a pane.
   *
   * CALLED "BROWSER", NOT "INTEGRATIONS" (#357). Both groups on it are about one
   * thing — Telar's own browser: the identities it signs in as, and the logins
   * it may fill without asking. "Integrations" is the word every app uses for
   * the drawer of things it connects to, so it named a category rather than this
   * pane. THE ID STAYS `integrations`: it is a route, bookmarks point at it, and
   * renaming a nav label is not a reason to strand one.
   */
  { id: "integrations", label: "Browser", icon: PlugZapIcon, group: "Cockpit" },
  { id: "providers", label: "Providers", icon: PlugIcon, group: "Runtime" },
  /**
   * UNDER "RUNTIME", beside Providers and for the same reason: both are CLIs
   * already signed in on the machine that runs turns, which Telar reads through
   * rather than holding a token for.
   */
  { id: "source-control", label: "Source control", icon: GitPullRequestIcon, group: "Runtime" },
  { id: "tools", label: "Agent tools", icon: WrenchIcon, group: "Runtime" },
  /**
   * ONE DESTINATION FOR EVERY PLUGIN, rather than a top-level item each. Two
   * shipped today and the list grows; a nav that grew with it would crowd out
   * the things a person opens settings for.
   */
  { id: "plugins", label: "Plugins", icon: BlocksIcon, group: "Runtime" },
];

/**
 * The retired pane ids keep answering. `section=mcp` is baked into the OAuth
 * callback's redirect (app/api/mcp/oauth/callback/route.ts), and the rest may
 * live in bookmarks; an alias costs one map entry and never strands a link on
 * the default pane.
 */
const SECTION_ALIASES: Record<string, string> = {
  sessions: "general",
  inbox: "general",
  textgen: "general",
  mcp: "tools",
  permissions: "tools",
  updates: "general",
  about: "general",
  // APPLICATION MERGED INTO GENERAL. Both held facts about this install and
  // splitting them meant looking in two places for one question; the id keeps
  // answering so bookmarks and the OAuth redirect do not strand.
  application: "general",
  /**
   * SETTLED IS NOT A SETTING, AND THE PANE IS GONE (#364). It listed the
   * conversations this rail has shelved — a shelf, which the rail already
   * draws and is where anyone looking for one goes. What IS a setting is the
   * rule that puts them there, and that is General ▸ Settling, so a bookmark
   * lands on the one row it could have meant.
   */
  settled: "general",
};

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
    // The caption listed the three rows under it in prose (#357); "State" keeps
    // its sub-line because a path with no gloss does not say what is in it.
    <SettingsGroup title="This build">
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
  const [active, setActive] = useSectionFromUrl("general", SECTION_IDS, SECTION_ALIASES);
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
    <SettingsShell
      title="Settings"
      subtitle="cockpit"
      sections={SECTIONS}
      active={active}
      onSelect={setActive}
      backHref="/"
      // `/` from anywhere in here finds a row by name without knowing which of
      // six panes holds it — which is the gap this nav has always had, since
      // General alone stacks six sections. See settings-registry.ts.
      search={SETTINGS_SEARCH_INDEX}
      // Appearance is a theme editor, not a list of rows — see `wide` in
      // settings-shell.tsx. Every other pane keeps the reading column.
      wide={active === "appearance"}
    >
      {active === "appearance" && <AppearanceSection />}

      {/* WORKSPACE FIRST: it is the only row here that decides what gets BUILT,
          and it is read before the session exists. Settling and naming both
          describe a session that is already running. */}
      {active === "general" && (
        <>
          <WorkspaceSection />
          <LinksSection />
          <InboxSection />
          <TextGenSection />
          {/* Merged in from the retired Application pane. */}
          <AboutSection {...(about ? { about } : {})} {...(health ? { health } : {})} unreachable={unreachable} />
          <UpdatesSection />
        </>
      )}

      {active === "projects" && <ProjectsPage />}

      {active === "keybindings" && <KeybindingsPage />}

      {active === "plugins" && <PluginsPage />}

      {active === "remote" && (
        <>
          <RemoteSection />
          <OtherMacsSection />
        </>
      )}

      {active === "providers" && <ProvidersSection />}

      {active === "source-control" && <SourceControlPage />}

      {active === "integrations" && <IntegrationsPage />}

      {active === "tools" && (
        <>
          <McpSection />
          <PermissionsSection />
        </>
      )}

    </SettingsShell>
  );
}
