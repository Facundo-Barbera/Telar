"use client";

// LANE: project (NEW) — project-git-remote. GitHub Issues + PRs as a section of
// the Git tab, split into Issues | Pull requests sub-tabs. Dense rows.
//
// HONESTY: this is AUTH-GATED FUTURE work — Telar would read via the `gh` CLI
// when available. The "not connected" empty state is a FIRST-CLASS design, not
// an afterthought: use the controls toggle to see it. Read-only-first. PR rows
// carry a linked-loom chip when a loom wove that branch (the registry knows).
import { useState } from "react";
import {
  CheckCircle2Icon,
  CircleDotIcon,
  ClockIcon,
  GitMergeIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  PlugZapIcon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fmtAgo } from "@/lib/format";
import {
  DEMO_ISSUES,
  DEMO_PRS,
  type ChecksState,
  type DemoIssue,
  type DemoPR,
  type RemoteState,
} from "./git-fixtures";
import { GitChip, HubShell } from "./git-shared";
import type { Theme } from "./shared";

/* ------------------------------------------------------------ state chips */

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

/* --------------------------------------------------------------- rows */

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

/* -------------------------------------------------------- empty state */

function NotConnected() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
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
      <Badge
        variant="outline"
        className="mt-2 border-amber-500/30 bg-amber-500/5 px-2 py-0.5 text-[10px] text-amber-300"
      >
        future · read-only
      </Badge>
    </div>
  );
}

/* --------------------------------------------------------------- body */

type Sub = "issues" | "prs";

function RemoteBody() {
  const [sub, setSub] = useState<Sub>("prs");
  const openIssues = DEMO_ISSUES.filter((i) => i.state === "open").length;
  const openPRs = DEMO_PRS.filter((p) => p.state === "open" || p.state === "draft").length;

  const subs: { key: Sub; label: string; icon: LucideIcon; count: number }[] = [
    { key: "issues", label: "Issues", icon: CircleDotIcon, count: openIssues },
    { key: "prs", label: "Pull requests", icon: GitPullRequestIcon, count: openPRs },
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border px-4 pt-2">
        {subs.map((s) => {
          const on = sub === s.key;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => setSub(s.key)}
              className={cn(
                "flex items-center gap-1.5 rounded-t-md border-b-2 px-3 py-1.5 text-xs font-medium transition-colors",
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
      <div className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
        {sub === "issues"
          ? DEMO_ISSUES.map((i) => <IssueRow key={i.number} issue={i} />)
          : DEMO_PRS.map((p) => <PRRow key={p.number} pr={p} />)}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- demo */

export function GitRemoteDemo() {
  const [connected, setConnected] = useState(true);

  const controls = (_theme: Theme) => (
    <div className="inline-flex items-center rounded-md border border-border bg-card p-0.5">
      {([["connected", "gh connected"], ["off", "not connected"]] as const).map(
        ([key, label]) => {
          const active = connected === (key === "connected");
          return (
            <button
              key={key}
              type="button"
              onClick={() => setConnected(key === "connected")}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium transition-colors",
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
  );

  return (
    <HubShell controls={controls}>
      {() => (connected ? <RemoteBody /> : <NotConnected />)}
    </HubShell>
  );
}
