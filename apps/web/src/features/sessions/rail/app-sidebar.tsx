"use client";

import { Suspense, useCallback, useState } from "react";
import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import type { Project } from "@telar/engine-client";
import { type CommandPalettePage, useCommandHandlers, useCommandKeys } from "@/features/commands";
import type { NewConversationTarget } from "@/features/projects";
import { Sidebar, SidebarContent, SidebarFooter, SidebarRail, type SidebarResizableOptions, type SidebarWidthProposal, useSidebar } from "@/components/ui/sidebar";
import { projectSettingsHref } from "@/lib/project-settings-link";
import {
  activeSessionFromPathname,
  canvasHref,
  canvasProjectFromPathname,
  SESSION_PAGE_SIZE,
  SETTLED_PAGE_SIZE,
  sessionHref,
  sessionKey,
  type SidebarSession,
} from "@/lib/session-list";
import { APP_SIDEBAR_MAIN_MIN_WIDTH, APP_SIDEBAR_STORAGE_KEY, keepsRoomForMain, SIDEBAR_RESIZE_MIN_WIDTH } from "@/lib/sidebar-width";
import { AppSidebarFooterRow } from "./app-sidebar-footer";
import { RailDrafts } from "./rail-drafts";
import { AttentionRows, RailSessionList, RailShelves } from "./rail-list";
import { TelarSidebarHeader } from "./rail-parts";
import { RailSearch } from "./rail-search";
import { SidebarProjectFilter } from "./sidebar-project-filter";
import { useRailData, type RemoteProject } from "./use-rail-data";
import { useRailView } from "./use-rail-view";

const CommandPalette = dynamic(() => import("@/features/commands/components/command-palette").then((mod) => mod.CommandPalette));

const APP_SIDEBAR_RESIZABLE = {
  minWidth: SIDEBAR_RESIZE_MIN_WIDTH,
  storageKey: APP_SIDEBAR_STORAGE_KEY,
  shouldAcceptWidth: ({ currentWidth, nextWidth, wrapper }: SidebarWidthProposal) =>
    keepsRoomForMain(currentWidth, nextWidth, wrapper.getBoundingClientRect().width, APP_SIDEBAR_MAIN_MIN_WIDTH),
} satisfies SidebarResizableOptions;

export function pickerTargetsFor(projects: readonly Project[], remoteProjects: readonly RemoteProject[]): NewConversationTarget[] {
  return [
    ...projects.map((project) => ({
      id: project.id,
      name: project.name,
      ...(project.icon ? { icon: project.icon } : {}),
      ...(project.iconName ? { iconName: project.iconName } : {}),
      ...(project.root ? { root: project.root } : {}),
    })),
    ...remoteProjects.map((project) => ({
      id: project.id,
      name: project.name,
      ...(project.icon ? { icon: project.icon } : {}),
      ...(project.iconName ? { iconName: project.iconName } : {}),
      hostId: project.hostId,
      hostName: project.hostName,
    })),
  ];
}

export const composerTargetOf = (target: { id: string; hostId?: string }) => ({
  projectId: target.id,
  ...(target.hostId ? { hostId: target.hostId } : {}),
});

type PaletteState = { open: boolean; asked: boolean; page: CommandPalettePage; query: string };
type ComposerTarget = { projectId: string; hostId?: string };

export function composerTargetFor(
  sessions: readonly SidebarSession[],
  activeSessionId: string | undefined,
  projects: readonly Project[],
  remoteProjects: readonly RemoteProject[],
): ComposerTarget | undefined {
  const active = sessions.find((session) => sessionKey(session) === activeSessionId);
  if (active?.projectId) return { projectId: active.projectId, ...(active.hostId ? { hostId: active.hostId } : {}) };
  const recent = [...sessions].sort((left, right) => right.updatedAt - left.updatedAt).find((session) => session.projectId);
  if (recent?.projectId) return { projectId: recent.projectId, ...(recent.hostId ? { hostId: recent.hostId } : {}) };
  if (projects[0]) return { projectId: projects[0].id };
  const remote = remoteProjects[0];
  return remote ? { projectId: remote.id, hostId: remote.hostId } : undefined;
}

