"use client";

/**
 * WHAT IS IN THE ENVIRONMENT, AND A WAY TO CHANGE IT — the day-two question
 * the interpreter picker never answered ("how do I add seaborn?").
 *
 * TWO SCOPES, ONE COMPONENT. In project settings it reads and writes through
 * the project routes and shows the job log inline. Inside a session it goes
 * through the session's `ds/*` door, which resolves the environment the way
 * that session does (a worktree's own `.venv`) and WAITS for the install, the
 * same call the agent's `ds_install` makes — so the panel and the tool cannot
 * disagree about what happened.
 *
 * After any change the kernel is stale: Python resolved its import paths at
 * start. The panel says so and offers the restart rather than doing it, since
 * a restart drops every variable.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { DownloadIcon, PackageIcon, RotateCwIcon, SearchIcon, Trash2Icon } from "lucide-react";
import type { DataScienceInstallCommand, DataScienceManager, DataSciencePackage, DataScienceRequirementsSource } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { JobLog, type JobHandle } from "./job-log";

const api = createEngineApi();

export type PackagesScope = { projectId: string } | { sessionId: string };

type Environment = { manager: DataScienceManager; root: string; python: string; command?: DataScienceInstallCommand };

export const MANAGER_LABEL: Record<DataScienceManager, string> = { venv: "uv venv", conda: "conda", system: "system Python", telar: "Telar's venv" };

/** What pressing Install actually runs — `uv add` writes the manifest, `uv pip` does not, and that difference is worth a sentence. */
const COMMAND_HINT: Record<DataScienceInstallCommand, string> = {
  "uv add": "Installs run uv add — pyproject.toml and uv.lock stay in step with the environment.",
  "uv pip": "Installs run uv pip install into this environment; no manifest is updated.",
  conda: "Installs run conda install.",
  pip: "Installs run pip install.",
};

