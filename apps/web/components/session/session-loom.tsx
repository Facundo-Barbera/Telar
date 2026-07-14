"use client";

// Loom notifications — the aggregate PILL + inline in-stream event ROWS that
// replace the permanent "Loom started" banner + header chip.
// Ported from lib/demo-gallery/chat/loom-notify.tsx (variants A + B). Data is the
// durable minimum the recon confirmed is available: state word, title + short
// id, god-view link, aggregate rollup with tone = the most-urgent loom. No
// thread/gate/elapsed detail (a reserved slot marks where that lands once the
// loom UI settles). Tone is a fixed-hue ACCENT only (dot/tint/border/ring);
// every WORD is a theme token so it re-themes in the dark shell.

import { useState } from "react";
import Link from "next/link";
import { ExternalLinkIcon, WorkflowIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type LoomTone = "weaving" | "blocked" | "ready";

// One loom as the pill/rows model it. `stateWord` is the REAL WorkUnitState
// string (running/blocked/ready/needs-review/…); `tone` is the caller's
// urgency mapping of it. `url` is the god-view link.
export type PillLoom = {
  key: string;
  id: string;
  title: string;
  tone: LoomTone;
  stateWord: string;
  url: string;
};

const URGENCY: Record<LoomTone, number> = { blocked: 3, ready: 2, weaving: 1 };

const TONE: Record<
  LoomTone,
  { dot: string; text: string; tint: string; border: string; pulse: boolean }
> = {
  weaving: {
    dot: "bg-muted-foreground/50",
    text: "text-muted-foreground",
    tint: "",
    border: "border-border",
    pulse: false,
  },
  blocked: {
    dot: "bg-amber-500",
    text: "text-amber-600",
    tint: "bg-amber-500/10",
    border: "border-amber-500/40",
    pulse: true,
  },
  ready: {
    dot: "bg-emerald-500",
    text: "text-emerald-600",
    tint: "bg-emerald-500/10",
    border: "border-emerald-500/40",
    pulse: false,
  },
};

function maxTone(looms: PillLoom[]): LoomTone {
  return looms.reduce<LoomTone>(
    (acc, l) => (URGENCY[l.tone] > URGENCY[acc] ? l.tone : acc),
    "weaving",
  );
}

// Solo → its own state + short id; N → count + most-urgent rollup.
function rollup(looms: PillLoom[]): { tone: LoomTone; label: string } {
  if (looms.length === 1) {
    const l = looms[0];
    return { tone: l.tone, label: `${l.stateWord} · ${l.id}` };
  }
  const tone = maxTone(looms);
  const blocked = looms.filter((l) => l.tone === "blocked").length;
  const ready = looms.filter((l) => l.tone === "ready").length;
  let sub = "weaving";
  if (blocked) sub = `${blocked} needs you`;
  else if (ready) sub = `${ready} ready`;
  return { tone, label: `${looms.length} looms · ${sub}` };
}

// A gentle attention pulse used when a loom parks (needs the human).
function Pulse() {
  return (
    <span className="relative flex size-1.5 shrink-0">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500/60" />
      <span className="relative inline-flex size-1.5 rounded-full bg-amber-500" />
    </span>
  );
}

function GodViewLink({ url, compact }: { url: string; compact?: boolean }) {
  return (
    <Link
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground",
        !compact && "border border-border px-1.5 py-0.5",
      )}
    >
      god-view
      <ExternalLinkIcon className="size-2.5" />
    </Link>
  );
}

function StateChip({ tone, word }: { tone: LoomTone; word: string }) {
  const t = TONE[tone];
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn("size-1.5 shrink-0 rounded-full", t.dot)} />
      <span className={cn("text-[10px] font-medium", t.text)}>{word}</span>
      {t.pulse && <Pulse />}
    </span>
  );
}

// The hover overlay: one row per loom — title, short id, state, per-row god-view
// link. Absolutely positioned → zero reflow. bg-card + text-card-foreground are
// explicit so the rows re-theme legibly (the wash-out lesson).
function LoomOverlay({ looms }: { looms: PillLoom[] }) {
  return (
    <div className="w-80 rounded-xl border border-border bg-card p-2 text-card-foreground shadow-lg">
      <div className="mb-1.5 flex items-center justify-between px-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
          Looms in this session
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">{looms.length}</span>
      </div>
      <ul className="space-y-0.5">
        {looms.map((l) => (
          <li key={l.key} className="rounded-md px-1.5 py-1.5 hover:bg-muted/50">
            <div className="flex items-center gap-1.5">
              <WorkflowIcon className={cn("size-3 shrink-0", TONE[l.tone].text)} />
              <span className="min-w-0 flex-1 truncate text-xs font-medium">{l.title}</span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">{l.id}</span>
            </div>
            <div className="mt-1 flex items-center justify-between pl-4">
              <StateChip tone={l.tone} word={l.stateWord} />
              <GodViewLink url={l.url} compact />
            </div>
          </li>
        ))}
      </ul>
      {/* Reserved for thread/gate progress once the loom UI shape settles. */}
      <div className="mt-1.5 border-t border-border px-1.5 pt-1.5 text-[10px] text-muted-foreground/60">
        details land when the loom view ships
      </div>
    </div>
  );
}

// The aggregate pill as it sits in the session heartbeat bar. Hover previews the
// overlay; click pins. ONE looms pill, never one per loom.
export function LoomsPill({ looms }: { looms: PillLoom[] }) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  if (looms.length === 0) return null;
  const open = hovered || pinned;
  const r = rollup(looms);
  const t = TONE[r.tone];

  return (
    <div
      className="relative inline-flex items-center leading-none"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        onClick={() => setPinned((v) => !v)}
        aria-expanded={open}
        title={pinned ? "Click to unpin" : "Hover to preview · click to pin"}
      >
        <Badge
          variant="outline"
          className={cn(
            "cursor-pointer gap-1.5 font-mono text-xs transition-shadow",
            t.tint,
            t.border,
            pinned && "ring-1 ring-ring",
          )}
        >
          <WorkflowIcon className={cn("size-3", t.text)} />
          <span className={cn("font-medium", t.text)}>{r.label}</span>
          {t.pulse && <Pulse />}
        </Badge>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1.5">
          <LoomOverlay looms={looms} />
        </div>
      )}
    </div>
  );
}

// ── B) inline in-stream event rows ──────────────────────────────────────────
// A durable transcript record of loom lifecycle: "Loom started/parked/resumed/
// ready · <title>" with the short id + a god-view link. Tone follows the event.

export type LoomEventRow = {
  id: string;
  loomId: string;
  title: string;
  verb: string; // "Loom started" / "Loom parked" / "Loom ready" / …
  tone: LoomTone;
  url: string;
};

export function InlineLoomRow({ row }: { row: LoomEventRow }) {
  const t = TONE[row.tone];
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border bg-muted/20 px-2.5 py-1.5 text-xs",
        t.border,
        t.tint,
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center rounded-md border border-border bg-background">
        <WorkflowIcon className={cn("size-3", t.text)} />
      </span>
      <span className={cn("shrink-0 font-medium", t.text)}>{row.verb}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">· {row.title}</span>
      {t.pulse && <Pulse />}
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">{row.loomId}</span>
      <GodViewLink url={row.url} compact />
    </div>
  );
}
