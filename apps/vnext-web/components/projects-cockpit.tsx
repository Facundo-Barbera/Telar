"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { EngineHealth, Project, Session } from "@telar/engine-client";
import { createVNextApi, VNextApiError } from "@/lib/vnext/client";
import { sessionsForSelectedProject } from "@/lib/vnext/project-selection";

const api = createVNextApi();

function EngineProblem({ error }: { error: VNextApiError }) {
  const unavailable = error.code === "engine_unavailable" || error.code === "engine_locked";
  return (
    <div role="alert" className="vnext-alert">
      <strong>{unavailable ? "vNext engine unavailable" : "vNext engine error"}</strong>
      <p>{error.message}</p>
      {unavailable && <p className="vnext-small">Start the dedicated local engine with the same TELAR_HOME, then refresh this cockpit.</p>}
    </div>
  );
}

export function ProjectsCockpit() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsProjectId, setSessionsProjectId] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [health, setHealth] = useState<EngineHealth>();
  const [error, setError] = useState<VNextApiError>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [root, setRoot] = useState("");
  const [title, setTitle] = useState("");

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const [projectResult, healthResult] = await Promise.all([api.projects(), api.health()]);
      setProjects(projectResult.projects);
      setHealth(healthResult);
      setSelectedId((current) => current && projectResult.projects.some((project) => project.id === current) ? current : projectResult.projects[0]?.id);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not load the vNext cockpit."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => { void loadProjects(); }, 0);
    return () => window.clearTimeout(task);
  }, [loadProjects]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    void api.sessions(selectedId).then(
      (result) => {
        if (!cancelled) {
          setSessions(result.sessions);
          setSessionsProjectId(selectedId);
        }
      },
      (cause) => {
        if (!cancelled) setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not load sessions."));
      },
    );
    return () => { cancelled = true; };
  }, [selectedId]);

  const visibleSessions = sessionsForSelectedProject(sessions, selectedId, sessionsProjectId);

  const register = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const result = await api.registerProject({ name, root });
      setName("");
      setRoot("");
      await loadProjects();
      setSelectedId(result.project.id);
    } catch (cause) {
      setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not register the project."));
    } finally {
      setSaving(false);
    }
  };

  const createSession = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedId) return;
    setSaving(true);
    try {
      const result = await api.createSession(selectedId, title || undefined);
      window.location.assign(`/projects/${encodeURIComponent(selectedId)}/sessions/${encodeURIComponent(result.session.id)}`);
    } catch (cause) {
      setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not create the session."));
      setSaving(false);
    }
  };

  return (
    <main className="vnext-main vnext-projects-cockpit">
      <header className="vnext-page-heading">
        <div>
          <p className="vnext-eyebrow">Engine-owned work</p>
          <h1>Projects</h1>
          <p className="vnext-muted">Register a local project or choose one from the session inbox. This surface only reads and writes vNext engine records.</p>
        </div>
        <button className="vnext-button vnext-button--secondary" type="button" onClick={() => void loadProjects()} disabled={loading}>Refresh</button>
      </header>

      {error && <EngineProblem error={error} />}

      <div className="vnext-grid">
        <section className="vnext-stack" aria-label="Projects">
          <article className="vnext-card">
            <h2>Engine status</h2>
            <p>{health ? (health.worker.registered ? `Worker ${health.worker.workerId ?? "registered"} is available.` : "No worker is registered; turns cannot be submitted yet.") : "Checking the local engine."}</p>
          </article>
          <article className="vnext-card">
            <h2>Register project</h2>
            <p>Stores only a vNext project record in the engine.</p>
            <form className="vnext-form" onSubmit={register}>
              <input className="vnext-input" aria-label="Project name" placeholder="Project name" value={name} onChange={(event) => setName(event.target.value)} required />
              <input className="vnext-input" aria-label="Project root" placeholder="/absolute/path/to/project" value={root} onChange={(event) => setRoot(event.target.value)} required />
              <button className="vnext-button" type="submit" disabled={saving}>Register project</button>
            </form>
          </article>
          <div className="vnext-list" aria-label="Registered projects">
            {loading && <p className="vnext-muted vnext-small">Loading projects…</p>}
            {!loading && projects.length === 0 && <p className="vnext-card">No vNext projects are registered.</p>}
            {projects.map((project) => (
              <button key={project.id} type="button" onClick={() => setSelectedId(project.id)} className={`vnext-list-button ${project.id === selectedId ? "vnext-list-button--selected" : ""}`}>
                <strong>{project.name}</strong>
                <span className="vnext-muted vnext-mono">{project.root}</span>
              </button>
            ))}
          </div>
        </section>

        <section id="sessions" aria-label="Sessions">
          <article className="vnext-card">
            <div className="vnext-card__header"><div><h2>Sessions</h2><p>{selectedId ? "Persistent transcripts owned by the vNext engine." : "Choose a project to inspect its sessions."}</p></div>{selectedId && <span className="vnext-quiet-label">{projects.find((project) => project.id === selectedId)?.name}</span>}</div>
            {selectedId && (
              <form className="vnext-row" onSubmit={createSession}>
                <input className="vnext-input vnext-fill" aria-label="Session title" placeholder="Session title (optional)" value={title} onChange={(event) => setTitle(event.target.value)} />
                <button className="vnext-button" type="submit" disabled={saving}>New session</button>
              </form>
            )}
            {selectedId && visibleSessions.length === 0 && <p>No sessions yet.</p>}
            <div className="vnext-list">
              {visibleSessions.map((session) => (
                <Link key={session.id} href={`/projects/${encodeURIComponent(session.projectId)}/sessions/${encodeURIComponent(session.id)}`} className="vnext-session-link">
                  <strong>{session.title}</strong>
                  <span className="vnext-muted vnext-mono">{session.id}</span>
                </Link>
              ))}
            </div>
          </article>
        </section>
      </div>
    </main>
  );
}
