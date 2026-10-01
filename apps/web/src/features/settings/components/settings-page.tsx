"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { EngineHealth } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { markNavigation } from "@/platform/perf-marks";
import { Badge } from "@/ui/badge";
import { Row, SettingsGroup, SettingsShell } from "./settings-shell";
import { SECTION_IDS, SECTIONS, settingsSearchIndex } from "../settings-sections";
import { projectPaneFor } from "@/features/plugins";
import { useSectionFromUrl } from "../use-section-from-url";

const AppearanceSection = dynamic(() => import("@/features/appearance/components/appearance-section").then((mod) => mod.AppearanceSection));
const InboxSection = dynamic(() => import("@/features/sessions/components/inbox-section").then((mod) => mod.InboxSection));
const RailSection = dynamic(() => import("@/features/sessions/components/rail-section").then((mod) => mod.RailSection));
const LinksSection = dynamic(() => import("./links-section").then((mod) => mod.LinksSection));
const DictationSection = dynamic(() => import("@/features/dictation/components/dictation-section").then((mod) => mod.DictationSection));
const McpSection = dynamic(() => import("@/features/agent-tools/components/mcp-section").then((mod) => mod.McpSection));
const OrientationSection = dynamic(() => import("@/features/agent-tools/components/orientation-section").then((mod) => mod.OrientationSection));
const IntegrationsPage = dynamic(() => import("@/features/browser/panes/integrations-page").then((mod) => mod.IntegrationsPage));
const KeybindingsPage = dynamic(() => import("@/features/commands/components/keybindings-page").then((mod) => mod.KeybindingsPage));
const ProjectsPage = dynamic(() => import("@/features/projects/components/projects-page").then((mod) => mod.ProjectsPage));
const PermissionsSection = dynamic(() => import("@/features/providers/components/permissions-section").then((mod) => mod.PermissionsSection));
const ProvidersSection = dynamic(() => import("@/features/providers/components/providers-section").then((mod) => mod.ProvidersSection));
const RemoteSection = dynamic(() => import("@/features/remote/components/remote-section").then((mod) => mod.RemoteSection));
const SourceControlPage = dynamic(() => import("@/features/github/components/source-control-page").then((mod) => mod.SourceControlPage));
const OtherHostsSection = dynamic(() => import("@/features/hosts/components/other-hosts-section").then((mod) => mod.OtherHostsSection));
const TextGenSection = dynamic(() => import("@/features/providers/components/textgen-section").then((mod) => mod.TextGenSection));
const PluginsPage = dynamic(() => import("@/features/plugins/components/plugins-page").then((mod) => mod.PluginsPage));
const UpdatesSection = dynamic(() => import("@/features/updates/components/updates-section").then((mod) => mod.UpdatesSection));
const StoreSection = dynamic(() => import("@/features/storage/components/store-section").then((mod) => mod.StoreSection));
const CleanupSection = dynamic(() => import("@/features/worktrees/components/cleanup-section").then((mod) => mod.CleanupSection));
const UsageProvidersSection = dynamic(() => import("@/features/usage").then((mod) => mod.UsageProvidersSection));
const WorkspaceSection = dynamic(() => import("@/features/projects/components/workspace-section").then((mod) => mod.WorkspaceSection));

const api = createEngineApi();

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
    <SettingsGroup title="This build">
      <Row label="Version" control={<Mono>{about ? about.appVersion : "—"}</Mono>} />
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
  const [active, setActive] = useSectionFromUrl("general", SECTION_IDS);
  const [about, setAbout] = useState<{ appVersion: string; stateRoot?: string }>();
  const [health, setHealth] = useState<EngineHealth>();
  const [unreachable, setUnreachable] = useState(false);

  const load = useCallback(async () => {
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
    const task = window.setTimeout(() => {
      void load().then(() => markNavigation("idle", window.location.pathname));
    }, 0);
    return () => window.clearTimeout(task);
  }, [load]);

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
      search={search}
    >
      <Suspense fallback={null}>
        {active === "appearance" && <AppearanceSection />}

        {active === "general" && (
          <>
            <WorkspaceSection />
            <RailSection />
            <InboxSection />
            <TextGenSection />
          </>
        )}

        {active === "about" && (
          <AboutSection {...(about ? { about } : {})} {...(health ? { health } : {})} unreachable={unreachable} />
        )}

        {active === "updates" && <UpdatesSection />}

        {active === "storage" && (
          <>
            <CleanupSection />
            <StoreSection />
          </>
        )}

        {active === "dictation" && <DictationSection />}

        {active === "projects" && <ProjectsPage />}

        {active === "keybindings" && <KeybindingsPage />}

        {active === "plugins" && <PluginsPage />}

        {active === "remote" && (
          <>
            <RemoteSection />
            <OtherHostsSection />
          </>
        )}

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
