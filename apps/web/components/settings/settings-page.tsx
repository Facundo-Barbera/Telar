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
 * state lives, and whether the engine answered at all — which is the This build
 * pane under About.
 *
 * PROVIDERS IS THE ACCOUNT REGISTRY NOW. It used to be three rows of prose
 * saying sign-in happens elsewhere. True, and useless: there was nothing to
 * configure and no way to tell whether anything worked. See
 * components/settings/providers-section.tsx.
 */

import { Suspense, useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { BlocksIcon, DownloadIcon, FolderKanbanIcon, GitPullRequestIcon, GlobeIcon, HardDriveIcon, InfoIcon, KeyboardIcon, MicIcon, PaletteIcon, PlugIcon, SlidersHorizontalIcon, SmartphoneIcon, WrenchIcon } from "lucide-react";
import type { EngineHealth } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { markNavigation } from "@/lib/perf-marks";
import { Badge } from "@/components/ui/badge";
import { Row, SettingsGroup, SettingsShell, type SettingsSection } from "./settings-shell";
import { SETTINGS_SEARCH_INDEX } from "./settings-registry";
import { useSectionFromUrl } from "./use-section-from-url";

/**
 * ONE PANE AT A TIME, AND ONLY THE ONE BEING READ (#492).
 *
 * Every arm of the render below is guarded by `active === …`, so at most one of
 * these is on screen and the rest are code the reader will probably never ask
 * for — somebody opens Settings to change a model or a shortcut, not to load a
 * LaTeX toolchain manager, a theme editor and a package browser. Statically
 * imported, every one was in the chunk the FIRST pane's paint waited on:
 * roughly a third of `/settings`, none of it drawn.
 *
 * SERVER RENDERING IS KEPT (no `ssr: false`). `useSectionFromUrl` deliberately
 * reports the fallback pane on the server and corrects in an effect, so General
 * is what the first HTML contains — that is a paint, and dropping it would trade
 * the split for a blank frame on the one pane that opens by default.
 *
 * NO `loading`, because these swap on a click within one app: the chunk comes
 * off the same origin the page came from, and a spinner that resolves in the
 * same frame is a flash, not feedback. BUT A `Suspense` OF OUR OWN around the
 * panes, with an empty fallback: without `loading`, `dynamic()` adds no
 * boundary of its own, and the first open of a pane suspended to the route's
 * — the whole page, nav included, swapped out and back for one chunk. See the
 * same note on components/right-panel.tsx, where the owner saw it as a reload.
 *
 * WHY ONE LINE EACH RATHER THAN A MAP over ids: `import()` must take a literal
 * path for the bundler to see it at all (next/dist/docs/01-app/02-guides/
 * lazy-loading.md). A table keyed by section id would compile and split nothing.
 */
const AppearanceSection = dynamic(() => import("./appearance-section").then((mod) => mod.AppearanceSection));
const InboxSection = dynamic(() => import("./inbox-section").then((mod) => mod.InboxSection));
const LinksSection = dynamic(() => import("./links-section").then((mod) => mod.LinksSection));
const DictationSection = dynamic(() => import("./dictation-section").then((mod) => mod.DictationSection));
const McpSection = dynamic(() => import("./mcp-section").then((mod) => mod.McpSection));
const OrientationSection = dynamic(() => import("./orientation-section").then((mod) => mod.OrientationSection));
const IntegrationsPage = dynamic(() => import("./integrations-page").then((mod) => mod.IntegrationsPage));
const KeybindingsPage = dynamic(() => import("./keybindings-page").then((mod) => mod.KeybindingsPage));
const ProjectsPage = dynamic(() => import("./projects-page").then((mod) => mod.ProjectsPage));
const PermissionsSection = dynamic(() => import("./permissions-section").then((mod) => mod.PermissionsSection));
const ProvidersSection = dynamic(() => import("./providers-section").then((mod) => mod.ProvidersSection));
const RemoteSection = dynamic(() => import("./remote-section").then((mod) => mod.RemoteSection));
const SourceControlPage = dynamic(() => import("./source-control-page").then((mod) => mod.SourceControlPage));
const OtherMacsSection = dynamic(() => import("./other-macs-section").then((mod) => mod.OtherMacsSection));
const TextGenSection = dynamic(() => import("./textgen-section").then((mod) => mod.TextGenSection));
const PluginsPage = dynamic(() => import("./plugins-page").then((mod) => mod.PluginsPage));
const UpdatesSection = dynamic(() => import("./updates-section").then((mod) => mod.UpdatesSection));
const StoreSection = dynamic(() => import("./store-section").then((mod) => mod.StoreSection));
const CleanupSection = dynamic(() => import("./cleanup-section").then((mod) => mod.CleanupSection));
const UsageProvidersSection = dynamic(() => import("./usage-providers-section").then((mod) => mod.UsageProvidersSection));
const WorkspaceSection = dynamic(() => import("./workspace-section").then((mod) => mod.WorkspaceSection));

const api = createEngineApi();

/**
 * FIVE GROUPS, EACH ANSWERING ONE QUESTION ABOUT WHERE A SETTING APPLIES:
 *
 *   - Cockpit: this window and how it behaves — what a new session is built
 *     with, how it looks, which keys it answers to, its browser, dictation.
 *   - Agents: what runs a turn and what it can reach — provider logins, the
 *     tools and permissions a session gets, plugins.
 *   - Projects: one project at a time, chosen on the pane.
 *   - This Mac: facts about the machine itself — who may reach it, and what it
 *     keeps on disk.
 *   - About: this install — its build, its updates, and the CLIs it reads
 *     through rather than holding a token for.
 *
 * GENERAL IS FIRST, AND IS WHERE SETTINGS OPENS. The pane used to land on
 * Appearance, which put a theme editor in front of somebody who came here to
 * change how their work behaves — the most decorative screen in the app as the
 * answer to "settings". General is the ordinary set: what a new session is
 * built with, when one leaves your list, who names it.
 *
 * "SESSIONS" BECAME "GENERAL" rather than gaining a sibling. Its rows were
 * already the general ones, and a General pane beside a Sessions pane would
 * make every reader guess which of the two holds the row they want.
 */
const SECTIONS: SettingsSection[] = [
  { id: "general", label: "General", icon: SlidersHorizontalIcon, group: "Cockpit" },
  { id: "appearance", label: "Appearance", icon: PaletteIcon, group: "Cockpit", scope: "browser" },
  /**
   * A chord is a decision about this window and the shell around it — the table
   * is what builds the Mac app's own menu. See keybindings-page.tsx.
   */
  { id: "keybindings", label: "Keybindings", icon: KeyboardIcon, group: "Cockpit", scope: "browser" },
  /**
   * The accounts THIS WINDOW browses and signs in as, and where its links open.
   *
   * CALLED "BROWSER", NOT "INTEGRATIONS" (#357). Every group on it is about
   * Telar's own browser. THE ID STAYS `integrations`: it is a route, bookmarks
   * point at it, and renaming a nav label is not a reason to strand one.
   *
   * THE GLYPH IS A BROWSER'S (#430) — what the right panel draws for it.
   */
  { id: "integrations", label: "Browser", icon: GlobeIcon, group: "Cockpit" },
  /**
   * ITS OWN PANE RATHER THAN A GROUP INSIDE GENERAL (#544). It ships OFF, so
   * the thing a reader is most often looking for is the switch that turns it
   * on, and a name in the nav is the cheapest answer to "can Telar dictate".
   */
  { id: "dictation", label: "Dictation", icon: MicIcon, group: "Cockpit" },
  { id: "providers", label: "Providers", icon: PlugIcon, group: "Agents", scope: "mac" },
  { id: "tools", label: "Agent tools", icon: WrenchIcon, group: "Agents", scope: "mac" },
  /**
   * ONE DESTINATION FOR EVERY PLUGIN, rather than a top-level item each. The
   * list grows; a nav that grew with it would crowd out the things a person
   * opens settings for.
   */
  { id: "plugins", label: "Plugins", icon: BlocksIcon, group: "Agents", scope: "mac" },
  { id: "projects", label: "Projects", icon: FolderKanbanIcon, group: "Projects", scope: "project" },
  /**
   * Pairing decides who may reach this Mac's engine and cockpit; the engine
   * itself stays on loopback either way.
   */
  { id: "remote", label: "Remote access", icon: SmartphoneIcon, group: "This Mac", scope: "mac" },
  /**
   * WHAT THIS MAC IS KEEPING, AND WHERE — issue #642: the checkouts sessions are
   * built in, the logs, and the store itself. A paired phone reading this pane
   * is reading THIS Mac's disk. The store's location lives here rather than
   * beside Updates because a pane that reports what is in the store and a row
   * elsewhere that moves it would be one question answered in two places.
   */
  { id: "storage", label: "Storage", icon: HardDriveIcon, group: "This Mac", scope: "mac" },
  { id: "about", label: "This build", icon: InfoIcon, group: "About", scope: "mac" },
  { id: "updates", label: "Updates", icon: DownloadIcon, group: "About", scope: "mac" },
  /**
   * The gh CLI already signed in on this Mac, which Telar reads through rather
   * than holding a token for.
   */
  { id: "source-control", label: "Source control", icon: GitPullRequestIcon, group: "About", scope: "mac" },
];

/**
 * The retired pane ids keep answering. `section=mcp` is baked into the OAuth
 * callback's redirect (app/api/mcp/oauth/callback/route.ts), and the rest may
 * live in bookmarks; an alias costs one map entry and never strands a link on
 * the default pane.
 */
export const SECTION_ALIASES: Record<string, string> = {
  sessions: "general",
  inbox: "general",
  textgen: "general",
  mcp: "tools",
  permissions: "tools",
  // THE OLD APPLICATION PANE, later folded into General, is This build again.
  application: "about",
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

/** Exported with `SECTION_ALIASES` above so a test can resolve a link the way
 *  the page does — through the real table and the real hook — rather than by
 *  matching a string in this file's source. */
export const SECTION_IDS = SECTIONS.map((section) => section.id);

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

  /**
   * ...AND WHEN IT STOPPED ASSEMBLING ITSELF (#492).
   *
   * The app shell stamps `commit` — the route rendering at all — and this
   * stamps `idle`, the two of them bracketing what "opening Settings" costs.
   * There is no `transcript` phase: that stamp means a conversation's own rows
   * landed, and this page has none, so it stays absent rather than being given
   * a meaning it does not have.
   *
   * ON `load()` RESOLVING, NOT ON A PIECE OF STATE ARRIVING. `about` is set
   * only when the engine answers, so an idle keyed to it would never fire on a
   * machine whose daemon is down — the slowest arrival there is would be the
   * one missing from the numbers. `load` settles either way, which is the
   * honest reading of "this screen has what it is going to have".
   */
  useEffect(() => {
    const task = window.setTimeout(() => {
      void load().then(() => markNavigation("idle", window.location.pathname));
    }, 0);
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
      // `/` from anywhere in here finds a row by name without knowing which
      // pane holds it. See settings-registry.ts.
      search={SETTINGS_SEARCH_INDEX}
    >
      <Suspense fallback={null}>
        {active === "appearance" && <AppearanceSection />}

        {/* WORKSPACE FIRST: it is the only row here that decides what gets BUILT,
            and it is read before the session exists. Settling and naming both
            describe a session that is already running. */}
        {active === "general" && (
          <>
            <WorkspaceSection />
            <InboxSection />
            <TextGenSection />
          </>
        )}

        {active === "about" && (
          <AboutSection {...(about ? { about } : {})} {...(health ? { health } : {})} unreachable={unreachable} />
        )}

        {active === "updates" && <UpdatesSection />}

        {/* What Telar deletes on its own, then where the store lives. */}
        {active === "storage" && (
          <>
            <CleanupSection />
            <StoreSection />
          </>
        )}

        {/* AND THE SAME FOR DICTATION (#544), which left General by the same
            door and for a sharper reason: it ships OFF, so the row a reader
            wants is the switch that turns it on. */}
        {active === "dictation" && <DictationSection />}

        {active === "projects" && <ProjectsPage />}

        {active === "keybindings" && <KeybindingsPage />}

        {active === "plugins" && <PluginsPage />}

        {active === "remote" && (
          <>
            <RemoteSection />
            <OtherMacsSection />
          </>
        )}

        {/* Usage providers sit UNDER the logins and on the same pane: a login is
            an account this machine runs turns as, a hub is a service that runs
            them on accounts it never signs in as, and both answer "where does my
            capacity come from". */}
        {active === "providers" && (
          <>
            <ProvidersSection />
            <UsageProvidersSection />
          </>
        )}

        {active === "source-control" && <SourceControlPage />}

        {active === "integrations" && (
          <>
            <IntegrationsPage />
            <LinksSection />
          </>
        )}

        {/* ORIENTATION LEADS THE PANE. The two groups under it decide what an
            agent may REACH; this decides what it is TOLD before anyone has said
            anything, which is the first thing a person auditing "what does Telar
            do to my agent" is looking for. */}
        {active === "tools" && (
          <>
            <OrientationSection />
            <McpSection />
            <PermissionsSection />
          </>
        )}
      </Suspense>
    </SettingsShell>
  );
}
