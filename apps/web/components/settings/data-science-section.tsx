"use client";

/**
 * DATA SCIENCE — a project's opt-in to a Python kernel, notebooks and the
 * `notebook_*` / `ds_*` tools.
 *
 * ONE SCREEN, THREE DOORS, NO MODAL. The one thing this feature needs to know
 * is WHICH Python, and a person arrives with one of three situations:
 *
 *   Detected   the checkout already has an environment — pick it from a list
 *   Existing   the environment lives somewhere Telar did not look — name it
 *   Create     there is none yet — make `.venv` in the project, or one under
 *              Telar's own home when the checkout should stay untouched
 *
 * The switch turns the feature on with whatever Python is chosen; until one
 * is, the doors are shown and the switch stays off. Nothing is applied
 * silently: every door ends in an explicit "Use this" that probes first.
 *
 * TELAR NEVER INSTALLS INTO AN ENVIRONMENT IT DID NOT CREATE. The kernel
 * bridge's own packages live in a venv under Telar's home built on the same
 * interpreter, so the project's lockfile stays the project's.
 */

import { useCallback, useEffect, useState } from "react";
import { CheckIcon, FlaskConicalIcon, FolderPlusIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import type { DataScienceCandidate, DataScienceConfig, DataScienceDetection, DataSciencePreflight, Project } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Row, Segmented, SettingsGroup } from "./settings-shell";
import { cn } from "@/lib/utils";

const api = createEngineApi();

const KIND_LABEL: Record<DataScienceCandidate["kind"], string> = {
  "project-venv": "In this project",
  uv: "uv's pick",
  pyenv: "pyenv",
  path: "On PATH",
  telar: "Telar's environment",
};

const STACK = ["pandas", "matplotlib", "duckdb", "pyarrow"] as const;

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

