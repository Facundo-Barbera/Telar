"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2Icon } from "lucide-react";
import type { RunKind } from "@telar/core";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { KIND_INFO } from "./utils";

type ProjectOption = { name: string; account: string };

const KINDS: RunKind[] = ["quickfix", "story", "custom", "verify"];
const TARGETS = ["dev", "preview", "prod"] as const;
type Target = (typeof TARGETS)[number];

export function NewRunDialog({
  open,
  onOpenChange,
  defaultProject,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultProject?: string | null;
  onCreated: (runId: string) => void;
}) {
  // null = not yet loaded, [] = loaded but none registered.
  const [projects, setProjects] = useState<ProjectOption[] | null>(null);
  const [project, setProject] = useState("");
  const [kind, setKind] = useState<RunKind>("quickfix");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [criteria, setCriteria] = useState("");
  const [target, setTarget] = useState<Target>("dev");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the form each time the dialog opens, then load registered projects.
  useEffect(() => {
    if (!open) return;
    setKind("quickfix");
    setTitle("");
    setPrompt("");
    setCriteria("");
    setTarget("dev");
    setError(null);
    setSubmitting(false);
    setProjects(null);

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/projects");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        const opts: ProjectOption[] = (data.projects ?? [])
          .filter((p: { manifest: unknown }) => p.manifest)
          .map((p: { manifest: { name: string; account: string } }) => ({
            name: p.manifest.name,
            account: p.manifest.account,
          }));
        setProjects(opts);
      } catch {
        if (!cancelled) setProjects([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Once projects arrive, settle on a selection: keep current if valid, else the
  // preselected project from the URL, else the first available.
  useEffect(() => {
    if (!projects) return;
    setProject((cur) => {
      if (cur && projects.some((p) => p.name === cur)) return cur;
      if (defaultProject && projects.some((p) => p.name === defaultProject))
        return defaultProject;
      return projects[0]?.name ?? "";
    });
  }, [projects, defaultProject]);

  const selected = projects?.find((p) => p.name === project) ?? null;
  const canSubmit =
    !submitting &&
    project !== "" &&
    title.trim() !== "" &&
    prompt.trim() !== "" &&
    (kind !== "verify" || criteria.trim() !== "");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      // One criterion per non-empty line; omit the field entirely when empty.
      const acceptanceCriteria = criteria
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project,
          kind,
          title: title.trim(),
          prompt,
          ...(acceptanceCriteria.length ? { acceptanceCriteria } : {}),
          ...(kind === "verify" ? { target } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      window.dispatchEvent(new Event("telar:refresh"));
      onCreated(data.run.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New run</DialogTitle>
            <DialogDescription>
              Hand a project to the executor — it attempts, verifies with gates,
              and retries on its own.
            </DialogDescription>
          </DialogHeader>

          {projects && projects.length === 0 ? (
            <div className="rounded-lg border border-border bg-muted/30 px-3 py-4 text-sm text-muted-foreground">
              No projects registered yet.{" "}
              <Link
                href="/projects"
                className="text-foreground underline underline-offset-4"
              >
                Add one
              </Link>{" "}
              to start a run.
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  Project
                </label>
                <Select
                  value={project}
                  onValueChange={(v) => setProject(typeof v === "string" ? v : "")}
                  disabled={!projects}
                >
                  <SelectTrigger className="w-full" size="default">
                    <SelectValue>
                      {selected ? (
                        <span className="flex items-center gap-2">
                          {selected.name}
                          <Badge
                            variant="outline"
                            className="px-1 py-0 font-mono text-[10px]"
                          >
                            {selected.account}
                          </Badge>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">
                          {projects ? "Select a project" : "Loading…"}
                        </span>
                      )}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {(projects ?? []).map((p) => (
                      <SelectItem key={p.name} value={p.name}>
                        <span className="flex w-full items-center gap-2">
                          {p.name}
                          <Badge
                            variant="outline"
                            className="ml-auto px-1 py-0 font-mono text-[10px]"
                          >
                            {p.account}
                          </Badge>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  Kind
                </label>
                <Select
                  value={kind}
                  onValueChange={(v) => v && setKind(v as RunKind)}
                >
                  <SelectTrigger className="w-full" size="default">
                    <SelectValue>{KIND_INFO[kind].label}</SelectValue>
                  </SelectTrigger>
                  <SelectContent className="w-[var(--anchor-width)]">
                    {KINDS.map((k) => (
                      <SelectItem key={k} value={k} className="py-2">
                        <span className="flex w-full flex-col gap-0.5">
                          <span className="font-medium">{KIND_INFO[k].label}</span>
                          <span className="text-xs text-muted-foreground">
                            {KIND_INFO[k].blurb}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  Title
                </label>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Short name for this run"
                  autoComplete="off"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  Prompt
                </label>
                <Textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Describe the work. The executor will make focused changes and verify them."
                  rows={6}
                  className="resize-none font-mono text-xs leading-relaxed"
                />
              </div>

              {kind === "verify" && (
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    Target
                  </label>
                  <Select
                    value={target}
                    onValueChange={(v) => v && setTarget(v as Target)}
                  >
                    <SelectTrigger className="w-full" size="default">
                      <SelectValue>{target}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {TARGETS.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  Acceptance criteria
                  {kind !== "verify" && (
                    <span className="ml-1.5 font-normal text-muted-foreground/70">
                      optional
                    </span>
                  )}
                </label>
                <Textarea
                  value={criteria}
                  onChange={(e) => setCriteria(e.target.value)}
                  placeholder={"Users can log in with email\nDashboard loads under 2s"}
                  rows={3}
                  className="resize-none font-mono text-xs leading-relaxed"
                />
                <p className="text-xs text-muted-foreground">
                  One per line — the Verifier checks each after the run.
                </p>
              </div>
            </>
          )}

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting && <Loader2Icon className="animate-spin" />}
              Start run
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
