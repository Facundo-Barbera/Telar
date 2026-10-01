"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ChevronDownIcon,
  FolderGit2Icon,
  FolderGitIcon,
  GitBranchIcon,
  HardDriveIcon,
  GitBranchPlusIcon,
  GitCommitHorizontalIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { GitOverview, GitReadFailure, GitRefEntry, ProjectAvailability, Session } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { cn } from "@/ui/utils";
import { usePoll } from "@/ui/hooks/use-poll";

const api = createEngineApi();

function shortName(ref: GitRefEntry): string {
  return ref.kind === "remote" ? ref.name.replace(/^[^/]+\//, "") : ref.name;
}

export function BaseRefPicker({
  refs,
  incomplete,
  onRetry,
  defaultBase,
  currentBranch,
  pending,
  onBase,
}: {
  refs: GitRefEntry[];
  incomplete?: GitReadFailure;
  onRetry?: () => void | Promise<void>;
  defaultBase?: string;
  currentBranch?: string;
  pending: { baseRef?: string; branchName?: string };
  onBase: (next: { baseRef?: string; branchName?: string }) => void;
}) {
  const [query, setQuery] = useState("");
  const [name, setName] = useState(pending.branchName ?? "");
  const [retrying, setRetrying] = useState(false);

  const trimmed = query.trim().toLowerCase();
  const filtered = trimmed ? refs.filter((ref) => ref.name.toLowerCase().includes(trimmed)) : refs;
  const pinned = new Set([defaultBase, currentBranch].filter(Boolean) as string[]);
  const localNames = new Set(refs.filter((ref) => ref.kind === "local").map((ref) => ref.name));
  const browsing = !trimmed;
  const visible = browsing
    ? filtered.filter((ref) => !pinned.has(ref.name) && !(ref.kind === "remote" && localNames.has(shortName(ref))))
    : filtered;
  const locals = visible.filter((ref) => ref.kind === "local").slice(0, 25);
  const remotes = visible.filter((ref) => ref.kind === "remote").slice(0, 25);
  const hiddenCount = browsing ? refs.length - pinned.size - locals.length - remotes.length : 0;

  const pick = (baseRef?: string) => {
    onBase({ ...(baseRef ? { baseRef } : {}), ...(name.trim() ? { branchName: name.trim() } : {}) });
  };

  const retry = async () => {
    if (!onRetry || retrying) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };

  const row = (refName: string, badge?: string) => (
    <button
      key={refName}
      type="button"
      onClick={() => pick(refName)}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm transition-colors outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring",
        pending.baseRef === refName && "bg-accent",
      )}
    >
      <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{refName}</span>
      {badge && <span className="shrink-0 text-3xs text-muted-foreground/60">{badge}</span>}
    </button>
  );

  return (
    <div>
      {incomplete && (
        <div className="mb-1 rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5">
          <p className="flex items-start gap-1.5 text-2xs text-warning">
            <TriangleAlertIcon className="mt-px size-3 shrink-0" />
            <span>
              {incomplete === "timeout"
                ? "git did not answer in time, so this list is missing branches — it is not the whole repository."
                : "git could not list this repository's branches, so this list is incomplete."}
            </span>
          </p>
          {onRetry && (
            <button
              type="button"
              onClick={() => void retry()}
              disabled={retrying}
              className="mt-1 flex items-center gap-1 rounded-md px-1 py-0.5 text-2xs font-medium text-warning transition-colors outline-none hover:bg-warning/15 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              <RefreshCwIcon className={cn("size-3 shrink-0", retrying && "animate-spin")} />
              {retrying ? "Asking git again…" : "Ask git again"}
            </button>
          )}
        </div>
      )}
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && trimmed) {
            event.preventDefault();
            const first = locals[0] ?? remotes[0];
            if (first) pick(first.name);
          }
        }}
        placeholder="Search branches…"
        className="mb-1 w-full rounded-md border border-border/60 bg-transparent px-2 py-1 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
      />
      <div className="max-h-56 overflow-y-auto">
        {browsing && (
          <>
            <button
              type="button"
              onClick={() => pick("HEAD")}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm transition-colors outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring",
                (!pending.baseRef || pending.baseRef === "HEAD") && "bg-accent",
              )}
            >
              <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-xs">Current HEAD</span>
            </button>
            {defaultBase && row(defaultBase, "default")}
            {currentBranch && currentBranch !== defaultBase && row(currentBranch, "current")}
          </>
        )}
        {locals.length > 0 && <p className="px-2 pt-1.5 pb-0.5 text-3xs font-medium uppercase tracking-wide text-muted-foreground">Local</p>}
        {locals.map((ref) => row(ref.name, ref.head ? "current" : undefined))}
        {remotes.length > 0 && <p className="px-2 pt-1.5 pb-0.5 text-3xs font-medium uppercase tracking-wide text-muted-foreground">Origin</p>}
        {remotes.map((ref) => row(ref.name, "remote"))}
        {filtered.length === 0 && (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            {trimmed ? "No matching refs." : incomplete ? "No branches were listed." : "This repository has no branches yet."}
          </p>
        )}
        {hiddenCount > 0 && <p className="px-2 py-1.5 text-3xs text-muted-foreground">{hiddenCount} more — search to find them.</p>}
      </div>
      <div className="mt-1 flex items-center gap-1.5 border-t border-border/60 pt-1.5">
        <GitBranchPlusIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onBase({ ...(pending.baseRef ? { baseRef: pending.baseRef } : {}), ...(name.trim() ? { branchName: name.trim() } : {}) });
            }
          }}
          placeholder="New branch name (optional)"
          className="w-full rounded-md border border-border/60 bg-transparent px-2 py-1 font-mono text-xs outline-none placeholder:font-sans placeholder:text-muted-foreground focus:border-ring"
        />
      </div>
    </div>
  );
}

