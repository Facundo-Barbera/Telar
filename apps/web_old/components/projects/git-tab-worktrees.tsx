"use client";

// WORKTREES sub-view. Reclaimable rows (merged + clean + no active loom, server-
// computed) are checkbox-selected by default; dirty/unmerged-but-removable rows
// require a per-row TYPED force (type the basename) that sets force:true; rows
// the server marks non-removable (main checkout / server tree / active loom) are
// locked with no affordance — force can never override them. Clean up opens a
// confirm modal listing the exact removals; the server's per-item refusals are
// rendered honestly.
import { useMemo, useState } from "react";
import {
  CircleDotIcon,
  GitBranchIcon,
  LockIcon,
  ShieldAlertIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { fmtAgo } from "@/lib/format";
import {
  GitChip,
  REFUSAL_TEXT,
  SectionBand,
  fmtSize,
  isActiveLoomState,
  type CleanupItem,
  type CleanupResponse,
  type CleanupResult,
  type WorktreeRow,
} from "./git-tab-shared";

function OwnerChip({ w }: { w: WorktreeRow }) {
  if (w.owner.kind === "manual") {
    return <GitChip tone="muted">manual</GitChip>;
  }
  return (
    <GitChip
      tone="active"
      className="border-indigo-500/30 bg-indigo-500/10 text-indigo-300"
    >
      {w.owner.loomId}
    </GitChip>
  );
}

function WorktreeStateChips({ w }: { w: WorktreeRow }) {
  const activeLoom =
    w.owner.kind === "loom" && isActiveLoomState(w.owner.loomState);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {w.isMainCheckout && <GitChip tone="muted">main checkout</GitChip>}
      {w.isServerWorktree && <GitChip tone="muted">server tree</GitChip>}
      {activeLoom && (
        <GitChip tone="active">
          <CircleDotIcon className="size-2.5" />
          active loom
        </GitChip>
      )}
      {w.merged && <GitChip tone="merged">merged</GitChip>}
      {w.dirty && <GitChip tone="dirty">dirty</GitChip>}
      {w.stale && <GitChip tone="stale">stale</GitChip>}
      {w.reclaimable && (
        <GitChip tone="reclaimable">
          <Trash2Icon className="size-2.5" />
          reclaimable
        </GitChip>
      )}
    </div>
  );
}

