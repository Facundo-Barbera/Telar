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
import { useMemo, useState } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleDotIcon,
  ClockIcon,
  FileIcon,
  FolderIcon,
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
  isReclaimable,
  type ChecksState,
  type DemoFileNode,
  type DemoIssue,
  type DemoPR,
  type DemoWorktree,
  type GitStatus,
  type RemoteState,
} from "./git-fixtures";
import { GitChip, HubShell, SectionBand, fmtSize } from "./git-shared";
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

/* --------------------------------------------------- branches (compact) */

function BranchesSection() {
  const merged = DEMO_BRANCHES.filter((b) => b.merged);
  return (
    <div>
      <SectionBand
        icon={GitBranchIcon}
        label="Branches"
        count={DEMO_BRANCHES.length}
        right={
          merged.length > 0 ? (
            <Button size="sm" variant="outline">
              <Trash2Icon />
              Delete {merged.length} merged
            </Button>
          ) : undefined
        }
      />
      <div className="flex flex-wrap gap-1.5 px-4 pb-3">
        {DEMO_BRANCHES.map((b) => (
          <Badge
            key={b.name}
            variant="outline"
            className={cn(
              "gap-1.5 px-2 py-0.5 font-mono text-[11px]",
              b.merged
                ? "border-border bg-muted/40 text-muted-foreground"
                : "border-sky-500/25 bg-sky-500/5 text-sky-300",
            )}
          >
            {b.name}
            {!b.merged && (b.ahead > 0 || b.behind > 0) && (
              <span className="text-muted-foreground/70">
                +{b.ahead}/-{b.behind}
              </span>
            )}
          </Badge>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------- activity (mini-log) */

function ActivitySection() {
  return (
    <div>
      <SectionBand icon={HistoryIcon} label="Activity" />
      <ol className="px-4 pb-4">
        {DEMO_COMMITS.map((c) => (
          <li
            key={c.sha}
            className="flex items-center gap-2.5 border-l border-border py-1.5 pl-3"
          >
            <span className="font-mono text-xs text-muted-foreground">
              {c.sha}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-foreground">
              {c.subject}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {c.author}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground/70">
              {fmtAgo(c.updatedAt)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ---------------------------------------------------------- remote bits */

function RemoteStateChip({ state }: { state: RemoteState }) {
  const map: Record<RemoteState, { label: string; cls: string; icon: LucideIcon }> = {
    open: {
      label: "open",
      cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
      icon: CircleDotIcon,
    },
    draft: {
      label: "draft",
      cls: "border-border bg-muted/40 text-muted-foreground",
      icon: GitPullRequestDraftIcon,
    },
    merged: {
      label: "merged",
      cls: "border-violet-500/30 bg-violet-500/10 text-violet-300",
      icon: GitMergeIcon,
    },
    closed: {
      label: "closed",
      cls: "border-destructive/30 bg-destructive/10 text-destructive",
      icon: XCircleIcon,
    },
  };
  const s = map[state];
  return (
    <Badge
      variant="outline"
      className={cn("shrink-0 gap-1 px-1.5 py-0 text-[10px]", s.cls)}
    >
      <s.icon className="size-2.5" />
      {s.label}
    </Badge>
  );
}

function ChecksChip({ checks }: { checks: ChecksState }) {
  if (checks === "none") return null;
  const map: Record<Exclude<ChecksState, "none">, { icon: LucideIcon; cls: string; label: string }> = {
    pass: { icon: CheckCircle2Icon, cls: "text-emerald-400", label: "checks pass" },
    fail: { icon: XCircleIcon, cls: "text-destructive", label: "checks fail" },
    pending: { icon: ClockIcon, cls: "text-amber-400", label: "checks pending" },
  };
  const s = map[checks];
  return (
    <span className={cn("inline-flex items-center", s.cls)} title={s.label}>
      <s.icon className="size-3.5" />
    </span>
  );
}

function IssueRow({ issue }: { issue: DemoIssue }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2 hover:bg-muted/30">
      <span className="w-12 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
        #{issue.number}
      </span>
      <RemoteStateChip state={issue.state} />
      <span className="min-w-0 flex-1 truncate text-sm">{issue.title}</span>
      <div className="hidden shrink-0 items-center gap-1 sm:flex">
        {issue.labels.map((l) => (
          <Badge
            key={l}
            variant="outline"
            className="px-1.5 py-0 text-[10px] text-muted-foreground"
          >
            {l}
          </Badge>
        ))}
      </div>
      <span className="w-16 shrink-0 truncate text-right text-xs text-muted-foreground">
        {issue.author}
      </span>
      <span className="w-14 shrink-0 text-right text-xs text-muted-foreground/70">
        {fmtAgo(issue.updatedAt)}
      </span>
    </div>
  );
}

function PRRow({ pr }: { pr: DemoPR }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2 hover:bg-muted/30">
      <span className="w-12 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
        #{pr.number}
      </span>
      <RemoteStateChip state={pr.state} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{pr.title}</div>
        <div className="mt-0.5 flex items-center gap-1.5">
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {pr.branch}
          </span>
          {pr.linkedLoomId && (
            <GitChip
              tone="active"
              className="border-indigo-500/30 bg-indigo-500/10 text-indigo-300"
            >
              wove {pr.linkedLoomId}
            </GitChip>
          )}
        </div>
      </div>
      <ChecksChip checks={pr.checks} />
      <span className="w-16 shrink-0 truncate text-right text-xs text-muted-foreground">
        {pr.author}
      </span>
      <span className="w-14 shrink-0 text-right text-xs text-muted-foreground/70">
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
          <div className="divide-y divide-border">
            {sub === "issues"
              ? DEMO_ISSUES.map((i) => <IssueRow key={i.number} issue={i} />)
              : prs.map((p) => <PRRow key={p.number} pr={p} />)}
          </div>
        </>
      ) : (
        <NotConnected />
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

function TreeNode({
  node,
  showTouched,
}: {
  node: DemoFileNode;
  showTouched: boolean;
}) {
  // folders collapsed by default (orientation surface, not a file browser)
  const [open, setOpen] = useState(false);
  const isDir = node.kind === "dir";
  const Icon = isDir ? FolderIcon : FileIcon;
  return (
    <div>
      <div
        role={isDir ? "button" : undefined}
        onClick={isDir ? () => setOpen((o) => !o) : undefined}
        className={cn(
          "flex items-center gap-2 py-1.5 pr-4 transition-colors",
          isDir ? "cursor-pointer hover:bg-muted/30" : "hover:bg-muted/20",
        )}
        style={{ paddingLeft: `${node.depth * 16 + 12}px` }}
      >
        {isDir ? (
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <Icon
          className={cn(
            "size-4 shrink-0",
            isDir ? "text-sky-400/80" : "text-muted-foreground",
          )}
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm",
            isDir ? "font-medium" : "text-foreground/90",
          )}
        >
          {node.name}
        </span>
        <HeatDot heat={node.heat} />
        <StatusBadge status={node.status} />
        {showTouched && <TouchedBy node={node} />}
      </div>
      {isDir && open && node.children && (
        <div>
          {node.children.map((c) => (
            <TreeNode key={c.name} node={c} showTouched={showTouched} />
          ))}
        </div>
      )}
    </div>
  );
}

// count files + dirty (files carrying a git status) across the whole tree
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

function FilesSection() {
  // owns its sub-view now — always expanded, no collapse chrome.
  const [showTouched, setShowTouched] = useState(true);
  const counts = useMemo(() => fileCounts(DEMO_FILE_TREE), []);

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

      {/* honesty caveat — the attribution is aspirational, not a fact yet */}
      {showTouched && (
        <div className="flex items-start gap-2 border-y border-border bg-amber-500/5 px-4 py-2">
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
      <div className="py-1">
        {DEMO_FILE_TREE.map((n) => (
          <TreeNode key={n.name} node={n} showTouched={showTouched} />
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

  // same-tick PR liveness: pending → pass on the linked PR when the loom lands
  const prs = useMemo(
    () =>
      replayed
        ? DEMO_PRS.map((p) =>
            p.number === 144 ? { ...p, checks: "pass" as ChecksState } : p,
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

            {active === "branches" && (
              // branches beside the activity mini-log — two-column if it fits
              <div className="grid grid-cols-1 lg:grid-cols-2 lg:divide-x lg:divide-border">
                <BranchesSection />
                <div className="border-t border-border lg:border-t-0">
                  <ActivitySection />
                </div>
              </div>
            )}

            {active === "remote" && <RemoteSection prs={prs} />}

            {active === "files" && <FilesSection />}
          </div>
        </div>
      )}
    </HubShell>
  );
}
