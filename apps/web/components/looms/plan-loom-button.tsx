"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2Icon, WorkflowIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

type ProjectOption = { name: string };

// The Looms-tab front door onto docs/loom-model.md §5/§6: a Loom begins ONLY
// from a planning session — the create-loom dialog is gone. This is that
// front door: "New loom session" opens a fresh Loom Session at
// `/looms/plan/[project]`. The Looms tab isn't project-scoped, so with more
// than one registered project this offers a minimal picker first; with
// exactly one, it jumps straight in — the common case shouldn't cost an
// extra click.
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

  const hrefFor = (project: string) => `/looms/plan/${encodeURIComponent(project)}`;

  // Exactly one registered project: skip the picker, straight into a new
  // loom session — the common case shouldn't cost an extra click.
  if (projects && projects.length === 1) {
    return (
      <Button variant={variant} className={className} render={<Link href={hrefFor(projects[0].name)} />}>
        <WorkflowIcon />
        New loom session
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant={variant} className={className} />}>
        <WorkflowIcon />
        New loom session
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Start a loom session in which project?</DropdownMenuLabel>
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
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
