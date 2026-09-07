"use client";

/**
 * DATA SCIENCE — a project's opt-in to a Python kernel, notebooks and the
 * `notebook_*` / `ds_*` tools, and the ENVIRONMENT MANAGER behind it.
 *
 * THE PAGE THINKS IN ENVIRONMENTS, the way PyCharm's interpreter settings and
 * Anaconda Navigator do, because that is how the person does: "the project's
 * .venv", "my conda env for this", "Homebrew's Python". Each is a card with
 * its manager, its version, where it lives and what imports; one is in use.
 * Beneath them, what is installed in the one in use, and a box to add more.
 *
 * WHAT IS MISSING IS INSTALLABLE FROM HERE. No uv: a button. No conda: a
 * button. The Python version you want is not on disk: pick it anyway and uv
 * fetches it. Every one of those runs as a job with its log on screen, so a
 * two-minute install is two minutes of lines rather than a spinner.
 *
 * TELAR WRITES INTO THE PROJECT'S ENVIRONMENT ON REQUEST — the Install box
 * here, or the agent's `ds_install` once approved. The kernel bridge's own
 * two packages still live only in a venv Telar owns, built on the same
 * interpreter, so nobody's lockfile learns about jupyter_client.
 */
import { useCallback, useEffect, useState } from "react";
import { CheckIcon, DownloadIcon, FlaskConicalIcon, FolderPlusIcon, PlusIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import type {
  DataScienceConfig,
  DataScienceCreateEnvironment,
  DataScienceEnvironment,
  DataScienceEnvironments,
  DataScienceJob,
  DataSciencePreflight,
  DataSciencePythonVersion,
  DataScienceToolchain,
  Project,
} from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Row, Segmented, SettingsGroup } from "./settings-shell";
import { JobLog, type JobHandle } from "./job-log";
import { MANAGER_LABEL, PackagesPanel } from "./packages-panel";
import { cn } from "@/lib/utils";

const api = createEngineApi();

const STACK = ["pandas", "matplotlib", "duckdb", "pyarrow"] as const;

const LOCATION_LABEL: Record<DataScienceEnvironment["location"], string> = { project: "In this project", user: "On this machine", telar: "Telar's" };

function ModuleChips({ modules }: { modules?: Record<string, boolean> }) {
  if (!modules) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {STACK.map((name) => (
        <Badge key={name} variant={modules[name] ? "secondary" : "outline"} className={modules[name] ? "" : "opacity-50 line-through"}>
          {name}
        </Badge>
      ))}
    </span>
  );
}

type Source = NonNullable<DataScienceConfig["python"]>["source"];

function toConfig(env: { path: string; root?: string; manager: DataScienceEnvironment["manager"] }, source: Source): DataScienceConfig {
  return { enabled: true, python: { source, path: env.path, resolvedAt: Date.now(), manager: env.manager, ...(env.root ? { root: env.root } : {}) } };
}

/* ────────────────────────────────────────────────────────────────────────── */

