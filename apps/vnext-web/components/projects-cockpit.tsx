"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ActivityIcon, ChevronRightIcon, FolderIcon, FolderPlusIcon, MessageSquarePlusIcon, MessageSquareIcon, RefreshCwIcon, SlidersHorizontalIcon, TriangleAlertIcon } from "lucide-react";
import type { EngineHealth, Project, Session } from "@telar/engine-client";
import { createVNextApi, VNextApiError } from "@/lib/vnext/client";
import { sessionsForSelectedProject } from "@/lib/vnext/project-selection";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Panel, PanelBody, PanelEmpty, PanelHeader, PanelRow } from "@/components/ui/panel";
import { Input } from "@/components/ui/input";
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
  /**
   * NO PROVIDER OR WORKTREE STATE HERE ANY MORE. Both moved to the composer
   * canvas, where they can still be changed after you have started typing —
   * the provider lives in the model picker's rail and the worktree in the
   * composer's foot, which is the surface that already answers "where does
   * this land".
   */

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
          <Panel>
            <PanelHeader icon={<ActivityIcon />} label="engine" tone={health?.worker.registered ? "done" : health ? "attention" : "none"} />
            {/* The worker id is a 40-character opaque token. Left to wrap it
                turned a one-line status into a four-line paragraph and pushed
                the panel out of its column, so the prose stays short and the
                full value lives in the title attribute. */}
            <PanelRow
              tone={health?.worker.registered ? "done" : health ? "attention" : "none"}
              className="text-xs text-muted-foreground"
              title={health?.worker.workerId}
            >
              {health
                ? health.worker.registered
                  ? "A worker is available."
                  : "No worker is registered; turns cannot be submitted yet."
                : "Checking the local engine."}
            </PanelRow>
          </Panel>

          <Panel>
            <PanelHeader icon={<FolderPlusIcon />} label="register a project" />
            <div className="p-3">
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
            </div>
          </Panel>

          <Panel className="min-h-0">
            <PanelHeader icon={<FolderIcon />} label="projects" count={projects.length} />
            <PanelBody>
              {loading && <p className="px-3 py-2 text-xs text-muted-foreground">Loading projects…</p>}
              {!loading && projects.length === 0 && (
                <PanelEmpty icon={<FolderIcon />} title="Nothing registered">
                  Point Telar at a local checkout above.
                </PanelEmpty>
              )}
              {projects.map((project) => (
                <PanelRow key={project.id} tone={project.id === selectedId ? "active" : "none"} active={project.id === selectedId} className="p-0 pl-0">
                  <button
                    type="button"
                    onClick={() => setSelectedId(project.id)}
                    aria-pressed={project.id === selectedId}
                    className="flex w-full flex-col items-start gap-0.5 py-2 pr-3 pl-4 text-left hover:bg-muted/40"
                  >
                    <span className="text-sm font-medium">{project.name}</span>
                    <span className="w-full truncate font-mono text-[10px] text-muted-foreground">{project.root}</span>
                  </button>
                </PanelRow>
              ))}
            </PanelBody>
          </Panel>
        </section>

        <section id="sessions" aria-label="Sessions">
          <Panel>
            <PanelHeader icon={<MessageSquareIcon />} label={selectedProject ? `sessions · ${selectedProject.name}` : "sessions"} count={visibleSessions.length} />
            <div className="flex flex-col gap-4 p-3">
              {/**
                * STARTING A CONVERSATION IS A COMPOSER, NOT A FORM.
                *
                * This used to be title + provider + worktree + a "New session"
                * button, which created an engine record BEFORE anybody had said
                * anything — so an abandoned thought left a session in the rail,
                * and the first thing a person met was a form rather than a
                * place to type. The canvas asks for the message; the message
                * creates the session, names it, and every one of those choices
                * lives on the composer where it can still be changed.
                */}
              {selectedId && (
                <div className="flex items-center gap-2">
                  <Button size="sm" render={<Link href={`/projects/${encodeURIComponent(selectedId)}/sessions/new`} />}>
                    <MessageSquarePlusIcon className="size-3.5" />
                    New conversation
                  </Button>
                  {/* The way in to per-project settings. Beside the primary
                      action rather than in a menu: it is the only route to a
                      surface that otherwise has no door, and a page nothing
                      links to is a page nobody finds. */}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground hover:text-foreground"
                    render={<Link href={`/projects/${encodeURIComponent(selectedId)}/settings`} />}
                  >
                    <SlidersHorizontalIcon className="size-3.5" />
                    Project settings
                  </Button>
                </div>
              )}
              {!selectedId && <PanelEmpty title="No project selected">Choose one on the left to see its sessions.</PanelEmpty>}
              {selectedId && visibleSessions.length === 0 && (
                <PanelEmpty icon={<MessageSquareIcon />} title="No sessions yet">
                  Start one above; it becomes a durable transcript the engine owns.
                </PanelEmpty>
              )}
              {/* NO RAIL BY DEFAULT. Every session here is active, so colouring
                  them all drew one continuous stripe down the list and the rail
                  stopped carrying information. A 3px rail marks the EXCEPTIONAL
                  row; the ordinary one gets none. */}
              <div className="-mx-3 flex flex-col">
                {visibleSessions.map((session) => (
                  <PanelRow key={session.id} tone="none" className="p-0 pl-0">
                    <Link
                      href={`/projects/${encodeURIComponent(session.projectId)}/sessions/${encodeURIComponent(session.id)}`}
                      className={cn("flex w-full items-center gap-2 py-1.5 pr-3 pl-4 transition-colors hover:bg-muted/40", session.state === "archived" && "opacity-60")}
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm">{session.title || "Untitled session"}</span>
                        <span className="truncate font-mono text-[10px] text-muted-foreground">{session.id}</span>
                      </span>
                      <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    </Link>
                  </PanelRow>
                ))}
              </div>
            </div>
          </Panel>
        </section>
      </div>
    </main>
  );
}