const CONTROL = "flex h-6 min-w-0 items-center gap-1 rounded-md px-1.5 transition-colors outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

const REFRESH_MS = 15_000;

function StripRule() {
  return <span aria-hidden className="h-3.5 w-px shrink-0 bg-border/60" />;
}

function WhereThisLands({
  projectName,
  git,
  onRetry,
  envMode,
  onEnvMode,
  pendingBase,
  onBase,
}: {
  projectName?: string;
  git?: GitOverview;
  onRetry?: () => void | Promise<void>;
  envMode?: "local" | "worktree";
  onEnvMode: (mode: "local" | "worktree") => void;
  pendingBase?: { baseRef?: string; branchName?: string };
  onBase?: (next: { baseRef?: string; branchName?: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const willBeWorktree = envMode === "worktree";

  const wantsDefaultBase = willBeWorktree && !pendingBase?.baseRef && !pendingBase?.branchName;
  const defaultBase = git?.defaultBase;
  useEffect(() => {
    if (!wantsDefaultBase || !defaultBase || !onBase) return;
    const task = window.setTimeout(() => onBase({ baseRef: defaultBase }), 0);
    return () => window.clearTimeout(task);
  }, [wantsDefaultBase, defaultBase, onBase]);

  const base = pendingBase?.branchName
    ? pendingBase.branchName
    : pendingBase?.baseRef && pendingBase.baseRef !== "HEAD"
      ? pendingBase.baseRef
      : (git?.branch ?? "HEAD");

  const incompleteRefs = willBeWorktree && git?.refsIncomplete !== undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Where this lands"
            title={
              incompleteRefs
                ? "Some branches could not be listed — open this before choosing a base"
                : "Where the first message creates this session"
            }
            className={CONTROL}
          />
        }
      >
        {willBeWorktree ? <GitBranchIcon className="size-3.5 shrink-0" /> : <FolderGitIcon className="size-3.5 shrink-0" />}
        <span className="min-w-0 truncate font-medium text-foreground">{projectName ?? "Project"}</span>
        <span className="hidden min-w-0 truncate font-mono text-muted-foreground @xl/composer:inline">
          {willBeWorktree ? base : "checkout"}
        </span>
        {incompleteRefs && <TriangleAlertIcon aria-hidden className="size-3 shrink-0 text-warning" />}
        <ChevronDownIcon className="size-3 shrink-0" />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-72 gap-0 rounded-xl p-1.5">
        {(["local", "worktree"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => onEnvMode(mode)}
            className={cn(
              "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              (mode === "worktree") === willBeWorktree ? "bg-accent" : "hover:bg-accent/60",
            )}
          >
            {mode === "worktree" ? (
              <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <FolderGitIcon className="size-4 shrink-0 text-muted-foreground" />
            )}
            {mode === "worktree" ? "Own worktree" : "Project checkout"}
          </button>
        ))}
        {willBeWorktree && onBase && (
          <div className="mt-1.5 border-t border-border/60 pt-1.5">
            <BaseRefPicker
              refs={git?.refs ?? []}
              {...(git?.refsIncomplete ? { incomplete: git.refsIncomplete } : {})}
              {...(onRetry ? { onRetry } : {})}
              {...(git?.defaultBase ? { defaultBase: git.defaultBase } : {})}
              {...(git?.branch ? { currentBranch: git.branch } : {})}
              pending={pendingBase ?? {}}
              onBase={onBase}
            />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function AwayNotice({ away, projectName }: { away: Exclude<ProjectAvailability, "available">; projectName?: string | undefined }) {
  return (
    <p className="flex items-start gap-2 border-b border-border/40 px-3 py-2 text-2xs text-muted-foreground">
      <HardDriveIcon className="mt-px size-3.5 shrink-0" />
      <span>
        {away === "unmounted" ? (
          `The drive holding ${projectName ?? "this project"} is not connected, so nothing can run here yet. Plug it back in — the conversation, its history and its settings are all still here.`
        ) : (
          <>
            The folder for <strong className="font-medium text-foreground">{projectName ?? "this project"}</strong> is not
            on this machine any more, so nothing can run here.
          </>
        )}
      </span>
    </p>
  );
}

function BranchPopover({
  git,
  branch,
  away,
  reachable,
  modeLabel,
  onOpenChanges,
}: {
  git?: GitOverview | undefined;
  branch?: string | undefined;
  away?: Exclude<ProjectAvailability, "available"> | undefined;
  reachable: boolean;
  modeLabel: string;
  onOpenChanges?: (() => void) | undefined;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={away ? "Drive" : "Branch"}
            title={away ? "This project's disk is not readable right now" : "Where this session's work lands"}
            className={CONTROL}
          />
        }
      >
        {away ? <HardDriveIcon className="size-3.5 shrink-0" /> : <GitBranchIcon className="size-3.5 shrink-0" />}
        <span className="min-w-0 truncate font-mono">
          {away === "unmounted" ? "drive away" : away === "missing" ? "folder gone" : (branch ?? "no branch")}
        </span>
        <ChevronDownIcon className="size-3 shrink-0" />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-[min(24rem,calc(100vw-2rem))] gap-0 rounded-2xl p-2">
        <p className="px-2 pb-1 pt-1 text-2xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Branch</p>
        <div className="rounded-xl bg-muted/35 p-1">
          {branch && (
            <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
              <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-sm">{branch}</span>
              {git && (git.ahead !== undefined || git.behind !== undefined) && (
                <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                  ↑{git.ahead ?? 0} ↓{git.behind ?? 0}
                </span>
              )}
            </div>
          )}
          {git?.repository && (
            <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
              <FolderGitIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm">{modeLabel}</span>
              {git.worktrees && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {git.worktrees.length} worktree{git.worktrees.length === 1 ? "" : "s"}
                </span>
              )}
            </div>
          )}
        </div>
        {(!reachable || away || (git && !git.repository)) && (
          <p className="px-2 pt-2 text-2xs text-muted-foreground">
            {!reachable
              ? "The engine did not answer — this may be out of date."
              : away === "unmounted"
                ? "The drive holding this project is not connected, so nothing above was read from it. Plug it back in and this comes back as it was — the project keeps its id, its conversations and its settings."
                : away === "missing"
                  ? "This project's folder is not on this machine any more, so nothing above was read from it."
                  : "Not a git repository."}
          </p>
        )}
        {onOpenChanges && (
          <button
            type="button"
            onClick={onOpenChanges}
            className="mt-2 flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-sm transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          >
            <GitCommitHorizontalIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">Files this session changed</span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">Open panel</span>
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function EnvironmentStrip({
  projectName,
  session,
  git,
  reachable = true,
  onRetry,
  envMode,
  onEnvMode,
  pendingBase,
  onBase,
  onOpenChanges,
}: {
  projectId: string;
  projectName?: string;
  session?: Session;
  git?: GitOverview;
  reachable?: boolean;
  onRetry?: () => void | Promise<void>;
  envMode?: "local" | "worktree";
  onEnvMode?: (mode: "local" | "worktree") => void;
  pendingBase?: { baseRef?: string; branchName?: string };
  onBase?: (next: { baseRef?: string; branchName?: string }) => void;
  onOpenChanges?: () => void;
}) {
  const away = git?.availability === "available" ? undefined : git?.availability;
  const worktreeBranch = session?.workspace.mode === "worktree" ? session.workspace.branch : undefined;
  const branch = worktreeBranch ?? git?.branch;
  const dirty = git?.dirtyFiles ?? 0;
  const choosing = Boolean(onEnvMode) && !session;
  const isWorktree = choosing ? envMode === "worktree" : Boolean(worktreeBranch);
  const modeLabel = isWorktree ? "Own worktree" : "Project checkout";

  return (
    <div className="mx-3 -mt-px">
      <div className="overflow-hidden rounded-b-2xl border border-t-0 border-border/80 bg-card/95 shadow-1 backdrop-blur-xl">
        {away && <AwayNotice away={away} projectName={projectName} />}
        <div className="flex min-h-8 w-full items-center gap-1 px-2 text-2xs text-muted-foreground">
        {choosing && onEnvMode ? (
          <WhereThisLands
            {...(projectName ? { projectName } : {})}
            {...(git ? { git } : {})}
            {...(onRetry ? { onRetry } : {})}
            {...(envMode ? { envMode } : {})}
            onEnvMode={onEnvMode}
            {...(pendingBase ? { pendingBase } : {})}
            {...(onBase ? { onBase } : {})}
          />
        ) : (
          <>
            <span className="flex min-w-0 shrink-0 items-center gap-1.5 px-1 font-medium text-foreground">
              <FolderGit2Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="max-w-40 truncate">{projectName ?? "Project"}</span>
            </span>

            <StripRule />

            <span className={cn(CONTROL, "hover:bg-transparent hover:text-muted-foreground")} title={modeLabel}>
              {isWorktree ? <GitBranchIcon className="size-3.5 shrink-0" /> : <FolderGitIcon className="size-3.5 shrink-0" />}
              <span className="hidden truncate @xl/composer:inline">{modeLabel}</span>
            </span>

            <StripRule />

            <BranchPopover git={git} branch={branch} away={away} reachable={reachable} modeLabel={modeLabel} onOpenChanges={onOpenChanges} />
          </>
        )}

        {dirty > 0 && (
          <span className="ml-auto shrink-0 rounded-full bg-warning/10 px-1.5 py-0.5 text-3xs font-medium text-warning">{dirty} changed</span>
        )}
        </div>
      </div>
    </div>
  );
}

export async function readWorkspaceGit(engine: typeof api, projectId: string, worktreeSessionId?: string): Promise<GitOverview> {
  const { git } = await engine.projectGit(projectId);
  if (!worktreeSessionId) return git;
  const rest = { ...git };
  delete rest.dirtyFiles;
  const own = await engine.sessionDirtyFiles(worktreeSessionId).catch(() => undefined);
  return own?.dirtyFiles === undefined ? rest : { ...rest, dirtyFiles: own.dirtyFiles };
}

export function WorkspaceEnvironment({
  onAvailability,
  ...props
}: Omit<Parameters<typeof EnvironmentStrip>[0], "git" | "reachable" | "onRetry"> & {
  onAvailability?: (availability: Exclude<ProjectAvailability, "available"> | undefined) => void;
}) {
  const { projectId, session } = props;
  const worktreeSessionId = session?.workspace.mode === "worktree" ? session.id : undefined;
  const [git, setGit] = useState<GitOverview>();
  const [reachable, setReachable] = useState(true);

  const load = useCallback(async () => {
    try {
      const next = await readWorkspaceGit(api, projectId, worktreeSessionId);
      setGit(next);
      setReachable(true);
      onAvailability?.(next.availability === "available" ? undefined : next.availability);
    } catch {
      setReachable(false);
    }
  }, [projectId, worktreeSessionId, onAvailability]);

  usePoll(load, REFRESH_MS, { key: load });

  return <EnvironmentStrip {...props} {...(git ? { git } : {})} reachable={reachable} onRetry={load} />;
}
