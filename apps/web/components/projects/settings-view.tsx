"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeftIcon,
  BanIcon,
  CheckCircle2Icon,
  FileCogIcon,
  FolderXIcon,
  PlusIcon,
  RotateCwIcon,
  SaveIcon,
  ShieldIcon,
  SlidersHorizontalIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import type { ProjectManifest, RegistryEntry } from "@telar/core";
import { ACCOUNTS } from "@/lib/accounts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { SettingsPermissions } from "@/components/projects/settings-permissions";
import { SettingsDanger } from "@/components/projects/settings-danger";

type ProjectEntry = {
  entry: RegistryEntry;
  manifest: ProjectManifest | null;
  error: string | null;
};

type Status = "loading" | "ready" | "missing" | "error";

type GateRow = { name: string; run: string };

// The editable slice of a manifest — name/root are identity and never surface
// here. Mirrors ProjectManifest but flattens guardrails so each list edits
// independently.
type Form = {
  account: string;
  baseBranch: string;
  adapter: "plain" | "bmad";
  gates: GateRow[];
  protectedPaths: string[];
  disallowedTools: string[];
};

const ADAPTERS = ["plain", "bmad"] as const;

function formFromManifest(m: ProjectManifest): Form {
  return {
    account: m.account,
    baseBranch: m.baseBranch,
    adapter: m.adapter,
    gates: m.gates.map((g) => ({ name: g.name, run: g.run })),
    protectedPaths: [...m.guardrails.protectedPaths],
    disallowedTools: [...m.guardrails.disallowedTools],
  };
}

// Only the fields the user actually changed, cleaned. Empty gate/path/tool rows
// are dropped so a stray blank row never counts as an edit or reaches the API.
function buildBody(form: Form, orig: Form): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (form.account !== orig.account) body.account = form.account;

  const baseBranch = form.baseBranch.trim();
  if (baseBranch !== orig.baseBranch) body.baseBranch = baseBranch;

  if (form.adapter !== orig.adapter) body.adapter = form.adapter;

  const gates = form.gates
    .map((g) => ({ name: g.name.trim(), run: g.run.trim() }))
    .filter((g) => g.name && g.run);
  if (JSON.stringify(gates) !== JSON.stringify(orig.gates)) body.gates = gates;

  const protectedPaths = form.protectedPaths.map((p) => p.trim()).filter(Boolean);
  const disallowedTools = form.disallowedTools.map((t) => t.trim()).filter(Boolean);
  if (
    JSON.stringify(protectedPaths) !== JSON.stringify(orig.protectedPaths) ||
    JSON.stringify(disallowedTools) !== JSON.stringify(orig.disallowedTools)
  ) {
    body.guardrails = { protectedPaths, disallowedTools };
  }
  return body;
}

function BackLink({ href }: { href: string }) {
  return (
    <Link
      href={href}
      className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      aria-label="Back to project"
    >
      <ArrowLeftIcon className="size-4" />
    </Link>
  );
}

function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="text-xs font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function SectionCard({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <Icon className="size-4 text-muted-foreground" />
          {title}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

// A trimmed-down list editor shared by protected paths and disallowed tools:
// each value is a single mono input with a remove control, plus an add button.
function StringListEditor({
  values,
  onChange,
  placeholder,
  addLabel,
  emptyLabel,
  ariaPrefix,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  addLabel: string;
  emptyLabel: string;
  ariaPrefix: string;
}) {
  return (
    <div className="space-y-2">
      {values.length === 0 && (
        <p className="rounded-md border border-dashed border-border px-2.5 py-2 text-xs text-muted-foreground">
          {emptyLabel}
        </p>
      )}
      {values.map((value, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            value={value}
            onChange={(e) =>
              onChange(values.map((v, idx) => (idx === i ? e.target.value : v)))
            }
            placeholder={placeholder}
            className="h-8 flex-1 font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
            aria-label={`${ariaPrefix} ${i + 1}`}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-muted-foreground hover:text-destructive"
            onClick={() => onChange(values.filter((_, idx) => idx !== i))}
            aria-label={`Remove ${ariaPrefix.toLowerCase()} ${i + 1}`}
          >
            <XIcon />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...values, ""])}
      >
        <PlusIcon />
        {addLabel}
      </Button>
    </div>
  );
}

