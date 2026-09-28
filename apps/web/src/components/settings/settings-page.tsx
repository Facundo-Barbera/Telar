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

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { EngineHealth } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { markNavigation } from "@/lib/perf-marks";
import { Badge } from "@/components/ui/badge";
import { Row, SettingsGroup, SettingsShell } from "./settings-shell";
import { SECTION_IDS, SECTIONS, settingsSearchIndex } from "./settings-sections";
import { projectPaneFor } from "@/components/plugins/settings-panes";
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
const AppearanceSection = dynamic(() => import("@/features/appearance/components/appearance-section").then((mod) => mod.AppearanceSection));
const InboxSection = dynamic(() => import("@/features/sessions/components/inbox-section").then((mod) => mod.InboxSection));
const LinksSection = dynamic(() => import("./links-section").then((mod) => mod.LinksSection));
const DictationSection = dynamic(() => import("./dictation-section").then((mod) => mod.DictationSection));
const McpSection = dynamic(() => import("@/features/agent-tools/components/mcp-section").then((mod) => mod.McpSection));
const OrientationSection = dynamic(() => import("./orientation-section").then((mod) => mod.OrientationSection));
const IntegrationsPage = dynamic(() => import("./integrations-page").then((mod) => mod.IntegrationsPage));
const KeybindingsPage = dynamic(() => import("./keybindings-page").then((mod) => mod.KeybindingsPage));
const ProjectsPage = dynamic(() => import("@/features/projects/components/projects-page").then((mod) => mod.ProjectsPage));
const PermissionsSection = dynamic(() => import("@/features/providers/components/permissions-section").then((mod) => mod.PermissionsSection));
const ProvidersSection = dynamic(() => import("@/features/providers/components/providers-section").then((mod) => mod.ProvidersSection));
const RemoteSection = dynamic(() => import("@/features/remote/components/remote-section").then((mod) => mod.RemoteSection));
const SourceControlPage = dynamic(() => import("./source-control-page").then((mod) => mod.SourceControlPage));
const OtherMacsSection = dynamic(() => import("@/features/hosts/components/other-macs-section").then((mod) => mod.OtherMacsSection));
const TextGenSection = dynamic(() => import("@/features/providers/components/textgen-section").then((mod) => mod.TextGenSection));
const PluginsPage = dynamic(() => import("./plugins-page").then((mod) => mod.PluginsPage));
const UpdatesSection = dynamic(() => import("./updates-section").then((mod) => mod.UpdatesSection));
const StoreSection = dynamic(() => import("./store-section").then((mod) => mod.StoreSection));
const CleanupSection = dynamic(() => import("@/features/worktrees/components/cleanup-section").then((mod) => mod.CleanupSection));
const UsageProvidersSection = dynamic(() => import("@/features/usage").then((mod) => mod.UsageProvidersSection));
const WorkspaceSection = dynamic(() => import("@/features/projects/components/workspace-section").then((mod) => mod.WorkspaceSection));

const api = createEngineApi();

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

export function SettingsPage() {
  // `?section=` is how a sign-in gets the user back to the pane they left —
  // see use-section-from-url.ts for the failure that made this necessary.
  const [active, setActive] = useSectionFromUrl("general", SECTION_IDS);
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

  // A bespoke project pane draws its own rows; the Mac scope is always generated.
  const search = useMemo(
    () => settingsSearchIndex(health?.plugins, (scope, id) => scope === "project" && projectPaneFor(id) !== undefined),
    [health],
  );

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
      search={search}
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
