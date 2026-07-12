"use client";

// M3 (read-only surface) — the consolidated deliverable badge. When a woven
// root has been built under worktree isolation, its every-thread work is folded
// onto a persistent review branch `telar/<rootId>` (looms.ts `consolidationBranch`).
// This surfaces that branch name, copyable, and reinforces the moat in the UI:
// the branch is a DELIVERABLE for human review — it is NOT merged until the
// owner clicks accept. Pure display; no mutation, no accept button here.
import { useState } from "react";
import { Check, Copy, GitBranch } from "lucide-react";
import type { Loom } from "@telar/core";
import { cn } from "@/lib/utils";

// Only a woven root that finished under isolation carries a consolidationBranch,
// and only once it has reached ready/done is the branch a meaningful deliverable
// to surface. Anything else renders nothing.
export function ConsolidationBranch({ loom }: { loom: Loom }) {
  const branch = loom.consolidationBranch;
  if (!branch) return null;
  if (loom.state !== "ready" && loom.state !== "done") return null;

  const landed = loom.state === "done" && !!loom.commit;

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-muted/20 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <GitBranch className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground/80">Review branch</span>
        <CopyBranch branch={branch} />
      </div>
      <p className="text-xs text-muted-foreground">
        {landed ? (
          <>
            Landed as{" "}
            <span className="font-mono text-foreground/70">{loom.commit!.slice(0, 10)}</span> — the
            owner accepted this weave and the branch was merged to the base branch.
          </>
        ) : (
          <>
            The gathered work for every thread, waiting on the loom.{" "}
            <span className="font-medium text-foreground/70">Not yet merged</span> — accept the loom
            to land it on the base branch.
          </>
        )}
      </p>
    </div>
  );
}

// The branch name, monospaced, with a click-to-copy affordance — the branch is
// the thing a reviewer checks out, so make it one click to grab.
function CopyBranch({ branch }: { branch: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(branch).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => {},
        );
      }}
      title={`Copy branch name ${branch}`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded border border-border bg-background px-1.5 py-0.5",
        "font-mono text-[11px] text-foreground/80 transition-colors hover:text-foreground",
      )}
    >
      {branch}
      {copied ? (
        <Check className="size-3 text-emerald-500" />
      ) : (
        <Copy className="size-3 opacity-60" />
      )}
    </button>
  );
}
