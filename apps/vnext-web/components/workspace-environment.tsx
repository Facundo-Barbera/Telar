"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronsUpDownIcon, FolderGit2Icon, GitBranchIcon, GitCommitHorizontalIcon, LaptopIcon } from "lucide-react";
import type { GitOverview, Session } from "@telar/engine-client";
import { createVNextApi } from "@/lib/vnext/client";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const api = createVNextApi();

/**
 * THE PINNED ENVIRONMENT — the composer's bottom lip.
 *
 * It answers one question, at the moment a person is about to press Enter:
 * WHERE DOES THIS LAND? Which project, which branch, and how much is already
 * uncommitted there. That is safety information, not decoration, which is why it
 * is attached to the composer rather than filed in a panel someone might not
 * have open.
 *
 * FUSED, NOT STACKED. `-mt-px` pulls it up so its top border lands exactly on
 * the composer's bottom border, `border-t-0` removes the doubled hairline, and
 * only the bottom corners are rounded — so it reads as the same object's foot
 * rather than as a second card that happens to sit below. `mx-3` insets it, so
 * the composer overhangs it slightly and the two read as one stacked form.
 *
 * REFRESHED ON A TIMER, because the working tree changes underneath this process
 * constantly — the agent writing files, a human on the same checkout, a rebase
 * in another terminal. Fifteen seconds is slow enough to be free and fast enough
 * that the number is not a lie by the time it is read.
 */
const REFRESH_MS = 15_000;

export function WorkspaceEnvironment({
  projectId,
  projectName,
  session,
  onOpenChanges,
}: {
  projectId: string;
  projectName?: string;
  /** A worktree session works on its OWN branch, not the project's current one
   *  — so its checkout is the honest thing to name, and the repository's HEAD
   *  would be actively misleading. */
  session?: Session;
  onOpenChanges?: () => void;
}) {
  const [git, setGit] = useState<GitOverview>();
  const [reachable, setReachable] = useState(true);

  const load = useCallback(async () => {
    try {
      const result = await api.projectGit(projectId);
      setGit(result.git);
      setReachable(true);
    } catch {
      setReachable(false);
    }
  }, [projectId]);

  useEffect(() => {
    // Deferred to a task rather than called in the effect body: a synchronous
    // fetch-and-setState on mount is a cascading render, and the rule that
    // catches it is the same one that caught the theme provider. The interval
    // that follows is an ordinary subscription.
    const first = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [load]);

  const worktreeBranch = session?.workspace.mode === "worktree" ? session.workspace.branch : undefined;
  const branch = worktreeBranch ?? git?.branch;
  const dirty = git?.dirtyFiles ?? 0;

  return (
    <div className="mx-3 -mt-px">
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label="Where this session's work lands"
              className="group flex min-h-8 w-full items-center gap-1.5 rounded-b-xl border border-t-0 border-border/60 bg-muted/25 px-2.5 text-left text-[11px] text-muted-foreground shadow-[0_8px_24px_-20px_rgba(0,0,0,.8)] transition-colors hover:bg-muted/45 hover:text-foreground"
            />
          }
        >
          <FolderGit2Icon className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate font-medium text-foreground">{projectName ?? projectId}</span>
          {branch && (
            <>
              <span className="text-border">/</span>
              <GitBranchIcon className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate font-mono">{branch}</span>
            </>
          )}
          {/* --warning, the app's "a person has to move" colour: uncommitted
              work is not a failure, it is something you may want to deal with. */}
          {dirty > 0 && (
            <span className="ml-auto shrink-0 rounded-full bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning">{dirty} changed</span>
          )}
          <ChevronsUpDownIcon className={cn("size-3.5 shrink-0", dirty === 0 && "ml-auto")} />
        </PopoverTrigger>

        <PopoverContent side="top" align="start" sideOffset={8} className="w-[min(27rem,calc(100vw-2rem))] gap-0 rounded-2xl p-2">
          <p className="px-2 pb-1 pt-1 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Environment</p>

          <div className="rounded-xl bg-muted/35 p-1">
            <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
              <LaptopIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm">
                {worktreeBranch ? "Own worktree" : "Project checkout"}
              </span>
              {git?.repository && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {git.worktrees.length} worktree{git.worktrees.length === 1 ? "" : "s"}
                </span>
              )}
            </div>
            {branch && (
              <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
                <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-sm">{branch}</span>
                {/* Absent ahead/behind means NO UPSTREAM, which is not zero —
                    so nothing is drawn rather than a reassuring "↑0 ↓0". */}
                {git && (git.ahead !== undefined || git.behind !== undefined) && (
                  <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                    ↑{git.ahead ?? 0} ↓{git.behind ?? 0}
                  </span>
                )}
              </div>
            )}
          </div>

          <p className="px-2 pt-2 text-[11px] text-muted-foreground">
            {!reachable
              ? "The engine did not answer, so this may be out of date."
              : git && !git.repository
                ? "This project is not a git repository. Sessions still run; there is simply no branch to report."
                : worktreeBranch
                  ? "This session has a checkout of its own, so its work cannot collide with another session on this project."
                  : "This session shares the project checkout with anything else running on it."}
          </p>

          {/* The donor's footer, pointing at the same place: the surface that
              lists what this session actually wrote. It opens the panel rather
              than a git pane, because the engine's git read is read-only and
              the file changes are what there is to look at. */}
          {onOpenChanges && (
            <button
              type="button"
              onClick={onOpenChanges}
              className="mt-2 flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-sm transition-colors hover:bg-muted"
            >
              <GitCommitHorizontalIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">Files this session changed</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">Open panel</span>
            </button>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
