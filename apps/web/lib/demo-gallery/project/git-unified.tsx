"use client";

// LANE: project (NEW) — project-git-unified. ONE dense Git tab inside the hub-c
// tab strip. The owner rejected both three separate entries (round 21) and one
// long scrollable screen (round 22): the sweet spot is ONE tab whose body shows
// ONE dense section at a time via a slim INTERNAL switcher — no stacked sections,
// no long scroll.
//
// Layout, top → bottom:
//  • HEADER STRIP  — PERSISTENT: branch, ahead/behind, dirty count, last commit,
//                    and the "~N GB reclaimable across M worktrees" headline,
//                    which doubles as a jump-to-Worktrees affordance.
//  • SWITCHER      — slim row: Worktrees | Branches | Remote | Files. One active.
//  • BODY (one of):
//     WORKTREES (default) — loom-owner chips, reclaimable logic, bulk clean-up
//                    confirm modal, per-row typed force.
//     BRANCHES    — branches beside the activity/commit mini-log (two-column).
//     REMOTE      — Issues | PRs, first-class "gh not connected" state, future/
//                    read-only tag.
//     FILES       — git-aware tree, M/A/? badges, heat dots, last-touched-by
//                    toggle with its inline data-gap caveat (owns its sub-view,
//                    no longer collapsed).
//
// ONE replay timeline drives the whole view: finishing the running loom flips
// its worktree to reclaimable AND flips a PR's checks green in the same tick.
// The trigger is visible from any sub-view; if a flip lands in a hidden sub-view
// its switcher item gets a subtle attention dot until visited.
//
// DATA HONESTY (carried from the round-21 entries):
//  • worktrees = `git worktree list --porcelain` (vcs.ts) joined to the loom
//    registry by telar-wt-<loomId> dir naming — REAL, server-side today.
//  • sizes = du estimates (the ~ is load-bearing).
//  • branches/commits = git plumbing — REAL.
//  • issues/PRs = `gh` CLI, AUTH-GATED — FUTURE, read-only-first, no write path.
//  • file tree + status = fs walk + `git status` — REAL. But per-node "last
//    touched by" is a GAP: the store records filesTouched as a COUNT, not the
//    paths a session changed (executor.ts), so attribution needs a schema that
//    records paths. Toggleable + flagged inline as design intent, not fact.
import { useMemo, useState, type ReactNode } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckCircle2Icon,
  CheckIcon,
  ChevronRightIcon,
  CircleDotIcon,
  ClockIcon,
  CornerDownRightIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GitMergeIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  HistoryIcon,
  InfoIcon,
  MessagesSquareIcon,
  PlugZapIcon,
  RotateCcwIcon,
  SearchIcon,
  ShieldAlertIcon,
  Trash2Icon,
  TreePineIcon,
  TriangleAlertIcon,
  WorkflowIcon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fmtAgo } from "@/lib/format";
import {
  DEMO_BRANCHES,
  DEMO_COMMITS,
  DEMO_FILE_TREE,
  DEMO_ISSUES,
  DEMO_PRS,
  DEMO_WORKTREES,
  GIT_HEAD,
  checksVerdict,
  isReclaimable,
  labelColor,
  type ChecksCluster,
  type ChecksVerdict,
  type DemoBranch,
  type DemoFileNode,
  type DemoIssue,
  type DemoPR,
  type DemoWorktree,
  type GitStatus,
  type RemoteState,
  type ReviewState,
} from "./git-fixtures";
import { GitChip, HubShell, SectionBand, fmtSize } from "./git-shared";
import { DEMO_PROJECT } from "./fixtures";
import type { Theme } from "./shared";

/* -------------------------------------------------------------- header */

