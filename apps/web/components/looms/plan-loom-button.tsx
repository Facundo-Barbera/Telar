"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2Icon, WorkflowIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

type ProjectOption = { name: string };

// The front door onto docs/loom-model.md §5: a Loom now begins from a
// planning session, never a raw one-click start — this is the conceptual
// replacement for the removed "Start loom" button. Planning is
// project-anchored, so this either jumps straight into a new session
// (the common case, exactly one registered project) or offers a minimal
// picker first — reusing sessions-rail.tsx's `/projects/[name]/sessions/new`
// link pattern either way. `?role=planner` is a forward-compatible hint only
// — the session actually becomes a planner the moment it drafts a bundle
// (lib/loom-mcp.ts's draft_bundle_file sets Chat.role server-side); nothing
// here depends on the chat route consuming the param.
export function PlanLoomButton({
  variant = "default",
  className,
}: {
  variant?: "default" | "outline";
  className?: string;
}) {
  const [projects, setProjects] = useState<ProjectOption[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/projects")
      .then((res) => (res.ok ? res.json() : { projects: [] }))
      .then((data) => {
        if (cancelled) return;
        const opts: ProjectOption[] = (data.projects ?? [])
          .filter((p: { manifest: unknown }) => p.manifest)
          .map((p: { manifest: { name: string } }) => ({ name: p.manifest.name }));
        setProjects(opts);
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const hrefFor = (project: string) =>
    `/projects/${encodeURIComponent(project)}/sessions/new?role=planner`;

  // Exactly one registered project: skip the picker, straight into a new
  // planning session — the common case shouldn't cost an extra click.
  if (projects && projects.length === 1) {
    return (
      <Button variant={variant} className={className} render={<Link href={hrefFor(projects[0].name)} />}>
        <WorkflowIcon />
        Plan a loom
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant={variant} className={className} />}>
        <WorkflowIcon />
        Plan a loom
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Plan in which project?</DropdownMenuLabel>
        {projects === null && (
          <div className="flex items-center gap-1.5 px-1.5 py-1.5 text-xs text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" />
            Loading projects…
          </div>
        )}
        {projects?.length === 0 && (
          <p className="px-1.5 py-1.5 text-xs text-muted-foreground">
            No registered projects yet.
          </p>
        )}
        {projects?.map((p) => (
          <DropdownMenuItem key={p.name} render={<Link href={hrefFor(p.name)} />}>
            {p.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
