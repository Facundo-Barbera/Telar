"use client";

/**
 * DATA SCIENCE — a project's opt-in to a Python kernel, notebooks and the
 * `notebook_*` / `ds_*` tools.
 *
 * OFF BY DEFAULT, AND THE SWITCH ASKS BEFORE IT TURNS ON. The one thing this
 * feature needs to know is WHICH Python, and that is a decision the engine
 * refuses to make: it detects every plausible interpreter, probes each, and
 * the dialog here shows the list. Turning the switch on opens that dialog;
 * only a chosen interpreter closes it with the feature enabled. Turning it off
 * needs no dialog — it removes the block and nothing else.
 *
 * THE PROJECT'S ENVIRONMENT IS NEVER WRITTEN TO. "Create a Telar environment"
 * builds a venv under Telar's own home on the interpreter you picked, so the
 * kernel bridge has what it needs without touching your lockfile.
 */

import { useCallback, useEffect, useState } from "react";
import { CheckIcon, FlaskConicalIcon, RefreshCwIcon } from "lucide-react";
import type { DataScienceCandidate, DataScienceConfig, DataScienceDetection, Project } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Row, SettingsGroup } from "./settings-shell";

const api = createEngineApi();

const KIND_LABEL: Record<DataScienceCandidate["kind"], string> = {
  "project-venv": "Project venv",
  uv: "uv",
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

function CandidateRow({ candidate, selected, onSelect }: { candidate: DataScienceCandidate; selected: boolean; onSelect: () => void }) {
  const { preflight } = candidate;
  return (
    <button
      type="button"
      disabled={!preflight.ok}
      onClick={onSelect}
      aria-pressed={selected}
      className={[
        "flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left transition-colors",
        selected ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40",
        preflight.ok ? "" : "cursor-not-allowed opacity-60",
      ].join(" ")}
    >
      <span className="flex items-center gap-2">
        <span className="text-sm font-medium">{KIND_LABEL[candidate.kind]}</span>
        {preflight.version && <Badge variant="outline">{preflight.version}</Badge>}
        <span className="text-xs text-muted-foreground">{candidate.reason}</span>
        {selected && <CheckIcon className="ml-auto size-4 text-primary" />}
      </span>
      <code className="truncate font-mono text-[0.6875rem] text-muted-foreground">{candidate.path}</code>
      {preflight.ok ? <ModuleChips modules={preflight.modules} /> : <span className="text-xs text-destructive">{preflight.reason}</span>}
    </button>
  );
}

/**
 * The picker. Resolves with the config to store, or `undefined` if dismissed.
 * Detection runs on open; "Create a Telar environment" builds the venv on the
 * selected interpreter and re-detects so the new venv appears as its own row.
 */
function PythonPickerDialog({
  projectId,
  open,
  onClose,
}: {
  projectId: string;
  open: boolean;
  onClose: (config?: DataScienceConfig) => void;
}) {
  const [detection, setDetection] = useState<DataScienceDetection>();
  const [detecting, setDetecting] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [building, setBuilding] = useState(false);
  const [withStack, setWithStack] = useState(true);
  const [error, setError] = useState<string>();

  const detect = useCallback(async () => {
    setDetecting(true);
    setError(undefined);
    try {
      const answer = await api.dataScienceDetect(projectId);
      setDetection(answer);
      setSelected((current) => current ?? answer.candidates.find((c) => c.preflight.ok)?.path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not detect interpreters.");
    } finally {
      setDetecting(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!open) return;
    const task = window.setTimeout(() => void detect(), 0);
    return () => window.clearTimeout(task);
  }, [open, detect]);

  const chosen = detection?.candidates.find((c) => c.path === selected);

  const build = async () => {
    if (!chosen) return;
    setBuilding(true);
    setError(undefined);
    try {
      const { venv } = await api.dataScienceVenv(projectId, { basePython: chosen.path, stack: withStack });
      if (!venv.ok) {
        setError(venv.reason);
        return;
      }
      setSelected(venv.python);
      await detect();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not build the environment.");
    } finally {
      setBuilding(false);
    }
  };

  const confirm = () => {
    if (!chosen) return;
    onClose({
      enabled: true,
      python: {
        source: chosen.kind === "telar" ? "telar" : "chosen",
        path: chosen.path,
        resolvedAt: Date.now(),
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Which Python?</DialogTitle>
          <DialogDescription>
            The kernel runs on the interpreter you pick. Your project&apos;s environment is never modified;
            the pieces Telar needs live in an environment of its own.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
          {detecting && !detection && (
            <span className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3" /> Probing interpreters…</span>
          )}
          {detection?.candidates.length === 0 && (
            <span className="text-xs text-muted-foreground">No Python found. Install one, or uv, and detect again.</span>
          )}
          {detection?.candidates.map((candidate) => (
            <CandidateRow key={candidate.path} candidate={candidate} selected={candidate.path === selected} onSelect={() => setSelected(candidate.path)} />
          ))}
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        {detection && chosen && chosen.kind !== "telar" && (
          <div className="flex flex-col gap-2 rounded-md border border-dashed border-border px-3 py-2">
            <span className="text-xs text-muted-foreground">
              {detection.uv
                ? "Build a Telar environment on the selected interpreter. Same Python, so your project's compiled packages still load."
                : "uv is not installed, so Telar cannot build its own environment. The kernel will need ipykernel in the interpreter you picked."}
            </span>
            {detection.uv && (
              <label className="flex items-center gap-2 text-xs">
                <Switch checked={withStack} onCheckedChange={setWithStack} aria-label="Also install the analysis stack" />
                Also install pandas, matplotlib, duckdb and pyarrow
              </label>
            )}
            {detection.uv && (
              <Button variant="outline" size="sm" disabled={building} onClick={() => void build()} className="self-start">
                {building ? <Spinner className="size-3" /> : <FlaskConicalIcon className="size-3" />}
                {building ? "Building…" : "Create a Telar environment"}
              </Button>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" disabled={detecting || building} onClick={() => void detect()}>
            <RefreshCwIcon className="size-3" /> Detect again
          </Button>
          <Button size="sm" disabled={!chosen || building} onClick={confirm}>Use this Python</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DataScienceSection({ project, onChange }: { project: Project; onChange: (project: Project) => void }) {
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const config = project.dataScience;
  const enabled = config?.enabled === true;

  const save = async (next: DataScienceConfig | null) => {
    setSaving(true);
    setError(undefined);
    try {
      const answer = await api.updateProject(project.id, { dataScience: next });
      onChange(answer.project);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsGroup
      title="Data science"
      description="A Python kernel per session, notebooks in the panel, and analysis tools for agents. Images of your data are stored beside the session."
    >
      <Row
        label="Enable for this project"
        hint={error ?? (enabled ? "Sessions on this project get notebook and ds_* tools." : "Off — no kernel, no tools, nothing extra in the panel.")}
        control={
          <Switch
            checked={enabled}
            disabled={saving}
            onCheckedChange={(next: boolean) => {
              if (next) setPicking(true);
              else void save(null);
            }}
            aria-label="Enable data science for this project"
          />
        }
      />
      {enabled && config?.python && (
        <Row
          label="Python"
          hint={config.python.source === "telar" ? "Telar's own environment." : "Chosen from the interpreters detected in this checkout."}
          control={
            <span className="flex items-center gap-2">
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem]">{config.python.path}</code>
              <Button variant="outline" size="sm" disabled={saving} onClick={() => setPicking(true)}>Change</Button>
            </span>
          }
        />
      )}
      <PythonPickerDialog
        projectId={project.id}
        open={picking}
        onClose={(next) => {
          setPicking(false);
          if (next) void save(next);
        }}
      />
    </SettingsGroup>
  );
}
