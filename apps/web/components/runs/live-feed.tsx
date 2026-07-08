"use client";

import { useEffect, useRef } from "react";
import {
  CircleCheckIcon,
  CircleXIcon,
  LayersIcon,
  OctagonXIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";
import type { GateResult, RunEvent, Verdict, WorkUnitState } from "@telar/core";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { shortId } from "@/lib/format";
import { isActive, fmtMs } from "./utils";

function Separator({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-1 text-[11px] text-muted-foreground/60">
      {children}
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function renderEvent(ev: RunEvent, i: number): React.ReactNode {
  switch (ev.type) {
    case "attempt":
      return (
        <div key={i} className="flex items-center gap-2 pt-3 pb-0.5">
          <LayersIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-xs font-medium">attempt {String(ev.n)}</span>
          <Badge variant="secondary" className="font-mono text-[10px]">
            {String(ev.role)} · {String(ev.model)}
          </Badge>
          <div className="h-px flex-1 bg-border" />
        </div>
      );
    case "state":
      return (
        <Separator key={i}>
          <span className="uppercase tracking-wide">{String(ev.state)}</span>
        </Separator>
      );
    case "session":
      return (
        <div key={i} className="font-mono text-[11px] text-muted-foreground/50">
          session {shortId(String(ev.sessionId))}
        </div>
      );
    case "text":
      return (
        <p key={i} className="text-sm leading-relaxed text-muted-foreground">
          {String(ev.text)}
        </p>
      );
    case "tool":
      return (
        <Badge key={i} variant="secondary" className="w-fit font-mono text-xs">
          <WrenchIcon className="size-3" />
          {String(ev.name)}
        </Badge>
      );
    case "gate": {
      const g = ev.result as GateResult;
      return (
        <div key={i} className="flex items-center gap-2 text-sm">
          {g.ok ? (
            <CircleCheckIcon className="size-4 shrink-0 text-emerald-400" />
          ) : (
            <CircleXIcon className="size-4 shrink-0 text-destructive" />
          )}
          <span className="truncate">
            gate <span className="font-medium">{g.name}</span>{" "}
            {g.ok ? "passed" : "failed"}
          </span>
          <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
            {fmtMs(g.durationMs)}
          </span>
        </div>
      );
    }
    case "verdict": {
      const v = ev.verdict as Verdict;
      return (
        <div key={i} className="flex items-start gap-2 text-sm">
          {v.ok ? (
            <CircleCheckIcon className="mt-px size-4 shrink-0 text-emerald-400" />
          ) : (
            <TriangleAlertIcon className="mt-px size-4 shrink-0 text-amber-400" />
          )}
          <span className="leading-snug">
            {v.summary}
            {v.blocker && (
              <span className="text-amber-300/90"> — {v.blocker}</span>
            )}
          </span>
        </div>
      );
    }
    case "agent-result":
      return (
        <div key={i} className="font-mono text-[11px] text-muted-foreground/60">
          result · {String(ev.subtype)}
          {ev.turns !== undefined && ` · ${String(ev.turns)} turns`}
          {typeof ev.costUsd === "number" && ` · $${ev.costUsd.toFixed(4)}`}
        </div>
      );
    case "error":
      return (
        <div key={i} className="flex items-start gap-2 text-sm text-destructive">
          <OctagonXIcon className="mt-px size-4 shrink-0" />
          <span className="leading-snug">{String(ev.message)}</span>
        </div>
      );
    default:
      return (
        <div key={i} className="font-mono text-[11px] text-muted-foreground/50">
          {ev.type}
        </div>
      );
  }
}

function shimmerLabel(events: RunEvent[], state: WorkUnitState): string {
  if (state === "verifying") return "Verifying…";
  if (state === "preparing") return "Preparing…";
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "text") break;
    if (e.type === "tool") return String(e.name);
  }
  return "Weaving…";
}

export function LiveFeed({
  events,
  state,
}: {
  events: RunEvent[];
  state: WorkUnitState;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const active = isActive(state);

  // Keep pinned to the newest event unless the user has scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events, active]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="flex max-h-[60vh] min-h-40 flex-col gap-1.5 overflow-y-auto px-1"
    >
      {events.length === 0 && !active && (
        <p className="py-6 text-center text-sm text-muted-foreground/60">
          No activity recorded.
        </p>
      )}
      {events.map((ev, i) => renderEvent(ev, i))}
      {active && (
        <div className="sticky bottom-0 flex items-center gap-2 bg-gradient-to-t from-card to-transparent pt-2 pb-1">
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full animate-pulse",
              state === "verifying" ? "bg-violet-400" : "bg-sky-400",
            )}
          />
          <Shimmer className="text-sm">{shimmerLabel(events, state)}</Shimmer>
        </div>
      )}
    </div>
  );
}
