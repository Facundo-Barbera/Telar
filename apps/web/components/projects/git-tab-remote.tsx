"use client";

// REMOTE sub-view. Fetches the AUTH-GATED `gh` endpoint on open. When the API
// says connected:false (gh missing / unauthed / no remote / gh error) it renders
// the first-class not-connected state — no fabricated rows. When connected it
// lists issues and PRs exactly like the review demo: state glyph, checks cluster,
// review chip, and the linked-loom chip when the API correlated a head branch.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CheckCircle2Icon,
  CheckIcon,
  CircleDotIcon,
  ClockIcon,
  CornerDownRightIcon,
  GitMergeIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  MessagesSquareIcon,
  PlugZapIcon,
  SearchIcon,
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
  GitChip,
  SectionBand,
  SubError,
  SubSkeleton,
  checksVerdict,
  labelColor,
  type ChecksCluster,
  type ChecksVerdict,
  type RemoteIssue,
  type RemotePR,
  type RemoteReason,
  type RemoteResponse,
  type RemoteState,
  type ReviewState,
} from "./git-tab-shared";

function RemoteStateIcon({ state }: { state: RemoteState }) {
  const map: Record<
    RemoteState,
    { icon: LucideIcon; cls: string; label: string }
  > = {
    open: { icon: CircleDotIcon, cls: "text-emerald-400", label: "open" },
    closed: {
      icon: CheckCircle2Icon,
      cls: "text-violet-400",
      label: "closed",
    },
    merged: { icon: GitMergeIcon, cls: "text-violet-400", label: "merged" },
    draft: {
      icon: GitPullRequestDraftIcon,
      cls: "text-muted-foreground",
      label: "draft",
    },
  };
  const s = map[state];
  return (
    <span className={cn("flex shrink-0 items-center", s.cls)} title={s.label}>
      <s.icon className="size-4" />
    </span>
  );
}

function ChecksClusterChip({ checks }: { checks: ChecksCluster }) {
  const verdict: ChecksVerdict = checksVerdict(checks);
  if (verdict === "none") return null;
  const total = checks.passed + checks.failed + checks.pending;
  const parts: { icon: LucideIcon; cls: string }[] = [
    { icon: XCircleIcon, cls: "text-destructive" },
    { icon: ClockIcon, cls: "text-amber-400" },
    { icon: CheckCircle2Icon, cls: "text-emerald-400" },
  ];
  const lead =
    verdict === "fail" ? parts[0] : verdict === "pending" ? parts[1] : parts[2];
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
  const map: Record<
    "approved" | "changes_requested",
    { label: string; cls: string }
  > = {
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
  if (labels.length === 0) return null;
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

function IssueRow({ issue }: { issue: RemoteIssue }) {
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

function PRRow({ pr }: { pr: RemotePR }) {
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
            <CornerDownRightIcon className="size-3 shrink-0 text-muted-foreground/50" />
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

const REASON_TEXT: Record<RemoteReason, ReactNode> = {
  "no-gh": (
    <>
      The <span className="font-mono text-foreground">gh</span> CLI isn't
      installed. Install it and re-open this tab to read issues and pull
      requests.
    </>
  ),
  unauthed: (
    <>
      The <span className="font-mono text-foreground">gh</span> CLI is installed
      but not authenticated. Run{" "}
      <span className="font-mono text-foreground">gh auth login</span> and
      re-open this tab.
    </>
  ),
  "no-remote": (
    <>
      This repo has no GitHub remote, so there are no issues or pull requests to
      read.
    </>
  ),
  "gh-error": (
    <>
      The <span className="font-mono text-foreground">gh</span> CLI returned an
      error. Nothing was written — this surface is read-only.
    </>
  ),
};

function NotConnected({
  reason,
  onRetry,
}: {
  reason: RemoteReason;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center">
      <div className="flex size-11 items-center justify-center rounded-xl border border-border bg-card">
        <PlugZapIcon className="size-5 text-muted-foreground" />
      </div>
      <div>
        <p className="text-sm font-medium">GitHub not connected</p>
        <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
          {REASON_TEXT[reason]}
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Check again
      </Button>
    </div>
  );
}

// Searchable list wrapper — a slim search field over a divided row list.
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
      {rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-xs text-muted-foreground">
          No open {noun}s.
        </p>
      ) : filtered.length > 0 ? (
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

type Sub = "issues" | "prs";

export function RemoteSection({ name }: { name: string }) {
  const [data, setData] = useState<RemoteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sub, setSub] = useState<Sub>("prs");

  const load = useCallback(async () => {
    setError(null);
    setData(null);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(name)}/git/remote`,
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Remote read failed (${res.status}).`);
      }
      setData((await res.json()) as RemoteResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [name]);

  useEffect(() => {
    void load();
  }, [load]);

  const openIssues = useMemo(
    () =>
      data?.connected
        ? data.issues.filter((i) => i.state === "open").length
        : 0,
    [data],
  );
  const openPRs = useMemo(
    () =>
      data?.connected
        ? data.prs.filter((p) => p.state === "open" || p.state === "draft")
            .length
        : 0,
    [data],
  );

  const subs: { key: Sub; label: string; icon: LucideIcon; count: number }[] = [
    { key: "issues", label: "Issues", icon: CircleDotIcon, count: openIssues },
    {
      key: "prs",
      label: "Pull requests",
      icon: GitPullRequestIcon,
      count: openPRs,
    },
  ];

  return (
    <div>
      <SectionBand
        icon={GitPullRequestIcon}
        label="Remote"
        right={
          <Badge
            variant="outline"
            className="border-amber-500/30 bg-amber-500/5 px-1.5 py-0 text-[10px] text-amber-300"
          >
            read-only
          </Badge>
        }
      />

      {error ? (
        <SubError message={error} onRetry={() => void load()} />
      ) : data === null ? (
        <SubSkeleton rows={4} />
      ) : !data.connected ? (
        <NotConnected reason={data.reason} onRetry={() => void load()} />
      ) : (
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
              rows={data.issues}
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
              rows={data.prs}
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
      )}
    </div>
  );
}
