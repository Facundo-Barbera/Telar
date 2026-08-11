"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { EngineHealth, EngineProject, EngineSession } from "@telar/engine-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { createVNextApi, VNextApiError } from "@/lib/vnext/client";
import { sessionsForSelectedProject } from "@/lib/vnext/project-selection";

const api = createVNextApi();

function EngineProblem({ error }: { error: VNextApiError }) {
  const unavailable = error.code === "engine_unavailable" || error.code === "engine_locked";
  return (
    <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
      <p className="font-medium">{unavailable ? "vNext engine unavailable" : "vNext engine error"}</p>
      <p className="mt-1">{error.message}</p>
      {unavailable && <p className="mt-2 text-xs">Start the dedicated local engine with the same TELAR_HOME, then refresh this cockpit.</p>}
    </div>
  );
}

export function ProjectsCockpit() {
  const [projects, setProjects] = useState<EngineProject[]>([]);
  const [sessions, setSessions] = useState<EngineSession[]>([]);
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
    // Defer the first client fetch until after the initial paint. This is an
    // external synchronization, not derived render state.
    const task = window.setTimeout(() => { void loadProjects(); }, 0);
    return () => window.clearTimeout(task);
  }, [loadProjects]);

  useEffect(() => {
    if (!selectedId) {
      return;
    }
    let cancelled = false;
    void api.sessions(selectedId).then(
      (result) => {
        if (!cancelled) {
          setSessions(result.sessions);
          setSessionsProjectId(selectedId);
        }
      },
      (cause) => { if (!cancelled) setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not load sessions.")); },
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
      window.location.assign(`/vnext/projects/${encodeURIComponent(selectedId)}/sessions/${encodeURIComponent(result.session.id)}`);
    } catch (cause) {
      setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not create the session."));
      setSaving(false);
    }
  };

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 p-6 md:p-10">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-primary">Telar vNext</p>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Projects and sessions</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">A small engine-owned cockpit. This page never reads or writes legacy Telar state.</p>
        </div>
        <Button variant="outline" onClick={() => void loadProjects()} disabled={loading}>Refresh</Button>
      </header>

      {error && <EngineProblem error={error} />}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <section className="space-y-4" aria-label="Projects">
          <Card>
            <CardHeader>
              <CardTitle>Engine status</CardTitle>
              <CardDescription>
                {health ? (health.worker.registered ? `Worker ${health.worker.workerId ?? "registered"} is available.` : "No worker is registered; turns cannot be submitted yet.") : "Checking the local engine."}
              </CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader><CardTitle>Register project</CardTitle><CardDescription>Stores only a vNext project record in the engine.</CardDescription></CardHeader>
            <CardContent>
              <form className="space-y-3" onSubmit={register}>
                <Input aria-label="Project name" placeholder="Project name" value={name} onChange={(event) => setName(event.target.value)} required />
                <Input aria-label="Project root" placeholder="/absolute/path/to/project" value={root} onChange={(event) => setRoot(event.target.value)} required />
                <Button type="submit" disabled={saving}>Register project</Button>
              </form>
            </CardContent>
          </Card>
          <div className="space-y-2">
            {loading && <p className="text-sm text-muted-foreground">Loading projects…</p>}
            {!loading && projects.length === 0 && <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No vNext projects are registered.</p>}
            {projects.map((project) => (
              <button key={project.id} type="button" onClick={() => setSelectedId(project.id)} className={`w-full rounded-lg border p-3 text-left text-sm transition-colors ${project.id === selectedId ? "border-primary bg-primary/5" : "border-border hover:bg-muted"}`}>
                <span className="block font-medium">{project.name}</span>
                <span className="mt-1 block truncate font-mono text-xs text-muted-foreground">{project.root}</span>
              </button>
            ))}
          </div>
        </section>

        <section id="sessions" aria-label="Sessions">
          <Card className="min-h-72">
            <CardHeader>
              <CardTitle>Sessions</CardTitle>
              <CardDescription>{selectedId ? "Persistent transcripts owned by the vNext engine." : "Choose a project to inspect its sessions."}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {selectedId && (
                <form className="flex flex-wrap gap-2" onSubmit={createSession}>
                  <Input aria-label="Session title" className="min-w-44 flex-1" placeholder="Session title (optional)" value={title} onChange={(event) => setTitle(event.target.value)} />
                  <Button type="submit" disabled={saving}>New session</Button>
                </form>
              )}
              {selectedId && visibleSessions.length === 0 && <p className="text-sm text-muted-foreground">No sessions yet.</p>}
              <div className="space-y-2">
                {visibleSessions.map((session) => (
                  <Link key={session.id} href={`/vnext/projects/${encodeURIComponent(session.projectId)}/sessions/${encodeURIComponent(session.id)}`} className="block rounded-lg border border-border p-3 text-sm hover:bg-muted">
                    <span className="block font-medium">{session.title}</span>
                    <span className="mt-1 block font-mono text-xs text-muted-foreground">{session.id}</span>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        </section>
      </div>
    </main>
  );
}
