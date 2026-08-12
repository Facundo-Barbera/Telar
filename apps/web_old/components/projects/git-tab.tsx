"use client";

// PROJECT GIT TAB — the production port of the approved round-24 demo
// (lib/demo-gallery/project/git-unified.tsx). ONE dense tab whose body shows one
// sub-view at a time via a slim internal switcher: Worktrees | Branches | Remote
// | Files. A persistent header strip carries branch / ahead-behind / dirty /
// last commit and the reclaimable headline (a jump-to-Worktrees affordance).
//
// DATA: the overview (header + worktrees + branches + commits) loads in one shot
// from GET /api/projects/[name]/git; Remote and Files own their own auth-gated /
// per-path fetches. Cleanup is HUMAN-triggered (Loom Doctrine: no autonomous
// deletion) via POST .../git/cleanup, then we refetch the overview.
//
// CLIENT-BUNDLE RULE: no runtime value crosses from @telar/core — every type is
// declared locally in ./git-tab-shared.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  FolderIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GitPullRequestIcon,
  HistoryIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtAgo } from "@/lib/format";
import { dispatchTelarRefresh, refreshIncludes } from "@/lib/telar-refresh";
import { cachedJson } from "@/lib/client-json-cache";
import { Skeleton } from "@/components/ui/skeleton";
import {
  SubError,
  SubSkeleton,
  fmtSize,
  type CleanupItem,
  type CleanupRequest,
  type CleanupResponse,
  type GitOverviewResponse,
} from "./git-tab-shared";
import { WorktreesSection } from "./git-tab-worktrees";
import { BranchesSection } from "./git-tab-branches";
import { RemoteSection } from "./git-tab-remote";
import { FilesSection } from "./git-tab-files";

/* -------------------------------------------------------------- header */

function GitHeaderStrip({
  header,
  reclaimMb,
  reclaimCount,
  reclaimApprox,
  onJumpWorktrees,
}: {
  header: GitOverviewResponse["header"];
  reclaimMb: number;
  reclaimCount: number;
  reclaimApprox: boolean;
  onJumpWorktrees: () => void;
}) {
  const c = header.lastCommit;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-background/40 px-4 py-2.5">
      <div className="flex items-center gap-1.5">
        <GitBranchIcon className="size-4 text-muted-foreground" />
        <span className="font-mono text-sm font-medium">{header.branch}</span>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-0.5 font-mono tabular-nums">
          <ArrowUpIcon className="size-3" />
          {header.ahead}
        </span>
        <span className="inline-flex items-center gap-0.5 font-mono tabular-nums">
          <ArrowDownIcon className="size-3" />
          {header.behind}
        </span>
        {header.dirtyFiles > 0 && (
          <>
            <span className="text-border">·</span>
            <span className="text-amber-300">{header.dirtyFiles} dirty</span>
          </>
        )}
      </div>

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
              {reclaimApprox && reclaimMb > 0 ? "≥ " : ""}
              {fmtSize(reclaimMb > 0 ? reclaimMb : null)}
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

/* ------------------------------------------------- internal view switcher */

type ViewKey = "worktrees" | "branches" | "remote" | "files";

const VIEW_ITEMS: { key: ViewKey; label: string; icon: LucideIcon }[] = [
  { key: "worktrees", label: "Worktrees", icon: GitBranchIcon },
  { key: "branches", label: "Branches", icon: HistoryIcon },
  { key: "remote", label: "Remote", icon: GitPullRequestIcon },
  { key: "files", label: "Files", icon: FolderIcon },
];

function SectionSwitcher({
  active,
  onSelect,
}: {
  active: ViewKey;
  onSelect: (k: ViewKey) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-background/60 px-3 py-1.5">
      {VIEW_ITEMS.map((it) => {
        const on = active === it.key;
        return (
          <button
            key={it.key}
            type="button"
            onClick={() => onSelect(it.key)}
            aria-current={on ? "page" : undefined}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              on
                ? "bg-primary/10 text-foreground"
                : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
            )}
          >
            <it.icon className="size-3.5" />
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------- loading header */

function HeaderSkeleton() {
  return (
    <div className="flex shrink-0 items-center gap-4 border-b border-border bg-background/40 px-4 py-2.5">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-4 w-16" />
      <Skeleton className="ml-auto h-4 w-48" />
    </div>
  );
}

/* -------------------------------------------------------------- the tab */

export function GitTab({ name }: { name: string }) {
  const [data, setData] = useState<GitOverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<ViewKey>("worktrees");

  const load = useCallback(async (force = false) => {
    setError(null);
    try {
      setData(
        await cachedJson<GitOverviewResponse>(`/api/projects/${encodeURIComponent(name)}/git`, {
          maxAgeMs: 15_000,
          force,
        }),
      );
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [name]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(initialLoad);
  }, [load]);

  useEffect(() => {
    const onRefresh = (event: Event) => {
      if (refreshIncludes(event, "git")) void load(true);
    };
    window.addEventListener("telar:refresh", onRefresh);
    return () => window.removeEventListener("telar:refresh", onRefresh);
  }, [load]);

  // HUMAN-triggered cleanup: POST the per-item intents, then refetch the
  // overview so worktrees/branches reflect the new truth. Results flow back to
  // the calling section, which renders the server's honest per-item refusals.
  const cleanup = useCallback(
    async (items: CleanupItem[]): Promise<CleanupResponse> => {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(name)}/git/cleanup`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items } satisfies CleanupRequest),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Cleanup failed (${res.status}).`);
      }
      const out = (await res.json()) as CleanupResponse;
      await load(true);
      if (out.results.some((result) => result.ok)) {
        dispatchTelarRefresh({ domains: ["git"], project: name });
      }
      return out;
    },
    [name, load],
  );

  const reclaim = useMemo(() => {
    const r = (data?.worktrees ?? []).filter((w) => w.reclaimable);
    return {
      mb: r.reduce((n, w) => n + (w.sizeMb ?? 0), 0),
      count: r.length,
      approx: r.some((w) => w.sizeMb == null),
    };
  }, [data]);

  if (error && !data) {
    return <SubError message={error} onRetry={() => void load()} />;
  }

  if (!data) {
    return (
      <div className="flex h-full flex-col">
        <HeaderSkeleton />
        <SubSkeleton rows={5} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <GitHeaderStrip
        header={data.header}
        reclaimMb={reclaim.mb}
        reclaimCount={reclaim.count}
        reclaimApprox={reclaim.approx}
        onJumpWorktrees={() => setActive("worktrees")}
      />
      <SectionSwitcher active={active} onSelect={setActive} />

      {/* BODY — exactly one sub-view, its own scroll. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {active === "worktrees" && (
          // keyed on the worktree signature so a refetch re-derives the default
          // selection (reclaimable rows) without stale checkboxes
          <WorktreesSection
            key={data.worktrees.map((w) => `${w.id}:${w.reclaimable}`).join(",")}
            worktrees={data.worktrees}
            onCleanup={cleanup}
          />
        )}
        {active === "branches" && (
          <BranchesSection
            branches={data.branches}
            commits={data.commits}
            defaultBranch={data.defaultBranch}
            onCleanup={cleanup}
          />
        )}
        {active === "remote" && <RemoteSection name={name} />}
        {active === "files" && <FilesSection name={name} />}
      </div>
    </div>
  );
}
