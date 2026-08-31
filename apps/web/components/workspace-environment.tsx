"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDownIcon, FolderGit2Icon, FolderGitIcon, GitBranchIcon, GitBranchPlusIcon, GitCommitHorizontalIcon } from "lucide-react";
import type { GitOverview, GitRefEntry, Session } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const api = createEngineApi();

/**
 * THE PINNED ENVIRONMENT — the composer's bottom lip.
 *
 * It answers one question, at the moment a person is about to press Enter:
 * WHERE DOES THIS LAND? Which project, which checkout, which branch, and how
 * much is already uncommitted there. That is safety information, not
 * decoration, which is why it is attached to the composer rather than filed in
 * a panel someone might not have open.
 *
 * SEPARATE CONTROLS, NOT ONE DOOR. This used to be a single strip-wide button
 * opening one popover holding everything. But the strip carries three
 * different KINDS of fact — identity (the project), a create-time choice (the
 * workspace mode), and live git state (the branch) — and one door meant the
 * gesture "change where this lands" and the gesture "check the branch" were
 * the same click into the same pile. Now each concern is its own small
 * control with a hairline between them, the shape the reference cockpit uses.
 * The machine/"run on" selector that cockpit also carries is deliberately
 * absent: Telar has no remote environments to choose between.
 *
 * FUSED, NOT STACKED. `-mt-px` pulls the strip up so its top border lands
 * exactly on the composer's bottom border, `border-t-0` removes the doubled
 * hairline, and only the bottom corners are rounded — so it reads as the same
 * object's foot rather than as a second card that happens to sit below.
 *
 * REFRESHED ON A TIMER, because the working tree changes underneath this
 * process constantly. Fifteen seconds is slow enough to be free and fast
 * enough that the number is not a lie by the time it is read.
 */
const REFRESH_MS = 15_000;

/** One control in the strip: xs, ghost, its label hidden when the composer is
 *  narrow (a CONTAINER query — the strip must not consult the viewport). */
const CONTROL = "flex h-6 min-w-0 items-center gap-1 rounded-md px-1.5 transition-colors hover:bg-muted/60 hover:text-foreground";

function StripRule() {
  return <span aria-hidden className="h-3.5 w-px shrink-0 bg-border/60" />;
}

/**
 * The base-ref picker — the branch control's interactive form, while the
 * session does not exist yet.
 *
 * WHAT PICKING MEANS: the new worktree is cut FROM the chosen ref. Local and
 * remote branches are both offered because a remote-tracking ref is a
 * perfectly good base — reviewing a colleague's `origin/feature-x` in its own
 * worktree is the whole use — and the engine resolves the name to a sha at
 * creation, so staleness is bounded by the last fetch. "New branch" names the
 * branch the worktree will be ON (the engine refuses, never resets, a
 * collision); without a name the engine derives one under `telar/`.
 */
