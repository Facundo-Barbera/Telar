"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Project, Session } from "@telar/engine-client";
import { createVNextApi } from "@/lib/vnext/client";
import { Icon } from "./vnext-icons";
import { type SessionFilter, sessionFilterLabel, VNextSessionList } from "./vnext-session-list";

const api = createVNextApi();

function activeSessionFromPath(pathname: string) {
  const match = pathname.match(/\/sessions\/([^/]+)/);
  return match?.[1];
}

export function VNextSidebar({ collapsed, onClose }: { collapsed: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [filter, setFilter] = useState<SessionFilter>("recent");
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const activeSessionId = activeSessionFromPath(pathname);
  const onNavigate = () => {
    if (window.matchMedia("(max-width: 720px)").matches) onClose();
  };

  const load = useCallback(async () => {
    try {
      const result = await api.projects();
      setProjects(result.projects);
      setProjectId((current) => current && result.projects.some((project) => project.id === current) ? current : result.projects[0]?.id ?? "");
      setUnavailable(false);
    } catch { setUnavailable(true); }
  }, []);
  useEffect(() => {
    const task = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(task);
  }, [load]);
  useEffect(() => {
    if (!projectId) {
      const task = window.setTimeout(() => setSessions([]), 0);
      return () => window.clearTimeout(task);
    }
    let cancelled = false;
    void api.sessions(projectId).then((result) => !cancelled && setSessions(result.sessions), () => !cancelled && setUnavailable(true));
    return () => { cancelled = true; };
  }, [projectId]);
  const selectedProject = useMemo(() => projects.find((project) => project.id === projectId), [projects, projectId]);

  return <aside className={`vnext-sidebar ${collapsed ? "is-collapsed" : ""}`} aria-label="Telar navigation">
    <div className="vnext-sidebar__head"><Link href="/" onClick={onNavigate} className="vnext-wordmark">telar <em>vNext</em></Link><button className="vnext-icon-button vnext-sidebar__close" type="button" aria-label="Hide navigation" onClick={onClose}><Icon name="close" /></button></div>
    <nav className="vnext-primary-nav" aria-label="Application"><Link href="/" className={pathname === "/" ? "is-active" : ""} onClick={onNavigate}><Icon name="home" />Overview</Link><Link href="/" className={pathname === "/" ? "is-active" : ""} onClick={onNavigate}><Icon name="folder" />Projects</Link></nav>
    <div className="vnext-sidebar__tools"><label className="vnext-search"><Icon name="search" /><span className="sr-only">Search sessions</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search sessions" /></label><Link href="/" onClick={onNavigate} className="vnext-icon-button" aria-label="Create or select a session"><Icon name="plus" /></Link></div>
    <label className="vnext-project-select"><span>Project</span><select value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={projects.length === 0}><option value="">{projects.length ? "Choose a project" : "No projects"}</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select>{selectedProject && <small>{selectedProject.root}</small>}</label>
    <div className="vnext-filter-row" role="tablist" aria-label="Session filter">{(["recent", "active", "all"] as const).map((entry) => <button key={entry} type="button" role="tab" aria-selected={filter === entry} className={filter === entry ? "is-active" : ""} onClick={() => setFilter(entry)}>{sessionFilterLabel(entry)}</button>)}</div>
    <section className="vnext-sidebar__sessions" aria-label="Sessions"><div className="vnext-sidebar__section-title"><span>{sessionFilterLabel(filter)}</span><button type="button" className="vnext-quiet-button" aria-label="Refresh sessions" onClick={() => void load()}><Icon name="refresh" /></button></div>{unavailable ? <p className="vnext-sidebar-empty">The local engine is unavailable.</p> : <VNextSessionList projects={projects} sessions={sessions} activeSessionId={activeSessionId} filter={filter} query={query} onNavigate={onNavigate} />}</section>
    <footer className="vnext-sidebar__foot"><Link href="/settings" className={pathname.startsWith("/settings") ? "is-active" : ""} onClick={onNavigate}><Icon name="settings" />Settings</Link></footer>
  </aside>;
}