function GitHeaderStrip({
  reclaimMb,
  reclaimCount,
  onJumpWorktrees,
}: {
  reclaimMb: number;
  reclaimCount: number;
  onJumpWorktrees: () => void;
}) {
  const c = GIT_HEAD.lastCommit;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-background/40 px-4 py-2.5">
      <div className="flex items-center gap-1.5">
        <GitBranchIcon className="size-4 text-muted-foreground" />
        <span className="font-mono text-sm font-medium">{GIT_HEAD.branch}</span>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-0.5 font-mono tabular-nums">
          <ArrowUpIcon className="size-3" />
          {GIT_HEAD.ahead}
        </span>
        <span className="inline-flex items-center gap-0.5 font-mono tabular-nums">
          <ArrowDownIcon className="size-3" />
          {GIT_HEAD.behind}
        </span>
        <span className="text-border">·</span>
        <span className="text-amber-300">{GIT_HEAD.dirtyFiles} dirty</span>
      </div>

      {/* reclaimable headline — the glanceable payoff, doubles as jump-to-Worktrees */}
      {reclaimCount > 0 && (
        <button
          type="button"
          onClick={onJumpWorktrees}
          title="Jump to Worktrees"
          className="flex min-w-0 items-center gap-1.5 rounded-md border border-emerald-500/25 bg-emerald-500/5 px-2 py-1 text-xs transition-colors hover:bg-emerald-500/10"
        >
          <Trash2Icon className="size-3.5 shrink-0 text-emerald-400" />
          <span className="truncate text-foreground">
            <span className="font-mono font-medium tabular-nums text-emerald-300">
              {fmtSize(reclaimMb)}
            </span>{" "}
            reclaimable
            <span className="text-muted-foreground">
              {" "}
              · {reclaimCount} worktree{reclaimCount === 1 ? "" : "s"}
            </span>
          </span>
        </button>
      )}

      <div className="ml-auto flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <GitCommitHorizontalIcon className="size-3.5 shrink-0" />
        <span className="shrink-0 font-mono text-foreground">{c.sha}</span>
        <span className="min-w-0 truncate">{c.subject}</span>
        <span className="shrink-0 text-border">·</span>
        <span className="shrink-0">{fmtAgo(c.updatedAt)}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------ internal view switcher */

type ViewKey = "worktrees" | "branches" | "remote" | "files";

const VIEW_ITEMS: { key: ViewKey; label: string; icon: LucideIcon }[] = [
  { key: "worktrees", label: "Worktrees", icon: GitBranchIcon },
  { key: "branches", label: "Branches", icon: HistoryIcon },
  { key: "remote", label: "Remote", icon: GitPullRequestIcon },
  { key: "files", label: "Files", icon: FolderIcon },
];

// Slim switcher — exactly one sub-view is live at a time (no stacked sections).
// A hidden sub-view that changed under a replay carries a subtle attention dot.
function SectionSwitcher({
  active,
  attention,
  onSelect,
}: {
  active: ViewKey;
  attention: Set<ViewKey>;
  onSelect: (k: ViewKey) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border bg-background/60 px-3 py-1.5">
      {VIEW_ITEMS.map((it) => {
        const on = active === it.key;
        const dot = !on && attention.has(it.key);
        return (
          <button
            key={it.key}
            type="button"
            onClick={() => onSelect(it.key)}
            aria-current={on ? "page" : undefined}
            className={cn(
              "relative flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              on
                ? "bg-primary/10 text-foreground"
                : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
            )}
          >
            <it.icon className="size-3.5" />
            {it.label}
            {dot && (
              <span
                aria-label="updated"
                className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-emerald-400 ring-2 ring-background"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------- worktree row */

function OwnerChip({ w }: { w: DemoWorktree }) {
  if (w.owner.kind === "manual") {
    return <GitChip tone="muted">manual</GitChip>;
  }
  return (
    <GitChip tone="active" className="border-indigo-500/30 bg-indigo-500/10 text-indigo-300">
      {w.owner.loomId}
    </GitChip>
  );
}

function WorktreeStateChips({ w }: { w: DemoWorktree }) {
  const activeLoom = w.owner.kind === "loom" &&
    (w.owner.loomState === "running" ||
      w.owner.loomState === "scoping" ||
      w.owner.loomState === "preparing" ||
      w.owner.loomState === "verifying");
  return (
    <div className="flex flex-wrap items-center gap-1">
      {activeLoom && (
        <GitChip tone="active">
          <CircleDotIcon className="size-2.5" />
          active loom
        </GitChip>
      )}
      {w.merged && <GitChip tone="merged">merged</GitChip>}
      {w.dirty && <GitChip tone="dirty">dirty</GitChip>}
      {w.stale && <GitChip tone="stale">stale</GitChip>}
      {isReclaimable(w) && (
        <GitChip tone="reclaimable">
          <Trash2Icon className="size-2.5" />
          reclaimable
        </GitChip>
      )}
    </div>
  );
}

function WorktreeRow({
  w,
  checked,
  forced,
  onToggle,
  onArmForce,
}: {
  w: DemoWorktree;
  checked: boolean;
  forced: boolean;
  onToggle: () => void;
  onArmForce: () => void;
}) {
  const reclaimable = isReclaimable(w);
  const marked = checked || forced;
  return (
    <div
      className={cn(
        "flex items-start gap-3 px-4 py-2.5 transition-colors",
        marked ? "bg-primary/5" : "hover:bg-muted/30",
      )}
    >
      {/* select control — checkbox for reclaimable, force for the rest */}
      <div className="pt-0.5">
        {reclaimable ? (
          <button
            type="button"
            onClick={onToggle}
            aria-label={checked ? "Deselect" : "Select"}
            className={cn(
              "flex size-4 items-center justify-center rounded border transition-colors",
              checked
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-transparent hover:border-foreground/40",
            )}
          >
            {checked && (
              <svg viewBox="0 0 12 12" className="size-3" fill="none">
                <path
                  d="M2.5 6.5l2.5 2.5 4.5-5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>
        ) : forced ? (
          <TriangleAlertIcon className="size-4 text-destructive" />
        ) : (
          <span
            className="flex size-4 items-center justify-center rounded border border-dashed border-border/60"
            title="Not safely reclaimable — force required"
          />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="truncate font-mono text-sm font-medium"
            title={w.path}
          >
            {w.basename}
          </span>
          <OwnerChip w={w} />
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <GitBranchIcon className="size-3 shrink-0" />
          <span className="truncate font-mono">{w.branch}</span>
        </div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground/80">
          <span className="font-mono text-muted-foreground">{w.sha}</span>{" "}
          {w.head}
        </div>
        <div className="mt-1">
          <WorktreeStateChips w={w} />
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="font-mono text-xs tabular-nums text-foreground">
          {fmtSize(w.sizeMb)}
        </span>
        <span className="text-xs text-muted-foreground">{fmtAgo(w.updatedAt)}</span>
        {!reclaimable && !forced && (
          <button
            type="button"
            onClick={onArmForce}
            className="text-[11px] font-medium text-destructive/80 hover:text-destructive"
          >
            Force…
          </button>
        )}
        {forced && (
          <span className="text-[11px] font-medium text-destructive">
            force armed
          </span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------- per-row typed force confirm */

function ForceConfirm({
  w,
  onArm,
  onCancel,
}: {
  w: DemoWorktree;
  onArm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const ok = typed === w.basename;
  return (
    <div className="border-l-2 border-destructive/50 bg-destructive/5 px-4 py-2.5">
      <p className="text-xs text-foreground">
        <span className="font-medium text-destructive">Force-remove</span> a{" "}
        {w.dirty ? "dirty" : "un-merged"} worktree — Telar cannot prove this is
        safe. Type{" "}
        <span className="font-mono font-medium text-foreground">
          {w.basename}
        </span>{" "}
        to arm it.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={w.basename}
          className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 font-mono text-xs outline-none focus:border-destructive focus:ring-2 focus:ring-destructive/30"
        />
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={!ok}
          onClick={onArm}
        >
          Arm
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------ cleanup confirm modal */

function CleanupDialog({
  worktrees,
  deleteBranches,
  onToggleBranches,
  onCancel,
  onConfirm,
}: {
  worktrees: DemoWorktree[];
  deleteBranches: boolean;
  onToggleBranches: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const totalMb = worktrees.reduce((n, w) => n + w.sizeMb, 0);
  const mergedCount = worktrees.filter((w) => w.merged).length;
  const anyForced = worktrees.some((w) => !isReclaimable(w));
  // Contained modal: absolute within the git body (no transformed ancestors),
  // so it covers the stage — not the whole browser viewport.
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onCancel}
        className="absolute inset-0 bg-background/70 backdrop-blur-sm"
      />
      <div className="relative flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Trash2Icon className="size-4 text-destructive" />
          <h2 className="text-sm font-semibold">
            Clean up {worktrees.length} worktree
            {worktrees.length === 1 ? "" : "s"}
          </h2>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <p className="text-xs text-muted-foreground">
            This removes the following worktree director
            {worktrees.length === 1 ? "y" : "ies"} from disk
            {deleteBranches && mergedCount > 0
              ? " and deletes their merged branches"
              : ""}
            . This cannot be undone.
          </p>
          <ul className="mt-3 space-y-1.5">
            {worktrees.map((w) => (
              <li
                key={w.id}
                className="flex items-center gap-2 rounded-md border border-border bg-background/50 px-2.5 py-1.5"
              >
                {isReclaimable(w) ? (
                  <GitChip tone="reclaimable">safe</GitChip>
                ) : (
                  <GitChip tone="dirty">forced</GitChip>
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={w.path}>
                  {w.basename}
                </span>
                <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                  {fmtSize(w.sizeMb)}
                </span>
              </li>
            ))}
          </ul>

          {mergedCount > 0 && (
            <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <button
                type="button"
                onClick={onToggleBranches}
                aria-label="Toggle branch deletion"
                className={cn(
                  "flex size-4 items-center justify-center rounded border transition-colors",
                  deleteBranches
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border",
                )}
              >
                {deleteBranches && (
                  <svg viewBox="0 0 12 12" className="size-3" fill="none">
                    <path
                      d="M2.5 6.5l2.5 2.5 4.5-5"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
              Also delete {mergedCount} merged branch
              {mergedCount === 1 ? "" : "es"}
            </label>
          )}

          {anyForced && (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2">
              <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
              <p className="text-[11px] text-destructive/90">
                Includes forced rows Telar could not prove safe — uncommitted or
                un-merged work will be lost.
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            frees {fmtSize(totalMb)}
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button size="sm" variant="destructive" onClick={onConfirm}>
              <Trash2Icon />
              Remove
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------ worktrees body */

function WorktreesSection({
  worktrees,
  onRemove,
}: {
  worktrees: DemoWorktree[];
  onRemove: (ids: string[]) => void;
}) {
  // default selection = reclaimable rows only
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(worktrees.filter(isReclaimable).map((w) => w.id)),
  );
  const [forced, setForced] = useState<Set<string>>(new Set());
  const [forcing, setForcing] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteBranches, setDeleteBranches] = useState(true);

  const toRemove = useMemo(
    () => worktrees.filter((w) => selected.has(w.id) || forced.has(w.id)),
    [worktrees, selected, forced],
  );

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const confirmRemoval = () => {
    onRemove(toRemove.map((w) => w.id));
    setSelected(new Set());
    setForced(new Set());
    setDialogOpen(false);
  };

  return (
    <div className="relative">
      <SectionBand
        icon={GitBranchIcon}
        label="Worktrees"
        count={worktrees.length}
        right={
          <Button
            size="sm"
            variant="destructive"
            disabled={toRemove.length === 0}
            onClick={() => setDialogOpen(true)}
          >
            <Trash2Icon />
            Clean up
            {toRemove.length > 0 && (
              <span className="font-mono tabular-nums">{toRemove.length}</span>
            )}
          </Button>
        }
      />

      {/* one-line rationale — the aggregate GB headline now lives in the header */}
      <p className="px-4 pb-1 text-[11px] text-muted-foreground">
        Reclaimable = merged, clean, and not backing an active loom — Telar proves
        it, so you never reverse-engineer safety.
      </p>

      <div className="divide-y divide-border">
        {worktrees.map((w) => (
          <div key={w.id}>
            <WorktreeRow
              w={w}
              checked={selected.has(w.id)}
              forced={forced.has(w.id)}
              onToggle={() => toggle(w.id)}
              onArmForce={() => setForcing(w.id)}
            />
            {forcing === w.id && (
              <ForceConfirm
                w={w}
                onArm={() => {
                  setForced((f) => new Set(f).add(w.id));
                  setForcing(null);
                }}
                onCancel={() => setForcing(null)}
              />
            )}
          </div>
        ))}
      </div>

      {dialogOpen && (
        <CleanupDialog
          worktrees={toRemove}
          deleteBranches={deleteBranches}
          onToggleBranches={() => setDeleteBranches((b) => !b)}
          onCancel={() => setDialogOpen(false)}
          onConfirm={confirmRemoval}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------- branches (the hero) */

// Mirrored ahead/behind bars around a center axis — GitHub's divergence glyph.
// behind extends LEFT (amber), ahead extends RIGHT (emerald); scaled to the
// busiest branch so relative divergence reads at a glance. Numbers beside, full
// count on hover.
function AheadBehindBars({
  ahead,
  behind,
  max,
  defaultName,
}: {
  ahead: number;
  behind: number;
  max: number;
  defaultName: string;
}) {
  if (ahead === 0 && behind === 0) {
    return (
      <span
        className="w-[7.5rem] shrink-0 text-center font-mono text-[11px] text-muted-foreground/60"
        title="Even with the default branch"
      >
        —
      </span>
    );
  }
  const pct = (n: number) => (max > 0 ? Math.max(n > 0 ? 12 : 0, (n / max) * 100) : 0);
  return (
    <div
      className="flex w-[7.5rem] shrink-0 items-center gap-1"
      title={`${ahead} ahead, ${behind} behind ${defaultName}`}
    >
      <span className="w-4 text-right font-mono text-[10px] tabular-nums text-amber-300/90">
        {behind || ""}
      </span>
      <div className="flex flex-1 items-center">
        <div className="flex h-1.5 flex-1 justify-end">
          <span
            className="h-full rounded-l-full bg-amber-400/70"
            style={{ width: `${pct(behind)}%` }}
          />
        </div>
        <span className="h-3 w-px shrink-0 bg-border" />
        <div className="flex h-1.5 flex-1 justify-start">
          <span
            className="h-full rounded-r-full bg-emerald-400/70"
            style={{ width: `${pct(ahead)}%` }}
          />
        </div>
      </div>
      <span className="w-4 font-mono text-[10px] tabular-nums text-emerald-300/90">
        {ahead || ""}
      </span>
    </div>
  );
}

function BranchStateChips({ b }: { b: DemoBranch }) {
  if (b.isDefault) {
    return (
      <Badge
        variant="outline"
        className="shrink-0 gap-1 border-primary/40 bg-primary/10 px-1.5 py-0 text-[10px] text-primary"
      >
        default
      </Badge>
    );
  }
  return (
    <div className="flex shrink-0 items-center gap-1">
      {b.merged ? (
        <GitChip tone="merged">merged</GitChip>
      ) : (
        <GitChip tone="active">
          <CircleDotIcon className="size-2.5" />
          active
        </GitChip>
      )}
      {b.stale && <GitChip tone="stale">stale</GitChip>}
    </div>
  );
}

function BranchRow({
  b,
  max,
  defaultName,
  onDelete,
}: {
  b: DemoBranch;
  max: number;
  defaultName: string;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2 transition-colors hover:bg-muted/30">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-sm font-medium" title={b.name}>
            {b.name}
          </span>
          <BranchStateChips b={b} />
        </div>
        {/* tip commit — secondary line, muted, truncates */}
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 pl-[1.375rem] text-xs text-muted-foreground">
          <span className="shrink-0 font-mono text-muted-foreground/80">{b.sha}</span>
          <span className="min-w-0 truncate">{b.subject}</span>
          <span className="shrink-0 text-border">·</span>
          <span className="shrink-0">{b.author}</span>
          <span className="shrink-0 text-border">·</span>
          <span className="shrink-0 text-muted-foreground/70">{fmtAgo(b.updatedAt)}</span>
        </div>
      </div>

      <AheadBehindBars
        ahead={b.ahead}
        behind={b.behind}
        max={max}
        defaultName={defaultName}
      />

      <div className="flex w-6 shrink-0 justify-end">
        {b.merged && !b.isDefault && (
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Delete ${b.name}`}
            title="Delete merged branch"
            className="text-muted-foreground/60 transition-colors hover:text-destructive"
          >
            <Trash2Icon className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

function BranchesSection() {
  const [deleted, setDeleted] = useState<Set<string>>(new Set());
  const rows = DEMO_BRANCHES.filter((b) => !deleted.has(b.name));
  const merged = rows.filter((b) => b.merged && !b.isDefault);
  const defaultName = DEMO_BRANCHES.find((b) => b.isDefault)?.name ?? "main";
  const max = Math.max(1, ...rows.map((b) => Math.max(b.ahead, b.behind)));

  const del = (name: string) =>
    setDeleted((s) => new Set(s).add(name));
  const delMerged = () =>
    setDeleted((s) => {
      const next = new Set(s);
      merged.forEach((b) => next.add(b.name));
      return next;
    });

  return (
    <div>
      <SectionBand
        icon={GitBranchIcon}
        label="Branches"
        count={rows.length}
        right={
          merged.length > 0 ? (
            <Button size="sm" variant="outline" onClick={delMerged}>
              <Trash2Icon />
              Delete {merged.length} merged
            </Button>
          ) : undefined
        }
      />
      {/* column hint — keeps the mirrored-bar axis legible */}
      <div className="flex items-center gap-3 px-4 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground/70 uppercase">
        <span className="flex-1">Branch · last commit</span>
        <span className="w-[7.5rem] text-center">← behind · ahead →</span>
        <span className="w-6" />
      </div>
      <div className="divide-y divide-border border-t border-border">
        {rows.map((b) => (
          <BranchRow
            key={b.name}
            b={b}
            max={max}
            defaultName={defaultName}
            onDelete={() => del(b.name)}
          />
        ))}
      </div>

      <ActivityStrip />
    </div>
  );
}

/* ---------------------------------------- activity (secondary strip) */

// Kept available but SECONDARY — a compact commit strip below the branches
// table, not a sidebar fighting the hero for width.
function ActivityStrip() {
  return (
    <div className="border-t border-border bg-background/40">
      <div className="flex items-center gap-2 px-4 pt-2.5 pb-1">
        <HistoryIcon className="size-3.5 text-muted-foreground" />
        <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          Recent commits
        </span>
      </div>
      <ol className="px-4 pb-3">
        {DEMO_COMMITS.map((c) => (
          <li
            key={c.sha}
            className="flex items-center gap-2 border-l border-border py-1 pl-3"
          >
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground/80">
              {c.sha}
            </span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/90">
              {c.subject}
            </span>
            <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">
              {c.author}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground/60">
              {fmtAgo(c.updatedAt)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ---------------------------------------------------------- remote bits */

// GitHub-style state glyph: an OPEN issue is a green dot, a CLOSED one a purple
// check; PRs reuse the same map (open green / merged purple / closed rose) with
// draft handled by the caller.
function RemoteStateIcon({ state }: { state: RemoteState }) {
  const map: Record<RemoteState, { icon: LucideIcon; cls: string; label: string }> = {
    open: { icon: CircleDotIcon, cls: "text-emerald-400", label: "open" },
    closed: { icon: CheckCircle2Icon, cls: "text-violet-400", label: "closed" },
    merged: { icon: GitMergeIcon, cls: "text-violet-400", label: "merged" },
    draft: { icon: GitPullRequestDraftIcon, cls: "text-muted-foreground", label: "draft" },
  };
  const s = map[state];
  return (
    <span className={cn("flex shrink-0 items-center", s.cls)} title={s.label}>
      <s.icon className="size-4" />
    </span>
  );
}

// CI cluster — passed check / failed x / pending dot, GitHub's checks summary.
function ChecksClusterChip({ checks }: { checks: ChecksCluster }) {
  const verdict: ChecksVerdict = checksVerdict(checks);
  if (verdict === "none") return null;
  const total = checks.passed + checks.failed + checks.pending;
  const parts: { icon: LucideIcon; cls: string; n: number }[] = [
    { icon: XCircleIcon, cls: "text-destructive", n: checks.failed },
    { icon: ClockIcon, cls: "text-amber-400", n: checks.pending },
    { icon: CheckCircle2Icon, cls: "text-emerald-400", n: checks.passed },
  ];
  const lead = verdict === "fail" ? parts[0] : verdict === "pending" ? parts[1] : parts[2];
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1"
      title={`${checks.passed}/${total} checks passed${checks.failed ? `, ${checks.failed} failed` : ""}${checks.pending ? `, ${checks.pending} pending` : ""}`}
    >
      <lead.icon className={cn("size-3.5", lead.cls)} />
      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
        {checks.passed}/{total}
      </span>
    </span>
  );
}

function ReviewChip({ review }: { review: ReviewState }) {
  if (!review || review === "review_required") return null;
  const map: Record<"approved" | "changes_requested", { label: string; cls: string }> = {
    approved: {
      label: "approved",
      cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    },
    changes_requested: {
      label: "changes",
      cls: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    },
  };
  const s = map[review];
  return (
    <Badge
      variant="outline"
      className={cn("shrink-0 gap-1 px-1.5 py-0 text-[10px]", s.cls)}
    >
      {review === "approved" ? (
        <CheckIcon className="size-2.5" />
      ) : (
        <TriangleAlertIcon className="size-2.5" />
      )}
      {s.label}
    </Badge>
  );
}

function LabelChips({ labels }: { labels: string[] }) {
  return (
    <div className="hidden shrink-0 items-center gap-1 md:flex">
      {labels.map((l) => (
        <Badge
          key={l}
          variant="outline"
          className={cn("px-1.5 py-0 text-[10px] font-normal", labelColor(l))}
        >
          {l}
        </Badge>
      ))}
    </div>
  );
}

function IssueRow({ issue }: { issue: DemoIssue }) {
  return (
    <div className="flex items-center gap-2.5 px-4 py-2 hover:bg-muted/30">
      <RemoteStateIcon state={issue.state} />
      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
        #{issue.number}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        {issue.title}
      </span>
      <LabelChips labels={issue.labels} />
      <span className="hidden w-16 shrink-0 truncate text-right text-xs text-muted-foreground sm:inline">
        {issue.author}
      </span>
      <span className="w-12 shrink-0 text-right text-xs text-muted-foreground/70">
        {fmtAgo(issue.updatedAt)}
      </span>
      <span
        className="flex w-10 shrink-0 items-center justify-end gap-0.5 text-xs text-muted-foreground"
        title={`${issue.comments} comments`}
      >
        <MessagesSquareIcon className="size-3" />
        <span className="tabular-nums">{issue.comments}</span>
      </span>
    </div>
  );
}

function PRRow({ pr }: { pr: DemoPR }) {
  // a draft shows a draft glyph; otherwise the shared open/merged/closed map
  const iconState: RemoteState = pr.state === "draft" ? "draft" : pr.state;
  return (
    <div className="flex items-center gap-2.5 px-4 py-2 hover:bg-muted/30">
      <RemoteStateIcon state={iconState} />
      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
        #{pr.number}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{pr.title}</div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px]">
          <span className="flex min-w-0 items-center gap-1 truncate font-mono text-muted-foreground">
            <span className="truncate">{pr.branch}</span>
            <CornerDownRightIcon className="size-3 shrink-0 rotate-0 text-muted-foreground/50" />
            <span className="shrink-0 text-muted-foreground/80">{pr.base}</span>
          </span>
          {pr.linkedLoomId && (
            <GitChip
              tone="active"
              className="border-indigo-500/30 bg-indigo-500/10 text-indigo-300"
            >
              <WorkflowIcon className="size-2.5" />
              wove {pr.linkedLoomId}
            </GitChip>
          )}
        </div>
      </div>
      <ReviewChip review={pr.review} />
      <ChecksClusterChip checks={pr.checks} />
      <span className="hidden w-16 shrink-0 truncate text-right text-xs text-muted-foreground sm:inline">
        {pr.author}
      </span>
      <span className="w-12 shrink-0 text-right text-xs text-muted-foreground/70">
        {fmtAgo(pr.updatedAt)}
      </span>
    </div>
  );
}

function NotConnected() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center">
      <div className="flex size-11 items-center justify-center rounded-xl border border-border bg-card">
        <PlugZapIcon className="size-5 text-muted-foreground" />
      </div>
      <div>
        <p className="text-sm font-medium">GitHub not connected</p>
        <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
          Telar reads issues and pull requests through the{" "}
          <span className="font-mono text-foreground">gh</span> CLI when it's
          installed and authenticated. Nothing is written — this surface is
          read-only.
        </p>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <Button size="sm" variant="outline">
          Check for gh
        </Button>
        <a
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          href="#"
          onClick={(e) => e.preventDefault()}
        >
          Setup guide
        </a>
      </div>
    </div>
  );
}

type Sub = "issues" | "prs";

function RemoteSection({ prs }: { prs: DemoPR[] }) {
  const [connected, setConnected] = useState(true);
  const [sub, setSub] = useState<Sub>("prs");
  const openIssues = DEMO_ISSUES.filter((i) => i.state === "open").length;
  const openPRs = prs.filter((p) => p.state === "open" || p.state === "draft").length;

  const subs: { key: Sub; label: string; icon: LucideIcon; count: number }[] = [
    { key: "issues", label: "Issues", icon: CircleDotIcon, count: openIssues },
    { key: "prs", label: "Pull requests", icon: GitPullRequestIcon, count: openPRs },
  ];

  return (
    <div>
      <SectionBand
        icon={GitPullRequestIcon}
        label="Remote"
        right={
          <div className="flex items-center gap-2">
            {/* future/read-only framing — kept in-section, subtle */}
            <Badge
              variant="outline"
              className="border-amber-500/30 bg-amber-500/5 px-1.5 py-0 text-[10px] text-amber-300"
            >
              future · read-only preview
            </Badge>
            {/* gh-connection toggle — reveals the first-class empty state */}
            <div className="inline-flex items-center rounded-md border border-border bg-card p-0.5">
              {([["on", "gh connected"], ["off", "not connected"]] as const).map(
                ([key, label]) => {
                  const active = connected === (key === "on");
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setConnected(key === "on")}
                      className={cn(
                        "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
                        active
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {label}
                    </button>
                  );
                },
              )}
            </div>
          </div>
        }
      />

      {connected ? (
        <>
          <div className="flex items-center gap-1 border-b border-border px-4">
            {subs.map((s) => {
              const on = sub === s.key;
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setSub(s.key)}
                  className={cn(
                    "flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs font-medium transition-colors",
                    on
                      ? "border-primary text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  <s.icon className="size-3.5" />
                  {s.label}
                  <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
                    {s.count}
                  </span>
                </button>
              );
            })}
          </div>
          {sub === "issues" ? (
            <RemoteList
              key="issues"
              placeholder="Search issues by title, label, author…"
              rows={DEMO_ISSUES}
              match={(i, q) =>
                i.title.toLowerCase().includes(q) ||
                `#${i.number}`.includes(q) ||
                i.author.toLowerCase().includes(q) ||
                i.labels.some((l) => l.toLowerCase().includes(q))
              }
              render={(i) => <IssueRow key={i.number} issue={i} />}
              noun="issue"
            />
          ) : (
            <RemoteList
              key="prs"
              placeholder="Search pull requests by title, branch, author…"
              rows={prs}
              match={(p, q) =>
                p.title.toLowerCase().includes(q) ||
                `#${p.number}`.includes(q) ||
                p.author.toLowerCase().includes(q) ||
                p.branch.toLowerCase().includes(q) ||
                p.base.toLowerCase().includes(q)
              }
              render={(p) => <PRRow key={p.number} pr={p} />}
              noun="pull request"
            />
          )}
        </>
      ) : (
        <NotConnected />
      )}
    </div>
  );
}

// Searchable list wrapper — a slim search field over a divided row list, with an
// empty state when the query matches nothing.
function RemoteList<T>({
  rows,
  match,
  render,
  placeholder,
  noun,
}: {
  rows: T[];
  match: (row: T, q: string) => boolean;
  render: (row: T) => ReactNode;
  placeholder: string;
  noun: string;
}) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const filtered = query ? rows.filter((r) => match(r, query)) : rows;
  return (
    <div>
      <div className="relative px-4 py-2">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-6 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder}
          className="h-8 w-full rounded-md border border-border bg-background/60 pr-3 pl-8 text-xs outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:bg-background focus:ring-2 focus:ring-ring/30"
        />
      </div>
      {filtered.length > 0 ? (
        <div className="divide-y divide-border border-t border-border">
          {filtered.map((r) => render(r))}
        </div>
      ) : (
        <p className="px-4 py-8 text-center text-xs text-muted-foreground">
          No {noun}s match “{q}”.
        </p>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- files bits */

function StatusBadge({ status }: { status: GitStatus }) {
  if (!status) return null;
  const map: Record<Exclude<GitStatus, null>, string> = {
    M: "border-amber-500/40 bg-amber-500/10 text-amber-300",
    A: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    "?": "border-border bg-muted/40 text-muted-foreground",
  };
  return (
    <Badge
      variant="outline"
      className={cn(
        "flex size-4 shrink-0 items-center justify-center p-0 font-mono text-[10px] leading-none",
        map[status],
      )}
    >
      {status}
    </Badge>
  );
}

// Heat dot: recently-churned paths glow warmer. Subtle by design.
function HeatDot({ heat }: { heat: number }) {
  if (heat < 0.25) return <span className="size-1.5 shrink-0" aria-hidden />;
  const tone =
    heat >= 0.8
      ? "bg-orange-400"
      : heat >= 0.5
        ? "bg-amber-400/80"
        : "bg-amber-400/40";
  return (
    <span
      aria-hidden
      title={`churn ${Math.round(heat * 100)}%`}
      className={cn("size-1.5 shrink-0 rounded-full", tone)}
    />
  );
}

function TouchedBy({ node }: { node: DemoFileNode }) {
  if (!node.touchedBy) return null;
  const { who, kind, updatedAt } = node.touchedBy;
  const Icon = kind === "loom" ? WorkflowIcon : MessagesSquareIcon;
  return (
    <span className="hidden shrink-0 items-center gap-1 text-[11px] text-muted-foreground/70 sm:flex">
      <Icon className="size-3" />
      <span className="font-mono">{who}</span>
      <span>· {fmtAgo(updatedAt)}</span>
    </span>
  );
}

// count files + dirty (files carrying a git status) across a subtree
function fileCounts(nodes: DemoFileNode[]): { files: number; dirty: number } {
  let files = 0;
  let dirty = 0;
  const walk = (ns: DemoFileNode[]) => {
    for (const n of ns) {
      if (n.kind === "file") {
        files += 1;
        if (n.status) dirty += 1;
      }
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return { files, dirty };
}

// dirty file count under a dir — bubbles a badge onto the parent directory row
function dirtyUnder(node: DemoFileNode): number {
  return node.children ? fileCounts(node.children).dirty : 0;
}

// the nodes at a given path (segment names from the repo root)
function childrenAt(path: string[]): DemoFileNode[] {
  let level = DEMO_FILE_TREE;
  for (const seg of path) {
    const node = level.find((n) => n.name === seg);
    if (!node?.children) return [];
    level = node.children;
  }
  return level;
}

// dirs first, then files — GitHub's ordering
function ordered(nodes: DemoFileNode[]): DemoFileNode[] {
  return [...nodes].sort((a, b) =>
    a.kind === b.kind ? 0 : a.kind === "dir" ? -1 : 1,
  );
}

function FileBrowserRow({
  node,
  showTouched,
  onOpen,
}: {
  node: DemoFileNode;
  showTouched: boolean;
  onOpen?: () => void;
}) {
  const isDir = node.kind === "dir";
  const Icon = isDir ? FolderIcon : FileIcon;
  const dirty = isDir ? dirtyUnder(node) : 0;
  return (
    <div
      role={isDir ? "button" : undefined}
      onClick={onOpen}
      className={cn(
        "flex items-center gap-2 px-4 py-2 transition-colors",
        isDir ? "cursor-pointer hover:bg-muted/30" : "hover:bg-muted/20",
      )}
    >
      <Icon
        className={cn(
          "size-4 shrink-0",
          isDir ? "text-sky-400/80" : "text-muted-foreground",
        )}
      />
      {/* name cluster — capped so the commit column keeps room */}
      <div className="flex min-w-0 shrink items-center gap-1.5 sm:basis-2/5">
        <span
          className={cn(
            "truncate text-sm",
            isDir ? "font-medium" : "text-foreground/90",
          )}
          title={node.name}
        >
          {node.name}
        </span>
        {dirty > 0 && (
          <Badge
            variant="outline"
            className="shrink-0 gap-0.5 border-amber-500/40 bg-amber-500/10 px-1 py-0 font-mono text-[10px] tabular-nums text-amber-300"
            title={`${dirty} dirty file${dirty === 1 ? "" : "s"} inside`}
          >
            {dirty}
          </Badge>
        )}
        <StatusBadge status={node.status} />
        <HeatDot heat={node.heat} />
      </div>

      {/* last commit for this path — muted middle column */}
      <span className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground md:inline">
        {node.commit.subject}
      </span>

      {showTouched && <TouchedBy node={node} />}
      <span className="w-14 shrink-0 text-right text-xs text-muted-foreground/70">
        {fmtAgo(node.commit.updatedAt)}
      </span>
      {isDir ? (
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/50" />
      ) : (
        <span className="w-3.5 shrink-0" />
      )}
    </div>
  );
}

function Breadcrumb({
  path,
  onNavigate,
}: {
  path: string[];
  onNavigate: (p: string[]) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 border-y border-border bg-background/40 px-4 py-1.5 text-xs">
      <button
        type="button"
        onClick={() => onNavigate([])}
        className={cn(
          "flex items-center gap-1 rounded px-1 py-0.5 font-medium transition-colors",
          path.length === 0
            ? "text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <FolderOpenIcon className="size-3.5" />
        {DEMO_PROJECT.name}
      </button>
      {path.map((seg, i) => {
        const last = i === path.length - 1;
        return (
          <span key={i} className="flex items-center gap-1">
            <ChevronRightIcon className="size-3 text-muted-foreground/50" />
            <button
              type="button"
              onClick={() => onNavigate(path.slice(0, i + 1))}
              className={cn(
                "rounded px-1 py-0.5 font-mono transition-colors",
                last
                  ? "font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {seg}
            </button>
          </span>
        );
      })}
    </div>
  );
}

function FilesSection() {
  const [showTouched, setShowTouched] = useState(true);
  const [path, setPath] = useState<string[]>([]);
  const counts = useMemo(() => fileCounts(DEMO_FILE_TREE), []);
  const nodes = useMemo(() => ordered(childrenAt(path)), [path]);

  return (
    <div>
      <SectionBand
        icon={FolderIcon}
        label="Files"
        count={counts.files}
        right={
          <>
            <span className="text-xs text-amber-300">{counts.dirty} dirty</span>
            <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <button
                type="button"
                onClick={() => setShowTouched((s) => !s)}
                aria-label="Toggle last-touched-by"
                className={cn(
                  "flex h-4 w-7 items-center rounded-full border px-0.5 transition-colors",
                  showTouched ? "border-primary bg-primary/30" : "border-border",
                )}
              >
                <span
                  className={cn(
                    "size-3 rounded-full bg-foreground transition-transform",
                    showTouched && "translate-x-3",
                  )}
                />
              </button>
              Last touched by
            </label>
          </>
        }
      />

      <Breadcrumb path={path} onNavigate={setPath} />

      {/* honesty caveat — the attribution is aspirational, not a fact yet */}
      {showTouched && (
        <div className="flex items-start gap-2 border-b border-border bg-amber-500/5 px-4 py-2">
          <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
          <p className="text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">
              Last-touched-by is a proposal.
            </span>{" "}
            The tree + status are real (fs walk + git status), but the store
            records how many files a session changed, not{" "}
            <span className="italic">which</span> — this attribution needs a
            schema that records paths.
          </p>
        </div>
      )}

      <div className="divide-y divide-border">
        {nodes.map((n) => (
          <FileBrowserRow
            key={n.name}
            node={n}
            showTouched={showTouched}
            onOpen={
              n.kind === "dir" ? () => setPath([...path, n.name]) : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------- replay bar */

function ReplayBar({
  replayed,
  onFinish,
  onReset,
}: {
  replayed: boolean;
  onFinish: () => void;
  onReset: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <TreePineIcon className="size-3.5 text-muted-foreground" />
      {!replayed ? (
        <Button size="sm" variant="outline" onClick={onFinish}>
          Finish running loom
        </Button>
      ) : (
        <Button size="sm" variant="ghost" onClick={onReset}>
          <RotateCcwIcon />
          Reset timeline
        </Button>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- demo */

// sub-views the ONE replay timeline touches: a worktree flips (worktrees) and a
// PR check flips (remote). Any of these that is HIDDEN at flip time gets a dot.
const REPLAY_TOUCHES: ViewKey[] = ["worktrees", "remote"];

export function GitUnifiedDemo() {
  const [worktrees, setWorktrees] = useState<DemoWorktree[]>(DEMO_WORKTREES);
  const [replayed, setReplayed] = useState(false);
  const [active, setActive] = useState<ViewKey>("worktrees");
  const [attention, setAttention] = useState<Set<ViewKey>>(new Set());

  // ONE timeline: the running loom (l-01, wt-l01) finishes → its worktree merges
  // clean → FLIPS to reclaimable; in the SAME tick a pending PR check flips green
  // (#144) so the whole view feels alive, not just the worktrees section.
  const finishLoom = () => {
    setReplayed(true);
    setWorktrees((ws) =>
      ws.map((w) =>
        w.id === "wt-l01"
          ? {
              ...w,
              owner: { kind: "loom", loomId: "l-01", loomState: "done" },
              merged: true,
              dirty: false,
              stale: false,
              sha: "1a2b3c4",
              head: "feat(web): worktrees section complete",
            }
          : w,
      ),
    );
    // dot the sub-views that changed but aren't the one you're looking at
    setAttention(new Set(REPLAY_TOUCHES.filter((k) => k !== active)));
  };
  const reset = () => {
    setReplayed(false);
    setWorktrees(DEMO_WORKTREES);
    setAttention(new Set());
  };
  const remove = (ids: string[]) =>
    setWorktrees((ws) => ws.filter((w) => !ids.includes(w.id)));

  // selecting a sub-view clears its attention dot
  const select = (k: ViewKey) => {
    setActive(k);
    setAttention((a) => {
      if (!a.has(k)) return a;
      const next = new Set(a);
      next.delete(k);
      return next;
    });
  };

  // same-tick PR liveness: the linked PR's pending checks flip green when the
  // loom lands (l-03 / #144: 2 pending → passed, in the same tick).
  const prs = useMemo(
    () =>
      replayed
        ? DEMO_PRS.map((p) =>
            p.number === 144
              ? {
                  ...p,
                  checks: {
                    passed: p.checks.passed + p.checks.pending,
                    failed: p.checks.failed,
                    pending: 0,
                  } satisfies ChecksCluster,
                }
              : p,
          )
        : DEMO_PRS,
    [replayed],
  );

  // reclaimable aggregate for the persistent header (re-derives on flip/remove)
  const reclaim = useMemo(() => {
    const r = worktrees.filter(isReclaimable);
    return { mb: r.reduce((n, w) => n + w.sizeMb, 0), count: r.length };
  }, [worktrees]);

  const controls = (_theme: Theme) => (
    <ReplayBar replayed={replayed} onFinish={finishLoom} onReset={reset} />
  );

  return (
    <HubShell controls={controls}>
      {() => (
        <div className="flex h-full flex-col">
          <GitHeaderStrip
            reclaimMb={reclaim.mb}
            reclaimCount={reclaim.count}
            onJumpWorktrees={() => select("worktrees")}
          />
          <SectionSwitcher
            active={active}
            attention={attention}
            onSelect={select}
          />
          {/* BODY — exactly one sub-view, its own scroll. No stacked sections. */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {active === "worktrees" && (
              // keyed so finishing the loom re-derives the default selection
              <WorktreesSection
                key={replayed ? "post" : "pre"}
                worktrees={worktrees}
                onRemove={remove}
              />
            )}

            {active === "branches" && <BranchesSection />}

            {active === "remote" && <RemoteSection prs={prs} />}

            {active === "files" && <FilesSection />}
          </div>
        </div>
      )}
    </HubShell>
  );
}
