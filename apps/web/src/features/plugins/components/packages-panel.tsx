"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { DownloadIcon, PackageIcon, RotateCwIcon, SearchIcon, Trash2Icon } from "lucide-react";
import type { DataScienceInstallCommand, DataScienceManager, DataSciencePackage, DataScienceRequirementsSource } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Spinner } from "@/ui/spinner";
import { cn } from "@/ui/utils";
import { JobLog, type JobHandle } from "./job-log";
import { Row, SettingsGroup } from "@/features/settings";

const api = createEngineApi();

export type PackagesScope = { projectId: string } | { sessionId: string };

type Environment = { manager: DataScienceManager; root: string; python: string; command?: DataScienceInstallCommand };

export const MANAGER_LABEL: Record<DataScienceManager, string> = { venv: "uv venv", conda: "conda", system: "system Python", telar: "Telar's venv" };

const COMMAND_HINT: Record<DataScienceInstallCommand, string> = {
  "uv add": "Installs run uv add — pyproject.toml and uv.lock stay in step with the environment.",
  "uv pip": "Installs run uv pip install into this environment; no manifest is updated.",
  conda: "Installs run conda install.",
  pip: "Installs run pip install.",
};

type InstallLog = { title: string; ok: boolean; lines: string[]; error?: string };

function Fields({ dense, children }: { dense?: boolean; children: ReactNode }) {
  if (dense) return <div className="divide-y divide-border/60 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">{children}</div>;
  return <SettingsGroup title="Environment">{children}</SettingsGroup>;
}

export function PackagesPanel({
  scope, requirements = [], kernelLive, onRestartKernel, dense,
}: {
  scope: PackagesScope;
  requirements?: DataScienceRequirementsSource[];
  kernelLive?: boolean;
  onRestartKernel?: () => void;
  dense?: boolean;
}) {
  const [packages, setPackages] = useState<DataSciencePackage[]>();
  const [environment, setEnvironment] = useState<Environment>();
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState("");
  const [specs, setSpecs] = useState("");
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<JobHandle>();
  const [sessionLog, setSessionLog] = useState<InstallLog>();
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

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", dense ? "gap-2 p-2" : "gap-3")}>
      <EnvironmentFields
        environment={environment}
        packages={packages}
        requirements={requirements}
        specs={specs}
        busy={busy}
        dense={dense}
        onSpecs={setSpecs}
        onInstall={install}
        onInstallFrom={(source) => void change(`Installing from ${source}`, { requirements: source })}
      />

      {job && (
        <JobLog
          handle={job}
          onDone={(finished) => { setBusy(false); if (finished.status === "ok") { setStale(true); setSpecs(""); } void load(); }}
          onDismiss={() => setJob(undefined)}
        />
      )}
      {sessionLog && <SessionLog log={sessionLog} onDismiss={() => setSessionLog(undefined)} />}
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

      <PackageList
        packages={packages}
        shown={shown}
        dense={dense}
        busy={busy}
        onRemove={(name) => void change(`Removing ${name}`, { remove: [name] })}
      />
    </div>
  );
}