export function ProjectSettings({ name }: { name: string }) {
  const projectHref = `/projects/${encodeURIComponent(name)}`;
  const accountNames = useMemo(() => Object.keys(ACCOUNTS), []);

  const [status, setStatus] = useState<Status>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [entry, setEntry] = useState<RegistryEntry | null>(null);
  const [manifest, setManifest] = useState<ProjectManifest | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);

  const [form, setForm] = useState<Form | null>(null);
  const [orig, setOrig] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      if (!res.ok)
        throw new Error(`Couldn't reach the registry (${res.status}).`);
      const data = (await res.json()) as { projects?: ProjectEntry[] };
      const match =
        (data.projects ?? []).find((p) => p.entry.name === name) ?? null;
      if (!match) {
        setStatus("missing");
        return;
      }
      setEntry(match.entry);
      setManifest(match.manifest);
      setManifestError(match.error);
      if (match.manifest) {
        const f = formFromManifest(match.manifest);
        setForm(f);
        setOrig(f);
      }
      setStatus("ready");
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      setStatus((prev) => (prev === "loading" ? "error" : prev));
    }
  }, [name]);

  useEffect(() => {
    void load();
  }, [load]);

  const body = useMemo(
    () => (form && orig ? buildBody(form, orig) : {}),
    [form, orig],
  );
  const dirty = Object.keys(body).length > 0;

  // Editing after a save clears the transient banners — the success/error state
  // only describes the last committed save, never the in-progress form.
  useEffect(() => {
    if (dirty) {
      setSaved(false);
      setSaveError(null);
    }
  }, [dirty]);

  const patch = useCallback(
    (partial: Partial<Form>) => setForm((f) => (f ? { ...f, ...partial } : f)),
    [],
  );

  const save = async () => {
    if (!form || !orig) return;
    if (!form.baseBranch.trim()) {
      setSaveError("Base branch can't be empty.");
      return;
    }
    const payload = buildBody(form, orig);
    if (Object.keys(payload).length === 0) return;

    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(name)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        manifest?: ProjectManifest;
      };
      if (!res.ok || !data.manifest)
        throw new Error(data.error ?? `Save failed (${res.status}).`);

      const next = formFromManifest(data.manifest);
      setManifest(data.manifest);
      setForm(next);
      setOrig(next);
      setSaved(true);
      window.dispatchEvent(new Event("telar:refresh"));
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // Unknown project.
  if (status === "missing") {
    return (
      <div className="flex h-dvh flex-col">
        <PageHeader title="Settings" leading={<BackLink href="/projects" />} />
        <div className="flex flex-1 items-center justify-center p-6">
          <EmptyState
            className="border-none"
            icon={FolderXIcon}
            title="Project not found"
            description={
              <>
                No project named{" "}
                <code className="font-mono text-foreground">{name}</code> is
                registered on the loom.
              </>
            }
            action={
              <Button variant="outline" render={<Link href="/projects" />}>
                Back to projects
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  // First-load registry failure.
  if (status === "error") {
    return (
      <div className="flex h-dvh flex-col">
        <PageHeader title="Settings" leading={<BackLink href={projectHref} />} />
        <div className="flex flex-1 items-center justify-center p-6">
          <EmptyState
            className="border-none"
            icon={TriangleAlertIcon}
            iconClassName="text-destructive/60"
            title="Couldn't load settings"
            description={
              <span className="font-mono text-xs break-words">{loadError}</span>
            }
            action={
              <Button variant="outline" size="sm" onClick={() => void load()}>
                <RotateCwIcon />
                Retry
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  // Loading.
  if (status === "loading" || !entry) {
    return (
      <div className="flex h-dvh flex-col">
        <PageHeader
          leading={<BackLink href={projectHref} />}
          title={<Skeleton className="h-5 w-32" />}
          actions={<Skeleton className="h-7 w-20 rounded-lg" />}
        />
        <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-4">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-36 w-full rounded-xl" />
          <Skeleton className="h-32 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  const root = manifest?.root ?? entry.root;

  const header = (
    <PageHeader
      leading={<BackLink href={projectHref} />}
      title="Settings"
      description={
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-[11px] text-foreground/80">{name}</span>
          <code
            className="truncate font-mono text-[11px] text-muted-foreground/70"
            title={root}
          >
            {root}
          </code>
        </div>
      }
      actions={
        form ? (
          <Button size="sm" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? <Spinner /> : <SaveIcon />}
            Save
          </Button>
        ) : undefined
      }
    />
  );

  return (
    <div className="flex h-dvh flex-col">
      {header}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-4">
          {saved && (
            <Alert>
              <CheckCircle2Icon />
              <AlertTitle>Settings saved</AlertTitle>
              <AlertDescription>
                telar.yaml at{" "}
                <code className="font-mono text-xs">{root}</code> was updated.
              </AlertDescription>
            </Alert>
          )}
          {saveError && (
            <Alert variant="destructive">
              <XIcon />
              <AlertTitle>Couldn&apos;t save</AlertTitle>
              <AlertDescription className="font-mono text-xs break-words">
                {saveError}
              </AlertDescription>
            </Alert>
          )}

          {form ? (
            <>
              {/* General */}
              <SectionCard icon={SlidersHorizontalIcon} title="General">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="Account"
                    hint="Default account for new sessions and runs in this project."
                  >
                    <Select
                      value={form.account}
                      onValueChange={(v) => v && patch({ account: String(v) })}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {accountNames.map((a) => (
                          <SelectItem key={a} value={a}>
                            {a}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Adapter" hint="Workflow flavor for runs.">
                    <Select
                      value={form.adapter}
                      onValueChange={(v) =>
                        v &&
                        patch({ adapter: String(v) as "plain" | "bmad" })
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ADAPTERS.map((a) => (
                          <SelectItem key={a} value={a}>
                            {a}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
                <Field
                  htmlFor="base-branch"
                  label="Base branch"
                  hint="Branch runs cut their work from and target."
                >
                  <Input
                    id="base-branch"
                    value={form.baseBranch}
                    onChange={(e) => patch({ baseBranch: e.target.value })}
                    placeholder="main"
                    className="font-mono text-xs sm:max-w-64"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
              </SectionCard>

              {/* Gates */}
              <SectionCard
                icon={CheckCircle2Icon}
                title="Gates"
                description="Commands whose exit code decides whether a run passes."
              >
                <div className="space-y-2">
                  {form.gates.length === 0 && (
                    <p className="rounded-md border border-dashed border-border px-2.5 py-2 text-xs text-muted-foreground">
                      No gates — runs pass on the agent&apos;s verdict alone.
                    </p>
                  )}
                  {form.gates.map((gate, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input
                        value={gate.name}
                        onChange={(e) =>
                          patch({
                            gates: form.gates.map((g, idx) =>
                              idx === i ? { ...g, name: e.target.value } : g,
                            ),
                          })
                        }
                        placeholder="name"
                        className="h-8 w-28 shrink-0 text-xs"
                        autoComplete="off"
                        spellCheck={false}
                        aria-label={`Gate ${i + 1} name`}
                      />
                      <Input
                        value={gate.run}
                        onChange={(e) =>
                          patch({
                            gates: form.gates.map((g, idx) =>
                              idx === i ? { ...g, run: e.target.value } : g,
                            ),
                          })
                        }
                        placeholder="command"
                        className="h-8 flex-1 font-mono text-xs"
                        autoComplete="off"
                        spellCheck={false}
                        aria-label={`Gate ${i + 1} command`}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() =>
                          patch({
                            gates: form.gates.filter((_, idx) => idx !== i),
                          })
                        }
                        aria-label={`Remove gate ${i + 1}`}
                      >
                        <XIcon />
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      patch({ gates: [...form.gates, { name: "", run: "" }] })
                    }
                  >
                    <PlusIcon />
                    Add gate
                  </Button>
                </div>
              </SectionCard>

              {/* Guardrails */}
              <SectionCard
                icon={ShieldIcon}
                title="Guardrails"
                description="Paths and tools runs are fenced off from."
              >
                <Field label="Protected paths">
                  <StringListEditor
                    values={form.protectedPaths}
                    onChange={(protectedPaths) => patch({ protectedPaths })}
                    placeholder="src/db/migrations/**"
                    addLabel="Add path"
                    emptyLabel="No protected paths — nothing fenced off."
                    ariaPrefix="Protected path"
                  />
                </Field>
                <Field label="Disallowed tools">
                  <StringListEditor
                    values={form.disallowedTools}
                    onChange={(disallowedTools) => patch({ disallowedTools })}
                    placeholder="Bash(rm:*)"
                    addLabel="Add tool"
                    emptyLabel="No disallowed tools — every tool is available."
                    ariaPrefix="Disallowed tool"
                  />
                </Field>
              </SectionCard>
            </>
          ) : (
            // Manifest failed to parse — the editable form can't render, but the
            // registry-scoped sections below still work.
            <SectionCard icon={FileCogIcon} title="Manifest">
              <Alert variant="destructive">
                <BanIcon />
                <AlertTitle>Invalid telar.yaml</AlertTitle>
                <AlertDescription className="font-mono text-xs break-words">
                  {manifestError ?? "The manifest could not be read."}
                </AlertDescription>
              </Alert>
              <p className="text-xs text-muted-foreground">
                Fix the manifest at{" "}
                <code className="font-mono">{root}</code>, then reload to edit
                these settings.
              </p>
            </SectionCard>
          )}

          {/* Permissions — registry-scoped, independent of the manifest. */}
          <SettingsPermissions project={name} />

          {/* Danger */}
          <SettingsDanger name={name} />
        </div>
      </div>
    </div>
  );
}
