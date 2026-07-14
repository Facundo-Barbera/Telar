"use client";

// LANE: project (NEW) — project-git-tab (RECOMMENDED). The Git tab body inside
// the hub-c tab strip. The WORKTREES section is the centerpiece and the reason
// this tab differs from a generic git GUI: Telar knows loom lifecycle, so a
// done+merged loom worktree renders as RECLAIMABLE without the user reverse-
// engineering safety. Bulk "Clean up" is destructive → a confirm dialog lists
// exactly what's removed; dirty/unmerged rows require a per-row typed force.
//
// DATA (real, server-side today): worktrees = `git worktree list --porcelain`
// (vcs.ts) joined to the loom registry via the telar-wt-<loomId> dir naming;
// sizes = du estimates (~); branches/commits = git plumbing. See git-fixtures.ts.
import { useMemo, useState } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CircleDotIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  HistoryIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  Trash2Icon,
  TreePineIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fmtAgo } from "@/lib/format";
import {
  DEMO_BRANCHES,
  DEMO_COMMITS,
  DEMO_WORKTREES,
  GIT_HEAD,
  isReclaimable,
  type DemoWorktree,
} from "./git-fixtures";
import { GitChip, HubShell, SectionBand, fmtSize } from "./git-shared";
import type { Theme } from "./shared";

/* -------------------------------------------------------------- header */

function GitHeaderStrip() {
  const c = GIT_HEAD.lastCommit;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-background/40 px-4 py-2.5">
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

  const reclaimable = useMemo(
    () => worktrees.filter(isReclaimable),
    [worktrees],
  );
  const headline = useMemo(() => {
    const mb = reclaimable.reduce((n, w) => n + w.sizeMb, 0);
    return { mb, count: reclaimable.length };
  }, [reclaimable]);

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

      {/* aggregate reclaimable headline — the glanceable payoff */}
      <div className="mx-4 mb-1 flex items-center gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2">
        <Trash2Icon className="size-4 text-emerald-400" />
        <p className="text-xs text-foreground">
          <span className="font-mono font-medium tabular-nums text-emerald-300">
            {fmtSize(headline.mb)}
          </span>{" "}
          reclaimable across{" "}
          <span className="font-medium">{headline.count}</span> worktree
          {headline.count === 1 ? "" : "s"}
          <span className="text-muted-foreground">
            {" "}
            — merged, clean, no active loom.
          </span>
        </p>
      </div>

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

export function GitTabDemo() {
  const [worktrees, setWorktrees] = useState<DemoWorktree[]>(DEMO_WORKTREES);
  const [replayed, setReplayed] = useState(false);

  // Timeline: the running loom (l-01, wt-l01) finishes → its worktree merges
  // clean → it FLIPS to reclaimable → the headline grows → user bulk-cleans.
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
  };
  const reset = () => {
    setReplayed(false);
    setWorktrees(DEMO_WORKTREES);
  };
  const remove = (ids: string[]) =>
    setWorktrees((ws) => ws.filter((w) => !ids.includes(w.id)));

  const controls = (_theme: Theme) => (
    <ReplayBar replayed={replayed} onFinish={finishLoom} onReset={reset} />
  );

  return (
    <HubShell controls={controls}>
      {() => (
        <div className="flex h-full flex-col">
          <GitHeaderStrip />
          <div className="min-h-0 flex-1 overflow-y-auto">
            {/* keyed so finishing the loom re-derives the default selection */}
            <WorktreesSection
              key={replayed ? "post" : "pre"}
              worktrees={worktrees}
              onRemove={remove}
            />
            <div className="h-px bg-border" />
            <BranchesSection />
            <div className="h-px bg-border" />
            <ActivitySection />
          </div>
        </div>
      )}
    </HubShell>
  );
}
