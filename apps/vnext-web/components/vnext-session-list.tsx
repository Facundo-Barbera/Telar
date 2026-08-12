import Link from "next/link";
import type { Project, Session } from "@telar/engine-client";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { PanelEmpty } from "@/components/ui/panel";
import { cn } from "@/lib/utils";

/** The sentinel for "no project filter". A reserved id rather than `""` so an
 *  empty scope and the all-projects scope cannot be confused for each other. */
export const ALL_PROJECTS = "__all__";

export type SessionFilter = "all" | "active" | "archived";

export function sessionFilterLabel(filter: SessionFilter) {
  return filter === "all" ? "All" : filter === "active" ? "Active" : "Archived";
}

/** Filter and search, in one place so the rail's COUNTS and its LIST cannot
 *  disagree about what a filter means. */
export function visibleSessions(
  sessions: readonly Session[],
  { filter, query, projectName }: { filter: SessionFilter; query: string; projectName: (id: string) => string },
): Session[] {
  const needle = query.trim().toLowerCase();
  return sessions.filter((session) => {
    if (filter !== "all" && session.state !== filter) return false;
    if (!needle) return true;
    return `${session.title} ${projectName(session.projectId)}`.toLowerCase().includes(needle);
  });
}

/**
 * A session row.
 *
 * Two lines and no leading icon: the title carries the row, and the metadata
 * sits under it at 11px. A glyph on every row would draw a column of identical
 * marks down the rail that says nothing — every entry here is a session.
 *
 * An ARCHIVED row is dimmed rather than hidden or badged. It is still a session
 * you can open; the point is only that it is not part of today's work.
 */
export function VNextSessionList({
  projects,
  sessions,
  activeSessionId,
  filter,
  query,
  showProject,
  onNavigate,
}: {
  projects: Project[];
  sessions: readonly Session[];
  activeSessionId?: string;
  filter: SessionFilter;
  query: string;
  /** True while the rail is scoped to all projects, where the project name is
   *  the one piece of context a bare title is missing. */
  showProject?: boolean;
  onNavigate?: () => void;
}) {
  const names = new Map(projects.map((project) => [project.id, project.name]));
  const projectName = (id: string) => names.get(id) ?? id;
  const visible = visibleSessions(sessions, { filter, query, projectName });

  if (visible.length === 0) {
    return (
      <PanelEmpty title={query ? "Nothing matches" : filter === "archived" ? "Nothing archived" : "No sessions yet"}>
        {query ? "No session title or project matches this search." : "Open a project and start one."}
      </PanelEmpty>
    );
  }

  return (
    <SidebarMenu>
      {visible.map((session) => (
        <SidebarMenuItem key={session.id}>
          <SidebarMenuButton
            isActive={session.id === activeSessionId}
            className={cn("h-auto flex-col items-start gap-0.5 py-1.5", session.state === "archived" && "opacity-60")}
            render={
              <Link
                href={`/projects/${encodeURIComponent(session.projectId)}/sessions/${encodeURIComponent(session.id)}`}
                onClick={onNavigate}
                aria-current={session.id === activeSessionId ? "page" : undefined}
              />
            }
          >
            <span className="w-full truncate text-sm">{session.title || "Untitled session"}</span>
            <span className="w-full truncate text-[11px] text-muted-foreground">
              {showProject ? `${projectName(session.projectId)} · ` : ""}
              {new Date(session.updatedAt).toLocaleDateString()}
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}
