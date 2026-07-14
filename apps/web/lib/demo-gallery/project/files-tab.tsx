"use client";

// LANE: project (NEW) — project-files-tab. A git/loom-AWARE Files proposal (the
// owner may reject it — see the entry summary). Positioned as an ORIENTATION
// surface, not an editor: a slim tree (folders collapsed by default), git-status
// badges (M/A/?), subtle heat dots on recently-churned paths, and a per-node
// "last touched by" annotation (session/loom short-id + relative time).
//
// HONESTY: fs walk + `git status` are REAL. The last-touched-by annotation is
// NOT — the session/loom store records filesTouched as a COUNT, not the paths a
// session changed (executor.ts persists `.length`). So per-node attribution
// needs a schema that records paths. Shown here as the design intent, gated by
// the toggle and flagged inline; the entry summary calls it a gap, not a fact.
import { useState } from "react";
import {
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  InfoIcon,
  MessagesSquareIcon,
  WorkflowIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { fmtAgo } from "@/lib/format";
import { DEMO_FILE_TREE, type DemoFileNode, type GitStatus } from "./git-fixtures";
import { HubShell } from "./git-shared";
import type { Theme } from "./shared";

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

export function FilesTabDemo() {
  const [showTouched, setShowTouched] = useState(true);

  const controls = (_theme: Theme) => (
    <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
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
  );

  return (
    <HubShell controls={controls}>
      {() => (
        <div className="flex h-full flex-col">
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
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {DEMO_FILE_TREE.map((n) => (
              <TreeNode key={n.name} node={n} showTouched={showTouched} />
            ))}
          </div>
        </div>
      )}
    </HubShell>
  );
}
