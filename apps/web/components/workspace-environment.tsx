"use client";

import { useEffect, useState } from "react";
import { ChevronDownIcon, FolderGitIcon, GitBranchIcon, GitBranchPlusIcon } from "lucide-react";
import type { GitOverview, GitRefEntry } from "@telar/engine-client";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * WHERE THIS LANDS — what is left of the pinned environment.
 *
 * The composer's foot used to carry three controls permanently: the project's
 * name, the worktree/local mode, and the branch. Two of the three were facts the
 * cockpit header and the Changes panel already state, and the third — the base
 * ref — is only ever a CHOICE for about ten seconds, between opening a fresh
 * canvas and sending the first message. After that the worktree is cut and the
 * strip was restating a decision nobody could change. The foot is the notebook
 * now (`project-notes-strip.tsx`); this is the ten seconds.
 *
 * SO: ONE POPOVER, ON A FRESH CANVAS ONLY. It holds the two create-time choices
 * a session cannot be created without — the workspace mode and the base ref —
 * and its trigger names the project, which is the other thing a person wants to
 * confirm before their first sentence. Nothing here is rendered once the session
 * exists.
 *
 * NOT A FETCHER. The strip already polls `projectGit` for the uncommitted count,
 * so the refs arrive as a prop rather than as a second request on the same
 * endpoint at the same interval.
 */