function EnvironmentFields({
  environment,
  packages,
  requirements,
  specs,
  busy,
  dense,
  onSpecs,
  onInstall,
  onInstallFrom,
}: {
  environment: Environment | undefined;
  packages: DataSciencePackage[] | undefined;
  requirements: DataScienceRequirementsSource[];
  specs: string;
  busy: boolean;
  dense: boolean | undefined;
  onSpecs: (specs: string) => void;
  onInstall: () => void;
  onInstallFrom: (source: DataScienceRequirementsSource) => void;
}) {
  const installable = requirements.filter((r) => r !== "Pipfile" && (environment?.manager === "conda" ? true : r !== "environment.yml"));
  return (
    <Fields dense={dense}>
      {environment && (
        <Row
          icon={PackageIcon}
          label="Environment"
          hint={environment.python}
          status={<Badge variant="secondary">{MANAGER_LABEL[environment.manager]}</Badge>}
          control={
            packages && <span className="text-xs text-muted-foreground tabular-nums">{packages.length} packages</span>
          }
        >
          <code className="mt-0.5 block min-w-0 truncate font-mono text-2xs text-muted-foreground">{environment.root}</code>
        </Row>
      )}

      <Row
        icon={DownloadIcon}
        label="Install packages"
        hint={environment?.command ? COMMAND_HINT[environment.command] : "Names, optionally with versions. Enter installs."}
        {...(environment ? {} : { unavailable: { reason: "No Python environment was resolved for this project." } })}
        control={
          <div className="flex items-center gap-2">
            <Input
              value={specs}
              onChange={(event) => onSpecs(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") onInstall(); }}
              placeholder="seaborn  polars>=1.0  scikit-learn"
              className="h-8 w-56 font-mono text-2xs"
              aria-label="Packages to install"
              disabled={busy || !environment}
            />
            <Button size="sm" disabled={busy || !specs.trim() || !environment} onClick={onInstall}>
              {busy ? <Spinner className="size-3" /> : <DownloadIcon className="size-3" />} Install
            </Button>
          </div>
        }
      />

      {installable.length > 0 && !dense && (
        <Row
          icon={PackageIcon}
          label="The project's own dependencies"
          hint="Install everything the checkout already declares."
          control={
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              {installable.map((source) => (
                <Button key={source} variant="outline" size="xs" disabled={busy} onClick={() => onInstallFrom(source)}>
                  <code className="font-mono text-3xs">{source}</code>
                </Button>
              ))}
            </div>
          }
        />
      )}
    </Fields>
  );
}

function SessionLog({ log, onDismiss }: { log: InstallLog; onDismiss: () => void }) {
  return (
    <div className={cn("rounded-md border px-3 py-2 text-xs", log.ok ? "border-border" : "border-destructive/40")}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{log.title}</span>
        <span className={log.ok ? "text-success" : "text-destructive"}>{log.ok ? "Done" : log.error ?? "Failed"}</span>
        <button type="button" aria-label="Dismiss" onClick={onDismiss} className="text-muted-foreground hover:text-foreground">×</button>
      </div>
      {log.lines.length > 0 && (
        <pre className="m-0 mt-1 max-h-32 overflow-auto font-mono text-3xs leading-[1.5] whitespace-pre-wrap text-muted-foreground">{log.lines.slice(-30).join("\n")}</pre>
      )}
    </div>
  );
}

function PackageList({
  packages,
  shown,
  dense,
  busy,
  onRemove,
}: {
  packages: DataSciencePackage[] | undefined;
  shown: DataSciencePackage[];
  dense: boolean | undefined;
  busy: boolean;
  onRemove: (name: string) => void;
}) {
  const [confirmRemove, setConfirmRemove] = useState<string>();
  const manifested = useMemo(() => (packages ?? []).some((p) => p.direct !== undefined), [packages]);
  const direct = manifested ? shown.filter((p) => p.direct) : shown;
  const transitive = manifested ? shown.filter((p) => !p.direct) : [];
  return (
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
          {manifested && direct.length > 0 && <div className="border-b border-border/60 bg-muted/30 px-3 py-1 text-3xs font-medium text-muted-foreground">Declared by the project ({direct.length})</div>}
          {direct.map((pkg) => (
            <div key={pkg.name} className="group flex items-center gap-2 border-b border-border/60 px-3 py-1 last:border-b-0 hover:bg-muted/40">
              <span className="min-w-0 flex-1 truncate font-mono text-2xs">{pkg.name}</span>
              <span className="shrink-0 font-mono text-3xs text-muted-foreground tabular-nums">{pkg.version}</span>
              {pkg.channel && !dense && <span className="shrink-0 text-4xs text-muted-foreground/70">{pkg.channel}</span>}
              {confirmRemove === pkg.name ? (
                <span className="flex shrink-0 items-center gap-1">
                  <Button variant="destructive" size="xs" disabled={busy} onClick={() => { setConfirmRemove(undefined); onRemove(pkg.name); }}>Remove</Button>
                  <Button variant="ghost" size="xs" onClick={() => setConfirmRemove(undefined)}>Keep</Button>
                </span>
              ) : (
                <button type="button" title={`Remove ${pkg.name}`} aria-label={`Remove ${pkg.name}`} disabled={busy} onClick={() => setConfirmRemove(pkg.name)} className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive disabled:opacity-0">
                  <Trash2Icon className="size-3" />
                </button>
              )}
            </div>
          ))}
          {manifested && transitive.length > 0 && <div className="border-b border-border/60 bg-muted/30 px-3 py-1 text-3xs font-medium text-muted-foreground">Installed with them ({transitive.length})</div>}
          {transitive.map((pkg) => (
            <div key={pkg.name} className="flex items-center gap-2 border-b border-border/60 px-3 py-1 last:border-b-0 hover:bg-muted/40">
              <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground">{pkg.name}</span>
              <span className="shrink-0 font-mono text-3xs text-muted-foreground tabular-nums">{pkg.version}</span>
              {pkg.channel && !dense && <span className="shrink-0 text-4xs text-muted-foreground/70">{pkg.channel}</span>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