/** One interpreter as a card: where it came from, its version, what imports. */
function InterpreterCard({
  title, reason, preflight, selected, onSelect, action,
}: {
  title: string;
  reason?: string;
  preflight: DataSciencePreflight;
  selected?: boolean;
  onSelect?: () => void;
  action?: React.ReactNode;
}) {
  return (
    <div
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onClick={preflight.ok ? onSelect : undefined}
      onKeyDown={(event) => { if (onSelect && preflight.ok && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onSelect(); } }}
      className={cn(
        "flex flex-col gap-1.5 rounded-md border px-3 py-2 transition-colors",
        selected ? "border-primary bg-primary/5" : "border-border",
        onSelect && preflight.ok && "cursor-pointer hover:bg-muted/40",
        !preflight.ok && "opacity-70",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{title}</span>
        {preflight.version && <Badge variant="outline">{preflight.version}</Badge>}
        {reason && <span className="text-xs text-muted-foreground">{reason}</span>}
        <span className="ml-auto flex items-center gap-2">
          {action}
          {selected && <CheckIcon className="size-4 text-primary" />}
        </span>
      </div>
      <code className="truncate font-mono text-[0.6875rem] text-muted-foreground">{preflight.path}</code>
      {preflight.ok ? <ModuleChips modules={preflight.modules} /> : <span className="text-xs text-destructive">{preflight.reason}</span>}
    </div>
  );
}

type Door = "detected" | "existing" | "create";
type Source = NonNullable<DataScienceConfig["python"]>["source"];

function toConfig(path: string, source: Source): DataScienceConfig {
  return { enabled: true, python: { source, path, resolvedAt: Date.now() } };
}

export function DataScienceSection({ project, onChange }: { project: Project; onChange: (project: Project) => void }) {
  const config = project.dataScience;
  const enabled = config?.enabled === true;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  /** Choosing is visible when the feature is off, or when "Change" was pressed. */
  const [choosing, setChoosing] = useState(!enabled);
  const [door, setDoor] = useState<Door>("detected");

  const [detection, setDetection] = useState<DataScienceDetection>();
  const [detecting, setDetecting] = useState(false);
  const detect = useCallback(async () => {
    setDetecting(true);
    try {
      setDetection(await api.dataScienceDetect(project.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not detect interpreters.");
    } finally {
      setDetecting(false);
    }
  }, [project.id]);
  useEffect(() => {
    if (!choosing) return;
    const task = window.setTimeout(() => void detect(), 0);
    return () => window.clearTimeout(task);
  }, [choosing, detect]);

  const save = async (next: DataScienceConfig | null) => {
    setSaving(true);
    setError(undefined);
    try {
      const answer = await api.updateProject(project.id, { dataScience: next });
      onChange(answer.project);
      setChoosing(next === null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  };

  const current = config?.python;

  return (
    <SettingsGroup
      title="Data science"
      description="A Python kernel per session, notebooks in the panel, and analysis tools for agents. Images of your data are stored beside the session."
    >
      <Row
        label="Enable for this project"
        hint={error ?? (enabled ? "Sessions on this project get notebook and ds_* tools." : current ? "Off. The chosen Python is kept." : "Choose a Python below to turn it on.")}
        control={
          <Switch
            checked={enabled}
            disabled={saving || (!enabled && !current)}
            onCheckedChange={(next: boolean) => void save(next && current ? { ...config, enabled: true, python: current } : current ? { enabled: false, python: current } : null)}
            aria-label="Enable data science for this project"
          />
        }
      />

      {current && !choosing && (
        <Row
          label="Python"
          hint={current.source === "telar" ? "An environment Telar built and owns." : current.source === "detected" ? "Found in this checkout." : "The one you named."}
          control={
            <span className="flex items-center gap-2">
              <code className="max-w-96 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem]">{current.path}</code>
              <Button variant="outline" size="sm" disabled={saving} onClick={() => setChoosing(true)}>Change</Button>
            </span>
          }
        />
      )}

      {choosing && (
        <Row label="Which Python?" hint="The kernel runs on the interpreter you pick. Your project's own environment is never written to.">
          <div className="mt-3 flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Segmented<Door>
                value={door}
                onChange={setDoor}
                options={[
                  { value: "detected", label: <span className="flex items-center gap-1.5"><SearchIcon className="size-3" /> Detected</span> },
                  { value: "existing", label: "Existing" },
                  { value: "create", label: <span className="flex items-center gap-1.5"><FolderPlusIcon className="size-3" /> Create</span> },
                ]}
              />
              {current && (
                <Button variant="ghost" size="sm" onClick={() => setChoosing(false)} className="ml-auto">Cancel</Button>
              )}
            </div>

            {door === "detected" && (
              <DetectedDoor
                detection={detection}
                detecting={detecting}
                onDetect={() => void detect()}
                selectedPath={current?.path}
                onUse={(candidate) => void save(toConfig(candidate.path, candidate.kind === "telar" ? "telar" : "detected"))}
              />
            )}
            {door === "existing" && <ExistingDoor projectId={project.id} onUse={(path) => void save(toConfig(path, "chosen"))} />}
            {door === "create" && (
              <CreateDoor
                projectId={project.id}
                detection={detection}
                onCreated={(path, source) => { void save(toConfig(path, source)); void detect(); }}
              />
            )}
          </div>
        </Row>
      )}
    </SettingsGroup>
  );
}

function DetectedDoor({
  detection, detecting, onDetect, selectedPath, onUse,
}: {
  detection?: DataScienceDetection;
  detecting: boolean;
  onDetect: () => void;
  selectedPath?: string;
  onUse: (candidate: DataScienceCandidate) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {detecting && !detection && (
        <span className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3" /> Probing interpreters…</span>
      )}
      {detection?.candidates.length === 0 && (
        <span className="text-xs text-muted-foreground">Nothing found in this checkout or on PATH. Name one under Existing, or make one under Create.</span>
      )}
      {detection?.candidates.map((candidate) => (
        <InterpreterCard
          key={candidate.path}
          title={KIND_LABEL[candidate.kind]}
          reason={candidate.reason}
          preflight={candidate.preflight}
          selected={candidate.path === selectedPath}
          action={<Button size="xs" disabled={!candidate.preflight.ok} onClick={(event) => { event.stopPropagation(); onUse(candidate); }}>Use this</Button>}
        />
      ))}
      <Button variant="ghost" size="sm" disabled={detecting} onClick={onDetect} className="self-start">
        <RefreshCwIcon className={cn("size-3", detecting && "animate-spin")} /> Detect again
      </Button>
    </div>
  );
}

function ExistingDoor({ projectId, onUse }: { projectId: string; onUse: (path: string) => void }) {
  const [path, setPath] = useState("");
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<(DataSciencePreflight & { relativePath?: string }) | undefined>();

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
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        A python binary, or a venv directory. Relative paths resolve against the project root — and against a worktree&apos;s own tree in a worktree session.
      </p>
      <div className="flex items-center gap-2">
        <Input
          value={path}
          onChange={(event) => { setPath(event.target.value); setProbe(undefined); }}
          onKeyDown={(event) => { if (event.key === "Enter") void check(); }}
          placeholder=".venv  ·  ~/envs/analysis/bin/python  ·  /opt/homebrew/bin/python3.12"
          className="font-mono text-[0.6875rem]"
          aria-label="Path to a Python interpreter or environment"
        />
        <Button variant="outline" size="sm" disabled={probing || !path.trim()} onClick={() => void check()}>
          {probing ? <Spinner className="size-3" /> : <SearchIcon className="size-3" />} Check
        </Button>
      </div>
      {probe && (
        <InterpreterCard
          title={probe.ok ? "Found" : "Not usable"}
          preflight={probe}
          action={probe.ok ? <Button size="xs" onClick={() => onUse(probe.relativePath ?? probe.path)}>Use this</Button> : undefined}
        />
      )}
    </div>
  );
}

function CreateDoor({
  projectId, detection, onCreated,
}: {
  projectId: string;
  detection?: DataScienceDetection;
  onCreated: (path: string, source: "detected" | "telar") => void;
}) {
  const [where, setWhere] = useState<"project" | "telar">("project");
  const [withStack, setWithStack] = useState(true);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string>();
  /** Bases are interpreters that are NOT already a venv — a venv on a venv is a mistake. */
  const bases = (detection?.candidates ?? []).filter((c) => c.preflight.ok && c.kind !== "project-venv" && c.kind !== "telar");
  const [base, setBase] = useState<string>();
  const chosenBase = bases.find((b) => b.path === base) ?? bases[0];
  const hasProjectVenv = detection?.candidates.some((c) => c.kind === "project-venv") ?? false;

  const build = async () => {
    if (!chosenBase) return;
    setBuilding(true);
    setError(undefined);
    try {
      const { venv } = where === "project"
        ? await api.dataScienceProjectVenv(projectId, { basePython: chosenBase.path, stack: withStack })
        : await api.dataScienceVenv(projectId, { basePython: chosenBase.path, stack: withStack });
      if (!venv.ok) { setError(venv.reason); return; }
      onCreated(where === "project" ? ((venv as { relativePath?: string }).relativePath ?? venv.python) : venv.python, where === "project" ? "detected" : "telar");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not build the environment.");
    } finally {
      setBuilding(false);
    }
  };

  if (detection && !detection.uv) {
    return <p className="text-xs text-muted-foreground">uv is not installed, so Telar cannot build an environment. Install it from https://docs.astral.sh/uv/ and detect again.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <Segmented<"project" | "telar">
        value={where}
        onChange={setWhere}
        options={[
          { value: "project", label: <code className="font-mono text-[0.6875rem]">.venv</code> },
          { value: "telar", label: "Under Telar's home" },
        ]}
      />
      <p className="text-xs text-muted-foreground">
        {where === "project"
          ? hasProjectVenv
            ? "This project already has a .venv — pick it under Detected."
            : "uv venv .venv in the checkout, gitignored. Yours to keep; the agent's shells see it too."
          : "A venv Telar owns, outside the checkout. The right choice when the project must stay untouched."}
      </p>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium">Build on</span>
        {bases.length === 0 ? (
          <span className="text-xs text-muted-foreground">{detection ? "No base interpreter found. Install Python, or install uv and let it fetch one." : "Detecting…"}</span>
        ) : (
          bases.map((b) => (
            <InterpreterCard key={b.path} title={KIND_LABEL[b.kind]} reason={b.reason} preflight={b.preflight} selected={b.path === chosenBase?.path} onSelect={() => setBase(b.path)} />
          ))
        )}
      </div>
      <label className="flex items-center gap-2 text-xs">
        <Switch checked={withStack} onCheckedChange={setWithStack} aria-label="Also install the analysis stack" />
        Also install pandas, matplotlib, duckdb and pyarrow
      </label>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button size="sm" disabled={building || !chosenBase || (where === "project" && hasProjectVenv)} onClick={() => void build()} className="self-start">
        {building ? <Spinner className="size-3" /> : <FlaskConicalIcon className="size-3" />}
        {building ? "Building…" : where === "project" ? "Create .venv and use it" : "Create Telar's environment and use it"}
      </Button>
    </div>
  );
}