/** `origin/feature-x` → `feature-x`, for the local-shadow dedupe below. */
function shortName(ref: GitRefEntry): string {
  return ref.kind === "remote" ? ref.name.replace(/^[^/]+\//, "") : ref.name;
}

/**
 * The base-ref picker — unchanged from the strip it used to live in.
 *
 * WHAT PICKING MEANS: the new worktree is cut FROM the chosen ref. Local and
 * remote branches are both offered because a remote-tracking ref is a perfectly
 * good base — reviewing a colleague's `origin/feature-x` in its own worktree is
 * the whole use — and the engine resolves the name to a sha at creation, so
 * staleness is bounded by the last fetch. "New branch" names the branch the
 * worktree will be ON (the engine refuses, never resets, a collision); without a
 * name the engine derives one under `telar/`.
 */
function BaseRefPicker({
  refs,
  defaultBase,
  currentBranch,
  pending,
  onBase,
}: {
  refs: GitRefEntry[];
  /** The remote's default branch (`origin/main`) — pinned to the top. */
  defaultBase?: string;
  currentBranch?: string;
  pending: { baseRef?: string; branchName?: string };
  onBase: (next: { baseRef?: string; branchName?: string }) => void;
}) {
  const [query, setQuery] = useState("");
  const [name, setName] = useState(pending.branchName ?? "");

  const trimmed = query.trim().toLowerCase();
  const filtered = trimmed ? refs.filter((ref) => ref.name.toLowerCase().includes(trimmed)) : refs;
  /**
   * WHY THE BROWSE LIST IS SMALLER THAN THE REPOSITORY. Unfiltered, every
   * `origin/x` whose local `x` also exists is noise doubling the list — main and
   * origin/main are the same choice to a person picking a base — so remote refs
   * shadowed by a same-named local are folded away, and the two pinned rows
   * (default base, current branch) are not repeated below. SEARCHING SUSPENDS
   * ALL OF IT: a typed query means "show me everything that matches", including
   * the shadowed remote that may be ahead.
   */
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

  /** The donor's row anatomy: mono name, one tiny muted badge at most. */
  const row = (refName: string, badge?: string) => (
    <button
      key={refName}
      type="button"
      onClick={() => pick(refName)}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm transition-colors hover:bg-accent/60",
        pending.baseRef === refName && "bg-accent",
      )}
    >
      <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{refName}</span>
      {badge && <span className="shrink-0 text-[0.625rem] text-muted-foreground/60">{badge}</span>}
    </button>
  );

  return (
    <div>
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          // Enter takes the first visible match — typing three letters and
          // hitting Enter is the whole gesture on a hundred-branch repo.
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
            {/* THE THREE ANSWERS MOST PICKS WANT, pinned above the pile: the
                checkout as it stands, the remote's default, and the branch you
                are on. AN EXPLICIT HEAD IS SENT AS `HEAD` — not an empty
                pending, which means "nobody chose yet" and gets filled with the
                default base by the foot. */}
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
            {defaultBase && row(defaultBase, "default")}
            {currentBranch && currentBranch !== defaultBase && row(currentBranch, "current")}
          </>
        )}
        {locals.length > 0 && <p className="px-2 pt-1.5 pb-0.5 text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground">Local</p>}
        {locals.map((ref) => row(ref.name, ref.head ? "current" : undefined))}
        {remotes.length > 0 && <p className="px-2 pt-1.5 pb-0.5 text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground">Origin</p>}
        {remotes.map((ref) => row(ref.name, "remote"))}
        {filtered.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">No matching refs.</p>}
        {hiddenCount > 0 && <p className="px-2 py-1.5 text-[0.625rem] text-muted-foreground">{hiddenCount} more — search to find them.</p>}
      </div>
      {/* The new-branch name rides WITH whichever base is chosen; empty means
          the engine derives a telar/ name as before. */}
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

/** One control in the strip: xs, ghost, its label hidden when the composer is
 *  narrow (a CONTAINER query — the foot must not consult the viewport). */
const CONTROL = "flex h-6 min-w-0 items-center gap-1 rounded-md px-1.5 transition-colors hover:bg-muted/60 hover:text-foreground";

export function WhereThisLands({
  projectId,
  projectName,
  git,
  envMode,
  onEnvMode,
  pendingBase,
  onBase,
}: {
  projectId: string;
  projectName?: string;
  /** Polled by the strip; absent until the first answer arrives. */
  git?: GitOverview;
  /**
   * The one create-time choice with nowhere else to live: a worktree is cut when
   * the session is created and cannot be changed afterwards, so it belongs to
   * the surface that already answers "where does this land" rather than to a
   * form standing between a person and their first sentence.
   */
  envMode?: "local" | "worktree";
  onEnvMode: (mode: "local" | "worktree") => void;
  /**
   * What the worktree is cut from (`baseRef`, any name in `GitOverview.refs`)
   * and optionally the human's own name for the new branch. Picking either
   * implies a worktree — the cockpit flips the mode, because a base for the
   * SHARED checkout would mean switching its branch, which the engine's
   * read-only git refuses.
   */
  pendingBase?: { baseRef?: string; branchName?: string };
  onBase?: (next: { baseRef?: string; branchName?: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const willBeWorktree = envMode === "worktree";

  /**
   * A FRESH WORKTREE DEFAULTS TO THE REMOTE'S DEFAULT BRANCH. The moment
   * worktree mode is on with nothing picked, the pending base becomes
   * `origin/main` (or whatever the remote calls it) — set through `onBase` so it
   * is VISIBLE here and changeable in the picker, not applied silently at
   * create. Explicit choices survive because "Current HEAD" is sent as `HEAD`:
   * an empty pending only ever means "nobody has chosen yet". Deferred a task
   * because a setState from an effect body is a cascading render.
   */
  const wantsDefaultBase = willBeWorktree && !pendingBase?.baseRef && !pendingBase?.branchName;
  const defaultBase = git?.defaultBase;
  useEffect(() => {
    if (!wantsDefaultBase || !defaultBase || !onBase) return;
    const task = window.setTimeout(() => onBase({ baseRef: defaultBase }), 0);
    return () => window.clearTimeout(task);
  }, [wantsDefaultBase, defaultBase, onBase]);

  /**
   * THE TRIGGER SAYS THE ANSWER, NOT THE QUESTION. "Own worktree · from
   * origin/main" is the sentence a person is checking before they press Enter,
   * and a button labelled "Workspace" would make them open it to find out.
   */
  const base = pendingBase?.branchName
    ? pendingBase.branchName
    : pendingBase?.baseRef && pendingBase.baseRef !== "HEAD"
      ? pendingBase.baseRef
      : (git?.branch ?? "HEAD");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<button type="button" aria-label="Where this lands" title="Where the first message creates this session" className={CONTROL} />}
      >
        {willBeWorktree ? <GitBranchIcon className="size-3.5 shrink-0" /> : <FolderGitIcon className="size-3.5 shrink-0" />}
        <span className="min-w-0 truncate font-medium text-foreground">{projectName ?? projectId}</span>
        <span className="hidden min-w-0 truncate font-mono text-muted-foreground @xl/composer:inline">
          {willBeWorktree ? base : "checkout"}
        </span>
        <ChevronDownIcon className="size-3 shrink-0" />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-72 gap-0 rounded-xl p-1.5">
        {/* TWO LABELS, NOTHING ELSE. This menu carried a header, a description
            per row and a footer paragraph — a form's worth of prose for a
            two-way choice whose labels already say everything. */}
        {(["local", "worktree"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => onEnvMode(mode)}
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
        {/* THE BASE REF, ONLY WHEN IT MEANS ANYTHING. A base for the project's
            own checkout would be switching its branch, which the engine's
            read-only git refuses — so the picker appears with the worktree
            rather than sitting there greyed. */}
        {willBeWorktree && onBase && (
          <div className="mt-1.5 border-t border-border/60 pt-1.5">
            <BaseRefPicker
              refs={git?.refs ?? []}
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
