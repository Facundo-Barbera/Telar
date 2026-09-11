"use client";

/**
 * LATEX — a project's opt-in to TeX compiles, the `latex_*` tools and the
 * LaTeX panel surface, and the TOOLCHAIN MANAGER behind it.
 *
 * THE PAGE THINKS IN DISTRIBUTIONS the way the data-science page thinks in
 * environments: Tectonic is one card, every TeX Live root (MacTeX, TinyTeX,
 * a vanilla install) is another; one is in use. What is missing installs
 * from here as a job with its log on screen — Tectonic via Homebrew or the
 * vendor installer, TinyTeX always the vendor script, because the Homebrew
 * casks are sudo-prompting pkg installers a background job cannot answer.
 *
 * PACKAGES ARE HONEST ABOUT THE SPLIT: a tlmgr-managed distribution lists
 * and installs; Tectonic shows one sentence, because it fetches packages
 * itself on first use and an install form would be a lie.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, DownloadIcon, RefreshCwIcon } from "lucide-react";
import type {
  LatexConfig,
  LatexDistributions,
  LatexEngine,
  LatexPackagesAnswer,
  LatexTexliveDistribution,
  LatexToolchainChoice,
  Project,
} from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Row, SettingsGroup } from "./settings-shell";
import { JobLog, type JobHandle, type JobIo } from "./job-log";
import { cn } from "@/lib/utils";
import { writeDraft } from "@/lib/composer-draft";
import { canvasHref } from "@/lib/session-list";

const api = createEngineApi();

/** The latex job endpoints — JobLog polls these instead of the DS pair. */
const LATEX_IO: JobIo = {
  read: (jobId, after) => api.latexJob(jobId, after),
  cancel: (jobId) => api.latexCancelJob(jobId),
};

const ENGINES: LatexEngine[] = ["pdflatex", "lualatex", "xelatex"];

const FLAVOUR_LABEL: Record<LatexTexliveDistribution["flavour"], string> = {
  mactex: "MacTeX",
  tinytex: "TinyTeX",
  texlive: "TeX Live",
};

