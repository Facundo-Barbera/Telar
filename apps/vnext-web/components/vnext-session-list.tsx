import Link from "next/link";
import type { Project, Session } from "@telar/engine-client";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";

export type SessionFilter = "recent" | "active" | "all";

export function sessionFilterLabel(filter: SessionFilter) {
  return filter === "recent" ? "Recent" : filter === "active" ? "Active" : "All";
}

/**
 * A session row.
 *
 * Two lines and no icon: the title carries the row, and the project plus the
 * date sit under it at 11px. A leading glyph on every row would draw a column of
 * identical marks down the rail that says nothing — every entry here is a
 * session, so a "this is a session" icon is pure noise.
 */
export function VNextSessionList({
  projects,
  sessions,
  activeSessionId,
  filter,
  query,
  onNavigate,
}: {
  projects: Project[];
  sessions: Session[];
  activeSessionId?: string;
  filter: SessionFilter;
  query: string;
  onNavigate?: () => void;
}) {
  const projectName = new Map(projects.map((project) => [project.id, project.name]));
  const visible = sessions.filter((session) => {
    const text = `${session.title} ${projectName.get(session.projectId) ?? session.projectId}`.toLowerCase();
    return (!query || text.includes(query.toLowerCase())) && (filter !== "active" || session.id === activeSessionId);
  });

  if (visible.length === 0) {
    return (
      <p className="px-2 py-1.5 text-xs text-muted-foreground">
        {query
          ? "No sessions match this search."
          : filter === "active"
            ? "No active session in this view."
            : "No engine-backed sessions yet."}
      </p>
    );
  }

  return (
    <SidebarMenu>
      {visible.map((session) => (
        <SidebarMenuItem key={session.id}>
          <SidebarMenuButton
            isActive={session.id === activeSessionId}
            className="h-auto flex-col items-start gap-0.5 py-1.5"
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
              {projectName.get(session.projectId) ?? session.projectId} · {new Date(session.updatedAt).toLocaleDateString()}
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}
