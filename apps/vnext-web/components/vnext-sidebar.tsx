"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { HomeIcon, RefreshCwIcon, SearchIcon, SettingsIcon } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { type SessionFilter, sessionFilterLabel, VNextSessionList } from "./vnext-session-list";

const api = createVNextApi();

function activeSessionFromPath(pathname: string) {
  const match = pathname.match(/\/sessions\/([^/]+)/);
  return match?.[1];
}

export function VNextSidebar() {
  const pathname = usePathname();
  const { isMobile, setOpenMobile } = useSidebar();
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [filter, setFilter] = useState<SessionFilter>("recent");
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState("");
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
      setProjectId((current) => (current && result.projects.some((project) => project.id === current) ? current : (result.projects[0]?.id ?? "")));
      setUnavailable(false);
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

  useEffect(() => {
    if (!projectId) {
      const task = window.setTimeout(() => setSessions([]), 0);
      return () => window.clearTimeout(task);
    }
    let cancelled = false;
    void api.sessions(projectId).then(
      (result) => !cancelled && setSessions(result.sessions),
      () => !cancelled && setUnavailable(true),
    );
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const selectedProject = useMemo(() => projects.find((project) => project.id === projectId), [projects, projectId]);

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
          <SidebarGroupLabel>Project</SidebarGroupLabel>
          <SidebarGroupContent>
            {/* Base UI reports `null` when a selection is cleared, which this
                control never offers — collapsing it to "" keeps the empty state
                one value instead of two that mean the same thing. */}
            <Select value={projectId} onValueChange={(next) => setProjectId(next ?? "")} disabled={projects.length === 0}>
              <SelectTrigger size="sm" className="w-full" aria-label="Project">
                {/* SelectValue renders the raw VALUE unless given a formatter,
                    which put `project_1a1649…` in the trigger where the project's
                    name belongs. The id is addressing; the name is the label. */}
                <SelectValue placeholder={projects.length ? "Choose a project" : "No projects"}>
                  {(value) => projects.find((project) => project.id === value)?.name ?? "Choose a project"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
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
              {(["recent", "active", "all"] as const).map((entry) => (
                <button
                  key={entry}
                  type="button"
                  role="tab"
                  aria-selected={filter === entry}
                  onClick={() => setFilter(entry)}
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[11px] transition-colors",
                    filter === entry ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {sessionFilterLabel(entry)}
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
              <p className="px-2 py-1.5 text-xs text-muted-foreground">The local engine is unavailable.</p>
            ) : (
              <VNextSessionList
                projects={projects}
                sessions={sessions}
                activeSessionId={activeSessionId}
                filter={filter}
                query={query}
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
