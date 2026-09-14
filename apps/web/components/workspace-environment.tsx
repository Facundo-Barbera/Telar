"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ChevronDownIcon,
  FolderGit2Icon,
  FolderGitIcon,
  GitBranchIcon,
  GitBranchPlusIcon,
  GitCommitHorizontalIcon,
} from "lucide-react";
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
 * much is already uncommitted there. That is safety information, not decoration,
 * which is why it is attached to the composer rather than filed in a panel
 * someone might not have open.
 *
 * SEPARATE CONTROLS, NOT ONE DOOR, once the session exists. The foot carries
 * three different KINDS of fact — identity (the project), a create-time choice
 * (the workspace mode), and live git state (the branch) — and one door meant the
 * gesture "change where this lands" and the gesture "check the branch" were the
 * same click into the same pile. Each concern is its own small control with a
 * hairline between them, the shape the reference cockpit uses. The
 * machine/"run on" selector that cockpit also carries is deliberately absent:
 * Telar has no remote environments to choose between.
 *
 * ONE DOOR ON A FRESH CANVAS, which is the one thing #258 got right and this
 * keeps: before the session exists all three facts are a single pending CHOICE,
 * so they belong in a single popover (`WhereThisLands`) rather than three
 * controls two of which cannot be pressed yet.
 *
 * FUSED, NOT STACKED. `-mt-px` pulls the strip up so its top border lands
 * exactly on the composer's bottom border, `border-t-0` removes the doubled
 * hairline, and only the bottom corners are rounded — so it reads as the same
 * object's foot rather than as a second card that happens to sit below.
 *
 * THE NOTEBOOK IS NOT HERE. It was, briefly (#258), and the user asked for it on
 * the pinned summary instead — `session/workspace-inspector.tsx`.
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

/** Fifteen seconds: slow enough to be free, fast enough that the uncommitted
 *  count is not a lie by the time it is read. */
const REFRESH_MS = 15_000;

function StripRule() {
  return <span aria-hidden className="h-3.5 w-px shrink-0 bg-border/60" />;
}

/**
 * THE FRESH CANVAS'S ONE DOOR: the workspace mode and the base ref, the two
 * create-time choices a session cannot be created without, behind a trigger that
 * names the project — which is the other thing a person wants to confirm before
 * their first sentence. Nothing here is rendered once the session exists.
 *
 * NOT A FETCHER. The strip around it already polls `projectGit` for the
 * uncommitted count, so the refs arrive as a prop rather than as a second
 * request on the same endpoint at the same interval.
 */
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

/**
 * THE STRIP ITSELF, with the git readout handed in rather than fetched.
 *
 * SPLIT OUT FOR THE SAME REASON `WhereThisLands` TAKES ITS GIT AS A PROP: this
 * is the half that decides what a reader sees, and a render test that has to
 * wait for a poll to answer is a render test that cannot assert the branch or
 * the count at all. The fetching half is `WorkspaceEnvironment` below.
 */
export function EnvironmentStrip({
  projectId,
  projectName,
  session,
  git,
  reachable = true,
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
  /** Absent until the engine has answered once. */
  git?: GitOverview;
  /** False once a read has failed, which is prose in the branch popover rather
   *  than a silently stale number. */
  reachable?: boolean;
  envMode?: "local" | "worktree";
  onEnvMode?: (mode: "local" | "worktree") => void;
  pendingBase?: { baseRef?: string; branchName?: string };
  onBase?: (next: { baseRef?: string; branchName?: string }) => void;
  onOpenChanges?: () => void;
}) {
  const worktreeBranch = session?.workspace.mode === "worktree" ? session.workspace.branch : undefined;
  const branch = worktreeBranch ?? git?.branch;
  const dirty = git?.dirtyFiles ?? 0;
  /** Only while the session does not exist. Afterwards the worktree is a fact
   *  on disk, not a setting. */
  const choosing = Boolean(onEnvMode) && !session;
  const isWorktree = choosing ? envMode === "worktree" : Boolean(worktreeBranch);
  const modeLabel = isWorktree ? "Own worktree" : "Project checkout";

  return (
    <div className="mx-3 -mt-px">
      {/* `shadow-1` — a RESTING surface (globals.css's elevation ladder). It
          hangs off the bottom of the composer, so it is attached to the page
          rather than floating over it, and it takes the rung below the bar it
          hangs from. Was a hand-written arbitrary value in --shadow-tint;
          right ink, private numbers.

          `bg-muted/25` lands at 25% of the theme's muted: the wash used to
          hand this element a token already at 72% alpha, which multiplied the
          strip down to 18% and dissolved it over a backdrop. */}
      <div className="flex min-h-8 w-full items-center gap-1 rounded-b-xl border border-t-0 border-border/60 bg-muted/25 px-2 text-[0.6875rem] text-muted-foreground shadow-1">
        {choosing && onEnvMode ? (
          <WhereThisLands
            projectId={projectId}
            {...(projectName ? { projectName } : {})}
            {...(git ? { git } : {})}
            {...(envMode ? { envMode } : {})}
            onEnvMode={onEnvMode}
            {...(pendingBase ? { pendingBase } : {})}
            {...(onBase ? { onBase } : {})}
          />
        ) : (
          <>
            {/* IDENTITY, not a control: the project is a fact of this canvas, and
                a button that could not do anything would be a lie of
                affordance. */}
            <span className="flex min-w-0 shrink-0 items-center gap-1.5 px-1 font-medium text-foreground">
              <FolderGit2Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="max-w-40 truncate">{projectName ?? projectId}</span>
            </span>

            <StripRule />

            {/* THE WORKSPACE MODE, a static label: the worktree is cut once, so
                once the session exists there is nothing here to choose. */}
            <span className={cn(CONTROL, "hover:bg-transparent hover:text-muted-foreground")} title={modeLabel}>
              {/* Git-flavoured on BOTH arms: a checkout is a git fact, and a
                  laptop said "machine" — the one concept this strip
                  deliberately dropped. */}
              {isWorktree ? <GitBranchIcon className="size-3.5 shrink-0" /> : <FolderGitIcon className="size-3.5 shrink-0" />}
              <span className="hidden truncate @xl/composer:inline">{modeLabel}</span>
            </span>

            <StripRule />

            {/* THE BRANCH: a readout, with the detail one click deep. */}
            <Popover>
              <PopoverTrigger render={<button type="button" aria-label="Branch" title="Where this session's work lands" className={CONTROL} />}>
                <GitBranchIcon className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate font-mono">{branch ?? "no branch"}</span>
                <ChevronDownIcon className="size-3 shrink-0" />
              </PopoverTrigger>
              <PopoverContent side="top" align="start" sideOffset={8} className="w-[min(24rem,calc(100vw-2rem))] gap-0 rounded-2xl p-2">
                <p className="px-2 pb-1 pt-1 text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">Branch</p>
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
                  <p className="px-2 pt-2 text-[0.6875rem] text-muted-foreground">
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
          </>
        )}

        {/* --warning, the app's "a person has to move" colour: uncommitted work
            is not a failure, it is something you may want to deal with. */}
        {dirty > 0 && (
          <span className="ml-auto shrink-0 rounded-full bg-warning/10 px-1.5 py-0.5 text-[0.625rem] font-medium text-warning">{dirty} changed</span>
        )}
      </div>
    </div>
  );
}

/**
 * The foot as the composer mounts it: the same strip, over a `projectGit` poll.
 *
 * REFRESHED ON A TIMER, because the working tree changes underneath this process
 * constantly — and a count that could not be read is drawn as NO count, never as
 * a reassuring zero.
 */
export function WorkspaceEnvironment(props: Omit<Parameters<typeof EnvironmentStrip>[0], "git" | "reachable">) {
  const { projectId } = props;
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

  return <EnvironmentStrip {...props} {...(git ? { git } : {})} reachable={reachable} />;
}
