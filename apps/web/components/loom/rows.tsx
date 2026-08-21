"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronDownIcon, CircleDashedIcon, CircleDotIcon, Loader2Icon, TerminalIcon } from "lucide-react";
import type { Loom, LoomState } from "@telar/engine-client";
import { loomStep } from "@/lib/loom-deck";
import { fmtAgo } from "@/lib/format";
import { sessionHref } from "@/lib/session-list";
import { GateChip } from "./gate-chip";

/**
 * A LOOM IS A SESSION, NOT A CARD.
 *
 * One line: a dot, a title, and a second micro-line saying what it is doing.
 * The earlier pass drew these as tracker cards — a bold reference number, a row
 * of coloured labels, a milestone — and every one of those is a shape borrowed
 * from ONE forge's schema. An `item` here is a STRING the project's own `list`
 * command produced; it may be `#491`, `inbox.md:12`, or a sentence. Nothing on
 * this surface may assume otherwise, and the idiom test enforces it.
 *
 * The title is the headline because the title is what a person recognises. The
 * item ref rides the second line in mono, small, as addressing rather than as
 * identity — the same treatment a session's id gets everywhere else in Telar.
 */

const DOT: Record<LoomState, { className: string; spin: boolean; dashed: boolean }> = {
  queued: { className: "text-muted-foreground/40", spin: false, dashed: true },
  working: { className: "text-info", spin: true, dashed: false },
  gating: { className: "text-info", spin: true, dashed: false },
  publishing: { className: "text-info", spin: true, dashed: false },
  published: { className: "text-success", spin: false, dashed: false },
  stuck: { className: "text-warning", spin: false, dashed: false },
  parked: { className: "text-muted-foreground/50", spin: false, dashed: true },
  asking: { className: "text-warning", spin: false, dashed: false },
  cancelled: { className: "text-muted-foreground/40", spin: false, dashed: true },
};

export function LoomDot({ state, className = "" }: { state: LoomState; className?: string }) {
  const tone = DOT[state];
  if (tone.spin) return <Loader2Icon className={`size-3 shrink-0 animate-spin ${tone.className} ${className}`} />;
  const Icon = tone.dashed ? CircleDashedIcon : CircleDotIcon;
  return <Icon className={`size-3 shrink-0 ${tone.className} ${className}`} />;
}

/** The loom's own display name. An untitled loom falls back to its item ref —
 *  which is addressing, and is the honest thing to show when nothing better is
 *  known, rather than an empty line that reads as a loading state. */
export function loomTitle(loom: Pick<Loom, "title" | "item">): string {
  return loom.title.trim() === "" ? loom.item : loom.title;
}

/**
 * THE DECK'S ROW — IT ANSWERS ONE QUESTION.
 *
 *   *What is this, and what do I do about it?*
 *
 * Title, item, state, gate, and the branch ONCE. A published row used to draw
 * the gate chip twice, the branch twice, a full session id and an absolute
 * worktree path: the bombardment the page was restructured to end, reassembled
 * inside 60px. The addressing moved behind the disclosure — real, and not what
 * a person reads the deck for in the morning.
 *
 * `trailing` WENT WITH IT: one caller, which used it to draw the second gate
 * chip. `children` stays — that is where a section hangs its own VERB, which is
 * the one thing a row cannot supply for itself.
 */
export function LoomRow({ loom, now, children }: { loom: Loom; now: number; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  /** Addressing: how to find this thing on disk or in the engine. Real, and
   *  never the headline. Absent on a loom that never got a worktree. */
  const addressable = Boolean(loom.sessionId || loom.worktreePath);

  return (
    <div className="rounded-lg border border-border/70 bg-card px-3 py-2">
      <div className="flex items-start gap-2.5">
        <LoomDot state={loom.state} className="mt-1" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{loomTitle(loom)}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <span className="truncate font-mono text-muted-foreground/70">{loom.item}</span>
            <span className="text-muted-foreground/40">·</span>
            <span className="truncate">{loomStep(loom)}</span>
            {loom.branch && <span className="truncate font-mono text-muted-foreground/60">{loom.branch}</span>}
            {/* THE ONE GATE CHIP. `gate-chip.tsx` is the only renderer and this
                is the only place a deck row calls it. */}
            {loom.gate && <GateChip gate={loom.gate} />}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground/70">{fmtAgo(loom.updatedAt, now)}</span>
          {addressable && (
            <button
              type="button"
              onClick={() => setOpen(!open)}
              aria-expanded={open}
              aria-label={open ? "Hide addressing" : "Show addressing"}
              className="rounded p-0.5 text-muted-foreground/50 transition-colors hover:text-foreground"
            >
              <ChevronDownIcon className={`size-3 transition-transform ${open ? "rotate-180" : ""}`} />
            </button>
          )}
        </div>
      </div>
      {loom.sessionId && <SessionLine loom={loom} />}
      {open && <Addressing loom={loom} />}
      {children}
    </div>
  );
}

/**
 * THE LIVE SESSION ROW under a loom in flight.
 *
 * A loom OWNS a session, so the session lives inside it — one level of nesting,
 * bounded — rather than as a sibling in a rail that would grow without limit.
 * It links to the stock cockpit: reading the transcript is that page's job and
 * this row does not try to be a second one.
 *
 * IT NAMES NO ID. "session running" is the fact; `session_d7868765d2b6…` is the
 * address, and an address belongs behind the disclosure with the worktree path.
 */
function SessionLine({ loom }: { loom: Loom }) {
  if (!loom.sessionId) return null;
  const live = loom.state === "working";
  return (
    <div className="mt-1.5 ml-[1.4rem] border-l border-border/60 pl-3">
      <Link
        href={sessionHref({ id: loom.sessionId, projectId: loom.projectId })}
        className="inline-flex items-center gap-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
      >
        {live ? (
          <Loader2Icon className="size-3 shrink-0 animate-spin text-info" />
        ) : (
          <TerminalIcon className="size-3 shrink-0 text-muted-foreground/50" />
        )}
        <span className="truncate">{live ? "session running" : "session"}</span>
      </Link>
    </div>
  );
}

/** The addressing, disclosed. Kept rather than dropped — at 2am the worktree
 *  path is the first thing you want — and not on the collapsed row, because at
 *  9am it is a wall of hex between you and the title. */
function Addressing({ loom }: { loom: Loom }) {
  return (
    <div className="mt-1.5 ml-[1.4rem] space-y-0.5 border-l border-border/60 pl-3 font-mono text-[10px] text-muted-foreground/60">
      {loom.sessionId && <div className="truncate">{loom.sessionId}</div>}
      {loom.worktreePath && <div className="truncate">{loom.worktreePath}</div>}
    </div>
  );
}

/** A section heading with its count and an optional right-hand hint. */
export function Section({
  icon: Icon,
  title,
  count,
  hint,
  children,
}: {
  icon: React.ElementType;
  title: string;
  count: number;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <Icon className="size-3.5 shrink-0 translate-y-0.5 text-muted-foreground" />
        <h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>
        <span className="font-mono text-[12px] text-muted-foreground/60">{count}</span>
        {hint && <span className="ml-auto text-[11px] text-muted-foreground/70">{hint}</span>}
      </div>
      {children}
    </section>
  );
}
