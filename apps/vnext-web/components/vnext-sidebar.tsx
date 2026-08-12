"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRightIcon, FolderIcon, HomeIcon, RefreshCwIcon, SearchIcon, SettingsIcon } from "lucide-react";
import type { Project, Session } from "@telar/engine-client";
import { createVNextApi } from "@/lib/vnext/client";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PanelEmpty } from "@/components/ui/panel";
import { cn } from "@/lib/utils";
import { ALL_PROJECTS, type SessionFilter, sessionFilterLabel, VNextSessionList } from "./vnext-session-list";

const api = createVNextApi();

function activeSessionFromPath(pathname: string) {
  const match = pathname.match(/\/sessions\/([^/]+)/);
  return match?.[1];
}

const FILTERS: SessionFilter[] = ["all", "active", "archived"];

/**
 * The rail.
 *
 * TWO THINGS CHANGED FROM THE FIRST BUILD, both of which the frozen app gets
 * right and this did not:
 *
 * 1. ALL PROJECTS IS A SCOPE. The sidebar used to force picking one project
 *    before it would list anything, which is wrong for the way these sessions
 *    are actually used — you move between them across projects, and a rail that
 *    hides everything outside the current one makes that a navigation task.
 * 2. THE FILTERS COUNT. `All 12 · Active 9 · Archived 3` over the real records.
 *    The donor shows `Unread 24`; vNext has no read state, and inventing one
 *    would put a number on the screen that nothing backs.
 */
export function VNextSidebar() {
  const pathname = usePathname();
  const { isMobile, setOpenMobile } = useSidebar();
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [filter, setFilter] = useState<SessionFilter>("all");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<string>(ALL_PROJECTS);
  const [unavailable, setUnavailable] = useState(false);
  const activeSessionId = activeSessionFromPath(pathname);

  // On a phone the rail is a sheet OVER the content, so following a link has to
  // close it — otherwise the destination is behind the thing you just used.
  const onNavigate = () => {
    if (isMobile) setOpenMobile(false);
  };

  const load = useCallback(async () => {
    try {
      const result = await api.projects();
      setProjects(result.projects);
      setUnavailable(false);
      /**
       * One request per project, in parallel, because the engine lists sessions
       * per project and the rail's scope is now "all of them". `allSettled`, not
       * `all`: one unreachable project must not blank the whole list — the
       * sessions that did answer are still worth showing.
       */
      const pages = await Promise.allSettled(result.projects.map((project) => api.sessions(project.id)));
      setSessions(pages.flatMap((page) => (page.status === "fulfilled" ? page.value.sessions : [])));
    } catch {
      setUnavailable(true);
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const scoped = useMemo(() => (scope === ALL_PROJECTS ? sessions : sessions.filter((session) => session.projectId === scope)), [sessions, scope]);
  const counts = useMemo(
    () => ({
      all: scoped.length,
      active: scoped.filter((session) => session.state === "active").length,
      archived: scoped.filter((session) => session.state === "archived").length,
    }),
    [scoped],
  );
  const selectedProject = useMemo(() => projects.find((project) => project.id === scope), [projects, scope]);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <Link
          href="/"
          onClick={onNavigate}
          className="flex items-center gap-2 px-2 py-1 text-[15px] font-semibold tracking-tight group-data-[collapsible=icon]:px-0"
        >
          <span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground">T</span>
          <span className="truncate group-data-[collapsible=icon]:hidden">Telar</span>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <SidebarGroupContent className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <SidebarInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search sessions"
              aria-label="Search sessions"
              className="pl-7"
            />
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="py-0 group-data-[collapsible=icon]:hidden">
          <SidebarGroupContent>
            <Select value={scope} onValueChange={(next) => setScope(next ?? ALL_PROJECTS)}>
              <SelectTrigger size="sm" className="w-full" aria-label="Project scope">
                {/* SelectValue renders the raw VALUE unless given a formatter,
                    which put `project_1a1649…` in the trigger where the name
                    belongs. The id is addressing; the name is the label. */}
                <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <SelectValue>
                  {(value) => (value === ALL_PROJECTS ? "All projects" : (projects.find((p) => p.id === value)?.name ?? "All projects"))}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedProject && (
              <p className="truncate px-1 pt-1 font-mono text-[10px] text-muted-foreground" title={selectedProject.root}>
                {selectedProject.root}
              </p>
            )}
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="pb-0 group-data-[collapsible=icon]:hidden">
          <SidebarGroupContent>
            <div className="flex gap-1" role="tablist" aria-label="Session filter">
              {FILTERS.map((entry) => (
                <button
                  key={entry}
                  type="button"
                  role="tab"
                  aria-selected={filter === entry}
                  onClick={() => setFilter(entry)}
                  className={cn(
                    "flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-colors",
                    filter === entry ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {sessionFilterLabel(entry)}
                  <span className="font-mono text-[10px] text-muted-foreground/70 tabular-nums">{counts[entry]}</span>
                </button>
              ))}
            </div>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="min-h-0 flex-1 group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel>{sessionFilterLabel(filter)}</SidebarGroupLabel>
          <SidebarGroupAction aria-label="Refresh sessions" onClick={() => void load()}>
            <RefreshCwIcon />
          </SidebarGroupAction>
          <SidebarGroupContent className="min-h-0 overflow-y-auto">
            {unavailable ? (
              <PanelEmpty title="Engine unavailable">Start the local engine, then refresh.</PanelEmpty>
            ) : projects.length === 0 ? (
              <PanelEmpty icon={<FolderIcon />} title="No projects yet">
                Register a project to start a session.
              </PanelEmpty>
            ) : (
              <VNextSessionList
                projects={projects}
                sessions={scoped}
                activeSessionId={activeSessionId}
                filter={filter}
                query={query}
                showProject={scope === ALL_PROJECTS}
                onNavigate={onNavigate}
              />
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton isActive={pathname === "/"} tooltip="Projects" render={<Link href="/" onClick={onNavigate} />}>
              <HomeIcon />
              <span>Projects</span>
              <ChevronRightIcon className="ml-auto size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover/menu-item:opacity-100" />
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={pathname.startsWith("/settings")}
              tooltip="Settings"
              render={<Link href="/settings" onClick={onNavigate} />}
            >
              <SettingsIcon />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      {/* The drag handle AND the click target that collapses the rail. */}
      <SidebarRail />
    </Sidebar>
  );
}
