"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ActivityIcon, ChevronRightIcon, FolderIcon, FolderPlusIcon, GitBranchIcon, MessageSquareIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import type { EngineHealth, Project, ProviderDriverKind, Session } from "@telar/engine-client";
import { createVNextApi, VNextApiError } from "@/lib/vnext/client";
import { sessionsForSelectedProject } from "@/lib/vnext/project-selection";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Panel, PanelBody, PanelEmpty, PanelHeader, PanelRow } from "@/components/ui/panel";
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