export function DataScienceSection({ project, onChange }: { project: Project; onChange: (project: Project) => void }) {
  const config = project.dataScience;
  const enabled = config?.enabled === true;
  const current = config?.python;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [data, setData] = useState<DataScienceEnvironments>();
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState<"new" | "existing">();
  const [job, setJob] = useState<JobHandle & { then?: (job: DataScienceJob) => void }>();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.dataScienceEnvironments(project.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read the environments.");
    } finally {
      setLoading(false);
    }
  }, [project.id]);
  useEffect(() => {
    const task = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(task);
  }, [refresh]);

  const save = async (next: DataScienceConfig | null) => {
    setSaving(true);
    setError(undefined);
    try {
      const answer = await api.updateProject(project.id, { dataScience: next });
      onChange(answer.project);
      setAdding(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  };

  /** Every job on this page ends by re-reading the list; some also save. */
  const runJob = (handle: JobHandle, then?: (job: DataScienceJob) => void) => setJob({ ...handle, then });

  const currentEnv = data?.environments.find((env) => env.id === data.currentId);
  const toolchain = data?.toolchain;

  return (
    <>
      <SettingsGroup
        title="Data science"
        description="A Python kernel per session, notebooks in the panel, and analysis tools for agents. Images of your data are stored beside the session."
      >
        <Row
          label="Enable for this project"
          hint={error ?? (enabled ? "Sessions on this project get notebook and ds_* tools." : current ? "Off. The chosen environment is kept." : "Pick an environment below to turn it on.")}
          control={
            <Switch
              checked={enabled}
              disabled={saving || (!enabled && !current)}
              onCheckedChange={(next: boolean) => void save(next && current ? { ...config, enabled: true, python: current } : current ? { enabled: false, python: current } : null)}
              aria-label="Enable data science for this project"
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup
        title="Tools"
        description="What environments are made with. Anything missing installs from here."
        action={
          <Button variant="ghost" size="sm" disabled={loading} onClick={() => void refresh()}>
            <RefreshCwIcon className={cn("size-3", loading && "animate-spin")} /> Detect again
          </Button>
        }
      >
        <ToolchainRows toolchain={toolchain} loading={loading && !data} onJob={runJob} />
      </SettingsGroup>

      {job && (
        <JobLog
          className="mb-7"
          handle={job}
          onDone={(finished) => { job.then?.(finished); void refresh(); }}
          onDismiss={() => setJob(undefined)}
        />
      )}

      <SettingsGroup
        title="Environments"
        description="Where the kernel runs and what it can import. One is in use."
        action={
          <span className="flex items-center gap-1.5">
            <Button variant={adding === "existing" ? "secondary" : "outline"} size="sm" onClick={() => setAdding(adding === "existing" ? undefined : "existing")}>
              <SearchIcon className="size-3" /> Add existing
            </Button>
            <Button variant={adding === "new" ? "secondary" : "default"} size="sm" onClick={() => setAdding(adding === "new" ? undefined : "new")}>
              <PlusIcon className="size-3" /> New environment
            </Button>
          </span>
        }
      >
        {adding === "new" && toolchain && (
          <div className="py-3">
            <NewEnvironmentForm
              projectId={project.id}
              toolchain={toolchain}
              hasProjectVenv={data?.environments.some((e) => e.location === "project") ?? false}
              hasTelarVenv={data?.environments.some((e) => e.manager === "telar") ?? false}
              onStarted={(handle) => {
                setAdding(undefined);
                runJob(handle, (finished) => {
                  if (finished.status !== "ok" || !finished.result) return;
                  const made = finished.result as { path: string; root: string; manager: DataScienceEnvironment["manager"]; source: Source };
                  void save(toConfig(made, made.source));
                });
              }}
              onCancel={() => setAdding(undefined)}
            />
          </div>
        )}
        {adding === "existing" && (
          <div className="py-3">
            <AddExistingForm projectId={project.id} onUse={(probe) => void save(toConfig({ path: probe.relativePath ?? probe.path, root: probe.root, manager: probe.manager ?? "system" }, "chosen"))} onCancel={() => setAdding(undefined)} />
          </div>
        )}

        <div className="flex flex-col gap-2 py-3">
          {!data && loading && <span className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3" /> Probing interpreters…</span>}
          {data && data.environments.length === 0 && (
            <p className="text-xs text-muted-foreground">No Python environment found in this checkout or on this machine. Make one with New environment — uv will fetch a Python if there is none.</p>
          )}
          {data?.environments.map((env) => (
            <EnvironmentCard
              key={env.id}
              env={env}
              inUse={env.id === data.currentId}
              onUse={() => void save(toConfig({ path: env.path, root: env.location === "project" ? relativeRoot(env) : env.root, manager: env.manager }, env.manager === "telar" ? "telar" : "detected"))}
              saving={saving}
            />
          ))}
          {current && data && !currentEnv && (
            <p className="text-xs text-warning">
              The configured interpreter <code className="font-mono">{current.path}</code> was not found. Pick another, or add it under Add existing.
            </p>
          )}
        </div>
      </SettingsGroup>

      {currentEnv && (
        <SettingsGroup title="Packages" description={`What is installed in ${currentEnv.name}. Installing here writes to that environment.`}>
          <div className="py-3">
            <PackagesPanel scope={{ projectId: project.id }} requirements={data?.requirements ?? []} />
          </div>
        </SettingsGroup>
      )}
    </>
  );
}

/** A project env's root, relative like its path (the engine relativised the python only). */
function relativeRoot(env: DataScienceEnvironment): string {
  const suffix = env.python.slice(env.root.length);
  return env.path.endsWith(suffix) ? env.path.slice(0, env.path.length - suffix.length) || "." : env.root;
}

/* ────────────────────────────────────────────────────────────────────────── */

function ToolchainRows({ toolchain, loading, onJob }: { toolchain?: DataScienceToolchain; loading: boolean; onJob: (handle: JobHandle) => void }) {
  const [starting, setStarting] = useState<string>();
  const [error, setError] = useState<string>();
  const [pick, setPick] = useState<string>();

  const bootstrap = async (what: "uv" | "conda" | "python", version?: string) => {
    setStarting(what);
    setError(undefined);
    try {
      const { jobId } = await api.dataScienceBootstrap(what === "python" ? { what, version: version! } : { what });
      onJob({ jobId, title: what === "uv" ? "Installing uv" : what === "conda" ? "Installing Miniforge" : `Installing Python ${version}` });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the install.");
    } finally {
      setStarting(undefined);
    }
  };

  if (loading || !toolchain) return <Row label="Detecting" control={<Spinner className="size-3" />} />;

  const installed = toolchain.pythons.filter((p) => p.installed);
  const downloadable = toolchain.pythons.filter((p) => !p.installed);

  return (
    <>
      <Row
        label="uv"
        hint={toolchain.uv ? "Makes venvs and installs packages, fast. Also fetches Python versions." : "Not installed. Telar makes environments with uv; without it only conda environments can be created."}
        control={
          toolchain.uv ? <Badge variant="secondary">{toolchain.uv.version}</Badge> : (
            <Button size="sm" disabled={starting !== undefined} onClick={() => void bootstrap("uv")}>
              {starting === "uv" ? <Spinner className="size-3" /> : <DownloadIcon className="size-3" />} Install uv
            </Button>
          )
        }
      />
      <Row
        label="conda"
        hint={toolchain.conda ? `${toolchain.conda.flavour} at ${toolchain.conda.path}` : "Not installed. Optional — for conda environments and conda-forge packages. Installs Miniforge."}
        control={
          toolchain.conda ? <Badge variant="secondary">{toolchain.conda.version}</Badge> : (
            <Button variant="outline" size="sm" disabled={starting !== undefined} onClick={() => void bootstrap("conda")}>
              {starting === "conda" ? <Spinner className="size-3" /> : <DownloadIcon className="size-3" />} Install Miniforge
            </Button>
          )
        }
      />
      <Row
        label="Python"
        hint={error ?? (installed.length ? `Installed: ${installed.map((p) => p.version).join(", ")}` : "No Python on this machine yet.")}
        control={
          toolchain.uv ? (
            <span className="flex items-center gap-1.5">
              <Select value={pick ?? ""} onValueChange={(next) => setPick(next ?? undefined)}>
                <SelectTrigger size="sm" className="w-44" aria-label="Python version to install">
                  <SelectValue placeholder="Install a version…" />
                </SelectTrigger>
                <SelectContent>
                  {downloadable.map((p) => (
                    <SelectItem key={p.version} value={p.version}>
                      {p.version}{p.prerelease ? " (pre-release)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" disabled={!pick || starting !== undefined} onClick={() => void bootstrap("python", pick)}>
                {starting === "python" ? <Spinner className="size-3" /> : <DownloadIcon className="size-3" />} Install
              </Button>
            </span>
          ) : <span className="text-xs text-muted-foreground">Install uv to fetch versions</span>
        }
      />
    </>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */

function EnvironmentCard({ env, inUse, onUse, saving }: { env: DataScienceEnvironment; inUse: boolean; onUse: () => void; saving: boolean }) {
  const ok = env.preflight.ok;
  return (
    <div className={cn("flex flex-col gap-1.5 rounded-md border px-3 py-2", inUse ? "border-primary bg-primary/5" : "border-border", !ok && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{env.name}</span>
        <Badge variant="outline">{MANAGER_LABEL[env.manager]}</Badge>
        {env.preflight.version && <Badge variant="outline">{env.preflight.version}</Badge>}
        <span className="text-xs text-muted-foreground">{LOCATION_LABEL[env.location]} · {env.reason}</span>
        <span className="ml-auto flex items-center gap-2">
          {inUse ? (
            <span className="flex items-center gap-1 text-xs text-primary"><CheckIcon className="size-3.5" /> In use</span>
          ) : (
            <Button size="xs" variant="outline" disabled={!ok || saving} onClick={onUse}>Use</Button>
          )}
        </span>
      </div>
      <code className="truncate font-mono text-[0.6875rem] text-muted-foreground" title={env.python}>{env.root}</code>
      {ok ? <ModuleChips modules={env.preflight.modules} /> : <span className="text-xs text-destructive">{env.preflight.reason}</span>}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */

function NewEnvironmentForm({
  projectId, toolchain, hasProjectVenv, hasTelarVenv, onStarted, onCancel,
}: {
  projectId: string;
  toolchain: DataScienceToolchain;
  hasProjectVenv: boolean;
  hasTelarVenv: boolean;
  onStarted: (handle: JobHandle) => void;
  onCancel: () => void;
}) {
  const [manager, setManager] = useState<"venv" | "conda">(toolchain.uv ? "venv" : "conda");
  const [location, setLocation] = useState<"project" | "telar">(hasProjectVenv ? "telar" : "project");
  const [name, setName] = useState("");
  const [stack, setStack] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();

  const versions = pickableVersions(toolchain.pythons);
  const [python, setPython] = useState<string>(versions.find((v) => v.installed && !v.prerelease)?.minor ?? versions[0]?.minor ?? "3.13");

  const start = async () => {
    setStarting(true);
    setError(undefined);
    const request: DataScienceCreateEnvironment = manager === "venv"
      ? { manager, location, python, stack }
      : { manager, name: name.trim(), python, stack };
    try {
      const { jobId } = await api.dataScienceCreateEnvironment(projectId, request);
      onStarted({ jobId, title: manager === "venv" ? `Creating ${location === "project" ? ".venv" : "Telar's environment"} on Python ${python}` : `Creating conda env ${name.trim()}` });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start.");
    } finally {
      setStarting(false);
    }
  };

  const blocked = manager === "venv"
    ? !toolchain.uv ? "uv is not installed — install it under Tools." : location === "project" && hasProjectVenv ? "This project already has a .venv — use it from the list." : location === "telar" && hasTelarVenv ? "Telar already has an environment for this project." : undefined
    : !toolchain.conda ? "conda is not installed — install Miniforge under Tools." : !name.trim() ? "Name the environment." : undefined;

  const chosen = versions.find((v) => v.minor === python);

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented<"venv" | "conda">
          value={manager}
          onChange={setManager}
          options={[
            { value: "venv", label: <span className="flex items-center gap-1.5"><FolderPlusIcon className="size-3" /> uv venv</span> },
            { value: "conda", label: "conda" },
          ]}
        />
        {manager === "venv" && (
          <Segmented<"project" | "telar">
            value={location}
            onChange={setLocation}
            options={[
              { value: "project", label: <code className="font-mono text-[0.6875rem]">.venv in the project</code> },
              { value: "telar", label: "Under Telar's home" },
            ]}
          />
        )}
        {manager === "conda" && (
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Environment name, e.g. ds-3.12" className="w-56 font-mono text-[0.6875rem]" aria-label="Conda environment name" />
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {manager === "venv"
          ? location === "project"
            ? "uv venv .venv in the checkout, gitignored. Yours to keep; the agent's shells see it too."
            : "A venv Telar owns, outside the checkout. For a project that must stay untouched."
          : "conda create with the version you pick. Packages come from conda-forge."}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs">
          <span className="font-medium">Python</span>
          <Select value={python} onValueChange={(next) => next && setPython(next)}>
            <SelectTrigger size="sm" className="w-52" aria-label="Python version">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {versions.map((v) => (
                <SelectItem key={v.minor} value={v.minor}>
                  {v.minor}{v.installed ? ` · ${v.version}` : " · will download"}{v.prerelease ? " (pre-release)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        {chosen && !chosen.installed && <span className="text-xs text-muted-foreground">{manager === "venv" ? "uv" : "conda"} will fetch it.</span>}
        <label className="flex items-center gap-2 text-xs">
          <Switch checked={stack} onCheckedChange={setStack} aria-label="Also install the analysis stack" />
          Also install pandas, matplotlib, duckdb, pyarrow
        </label>
      </div>

      {(error ?? blocked) && <p className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>{error ?? blocked}</p>}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={starting || Boolean(blocked)} onClick={() => void start()}>
          {starting ? <Spinner className="size-3" /> : <FlaskConicalIcon className="size-3" />} Create and use
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

/** One row per minor version: the installed patch when there is one, else the newest downloadable. */
function pickableVersions(pythons: DataSciencePythonVersion[]): DataSciencePythonVersion[] {
  const byMinor = new Map<string, DataSciencePythonVersion>();
  for (const p of pythons) {
    const existing = byMinor.get(p.minor);
    if (!existing || (!existing.installed && p.installed)) byMinor.set(p.minor, p);
  }
  return [...byMinor.values()];
}

/* ────────────────────────────────────────────────────────────────────────── */

type Probe = DataSciencePreflight & { relativePath?: string; root?: string; manager?: DataScienceEnvironment["manager"] };

function AddExistingForm({ projectId, onUse, onCancel }: { projectId: string; onUse: (probe: Probe) => void; onCancel: () => void }) {
  const [path, setPath] = useState("");
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<Probe>();

  const check = async () => {
    if (!path.trim()) return;
    setProbing(true);
    try {
      setProbe((await api.dataScienceProbe(projectId, path.trim())).probe);
    } catch (cause) {
      setProbe({ ok: false, path, reason: cause instanceof Error ? cause.message : "Could not probe." });
    } finally {
      setProbing(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-3">
      <p className="text-xs text-muted-foreground">
        A python binary, a venv or a conda environment directory Telar did not find on its own. Relative paths resolve against the project root — and against a worktree&apos;s own tree in a worktree session.
      </p>
      <div className="flex items-center gap-2">
        <Input
          value={path}
          onChange={(event) => { setPath(event.target.value); setProbe(undefined); }}
          onKeyDown={(event) => { if (event.key === "Enter") void check(); }}
          placeholder="~/envs/analysis  ·  /opt/miniforge3/envs/ds  ·  /usr/local/bin/python3.12"
          className="font-mono text-[0.6875rem]"
          aria-label="Path to a Python interpreter or environment"
        />
        <Button variant="outline" size="sm" disabled={probing || !path.trim()} onClick={() => void check()}>
          {probing ? <Spinner className="size-3" /> : <SearchIcon className="size-3" />} Check
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
      {probe && (
        <div className={cn("flex flex-col gap-1.5 rounded-md border px-3 py-2", probe.ok ? "border-border" : "border-destructive/40")}>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{probe.ok ? "Found" : "Not usable"}</span>
            {probe.manager && <Badge variant="outline">{MANAGER_LABEL[probe.manager]}</Badge>}
            {probe.version && <Badge variant="outline">{probe.version}</Badge>}
            <span className="ml-auto">{probe.ok && <Button size="xs" onClick={() => onUse(probe)}>Use this</Button>}</span>
          </div>
          <code className="truncate font-mono text-[0.6875rem] text-muted-foreground">{probe.root ?? probe.path}</code>
          {probe.ok ? <ModuleChips modules={probe.modules} /> : <span className="text-xs text-destructive">{probe.reason}</span>}
        </div>
      )}
    </div>
  );
}