export function PackagesPanel({
  scope, requirements = [], kernelLive, onRestartKernel, dense,
}: {
  scope: PackagesScope;
  /** Dependency manifests in the checkout, so "install the project's dependencies" can be offered. */
  requirements?: DataScienceRequirementsSource[];
  kernelLive?: boolean;
  onRestartKernel?: () => void;
  /** Panel density — the session's right column is narrow. */
  dense?: boolean;
}) {
  const [packages, setPackages] = useState<DataSciencePackage[]>();
  const [environment, setEnvironment] = useState<Environment>();
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState("");
  const [specs, setSpecs] = useState("");
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<JobHandle>();
  const [sessionLog, setSessionLog] = useState<{ title: string; ok: boolean; lines: string[]; error?: string }>();
  const [confirmRemove, setConfirmRemove] = useState<string>();
  const [stale, setStale] = useState(false);

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const answer = "projectId" in scope ? await api.dataSciencePackages(scope.projectId) : await api.sessionPackages(scope.sessionId);
      setPackages(answer.packages);
      setEnvironment(answer.environment);
    } catch (cause) {
      setPackages([]);
      setError(cause instanceof Error ? cause.message : "Could not list packages.");
    }
  }, [scope]);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const change = async (title: string, input: { add?: string[]; remove?: string[]; requirements?: DataScienceRequirementsSource }) => {
    setBusy(true);
    setError(undefined);
    setSessionLog(undefined);
    try {
      if ("projectId" in scope) {
        const { jobId } = await api.dataScienceInstall(scope.projectId, input);
        setJob({ jobId, title });
      } else {
        const outcome = await api.sessionInstall(scope.sessionId, input);
        setSessionLog({ title, ...outcome });
        setBusy(false);
        if (outcome.ok) { setStale(true); setSpecs(""); }
        void load();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the install.");
      setBusy(false);
    }
  };

  const install = () => {
    const list = specs.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (!list.length) return;
    void change(`Installing ${list.join(", ")}`, { add: list });
  };

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (packages ?? []).filter((p) => !q || p.name.toLowerCase().includes(q));
  }, [packages, filter]);

  /**
   * DIRECT DEPS ARE THE ONLY REMOVABLE ONES when the project declares any:
   * deleting a transitive dep (asttokens, say) breaks its dependents and the
   * next sync just reinstalls it. A project with no manifest keeps the flat
   * list, where every install was a deliberate act and removal is fair game.
   */
  const manifested = useMemo(() => (packages ?? []).some((p) => p.direct !== undefined), [packages]);
  const direct = manifested ? shown.filter((p) => p.direct) : shown;
  const transitive = manifested ? shown.filter((p) => !p.direct) : [];

  const installable = requirements.filter((r) => r !== "Pipfile" && (environment?.manager === "conda" ? true : r !== "environment.yml"));

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", dense ? "gap-2 p-2" : "gap-3")}>
      {environment && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Badge variant="secondary">{MANAGER_LABEL[environment.manager]}</Badge>
          <code className="min-w-0 truncate font-mono text-[0.6875rem]" title={environment.python}>{environment.root}</code>
          {packages && <span className="ml-auto shrink-0 tabular-nums">{packages.length} packages</span>}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Input
          value={specs}
          onChange={(event) => setSpecs(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") install(); }}
          placeholder="seaborn  polars>=1.0  scikit-learn"
          className="font-mono text-[0.6875rem]"
          aria-label="Packages to install"
          disabled={busy || !environment}
        />
        <Button size="sm" disabled={busy || !specs.trim() || !environment} onClick={install}>
          {busy ? <Spinner className="size-3" /> : <DownloadIcon className="size-3" />} Install
        </Button>
      </div>
      {environment?.command && <p className="text-[0.625rem] text-muted-foreground">{COMMAND_HINT[environment.command]}</p>}
      {installable.length > 0 && !dense && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>Or the project&apos;s own dependencies:</span>
          {installable.map((source) => (
            <Button key={source} variant="outline" size="xs" disabled={busy} onClick={() => void change(`Installing from ${source}`, { requirements: source })}>
              <code className="font-mono text-[0.625rem]">{source}</code>
            </Button>
          ))}
        </div>
      )}

      {job && (
        <JobLog
          handle={job}
          onDone={(finished) => { setBusy(false); if (finished.status === "ok") { setStale(true); setSpecs(""); } void load(); }}
          onDismiss={() => setJob(undefined)}
        />
      )}
      {sessionLog && (
        <div className={cn("rounded-md border px-3 py-2 text-xs", sessionLog.ok ? "border-border" : "border-destructive/40")}>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-medium">{sessionLog.title}</span>
            <span className={sessionLog.ok ? "text-success" : "text-destructive"}>{sessionLog.ok ? "Done" : sessionLog.error ?? "Failed"}</span>
            <button type="button" aria-label="Dismiss" onClick={() => setSessionLog(undefined)} className="text-muted-foreground hover:text-foreground">×</button>
          </div>
          {sessionLog.lines.length > 0 && (
            <pre className="m-0 mt-1 max-h-32 overflow-auto font-mono text-[0.625rem] leading-[1.5] whitespace-pre-wrap text-muted-foreground">{sessionLog.lines.slice(-30).join("\n")}</pre>
          )}
        </div>
      )}
      {stale && kernelLive && (
        <div className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-1.5 text-xs">
          <span className="min-w-0 flex-1">The kernel started before this change. Restart it so new imports resolve.</span>
          {onRestartKernel && <Button variant="outline" size="xs" onClick={() => { onRestartKernel(); setStale(false); }}><RotateCwIcon className="size-3" /> Restart</Button>}
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
        <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter installed packages" className="h-7 pl-7 text-xs" aria-label="Filter installed packages" />
      </div>

      <div className={cn("min-h-0 overflow-auto rounded-md border border-border", dense ? "flex-1" : "max-h-96")}>
        {packages === undefined ? (
          <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground"><Spinner className="size-3" /> Reading the environment…</div>
        ) : shown.length === 0 ? (
          <div className="flex flex-col items-center gap-1 px-3 py-6 text-center text-xs text-muted-foreground">
            <PackageIcon className="size-4 opacity-60" />
            {packages.length === 0 ? "Nothing installed yet." : "No package matches."}
          </div>
        ) : (
          <>
            {manifested && direct.length > 0 && <div className="border-b border-border/60 bg-muted/30 px-3 py-1 text-[0.625rem] font-medium text-muted-foreground">Declared by the project ({direct.length})</div>}
            {direct.map((pkg) => (
              <div key={pkg.name} className="group flex items-center gap-2 border-b border-border/60 px-3 py-1 last:border-b-0 hover:bg-muted/40">
                <span className="min-w-0 flex-1 truncate font-mono text-[0.6875rem]">{pkg.name}</span>
                <span className="shrink-0 font-mono text-[0.625rem] text-muted-foreground tabular-nums">{pkg.version}</span>
                {pkg.channel && !dense && <span className="shrink-0 text-[0.5625rem] text-muted-foreground/70">{pkg.channel}</span>}
                {confirmRemove === pkg.name ? (
                  <span className="flex shrink-0 items-center gap-1">
                    <Button variant="destructive" size="xs" disabled={busy} onClick={() => { setConfirmRemove(undefined); void change(`Removing ${pkg.name}`, { remove: [pkg.name] }); }}>Remove</Button>
                    <Button variant="ghost" size="xs" onClick={() => setConfirmRemove(undefined)}>Keep</Button>
                  </span>
                ) : (
                  <button type="button" title={`Remove ${pkg.name}`} aria-label={`Remove ${pkg.name}`} disabled={busy} onClick={() => setConfirmRemove(pkg.name)} className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive disabled:opacity-0">
                    <Trash2Icon className="size-3" />
                  </button>
                )}
              </div>
            ))}
            {manifested && transitive.length > 0 && <div className="border-b border-border/60 bg-muted/30 px-3 py-1 text-[0.625rem] font-medium text-muted-foreground">Installed with them ({transitive.length})</div>}
            {transitive.map((pkg) => (
              <div key={pkg.name} className="flex items-center gap-2 border-b border-border/60 px-3 py-1 last:border-b-0 hover:bg-muted/40">
                <span className="min-w-0 flex-1 truncate font-mono text-[0.6875rem] text-muted-foreground">{pkg.name}</span>
                <span className="shrink-0 font-mono text-[0.625rem] text-muted-foreground tabular-nums">{pkg.version}</span>
                {pkg.channel && !dense && <span className="shrink-0 text-[0.5625rem] text-muted-foreground/70">{pkg.channel}</span>}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