export function LatexSection({ project, onChange }: { project: Project; onChange: (project: Project) => void }) {
  const router = useRouter();
  const config = project.latex;
  const enabled = config?.enabled === true;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [data, setData] = useState<LatexDistributions>();
  const [loading, setLoading] = useState(false);
  const [job, setJob] = useState<JobHandle>();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.latexDistributions(project.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read the TeX toolchain.");
    } finally {
      setLoading(false);
    }
  }, [project.id]);
  useEffect(() => {
    const task = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(task);
  }, [refresh]);

  const save = async (next: LatexConfig | null) => {
    setSaving(true);
    setError(undefined);
    try {
      const answer = await api.updateProject(project.id, { latex: next });
      onChange(answer.project);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  };

  /** The one distribution discovery would pick unaided, for the enable switch. */
  const soleChoice = (): LatexToolchainChoice | undefined => {
    if (!data) return undefined;
    const cards = [
      ...(data.toolchain.tectonic ? [{ kind: "tectonic" as const, path: data.toolchain.tectonic.path }] : []),
      ...data.toolchain.texlive.map((dist) => ({ kind: "texlive" as const, path: dist.binDir })),
    ];
    return cards.length === 1 ? cards[0] : undefined;
  };

  const setEnabled = (next: boolean) => {
    if (!next) return void save(config ? { ...config, enabled: false } : null);
    // On first enable with exactly one distribution, pick it silently — the
    // same moment the DS page writes the environment on "Use".
    const toolchain = config?.toolchain ?? soleChoice();
    void save({ enabled: true, ...(toolchain ? { toolchain } : {}), ...(config?.mainFile ? { mainFile: config.mainFile } : {}) });
  };

  const use = (choice: LatexToolchainChoice) =>
    void save({ enabled: true, toolchain: { ...choice, ...(config?.toolchain?.engine && choice.kind === "texlive" ? { engine: config.toolchain.engine } : {}) }, ...(config?.mainFile ? { mainFile: config.mainFile } : {}) });

  const bootstrap = async (what: "tectonic" | "tinytex") => {
    setError(undefined);
    try {
      const { jobId } = await api.latexBootstrap({ what });
      setJob({ jobId, title: what === "tectonic" ? "Installing Tectonic" : "Installing TinyTeX" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the install.");
    }
  };

  const currentPath = config?.toolchain?.path;
  const tectonic = data?.toolchain.tectonic;
  const texlive = data?.toolchain.texlive ?? [];
  const currentTexlive = texlive.find((dist) => dist.binDir === currentPath);
  const askAgentToSetUp = () => {
    writeDraft(
      undefined,
      project.id,
      "Set up LaTeX for this workspace. Please inspect the .tex files, choose or install the right TeX toolchain, identify the report entry points, and compile one document to confirm it works.",
    );
    router.push(canvasHref(project.id));
  };

  return (
    <>
      <SettingsGroup
        title="LaTeX"
        // The second sentence was the "Default document" row's hint, written a
        // second time three rows higher: that row already says the default only
        // fills in a bare Compile and that agents can compile anything by path.
        // A header that pre-explains a row it sits above makes the reader read
        // the same fact twice and trust neither.
        description="Compile tools for this project."
        action={
          <Button variant="outline" size="sm" onClick={askAgentToSetUp}>
            <DownloadIcon className="size-3" /> Ask agent to set up
          </Button>
        }
      >
        <Row
          label="Enabled"
          hint={error ?? (enabled ? "Sessions get the latex_* tools and the LaTeX panel tab." : "Off. You can enable first, then choose or install a toolchain below.")}
          control={<Switch checked={enabled} disabled={saving} onCheckedChange={setEnabled} aria-label="Enable LaTeX for this project" />}
        />
        <Row
          label="Default document"
          hint={data?.mainCandidates.length ? "Used only when you press Compile without choosing a file. Agents can still compile any report by path." : "No .tex with \\documentclass found in the top folders — type a path, or ask the agent to inspect deeper."}
          control={
            data && data.mainCandidates.length > 0 ? (
              <Select
                value={config?.mainFile ?? "__none"}
                onValueChange={(next) => void save({ enabled, ...(config?.toolchain ? { toolchain: config.toolchain } : {}), ...(typeof next === "string" && next !== "__none" ? { mainFile: next } : {}) })}
              >
                <SelectTrigger size="sm" className="w-56" aria-label="Main .tex file">
                  <SelectValue placeholder="No default" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">No default</SelectItem>
                  {data.mainCandidates.map((candidate) => (
                    <SelectItem key={candidate} value={candidate}>{candidate}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <MainFileInput
                value={config?.mainFile ?? ""}
                disabled={saving}
                onSave={(next) => void save({ enabled, ...(config?.toolchain ? { toolchain: config.toolchain } : {}), ...(next ? { mainFile: next } : {}) })}
              />
            )
          }
        />
        {config?.toolchain?.kind === "texlive" && (
          <Row
            label="Engine"
            hint="What latexmk drives. pdflatex unless the document needs system fonts (xelatex, lualatex)."
            control={
              <Select
                value={config.toolchain.engine ?? "pdflatex"}
                onValueChange={(next) => void save({ ...config, toolchain: { ...config.toolchain!, engine: next as LatexEngine } })}
              >
                <SelectTrigger size="sm" className="w-36" aria-label="TeX engine">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ENGINES.map((engine) => (
                    <SelectItem key={engine} value={engine}>{engine}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Distributions"
        // "One is in use; anything missing installs from here" narrated the
        // cards below, which already carry an In use state and an Install
        // button. A header describing its own list is a caption nobody needs.
        description="What compiles this project."
        action={
          <Button variant="ghost" size="sm" disabled={loading} onClick={() => void refresh()}>
            <RefreshCwIcon className={cn("size-3", loading && "animate-spin")} /> Detect again
          </Button>
        }
      >
        <div className="flex flex-col gap-2 py-3">
          {!data && loading && <span className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3" /> Probing TeX programs…</span>}
          {data && (
            <DistributionCard
              name="Tectonic"
              detail={tectonic ? `${tectonic.path} — packages download automatically on first use` : "A single self-contained engine. Packages download automatically — no tlmgr, no 5 GB install."}
              version={tectonic?.version}
              inUse={enabled && config?.toolchain?.kind === "tectonic"}
              saving={saving}
              onUse={tectonic ? () => use({ kind: "tectonic", path: tectonic.path }) : undefined}
              onInstall={tectonic ? undefined : () => void bootstrap("tectonic")}
            />
          )}
          {texlive.map((dist) => (
            <DistributionCard
              key={dist.binDir}
              name={`${FLAVOUR_LABEL[dist.flavour]}${dist.year ? ` ${dist.year}` : ""}`}
              detail={`${dist.binDir} — ${(["pdflatex", "lualatex", "xelatex"] as const).filter((engine) => dist[engine]).join(", ") || "no engines found"}${dist.tlmgr ? ", tlmgr" : ", no tlmgr"}`}
              version={dist.latexmk ? `latexmk ${dist.latexmk.version}` : undefined}
              inUse={enabled && config?.toolchain?.kind === "texlive" && config.toolchain.path === dist.binDir}
              saving={saving}
              onUse={() => use({ kind: "texlive", path: dist.binDir })}
            />
          ))}
          {data && !data.toolchain.texlive.some((dist) => dist.flavour === "tinytex") && (
            <DistributionCard
              name="TinyTeX"
              detail="A ~150 MB user-owned TeX Live with a writable tlmgr — the managed choice when Tectonic's engine is not enough."
              saving={saving}
              onInstall={() => void bootstrap("tinytex")}
            />
          )}
        </div>
      </SettingsGroup>

      {job && <JobLog className="mb-7" handle={job} io={LATEX_IO} onDone={() => void refresh()} onDismiss={() => setJob(undefined)} />}

      {enabled && config?.toolchain && (
        <SettingsGroup
          title="Packages"
          description={config.toolchain.kind === "tectonic" ? "Tectonic fetches packages automatically the first time a document uses them." : `What tlmgr manages in ${currentTexlive ? FLAVOUR_LABEL[currentTexlive.flavour] : "the configured TeX Live"}.`}
        >
          {config.toolchain.kind === "texlive" && <TexPackagesPanel projectId={project.id} onJob={setJob} />}
        </SettingsGroup>
      )}
    </>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */

function MainFileInput({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (next: string) => void }) {
  const [draft, setDraft] = useState(value);
  // Adjust-during-render, not an effect: a save landing resets the draft.
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setDraft(value);
  }
  return (
    <span className="flex items-center gap-1.5">
      <Input value={draft} disabled={disabled} placeholder="paper/main.tex" className="h-8 w-56 text-xs" onChange={(event) => setDraft(event.target.value)} />
      <Button size="sm" variant="outline" disabled={disabled || draft.trim() === value} onClick={() => onSave(draft.trim())}>Set</Button>
    </span>
  );
}

function DistributionCard({ name, detail, version, inUse = false, saving, onUse, onInstall }: {
  name: string;
  detail: string;
  version?: string;
  inUse?: boolean;
  saving: boolean;
  onUse?: () => void;
  onInstall?: () => void;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5 rounded-md border px-3 py-2", inUse ? "border-primary bg-primary/5" : "border-border", !onUse && !onInstall && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{name}</span>
        {version && <Badge variant="outline">{version}</Badge>}
        <span className="ml-auto flex items-center gap-2">
          {inUse ? (
            <span className="flex items-center gap-1 text-xs text-primary"><CheckIcon className="size-3.5" /> In use</span>
          ) : onUse ? (
            <Button size="xs" variant="outline" disabled={saving} onClick={onUse}>Use</Button>
          ) : onInstall ? (
            <Button size="xs" disabled={saving} onClick={onInstall}><DownloadIcon className="size-3" /> Install</Button>
          ) : null}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */

function TexPackagesPanel({ projectId, onJob }: { projectId: string; onJob: (handle: JobHandle) => void }) {
  const [answer, setAnswer] = useState<LatexPackagesAnswer>();
  const [loading, setLoading] = useState(false);
  const [names, setNames] = useState("");
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setAnswer(await api.latexPackages(projectId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not list packages.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);
  useEffect(() => {
    const task = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(task);
  }, [refresh]);

  const install = async () => {
    const add = names.split(/[\s,]+/).filter(Boolean);
    if (!add.length) return;
    setError(undefined);
    try {
      const { jobId } = await api.latexInstall(projectId, { add });
      onJob({ jobId, title: `Installing ${add.join(", ")}` });
      setNames("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the install.");
    }
  };

  return (
    <div className="flex flex-col gap-2 py-3">
      <span className="flex items-center gap-1.5">
        <Input value={names} placeholder="tlmgr package names — siunitx booktabs…" className="h-8 flex-1 text-xs" onChange={(event) => setNames(event.target.value)} />
        <Button size="sm" disabled={!names.trim()} onClick={() => void install()}><DownloadIcon className="size-3" /> Install</Button>
      </span>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {loading && !answer && <span className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3" /> Asking tlmgr…</span>}
      {answer?.mode === "unavailable" && <p className="text-xs text-warning">{answer.reason}</p>}
      {answer?.mode === "managed" && (
        <ul className="max-h-64 overflow-y-auto text-xs text-muted-foreground">
          {answer.packages.map((pkg) => (
            <li key={pkg.name} className="flex gap-2 border-b border-border/40 py-1 last:border-b-0">
              <span className="font-mono text-foreground">{pkg.name}</span>
              {pkg.revision && <span>r{pkg.revision}</span>}
              <span className="min-w-0 flex-1 truncate">{pkg.description}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
