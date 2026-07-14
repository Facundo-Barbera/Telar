"use client";

// BRANCHES sub-view: a GitHub-grade table (mono name, default badge, tip-commit
// line, mirrored ahead/behind bars vs the default branch, merged/stale chips)
// with a per-row delete on merged branches and a bulk "Delete N merged". Both
// go through the cleanup endpoint's branch semantics (`git branch -d` only —
// an un-merged branch is refused, never escalated to -D). A compact recent-
// commits strip sits below.
import { useMemo, useState } from "react";
import {
  CircleDotIcon,
  GitBranchIcon,
  HistoryIcon,
  Trash2Icon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fmtAgo } from "@/lib/format";
import {
  GitChip,
  REFUSAL_TEXT,
  SectionBand,
  type BranchRow,
  type CleanupItem,
  type CleanupResponse,
  type CleanupResult,
  type CommitRef,
} from "./git-tab-shared";

// Mirrored ahead/behind bars around a center axis. behind extends LEFT (amber),
// ahead RIGHT (emerald); scaled to the busiest branch so relative divergence
// reads at a glance.
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
  const pct = (n: number) =>
    max > 0 ? Math.max(n > 0 ? 12 : 0, (n / max) * 100) : 0;
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

function BranchStateChips({ b }: { b: BranchRow }) {
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
      {b.current && (
        <Badge
          variant="outline"
          className="shrink-0 gap-1 border-sky-500/40 bg-sky-500/10 px-1.5 py-0 text-[10px] text-sky-300"
        >
          current
        </Badge>
      )}
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

function BranchRowView({
  b,
  max,
  defaultName,
  deletable,
  onDelete,
}: {
  b: BranchRow;
  max: number;
  defaultName: string;
  deletable: boolean;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2 transition-colors hover:bg-muted/30">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span
            className="truncate font-mono text-sm font-medium"
            title={b.name}
          >
            {b.name}
          </span>
          <BranchStateChips b={b} />
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 pl-[1.375rem] text-xs text-muted-foreground">
          <span className="shrink-0 font-mono text-muted-foreground/80">
            {b.sha}
          </span>
          <span className="min-w-0 truncate">{b.subject}</span>
          <span className="shrink-0 text-border">·</span>
          <span className="shrink-0">{b.author}</span>
          <span className="shrink-0 text-border">·</span>
          <span className="shrink-0 text-muted-foreground/70">
            {fmtAgo(b.updatedAt)}
          </span>
        </div>
      </div>

      <AheadBehindBars
        ahead={b.ahead}
        behind={b.behind}
        max={max}
        defaultName={defaultName}
      />

      <div className="flex w-6 shrink-0 justify-end">
        {deletable && (
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

function RecentCommits({ commits }: { commits: CommitRef[] }) {
  return (
    <div className="border-t border-border bg-background/40">
      <div className="flex items-center gap-2 px-4 pt-2.5 pb-1">
        <HistoryIcon className="size-3.5 text-muted-foreground" />
        <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          Recent commits
        </span>
      </div>
      {commits.length === 0 ? (
        <p className="px-4 pb-3 text-[11px] text-muted-foreground">
          No commits yet.
        </p>
      ) : (
        <ol className="px-4 pb-3">
          {commits.map((c) => (
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
      )}
    </div>
  );
}

function ResultsNote({
  results,
  onDismiss,
}: {
  results: CleanupResult[];
  onDismiss: () => void;
}) {
  const ok = results.filter((r) => r.ok).length;
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
          {ok > 0 && `Deleted ${ok} branch${ok === 1 ? "" : "es"}`}
          {ok > 0 && refused.length > 0 && " · "}
          {refused.length > 0 && `${refused.length} refused`}
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
            <li key={r.id} className="flex items-start gap-1.5">
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

export function BranchesSection({
  branches,
  commits,
  defaultBranch,
  onCleanup,
}: {
  branches: BranchRow[];
  commits: CommitRef[];
  defaultBranch: string;
  onCleanup: (items: CleanupItem[]) => Promise<CleanupResponse>;
}) {
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<CleanupResult[] | null>(null);

  // deletable = merged, not the default, and not the checked-out branch
  const deletable = (b: BranchRow) => b.merged && !b.isDefault && !b.current;
  const merged = branches.filter(deletable);
  const max = Math.max(1, ...branches.map((b) => Math.max(b.ahead, b.behind)));

  const run = async (items: CleanupItem[]) => {
    setBusy(true);
    try {
      const res = await onCleanup(items);
      setResults(res.results);
    } catch (e) {
      setResults([
        {
          id: "request",
          kind: "branch",
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
    <div>
      <SectionBand
        icon={GitBranchIcon}
        label="Branches"
        count={branches.length}
        right={
          merged.length > 0 ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(merged.map((b) => ({ kind: "branch", name: b.name })))
              }
            >
              <Trash2Icon />
              Delete {merged.length} merged
            </Button>
          ) : undefined
        }
      />

      {results && (
        <ResultsNote results={results} onDismiss={() => setResults(null)} />
      )}

      <div className="mt-1 flex items-center gap-3 px-4 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground/70 uppercase">
        <span className="flex-1">Branch · last commit</span>
        <span className="w-[7.5rem] text-center">← behind · ahead →</span>
        <span className="w-6" />
      </div>
      <div className="divide-y divide-border border-t border-border">
        {branches.map((b) => (
          <BranchRowView
            key={b.name}
            b={b}
            max={max}
            defaultName={defaultBranch}
            deletable={deletable(b)}
            onDelete={() =>
              void run([{ kind: "branch", name: b.name }])
            }
          />
        ))}
      </div>

      <RecentCommits commits={commits} />
    </div>
  );
}