function BaseRefPicker({
  refs,
  currentBranch,
  pending,
  onBase,
}: {
  refs: GitRefEntry[];
  currentBranch?: string;
  pending: { baseRef?: string; branchName?: string };
  onBase: (next: { baseRef?: string; branchName?: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [name, setName] = useState(pending.branchName ?? "");

  const filtered = query.trim() ? refs.filter((ref) => ref.name.toLowerCase().includes(query.trim().toLowerCase())) : refs;
  const locals = filtered.filter((ref) => ref.kind === "local").slice(0, 25);
  const remotes = filtered.filter((ref) => ref.kind === "remote").slice(0, 25);

  // `HEAD` is the EXPLICIT "current checkout" choice (see the row below), so
  // it reads as the branch it means, not as a literal "from HEAD".
  const label = pending.branchName
    ? pending.branchName
    : pending.baseRef && pending.baseRef !== "HEAD"
      ? `from ${pending.baseRef}`
      : (currentBranch ?? "no branch");

  const pick = (baseRef?: string) => {
    onBase({ ...(baseRef ? { baseRef } : {}), ...(name.trim() ? { branchName: name.trim() } : {}) });
    setOpen(false);
  };

  const row = (ref: GitRefEntry) => (
    <button
      key={ref.name}
      type="button"
      onClick={() => pick(ref.name)}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm transition-colors hover:bg-accent/60",
        pending.baseRef === ref.name && "bg-accent",
      )}
    >
      <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{ref.name}</span>
      {ref.head && <span className="shrink-0 text-[10px] text-muted-foreground">current</span>}
    </button>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<button type="button" aria-label="Branch" title="What the worktree starts from" className={CONTROL} />}>
        {pending.branchName ? <GitBranchPlusIcon className="size-3.5 shrink-0" /> : <GitBranchIcon className="size-3.5 shrink-0" />}
        <span className="min-w-0 truncate font-mono">{label}</span>
        <ChevronDownIcon className="size-3 shrink-0" />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-72 gap-0 rounded-xl p-1.5">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search refs…"
          className="mb-1 w-full rounded-md border border-border/60 bg-transparent px-2 py-1 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
        />
        <div className="max-h-64 overflow-y-auto">
          {/* AN EXPLICIT CHOICE, SENT AS `HEAD` — not an empty pending. Empty
              means "nobody chose yet", which the foot fills with the remote's
              default branch; this row must be able to override that. */}
          <button
            type="button"
            onClick={() => pick("HEAD")}
            className={cn(
              "flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm transition-colors hover:bg-accent/60",
              (!pending.baseRef || pending.baseRef === "HEAD") && "bg-accent",
            )}
          >
            <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-xs">Current HEAD</span>
          </button>
          {locals.length > 0 && <p className="px-2 pt-1.5 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Local</p>}
          {locals.map(row)}
          {remotes.length > 0 && <p className="px-2 pt-1.5 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Origin</p>}
          {remotes.map(row)}
          {filtered.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">No matching refs.</p>}
        </div>
        {/* The new-branch name rides WITH whichever base is chosen; empty
            means the engine derives a telar/ name as before. */}
        <div className="mt-1 flex items-center gap-1.5 border-t border-border/60 pt-1.5">
          <GitBranchPlusIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onBase({ ...(pending.baseRef ? { baseRef: pending.baseRef } : {}), ...(name.trim() ? { branchName: name.trim() } : {}) });
                setOpen(false);
              }
            }}
            placeholder="New branch name (optional)"
            className="w-full rounded-md border border-border/60 bg-transparent px-2 py-1 font-mono text-xs outline-none placeholder:font-sans placeholder:text-muted-foreground focus:border-ring"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function WorkspaceEnvironment({
  projectId,
  projectName,
  session,
  envMode,
  onEnvMode,
  pendingBase,
  onBase,
  onOpenChanges,
}: {
  projectId: string;
  projectName?: string;
  /** A worktree session works on its OWN branch, not the project's current one
   *  — so its checkout is the honest thing to name, and the repository's HEAD
   *  would be actively misleading. */
  session?: Session;
  /**
   * WHERE THE FIRST MESSAGE WILL LAND, while there is no session yet.
   *
   * This is the one create-time choice with nowhere else to live: a worktree is
   * cut when the session is created and cannot be changed afterwards, so it
   * belongs to the surface that already answers "where does this land" rather
   * than to a form standing between a person and their first sentence.
   */
  envMode?: "local" | "worktree";
  onEnvMode?: (mode: "local" | "worktree") => void;
  /**
   * The base-ref choice, while there is no session yet: what the worktree is
   * cut from (`baseRef`, any name in `GitOverview.refs`) and optionally the
   * human's own name for the new branch. Picking either implies a worktree —
   * the cockpit flips the mode, because a base for the SHARED checkout would
   * mean switching its branch, which the engine's read-only git refuses.
   */
  pendingBase?: { baseRef?: string; branchName?: string };
  onBase?: (next: { baseRef?: string; branchName?: string }) => void;
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
  /** Only while the session does not exist. Afterwards the worktree is a fact
   *  on disk, not a setting. */
  const choosing = Boolean(onEnvMode) && !session;

  /**
   * A FRESH WORKTREE DEFAULTS TO THE REMOTE'S DEFAULT BRANCH. The moment
   * worktree mode is on with nothing picked, the pending base becomes
   * `origin/main` (or whatever the remote calls it) — set through `onBase` so
   * it is VISIBLE in the foot and changeable in the picker, not applied
   * silently at create. Explicit choices survive because "Current HEAD" is
   * sent as `HEAD`: an empty pending only ever means "nobody has chosen yet".
   * Deferred a task for the same reason the loader above is.
   */
  const wantsDefaultBase = choosing && envMode === "worktree" && !pendingBase?.baseRef && !pendingBase?.branchName;
  const defaultBase = git?.defaultBase;
  useEffect(() => {
    if (!wantsDefaultBase || !defaultBase || !onBase) return;
    const task = window.setTimeout(() => onBase({ baseRef: defaultBase }), 0);
    return () => window.clearTimeout(task);
  }, [wantsDefaultBase, defaultBase, onBase]);
  const willBeWorktree = envMode === "worktree";
  const isWorktree = choosing ? willBeWorktree : Boolean(worktreeBranch);
  const modeLabel = isWorktree ? "Own worktree" : "Project checkout";

  const modeBody = (
    <>
      {/* Git-flavoured on BOTH arms: a checkout is a git fact, and a laptop
          said "machine" — the one concept this strip deliberately dropped. */}
      {isWorktree ? <GitBranchIcon className="size-3.5 shrink-0" /> : <FolderGitIcon className="size-3.5 shrink-0" />}
      <span className="hidden truncate @xl/composer:inline">{modeLabel}</span>
    </>
  );

  return (
    <div className="mx-3 -mt-px">
      <div className="flex min-h-8 w-full items-center gap-1 rounded-b-xl border border-t-0 border-border/60 bg-muted/25 px-2 text-[11px] text-muted-foreground shadow-[0_8px_24px_-20px_rgba(0,0,0,.8)]">
        {/* IDENTITY, not a control: the project is a fact of this canvas, and
            a button that could not do anything would be a lie of affordance. */}
        <span className="flex min-w-0 shrink-0 items-center gap-1.5 px-1 font-medium text-foreground">
          <FolderGit2Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="max-w-40 truncate">{projectName ?? projectId}</span>
        </span>

        <StripRule />

        {/* THE WORKSPACE MODE. A menu while the choice is still open; a static
            label once the session exists, because the worktree is cut once. */}
        {choosing ? (
          <Popover>
            <PopoverTrigger
              render={<button type="button" aria-label="Workspace" title="Where the first message creates this session" className={CONTROL} />}
            >
              {modeBody}
              <ChevronDownIcon className="size-3 shrink-0" />
            </PopoverTrigger>
            {/* TWO LABELS, NOTHING ELSE. This menu carried a header, a
                description per row and a footer paragraph — a form's worth of
                prose for a two-way choice whose labels already say everything.
                The names are the menu. */}
            <PopoverContent side="top" align="start" sideOffset={8} className="w-52 gap-0 rounded-xl p-1">
              {(["local", "worktree"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => onEnvMode?.(mode)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors",
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
            </PopoverContent>
          </Popover>
        ) : (
          <span className={cn(CONTROL, "hover:bg-transparent hover:text-muted-foreground")} title={modeLabel}>
            {modeBody}
          </span>
        )}

        <StripRule />

        {/* THE BRANCH. Interactive while the session does not exist — the
            base-ref picker — and a read-only readout with the detail one
            click deep once it does. */}
        {choosing && onBase ? (
          <BaseRefPicker
            refs={git?.refs ?? []}
            {...(git?.branch ? { currentBranch: git.branch } : {})}
            pending={pendingBase ?? {}}
            onBase={onBase}
          />
        ) : (
        <Popover>
          <PopoverTrigger render={<button type="button" aria-label="Branch" title="Where this session's work lands" className={CONTROL} />}>
            <GitBranchIcon className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate font-mono">{branch ?? "no branch"}</span>
            <ChevronDownIcon className="size-3 shrink-0" />
          </PopoverTrigger>
          <PopoverContent side="top" align="start" sideOffset={8} className="w-[min(24rem,calc(100vw-2rem))] gap-0 rounded-2xl p-2">
            <p className="px-2 pb-1 pt-1 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Branch</p>
            <div className="rounded-xl bg-muted/35 p-1">
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
              {git?.repository && (
                <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
                  <FolderGitIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm">{modeLabel}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {git.worktrees.length} worktree{git.worktrees.length === 1 ? "" : "s"}
                  </span>
                </div>
              )}
            </div>
            {/* Prose only when something is WRONG. The ordinary cases were a
                paragraph restating what the rows above already show. */}
            {(!reachable || (git && !git.repository)) && (
              <p className="px-2 pt-2 text-[11px] text-muted-foreground">
                {!reachable ? "The engine did not answer — this may be out of date." : "Not a git repository."}
              </p>
            )}
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
        )}

        {/* --warning, the app's "a person has to move" colour: uncommitted
            work is not a failure, it is something you may want to deal with. */}
        {dirty > 0 && (
          <span className="ml-auto shrink-0 rounded-full bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning">{dirty} changed</span>
        )}
      </div>
    </div>
  );
}
