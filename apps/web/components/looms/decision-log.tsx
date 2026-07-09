"use client";

import { useEffect, useRef, type ReactNode } from "react";
import Link from "next/link";
import type { LoomEvent, OrchestratorDecision } from "@telar/core";
import { cn } from "@/lib/utils";
import { fmtAgo, shortId } from "@/lib/format";

type Entry = { key: string; ts: number; dot: string; content: ReactNode };

const DOT = {
  sky: "bg-sky-400",
  primary: "bg-primary",
  destructive: "bg-destructive",
  amber: "bg-amber-400",
  muted: "bg-muted-foreground/40",
} as const;

function decisionEntry(ev: LoomEvent, key: string): Entry | null {
  const d = ev.decision as OrchestratorDecision | undefined;
  if (!d) return null;
  switch (d.action) {
    case "schedule":
      return {
        key,
        ts: ev.ts,
        dot: DOT.sky,
        content: (
          <>
            Scheduled {d.subGoalIds.join(", ")} — {d.agents} agent{d.agents === 1 ? "" : "s"}
          </>
        ),
      };
    case "hold":
      return {
        key,
        ts: ev.ts,
        dot: DOT.muted,
        content: "Holding — waiting on in-flight threads",
      };
    case "finish-loom":
      return {
        key,
        ts: ev.ts,
        dot: DOT.primary,
        content: "Finishing the weave — every required thread is done",
      };
    case "escalate":
      return {
        key,
        ts: ev.ts,
        dot: DOT.amber,
        content: <>Escalated — {d.reason}</>,
      };
    case "repair":
      return {
        key,
        ts: ev.ts,
        dot: DOT.amber,
        content: <>Repair requested for thread {shortId(d.threadId)}</>,
      };
    case "fanout":
      return {
        key,
        ts: ev.ts,
        dot: DOT.amber,
        content: (
          <>
            Fan-out: thread {shortId(d.threadId)} → {d.pieces} agents
          </>
        ),
      };
    default:
      return null;
  }
}

function eventEntry(ev: LoomEvent, key: string): Entry | null {
  if (ev.type === "decision") return decisionEntry(ev, key);
  if (ev.type === "epic-child-spawned") {
    const subGoalId = String(ev.subGoalId);
    const childId = String(ev.childId);
    return {
      key,
      ts: ev.ts,
      dot: DOT.sky,
      content: (
        <>
          Spawned {subGoalId} → thread{" "}
          <Link href={`/looms/${childId}`} className="underline underline-offset-2 hover:text-foreground">
            {shortId(childId)}
          </Link>
        </>
      ),
    };
  }
  if (ev.type === "epic-rollup") {
    const state = String(ev.state);
    const dot =
      state === "done" ? DOT.primary : state === "failed" ? DOT.destructive : DOT.amber;
    return { key, ts: ev.ts, dot, content: <>Weave settled: {state}</> };
  }
  return null;
}

export function DecisionLog({ events }: { events: LoomEvent[] }) {
  const entries: Entry[] = [];
  events.forEach((ev, i) => {
    const entry = eventEntry(ev, String(i));
    if (entry) entries.push(entry);
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Keep pinned to the newest entry unless the user has scrolled up — same
  // stick-to-bottom pattern as LiveFeed.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="max-h-[50vh] overflow-y-auto px-1"
    >
      {entries.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground/60">
          No decisions yet.
        </p>
      ) : (
        <ol className="flex flex-col border-l border-border pl-4">
          {entries.map((e) => (
            <li key={e.key} className="relative py-2 text-sm">
              <span
                className={cn(
                  "absolute top-2.5 -left-[21px] size-2 rounded-full ring-2 ring-card",
                  e.dot,
                )}
              />
              <div className="leading-snug">{e.content}</div>
              <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                {fmtAgo(e.ts)}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
