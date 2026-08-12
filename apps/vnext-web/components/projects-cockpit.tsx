"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ChevronRightIcon, GitBranchIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import type { EngineHealth, Project, ProviderDriverKind, Session } from "@telar/engine-client";
import { createVNextApi, VNextApiError } from "@/lib/vnext/client";
import { sessionsForSelectedProject } from "@/lib/vnext/project-selection";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

const api = createVNextApi();

function EngineProblem({ error }: { error: VNextApiError }) {
  const unavailable = error.code === "engine_unavailable" || error.code === "engine_locked";
  return (
    <Alert variant="destructive">
      <TriangleAlertIcon />
      <AlertTitle>{unavailable ? "Engine unavailable" : "Engine error"}</AlertTitle>
      <AlertDescription className="flex flex-col gap-1">
        <p>{error.message}</p>
        {unavailable && <p className="text-xs">Start the local engine with the same TELAR_HOME, then refresh.</p>}
      </AlertDescription>
    </Alert>
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
  /**
   * Both are engine capabilities that existed with no way to ask for them: a
   * session has been able to run on Codex, and to get a git worktree of its own,
   * since those stages landed — the form simply never offered either, so every
   * session was Claude-on-the-shared-checkout by omission rather than by choice.
   */
  const [driver, setDriver] = useState<ProviderDriverKind>("claude");
  const [worktree, setWorktree] = useState(false);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const [projectResult, healthResult] = await Promise.all([api.projects(), api.health()]);
      setProjects(projectResult.projects);
      setHealth(healthResult);
      setSelectedId((current) =>
        current && projectResult.projects.some((project) => project.id === current) ? current : projectResult.projects[0]?.id,
      );
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not load the cockpit."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => {
      void loadProjects();
    }, 0);
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
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const visibleSessions = sessionsForSelectedProject(sessions, selectedId, sessionsProjectId);
  const selectedProject = projects.find((project) => project.id === selectedId);

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
      const result = await api.createSession(selectedId, {
        ...(title ? { title } : {}),
        driver,
        envMode: worktree ? "worktree" : "local",
      });
      window.location.assign(`/projects/${encodeURIComponent(selectedId)}/sessions/${encodeURIComponent(result.session.id)}`);
    } catch (cause) {
      setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not create the session."));
      setSaving(false);
    }
  };

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 overflow-y-auto p-6">
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground">
            Register a local project or pick one to open its sessions. Everything here is an engine-owned record.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void loadProjects()} disabled={loading}>
          <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
          Refresh
        </Button>
      </header>

      {error && <EngineProblem error={error} />}

      <div className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <section className="flex flex-col gap-4" aria-label="Projects">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Engine status</CardTitle>
              {/* The worker id is a 40-character opaque token. Left to wrap it
                  turned a one-line status into a four-line paragraph and pushed
                  the card out of the column, so it truncates and the full value
                  lives in the title attribute. */}
              <CardDescription className="truncate" title={health?.worker.workerId}>
                {health
                  ? health.worker.registered
                    ? "A worker is available."
                    : "No worker is registered; turns cannot be submitted yet."
                  : "Checking the local engine."}
              </CardDescription>
            </CardHeader>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Register a project</CardTitle>
              <CardDescription>Stores a project record and nothing else.</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="flex flex-col gap-2" onSubmit={register}>
                <Input aria-label="Project name" placeholder="Project name" value={name} onChange={(event) => setName(event.target.value)} required />
                <Input
                  aria-label="Project root"
                  placeholder="/absolute/path/to/project"
                  className="font-mono text-xs"
                  value={root}
                  onChange={(event) => setRoot(event.target.value)}
                  required
                />
                <Button type="submit" size="sm" disabled={saving}>
                  Register project
                </Button>
              </form>
            </CardContent>
          </Card>

          <div className="flex flex-col gap-1" aria-label="Registered projects">
            {loading && <p className="px-1 text-xs text-muted-foreground">Loading projects…</p>}
            {!loading && projects.length === 0 && <p className="px-1 text-xs text-muted-foreground">No projects are registered.</p>}
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                onClick={() => setSelectedId(project.id)}
                aria-pressed={project.id === selectedId}
                className={cn(
                  "flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors",
                  project.id === selectedId ? "border-primary/40 bg-primary/5" : "border-transparent hover:bg-muted/60",
                )}
              >
                <span className="text-sm font-medium">{project.name}</span>
                <span className="w-full truncate font-mono text-[10px] text-muted-foreground">{project.root}</span>
              </button>
            ))}
          </div>
        </section>

        <section id="sessions" aria-label="Sessions">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Sessions</CardTitle>
              <CardDescription>
                {selectedProject ? `Persistent transcripts in ${selectedProject.name}.` : "Choose a project to see its sessions."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {selectedId && (
                <form className="flex flex-col gap-2 rounded-lg border border-border p-3" onSubmit={createSession}>
                  <Input
                    aria-label="Session title"
                    placeholder="Session title (optional)"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                  <div className="flex flex-wrap items-center gap-3">
                    <Tabs value={driver} onValueChange={(next) => setDriver(next as ProviderDriverKind)}>
                      <TabsList className="h-7">
                        <TabsTrigger value="claude" className="text-xs">
                          Claude
                        </TabsTrigger>
                        <TabsTrigger value="codex" className="text-xs">
                          Codex
                        </TabsTrigger>
                      </TabsList>
                    </Tabs>
                    <label
                      className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground"
                      title="Cut a git worktree and a branch of its own, so this session cannot collide with another working in the same project."
                    >
                      <Switch checked={worktree} onCheckedChange={setWorktree} />
                      <GitBranchIcon className="size-3.5" />
                      Own worktree
                    </label>
                    <Button type="submit" size="sm" className="ml-auto" disabled={saving}>
                      New session
                    </Button>
                  </div>
                </form>
              )}
              {selectedId && visibleSessions.length === 0 && <p className="text-sm text-muted-foreground">No sessions yet.</p>}
              <div className="flex flex-col gap-0.5">
                {visibleSessions.map((session) => (
                  <Link
                    key={session.id}
                    href={`/projects/${encodeURIComponent(session.projectId)}/sessions/${encodeURIComponent(session.id)}`}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/60"
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm">{session.title || "Untitled session"}</span>
                      <span className="truncate font-mono text-[10px] text-muted-foreground">{session.id}</span>
                    </span>
                    <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
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
