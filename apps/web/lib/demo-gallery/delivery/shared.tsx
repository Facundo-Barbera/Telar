"use client";
// LANE: delivery (UX brainstorm 2026-07-23) — shared kit for the FINAL
// delivery design. Sizing carried over from the loom cockpit kit so the two
// surfaces speak one component language: rows px-3 py-2/2.5, icons size-3.5,
// text-xs body, mono 9–10px micro. Hue on icons only; amber = a flag to
// read, never a verdict.
import { useState } from "react";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  FileTextIcon,
  FlagIcon,
  FlaskConicalIcon,
  GitCompareIcon,
  ImageIcon,
  SendIcon,
  ShieldCheckIcon,
  Undo2Icon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { EvidenceKind } from "./fixtures";

export const KIND_ICON: Record<EvidenceKind, LucideIcon> = {
  shot: ImageIcon,
  test: FlaskConicalIcon,
  log: FileTextIcon,
  diff: GitCompareIcon,
};

export function GradeBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 font-mono text-[9px] text-muted-foreground">
      <ShieldCheckIcon className="size-3 text-foreground/70" />
      release grade
    </span>
  );
}

export function RiskChip({ label }: { label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
      <FlagIcon className="size-3 text-amber-600 dark:text-amber-400" />
      {label}
    </span>
  );
}

// The courtroom rule made visible: a claim with no citation wears this.
export function UnverifiedChip() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">
      <CircleAlertIcon className="size-3 text-amber-600 dark:text-amber-400" />
      unverified — no citation
    </span>
  );
}

export function CiteChip({
  id,
  active,
  onClick,
}: {
  id: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded border px-1 py-0.5 font-mono text-[9px] transition-colors",
        active
          ? "border-foreground/50 text-foreground"
          : "border-border text-muted-foreground/70 hover:text-foreground",
      )}
    >
      {id}
    </button>
  );
}

export function ProjectTag({ name }: { name: string }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      {name}
    </span>
  );
}

// Wireframe screenshot placeholder — same idiom as the home lane's thumbs.
export function EvidenceThumb({
  evidence,
  wide,
}: {
  evidence: { label: string; age: string };
  wide?: boolean;
}) {
  return (
    <figure className={cn("shrink-0", wide ? "w-36" : "w-24")}>
      <div className="flex aspect-video flex-col gap-1 rounded-md border border-border bg-muted/30 p-1.5">
        <div className="h-1.5 w-2/3 rounded-sm bg-muted-foreground/20" />
        <div className="h-1.5 w-1/2 rounded-sm bg-muted-foreground/15" />
        <div className="mt-auto flex gap-1">
          <div className="h-3 flex-1 rounded-sm bg-muted-foreground/10" />
          <div className="h-3 w-1/3 rounded-sm bg-muted-foreground/20" />
        </div>
      </div>
      <figcaption className="mt-1 truncate font-mono text-[9px] text-muted-foreground/60">
        {evidence.label} · {evidence.age}
      </figcaption>
    </figure>
  );
}

// One verdict surface everywhere: accept-then-land or boomerang-not-bin.
// Accept resolves to the landing line (silent unless it knocks) and the
// declared drift note; boomerang opens a composer — sending is the resume.
// Pass resolved/onResolve to share one verdict between the shelf row and the
// open card; omit them and the bar keeps its own state.
export type VerdictState = "idle" | "accepted" | "boomeranged";

export function VerdictBar({
  acceptLabel,
  acceptedLine,
  boomerangLine,
  placeholder = "Tell it what to finish — it keeps its branch, worktree, and recipe…",
  compact,
  resolved,
  onResolve,
}: {
  acceptLabel: string;
  acceptedLine: string;
  boomerangLine: string;
  placeholder?: string;
  compact?: boolean;
  resolved?: VerdictState;
  onResolve?: (v: VerdictState) => void;
}) {
  const [innerResolved, setInnerResolved] = useState<VerdictState>("idle");
  const [composing, setComposing] = useState(false);
  const state = resolved ?? innerResolved;
  const resolve = (v: VerdictState) => {
    setInnerResolved(v);
    setComposing(false);
    onResolve?.(v);
  };

  if (state === "accepted") {
    return (
      <div className="flex items-start gap-2">
        <CircleCheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
          {acceptedLine}
        </p>
      </div>
    );
  }

  if (state === "boomeranged") {
    return (
      <div className="flex items-start gap-2">
        <Undo2Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
          {boomerangLine}
        </p>
      </div>
    );
  }

  if (composing) {
    return (
      <div className="space-y-2">
        <textarea
          rows={compact ? 2 : 3}
          placeholder={placeholder}
          className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-foreground/25"
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => resolve("boomeranged")}
            className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/40 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/40"
          >
            <SendIcon className="size-3" />
            Send — the loom resumes
          </button>
          <button
            type="button"
            onClick={() => setComposing(false)}
            className="px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex items-center gap-2", !compact && "gap-2.5")}>
      <button
        type="button"
        onClick={() => resolve("accepted")}
        className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/40 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/40"
      >
        <CircleCheckIcon className="size-3" />
        {acceptLabel}
      </button>
      <button
        type="button"
        onClick={() => setComposing(true)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <Undo2Icon className="size-3" />
        Boomerang — send it back
      </button>
    </div>
  );
}