function SidebarBody() {
  const pathname = usePathname();
  const router = useRouter();
  const { isMobile, open: railOpen, setOpenMobile, toggleSidebar } = useSidebar();
  const data = useRailData();
  const [query, setQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const [sessionLimit, setSessionLimit] = useState(SESSION_PAGE_SIZE);
  const [settledLimit, setSettledLimit] = useState(SETTLED_PAGE_SIZE);
  const [palette, setPalette] = useState<PaletteState>({ open: false, asked: false, page: "root", query: "" });
  const openPalette = (page: CommandPalettePage, seed = "") => setPalette({ open: true, asked: true, page, query: seed });

  const onNavigate = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  const activeSessionId = activeSessionFromPathname(pathname);
  const view = useRailView(data, { query, activeSessionId, sessionLimit, settledLimit });
  const run = useCommandKeys(view.jumpRows, {
    "new-conversation": () => newConversation(),
    "new-conversation-in": () => openPalette("projects"),
    "add-project": () => openPalette("sources"),
    "search-sessions": () =>
      setPalette((current) => (current.open ? { ...current, open: false } : { open: true, asked: true, page: "root", query })),
    "toggle-rail": () => toggleSidebar(),
  });

  const results = view.list.sessions;
  const selectedSearchIndex = results.length ? Math.min(searchIndex, results.length - 1) : -1;
  const composerTarget = composerTargetFor(data.sessions, activeSessionId, data.projects, data.remoteProjects);
  const startSession = (target = composerTarget) => {
    onNavigate();
    router.push(target ? canvasHref(target.projectId, target.hostId) : "/");
  };
  const openSession = (session: SidebarSession) => {
    onNavigate();
    router.push(sessionHref(session));
  };
  const openProjectSettings = (projectId: string) => {
    onNavigate();
    router.push(projectSettingsHref(projectId));
  };

  const pickerTargets = pickerTargetsFor(data.projects, data.remoteProjects);
  const soleTarget = pickerTargets.length === 1 ? pickerTargets[0] : undefined;
  const newConversation = () => {
    if (soleTarget) startSession(composerTargetOf(soleTarget));
    else openPalette("projects");
  };

  const localProjectId = composerTarget && !composerTarget.hostId ? composerTarget.projectId : undefined;
  useCommandHandlers(localProjectId ? { "project-settings": () => openProjectSettings(localProjectId) } : {}, [localProjectId]);

  const filter = view.projectFilter;
  const listProps = { data, view, query, selectedSearchIndex, onNavigate, startSession, openProjectSettings };
  return (
    <>
      {palette.asked && (
        <Suspense fallback={null}>
          <CommandPalette
            open={palette.open}
            page={palette.page}
            query={palette.query}
            onOpenChange={(open) => setPalette((current) => ({ ...current, open, asked: current.asked || open }))}
            targets={pickerTargets}
            sessions={data.sessions}
            railOpen={railOpen}
            onRun={run}
            onChooseProject={(target) => startSession(composerTargetOf(target))}
            onOpenSession={openSession}
            onRegistered={() => void data.loadAll()}
          />
        </Suspense>
      )}
      <TelarSidebarHeader mode={view.layout.mode} onModeChange={(next) => void view.layout.setMode(next)} />
      <SidebarContent>
        <RailSearch
          query={query}
          onType={(value) => {
            setQuery(value);
            setSearchIndex(0);
            setSessionLimit(SESSION_PAGE_SIZE);
          }}
          onClear={() => {
            setQuery("");
            setSearchIndex(0);
          }}
          results={results}
          selectedIndex={selectedSearchIndex}
          setSelectedIndex={setSearchIndex}
          onOpen={openSession}
          filter={
            pickerTargets.length > 1 ? (
              <SidebarProjectFilter targets={pickerTargets} selected={view.projectsShown} onToggle={filter.toggle} onClear={filter.clear} />
            ) : undefined
          }
          soleTargetName={soleTarget?.name}
          run={run}
        />
        <RailDrafts
          projects={data.projects}
          projectsShown={view.projectsShown}
          query={query}
          openCanvasProject={canvasProjectFromPathname(pathname)}
          onNavigate={onNavigate}
        />
        {view.grouped && <AttentionRows rows={view.grouped.attention} env={view.env} />}
        <RailSessionList
          {...listProps}
          onShowMore={() => setSessionLimit((limit) => limit + SESSION_PAGE_SIZE)}
          canStart={Boolean(composerTarget)}
          onAddProject={() => openPalette("sources")}
        />
        {!view.list.flat && (
          <RailShelves data={data} view={view} settledLimit={settledLimit} onMoreSettled={() => setSettledLimit((limit) => limit + SETTLED_PAGE_SIZE)} />
        )}
      </SidebarContent>
      <SidebarFooter>
        <AppSidebarFooterRow onNavigate={onNavigate} />
      </SidebarFooter>
    </>
  );
}

function AppSidebarRail() {
  const { open } = useSidebar();
  return open ? <SidebarRail className="after:bg-transparent" /> : null;
}

export { SidebarBody as AppSidebarBody };

export function AppSidebar() {
  return (
    <Sidebar variant="floating" collapsible="offcanvas" resizable={APP_SIDEBAR_RESIZABLE} className="p-[var(--app-island-inset)]">
      <SidebarBody />
      <AppSidebarRail />
    </Sidebar>
  );
}
