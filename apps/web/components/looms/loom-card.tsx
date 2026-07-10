"use client";

// The one LoomCard every loom surface renders: the looms list, the
// dashboard's Active now / Needs attention / Recent looms sections. Two
// layouts share the same data plumbing (role, rail, cost, age) so the list
// and the dashboard visually rhyme instead of drifting per-page.
import Link from "next/link";
import { ClockIcon, FolderGit2Icon, WorkflowIcon } from "lucide-react";
import type { Loom } from "@telar/core";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { StateBadge } from "@/components/common/state-badge";
import { fmtAgo, fmtCost } from "@/lib/format";
import { fmtDuration, loomRole, stateRailClass, sumCost, threadCount } from "./utils";

// WEAVE identity marker — indigo, deliberately outside the state palette
// (sky/violet/primary/amber/destructive/muted, already owned by StateBadge +
// the state rail) so a woven loom sitting in needs-review never shows two
// competing amber signals: state stays amber, "this weaves threads" stays
// indigo, always.
function WeaveChip({ loom }: { loom: Loom }) {
  if (loomRole(loom) !== "woven") return null;
  const n = threadCount(loom);
  return (
    <Badge
      variant="outline"
      className="shrink-0 border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0 font-mono text-[10px] text-indigo-300"
    >
      <WorkflowIcon className="size-2.5" />
      {n == null ? "weave" : `${n} thread${n === 1 ? "" : "s"}`}
    </Badge>
  );
}

// VERIFY looms are read-only judgments — no writes. A subtle outline-only
// badge (rather than the plain mono text every other kind gets) marks that
// distinction without competing with the weave chip's indigo or any state
// color. Everything else (single, and verify's own kind) stays plain text.
function KindLabel({ loom }: { loom: Loom }) {
  if (loomRole(loom) === "verify") {
    return (
      <Badge
        variant="outline"
        className="px-1.5 py-0 font-mono text-[10px] text-muted-foreground"
      >
        {loom.kind}
      </Badge>
    );
  }
  return <span className="font-mono">{loom.kind}</span>;
}

function ErrorSnippet({ loom }: { loom: Loom }) {
  if (!loom.error || (loom.state !== "failed" && loom.state !== "needs-review")) {
    return null;
  }
  return (
    <p
      className={cn(
        "mt-1 line-clamp-2 font-mono text-xs",
        loom.state === "failed" ? "text-destructive" : "text-amber-300",
      )}
    >
      {loom.error}
    </p>
  );
}

export function LoomCard({
  loom,
  layout = "row",
  now,
  showError = false,
  className,
}: {
  loom: Loom;
  /** 'row' — horizontal, divide-y list item. 'tile' — shadcn Card. */
  layout?: "row" | "tile";
  /** Tick source for a live elapsed clock on layout="tile" (Date.now(), refreshed by the caller). Omit for a static card. */
  now?: number;
  /** Reproduce AttentionRow's line-clamp-2 error snippet, toned destructive/amber by state. */
  showError?: boolean;
  className?: string;
}) {
  const cost = fmtCost(sumCost(loom.attempts));
  const attempts = loom.attempts.length;

  if (layout === "tile") {
    return (
      <Link href={`/looms/${loom.id}`} className="block">
        <Card
          size="sm"
          className={cn(
            "relative gap-2 overflow-hidden transition-shadow hover:ring-foreground/20",
            className,
          )}
        >
          <span
            aria-hidden
            className={cn(
              "absolute top-0 bottom-0 left-0 w-[3px]",
              stateRailClass(loom.state),
            )}
          />
          <CardContent className="flex flex-col gap-2 pl-3">
            <div className="flex items-center gap-2">
              <StateBadge state={loom.state} />
              <WeaveChip loom={loom} />
              {now != null && (
                <span className="ml-auto flex items-center gap-1 font-mono text-xs text-muted-foreground tabular-nums">
                  <ClockIcon className="size-3.5" />
                  {fmtDuration(now - loom.createdAt)}
                </span>
              )}
            </div>
            <span className="truncate text-sm font-medium">{loom.title}</span>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <FolderGit2Icon className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{loom.project}</span>
              <span className="text-border">·</span>
              <KindLabel loom={loom} />
              <span className="ml-auto font-mono tabular-nums">{cost}</span>
            </div>
          </CardContent>
        </Card>
      </Link>
    );
  }

  return (
    <Link
      href={`/looms/${loom.id}`}
      className={cn(
        "relative flex items-start gap-3 py-3 pr-3 pl-4 transition-colors hover:bg-muted/40",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full",
          stateRailClass(loom.state),
        )}
      />
      <StateBadge state={loom.state} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {loom.title}
          </span>
          <WeaveChip loom={loom} />
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <KindLabel loom={loom} />
          <span className="text-border">·</span>
          <span className="min-w-0 flex-1 truncate">{loom.project}</span>
          <span className="text-border">·</span>
          <span className="shrink-0">
            {attempts} {attempts === 1 ? "attempt" : "attempts"}
          </span>
        </div>
        {showError && <ErrorSnippet loom={loom} />}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span className="font-mono text-xs">{cost}</span>
        <span className="text-xs text-muted-foreground">{fmtAgo(loom.updatedAt)}</span>
      </div>
    </Link>
  );
}