function WorktreeRowView({
  w,
  checked,
  forced,
  onToggle,
  onArmForce,
}: {
  w: WorktreeRow;
  checked: boolean;
  forced: boolean;
  onToggle: () => void;
  onArmForce: () => void;
}) {
  const marked = checked || forced;
  return (
    <div
      className={cn(
        "flex items-start gap-3 px-4 py-2.5 transition-colors",
        marked ? "bg-primary/5" : "hover:bg-muted/30",
      )}
    >
      {/* select control — checkbox for reclaimable, force for removable, lock else */}
      <div className="pt-0.5">
        {w.reclaimable ? (
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
        ) : w.removable ? (
          <span
            className="flex size-4 items-center justify-center rounded border border-dashed border-border/60"
            title="Not safely reclaimable — force required"
          />
        ) : (
          <LockIcon
            className="size-4 text-muted-foreground/50"
            aria-label="Removal always refused"
          />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-mono text-sm font-medium" title={w.path}>
            {w.basename}
          </span>
          <OwnerChip w={w} />
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <GitBranchIcon className="size-3 shrink-0" />
          <span className="truncate font-mono">
            {w.branch ?? "(detached)"}
          </span>
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
        <span className="text-xs text-muted-foreground">
          {fmtAgo(w.updatedAt)}
        </span>
        {w.removable && !w.reclaimable && !forced && (
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

function ForceConfirm({
  w,
  onArm,
  onCancel,
}: {
  w: WorktreeRow;
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
        <Button size="sm" variant="destructive" disabled={!ok} onClick={onArm}>
          Arm
        </Button>
      </div>
    </div>
  );
}

function CleanupDialog({
  worktrees,
  deleteBranches,
  busy,
  onToggleBranches,
  onCancel,
  onConfirm,
}: {
  worktrees: WorktreeRow[];
  deleteBranches: boolean;
  busy: boolean;
  onToggleBranches: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const totalMb = worktrees.reduce((n, w) => n + (w.sizeMb ?? 0), 0);
  const anyNullSize = worktrees.some((w) => w.sizeMb == null);
  const mergedCount = worktrees.filter((w) => w.merged).length;
  const anyForced = worktrees.some((w) => !w.reclaimable);
  // Contained modal: absolute within the git body (no transformed ancestors),
  // so it covers the stage — not the whole browser viewport.
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Dismiss"
        onClick={busy ? undefined : onCancel}
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
                {w.reclaimable ? (
                  <GitChip tone="reclaimable">safe</GitChip>
                ) : (
                  <GitChip tone="dirty">forced</GitChip>
                )}
                <span
                  className="min-w-0 flex-1 truncate font-mono text-xs"
                  title={w.path}
                >
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
              {mergedCount === 1 ? "" : "es"} (safe delete only)
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
            frees {anyNullSize ? "≥ " : ""}
            {fmtSize(totalMb)}
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={onCancel}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={onConfirm}
              disabled={busy}
            >
              {busy ? <Spinner /> : <Trash2Icon />}
              Remove
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Per-item outcome banner rendered after a cleanup POST resolves — honest about
// what the server actually refused, keyed to the machine-stable reason.
function ResultsBanner({
  results,
  onDismiss,
}: {
  results: CleanupResult[];
  onDismiss: () => void;
}) {
  const ok = results.filter((r) => r.ok);
  const refused = results.filter((r) => !r.ok);
  return (
    <div
      className={cn(
        "mx-4 mt-2 rounded-lg border px-3 py-2 text-xs",
        refused.length > 0
          ? "border-amber-500/30 bg-amber-500/5"
          : "border-emerald-500/30 bg-emerald-500/5",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="font-medium text-foreground">
          {ok.length > 0 && `Removed ${ok.length}`}
          {ok.length > 0 && refused.length > 0 && " · "}
          {refused.length > 0 && `${refused.length} refused`}
          {ok.length === 0 && refused.length === 0 && "Nothing to remove"}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          className="ml-auto text-muted-foreground hover:text-foreground"
        >
          Dismiss
        </button>
      </div>
      {refused.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {refused.map((r) => (
            <li key={`${r.kind}:${r.id}`} className="flex items-start gap-1.5">
              <span className="shrink-0 font-mono text-muted-foreground">
                {r.id}
              </span>
              <span className="text-muted-foreground/90">
                — {r.refusedReason ? REFUSAL_TEXT[r.refusedReason] : "refused"}
                {r.detail ? ` (${r.detail})` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function WorktreesSection({
  worktrees,
  onCleanup,
}: {
  worktrees: WorktreeRow[];
  onCleanup: (items: CleanupItem[]) => Promise<CleanupResponse>;
}) {
  // default selection = reclaimable rows only (server-proven safe)
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(worktrees.filter((w) => w.reclaimable).map((w) => w.id)),
  );
  const [forced, setForced] = useState<Set<string>>(new Set());
  const [forcing, setForcing] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteBranches, setDeleteBranches] = useState(true);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<CleanupResult[] | null>(null);

  const toRemove = useMemo(
    () => worktrees.filter((w) => selected.has(w.id) || forced.has(w.id)),
    [worktrees, selected, forced],
  );

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const confirmRemoval = async () => {
    const items: CleanupItem[] = toRemove.map((w) =>
      w.reclaimable
        ? {
            kind: "worktree",
            id: w.id,
            deleteMergedBranch: deleteBranches && w.merged,
          }
        : {
            kind: "worktree",
            id: w.id,
            force: true,
            confirm: w.basename,
            deleteMergedBranch: deleteBranches && w.merged,
          },
    );
    setBusy(true);
    try {
      const res = await onCleanup(items);
      setResults(res.results);
      setSelected(new Set());
      setForced(new Set());
      setDialogOpen(false);
    } catch (e) {
      setResults([
        {
          id: "request",
          kind: "worktree",
          ok: false,
          refusedReason: "git-error",
          detail: e instanceof Error ? e.message : String(e),
        },
      ]);
    } finally {
      setBusy(false);
    }
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

      <p className="px-4 pb-1 text-[11px] text-muted-foreground">
        Reclaimable = merged, clean, and not backing an active loom — Telar proves
        it, so you never reverse-engineer safety.
      </p>

      {results && (
        <ResultsBanner results={results} onDismiss={() => setResults(null)} />
      )}

      {worktrees.length === 0 ? (
        <p className="px-4 py-10 text-center text-xs text-muted-foreground">
          No worktrees — the main checkout is the only working tree.
        </p>
      ) : (
        <div className="divide-y divide-border">
          {worktrees.map((w) => (
            <div key={w.id}>
              <WorktreeRowView
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
      )}

      {dialogOpen && (
        <CleanupDialog
          worktrees={toRemove}
          deleteBranches={deleteBranches}
          busy={busy}
          onToggleBranches={() => setDeleteBranches((b) => !b)}
          onCancel={() => setDialogOpen(false)}
          onConfirm={() => void confirmRemoval()}
        />
      )}
    </div>
  );
}
