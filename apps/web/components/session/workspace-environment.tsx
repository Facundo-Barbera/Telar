"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckIcon,
  ChevronsUpDownIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  LaptopIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { refreshIncludes } from "@/lib/telar-refresh";
import { cachedJson } from "@/lib/client-json-cache";
import { openRightPanelGit } from "@/lib/right-panel-store";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

type ProjectEntry = { entry: { name: string } };
type GitOverview = {
  header: { branch: string; dirtyFiles: number; ahead: number; behind: number };
  worktrees: Array<{
    id: string;
    basename: string;
    branch: string | null;
    isMainCheckout: boolean;
    dirty: boolean;
  }>;
};

export function WorkspaceEnvironment({
  project,
  rightPanelScopeKey,
}: {
  project: string;
  rightPanelScopeKey: string;
}) {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [git, setGit] = useState<GitOverview | null>(null);

  const loadProjects = useCallback((force = false) => {
    void cachedJson<{ projects?: ProjectEntry[] }>("/api/projects", { force })
      .then((body) => setProjects(Array.isArray(body?.projects) ? body.projects : []))
      .catch(() => {});
  }, []);
  const loadGit = useCallback((force = false) => {
    const url = `/api/projects/${encodeURIComponent(project)}/git`;
    void cachedJson<GitOverview>(url, { maxAgeMs: 15_000, force })
      .then((body) => setGit(body?.header ? body : null))
      .catch(() => setGit(null));
  }, [project]);

  useEffect(() => {
    loadProjects();
    loadGit();
    const onRefresh = (event: Event) => {
      if (refreshIncludes(event, "projects")) loadProjects(true);
      if (refreshIncludes(event, "git")) loadGit(true);
    };
    window.addEventListener("telar:refresh", onRefresh);
    return () => window.removeEventListener("telar:refresh", onRefresh);
  }, [loadProjects, loadGit]);

  const branch = git?.header.branch ?? "Current checkout";
  const activeWorktree = git?.worktrees.find((worktree) => worktree.isMainCheckout);

  return (
    <div className="mx-3 -mt-px">
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Choose project and environment"
            className="group flex min-h-8 w-full items-center gap-1.5 rounded-b-xl border border-t-0 border-border/60 bg-muted/25 px-2.5 text-left text-[11px] text-muted-foreground shadow-[0_8px_24px_-20px_rgba(0,0,0,.8)] transition-colors hover:bg-muted/45 hover:text-foreground"
          />
        }
      >
        <FolderGit2Icon className="size-3.5 shrink-0" />
        <span className="font-medium text-foreground">{project}</span>
        <span className="text-border">/</span>
        <GitBranchIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate font-mono">{branch}</span>
        {git && git.header.dirtyFiles > 0 && (
          <span className="ml-auto shrink-0 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
            {git.header.dirtyFiles} changed
          </span>
        )}
        <ChevronsUpDownIcon className={cn("size-3.5 shrink-0", (!git || git.header.dirtyFiles === 0) && "ml-auto")} />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-[min(27rem,calc(100vw-2rem))] gap-0 rounded-2xl p-2">
        <div className="px-2 pb-2 pt-1 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Workspace
        </div>

        <div className="space-y-0.5">
          {projects.map(({ entry }) => {
            const active = entry.name === project;
            return (
              <button
                key={entry.name}
                type="button"
                onClick={() => {
                  if (!active) router.push(`/projects/${encodeURIComponent(entry.name)}/sessions/new`);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-muted",
                  active && "bg-muted/70",
                )}
              >
                <FolderGit2Icon className="size-4 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{entry.name}</span>
                {active && <CheckIcon className="size-4 text-primary" />}
              </button>
            );
          })}
        </div>

        <div className="my-2 h-px bg-border/70" />
        <div className="px-2 pb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Environment
        </div>
        <div className="rounded-xl bg-muted/35 p-1">
          <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
            <LaptopIcon className="size-4 text-muted-foreground" />
            <span className="text-sm">{activeWorktree?.basename ?? "Local"}</span>
            <span className="ml-auto text-xs text-muted-foreground">
              {git?.worktrees.length ?? 0} worktree{git?.worktrees.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
            <GitBranchIcon className="size-4 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono text-sm">{branch}</span>
            {git && (git.header.ahead > 0 || git.header.behind > 0) && (
              <span className="text-xs text-muted-foreground">
                ↑{git.header.ahead} ↓{git.header.behind}
              </span>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={() => openRightPanelGit(rightPanelScopeKey)}
          className="mt-2 flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-sm transition-colors hover:bg-muted"
        >
          <GitCommitHorizontalIcon className="size-4 text-muted-foreground" />
          Changes, worktrees, and branches
          <span className="ml-auto text-xs text-muted-foreground">Open Git</span>
        </button>
      </PopoverContent>
    </Popover>
    </div>
  );
}
