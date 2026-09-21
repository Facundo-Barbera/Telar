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
  /**
   * WHY THE LIST BELOW MAY NOT BE THE REPOSITORY — issue #650.
   *
   * The refs come from two `for-each-ref` calls, and on a loaded machine one of
   * them can be killed at the engine's 30-second bound. That used to arrive here
   * as a SHORT LIST, which is the worst shape a wrong answer can take: an empty
   * picker looks broken and gets questioned, a short one looks complete and gets
   * BELIEVED. The person does not find the branch they wanted, reads that as
   * "it does not exist", and cuts their session from a base they did not mean —
   * a decision about where their work starts from, corrupted with nothing
   * anywhere saying git failed.
   */
  incomplete?: GitReadFailure;
  /** What a person can actually do about a timeout. Absent means the caller has
   *  no way to ask again, and the notice says so rather than offering a button
   *  that does nothing. */
  onRetry?: () => void | Promise<void>;
  /** The remote's default branch (`origin/main`) — pinned to the top. */
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

  const retry = async () => {
    if (!onRetry || retrying) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };

  /** The donor's row anatomy: mono name, one tiny muted badge at most. */
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
      {/*
        GIT DID NOT ANSWER, SAID OUT LOUD — issue #650.

        ABOVE the list rather than in place of it: the refs that did arrive are
        still perfectly good bases, and throwing them away would trade a
        misleading list for a useless one. What this has to prevent is the list
        being read as the whole repository, and a notice over it does that while
        the rows stay pickable.

        RETRY IS THE OFFER because a timeout is the case that goes away on its
        own — the machine was busy, ask again. The other failures keep the
        button too (it costs one poll) but say what they are, so a person who
        presses it twice to no effect knows this is not a busy machine.
      */}
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
        {/* THE TWO EMPTIES ARE DIFFERENT SENTENCES. "Nothing matched what you
            typed" is about the search; "this repository has no branches" is a
            claim about the repository, and it is only safe to make when the
            listing is whole — the notice above owns the case where it is not. */}
        {filtered.length === 0 && (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            {trimmed ? "No matching refs." : incomplete ? "No branches were listed." : "This repository has no branches yet."}
          </p>
        )}
        {hiddenCount > 0 && <p className="px-2 py-1.5 text-3xs text-muted-foreground">{hiddenCount} more — search to find them.</p>}
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
const CONTROL = "flex h-6 min-w-0 items-center gap-1 rounded-md px-1.5 transition-colors outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

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
  onRetry,
  envMode,
  onEnvMode,
  pendingBase,
  onBase,
}: {
  projectId: string;
  projectName?: string;
  /** Polled by the strip; absent until the first answer arrives. */
  git?: GitOverview;
  /** Re-read the overview now, for the picker's "ask git again". */
  onRetry?: () => void | Promise<void>;
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

  /** Only where it could change a choice: the base ref is a worktree's question. */
  const incompleteRefs = willBeWorktree && git?.refsIncomplete !== undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Where this lands"
            title={
              /* THE DECISION IS MADE AT ENTER, NOT AT POPOVER-OPEN — so the one
                 thing that would change it has to be readable without opening
                 anything. A person who never presses this button still cuts a
                 session from whatever base the foot settled on. */
              incompleteRefs
                ? "Some branches could not be listed — open this before choosing a base"
                : "Where the first message creates this session"
            }
            className={CONTROL}
          />
        }
      >
        {willBeWorktree ? <GitBranchIcon className="size-3.5 shrink-0" /> : <FolderGitIcon className="size-3.5 shrink-0" />}
        <span className="min-w-0 truncate font-medium text-foreground">{projectName ?? projectId}</span>
        <span className="hidden min-w-0 truncate font-mono text-muted-foreground @xl/composer:inline">
          {willBeWorktree ? base : "checkout"}
        </span>
        {incompleteRefs && <TriangleAlertIcon aria-hidden className="size-3 shrink-0 text-warning" />}
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
        {/* THE BASE REF, ONLY WHEN IT MEANS ANYTHING. A base for the project's
            own checkout would be switching its branch, which the engine's
            read-only git refuses — so the picker appears with the worktree
            rather than sitting there greyed. */}
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
  onRetry,
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
  /** Re-read the overview now. Handed down to the base picker, which is the one
   *  surface here that can be wrong in a way a person should be able to fix. */
  onRetry?: () => void | Promise<void>;
  envMode?: "local" | "worktree";
  onEnvMode?: (mode: "local" | "worktree") => void;
  pendingBase?: { baseRef?: string; branchName?: string };
  onBase?: (next: { baseRef?: string; branchName?: string }) => void;
  onOpenChanges?: () => void;
}) {
  /** The project's disk, when it is not readable — stamped on the same `git`
   *  read this strip already polls, so it costs no request. See #534. */
  const away = git?.availability === "available" ? undefined : git?.availability;
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

          ONE BAND, THE COMPOSER'S OWN SURFACE. `bg-card/95` and
          `border-border/80` are the same tokens the composer's card is built
          from (composer.tsx's `InputGroup`), and `rounded-b-2xl` continues
          its `rounded-2xl` around the two corners this band owns — so the
          strip reads as the card's bottom edge, not a second, separately
          tinted block hung beneath it. */}
      <div className="overflow-hidden rounded-b-2xl border border-t-0 border-border/80 bg-card/95 shadow-1 backdrop-blur-xl">
        {/* THE DISK NOTICE, WHEN THERE IS ONE — issue #534. A row of this same
            band rather than a floating banner above it, divided from the
            controls below by a hairline rather than a second fill: the same
            `border-border/40` the composer's own footer row uses to split
            itself from the editor above it (composer.tsx's `InputGroupAddon`). */}
        {away && (
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
        )}
        <div className="flex min-h-8 w-full items-center gap-1 px-2 text-2xs text-muted-foreground">
        {choosing && onEnvMode ? (
          <WhereThisLands
            projectId={projectId}
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
              {/*
                THE DRIVE, NOT THE BRANCH, WHEN THERE IS NO DRIVE — issue #534.

                Every number this control draws comes from a `git` that answered
                about a path it could not read: no branch, zero dirty files, no
                worktrees. Drawn as-is that is a clean checkout on no branch,
                which is a reassuring picture of a disk nobody opened. The strip
                names the cable instead, and the popover below says the rest.
              */}
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
                      {/* ABSENT IS NOT ZERO here either: a `git worktree list`
                          the engine killed is a count nobody took, and
                          "0 worktrees" is a fact a reader would act on. */}
                      {git.worktrees && (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {git.worktrees.length} worktree{git.worktrees.length === 1 ? "" : "s"}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                {/* Prose only when something is WRONG. The ordinary cases were a
                    paragraph restating what the rows above already show. */}
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
                {/* The donor's footer, pointing at the same place: the surface that
                    lists what this session actually wrote. It opens the panel rather
                    than a git pane, because the engine's git read is read-only and
                    the file changes are what there is to look at. */}
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
          </>
        )}

        {/* --warning, the app's "a person has to move" colour: uncommitted work
            is not a failure, it is something you may want to deal with. */}
        {dirty > 0 && (
          <span className="ml-auto shrink-0 rounded-full bg-warning/10 px-1.5 py-0.5 text-3xs font-medium text-warning">{dirty} changed</span>
        )}
        </div>
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
export function WorkspaceEnvironment({
  onAvailability,
  ...props
  // `onRetry` is this component's own poll — offering it as a prop would invite
  // a caller to pass a second one that silently loses to it.
}: Omit<Parameters<typeof EnvironmentStrip>[0], "git" | "reachable" | "onRetry"> & {
  /**
   * TOLD WHEN THE PROJECT'S DISK CHANGES STATE — issue #534.
   *
   * REPORTED UP RATHER THAN POLLED TWICE. The composer has to refuse a send on
   * an unplugged project, and this strip is already reading `projectGit` on a
   * timer for the branch and the dirty count — an answer the engine now stamps
   * its availability probe on. A second poller in the composer would be a
   * second request for one enum and, worse, a second opinion about a cable.
   */
  onAvailability?: (availability: Exclude<ProjectAvailability, "available"> | undefined) => void;
}) {
  const { projectId } = props;
  const [git, setGit] = useState<GitOverview>();
  const [reachable, setReachable] = useState(true);

  const load = useCallback(async () => {
    try {
      const result = await api.projectGit(projectId);
      setGit(result.git);
      setReachable(true);
      onAvailability?.(result.git.availability === "available" ? undefined : result.git.availability);
    } catch {
      setReachable(false);
      // AN ENGINE THAT DID NOT ANSWER SAYS NOTHING ABOUT A DRIVE. Reporting
      // "away" here would make a restarting daemon look like an unplugged disk
      // and refuse a send for it; the strip's own `reachable` prose is the
      // honest answer to that, and it is already there.
    }
  }, [projectId, onAvailability]);

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

  return <EnvironmentStrip {...props} {...(git ? { git } : {})} reachable={reachable} onRetry={load} />;
}
