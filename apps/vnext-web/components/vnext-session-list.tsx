import Link from "next/link";
import type { EngineProject, EngineSession } from "@telar/engine-client";
import { Icon } from "./vnext-icons";

export type SessionFilter = "recent" | "active" | "all";

export function sessionFilterLabel(filter: SessionFilter) {
  return filter === "recent" ? "Recent" : filter === "active" ? "Active" : "All";
}

export function VNextSessionList({
  projects, sessions, activeSessionId, filter, query,
  onNavigate,
}: {
  projects: EngineProject[];
  sessions: EngineSession[];
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
  if (visible.length === 0) return <p className="vnext-sidebar-empty">{query ? "No sessions match this search." : filter === "active" ? "No active session in this view." : "No engine-backed sessions yet."}</p>;
  return <div className="vnext-session-list">{visible.map((session) => (
    <Link key={session.id} href={`/projects/${encodeURIComponent(session.projectId)}/sessions/${encodeURIComponent(session.id)}`} onClick={onNavigate} aria-current={session.id === activeSessionId ? "page" : undefined} className="vnext-session-row">
      <span className="vnext-session-row__mark"><Icon name="message" /></span>
      <span className="vnext-session-row__copy"><strong>{session.title || "Untitled session"}</strong><small>{projectName.get(session.projectId) ?? session.projectId} · {new Date(session.updatedAt).toLocaleDateString()}</small></span>
    </Link>
  ))}</div>;
}
