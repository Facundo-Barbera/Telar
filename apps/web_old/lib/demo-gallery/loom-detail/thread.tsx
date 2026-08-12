"use client";

// LANE: loom-detail (UX brainstorm 2026-07-23) — Drill-in: the thread page.
// A thread is a TEAM behind a feature, not a log line. Its main agent
// compiled the flow on display (schema-validated DAG, run deterministically):
// per-node context manifests, two builder lanes in isolated worktrees merging
// on green, one bounded recompile on record. Right rail: thread-altitude
// rungs that double as the heartbeat.
//
// Expanded IN PLACE per the session's direction (the separate live-cockpit
// redesign was killed): same bones, now alive — every flow node opens its
// owner's transcript in a RIGHT DRAWER SIDEBAR (bottom panel rejected; the
// flow is the index into the conversation), the review rung opens the
// reviewer's, lane B streams live, and cross-agent events (recompile,
// mediation, handoff, findings) appear as dashed markers in every transcript
// they touch. Timers start after mount.
import { useEffect, useRef, useState } from "react";
import {
  CheckIcon,
  EyeIcon,
  MessageSquareTextIcon,
  PauseIcon,
  PlayIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { EvidenceThumb } from "../home/shared";
import { RECOMPILE, THREAD_FLOW, THREAD_RUNGS } from "./fixtures";
import type { FlowNode, Rung } from "./fixtures";
import { ASSERT_VISUAL, ActorTag, NODE_VISUAL, StateIcon } from "./shared";

type AgentId = "lead" | "builder-a" | "builder-b" | "reviewer";

const AGENT_META: Record<AgentId, { label: string; role: string; live?: boolean }> = {
  lead: { label: "lead", role: "compiles the flow · merges on green" },
  "builder-a": { label: "builder · lane A", role: "wt-a · done" },
  "builder-b": { label: "builder · lane B", role: "wt-b · building", live: true },
  reviewer: { label: "reviewer", role: "read-only by construction" },
};

// Which agent owns each flow node — clicking a node opens this transcript.
const NODE_OWNER: Record<string, AgentId> = {
  ctx: "lead",
  "nav-desktop": "builder-a",
  guards: "builder-a",
  "nav-mobile": "builder-b",
  integrate: "lead",
  "self-check": "lead",
};

type Ev =
  | { kind: "say"; t: string; text: string }
  | { kind: "tool"; t: string; call: string; result: string }
  | { kind: "evidence"; t: string; label: string }
  | { kind: "marker"; t: string; text: string }
  | { kind: "finding"; t: string; text: string };

const TRANSCRIPTS: Record<AgentId, Ev[]> = {
  lead: [
    { kind: "say", t: "07:48", text: "Picked up subgoal “client nav variant” — session claims landed, deps green." },
    { kind: "tool", t: "07:49", call: "read map · form/UX + surfaces", result: "4 files" },
    { kind: "say", t: "07:50", text: "Desktop and mobile nav touch disjoint components; role guards are middleware-side. Two lanes." },
    { kind: "marker", t: "07:52", text: "recompile #1 (bounded 1 of 2) — split nav into desktop/mobile lanes · audited" },
    { kind: "marker", t: "08:41", text: "mediation — selector drift on lane B → inner-loop retry (rung 1), resolved" },
    { kind: "say", t: "08:58", text: "Lane A handed off clean. Merge order on green: A → B, then self-check against the subgoal." },
  ],
  "builder-a": [
    { kind: "tool", t: "07:55", call: "read manifest · wt-a", result: "6 files · no secrets" },
    { kind: "tool", t: "08:02", call: "edit nav-desktop.tsx", result: "+72" },
    { kind: "tool", t: "08:11", call: "edit role-guards.ts", result: "+38" },
    { kind: "tool", t: "08:20", call: "bun test nav", result: "18/18" },
    { kind: "evidence", t: "08:26", label: "nav-desktop.png" },
    { kind: "finding", t: "08:31", text: "reviewer sent back: aria-current missing on the active item → patched, test added" },
    { kind: "marker", t: "08:58", text: "handoff → integrate: lane green, worktree clean" },
  ],
  "builder-b": [
    { kind: "tool", t: "08:05", call: "read manifest · wt-b", result: "5 files · no secrets" },
    { kind: "tool", t: "08:40", call: "bun test nav-mobile", result: "FAIL — selector drift" },
    { kind: "marker", t: "08:41", text: "inner-loop retry (rung 1) — mediated by the orchestrator, selectors re-resolved" },
    { kind: "evidence", t: "08:47", label: "client-nav.png" },
  ],
  reviewer: [
    { kind: "say", t: "08:28", text: "Review rung on lane A’s diff. I hold no pen — read-only by construction." },
    { kind: "finding", t: "08:31", text: "Finding — aria-current missing on the active nav item. Sent back to lane A." },
    { kind: "say", t: "08:35", text: "Patched. Re-review clean." },
    { kind: "marker", t: "08:35", text: "rung review → green" },
  ],
};

// Lane B's live tail — appended one event at a time after mount.
const STREAM: Ev[] = [
  { kind: "say", t: "09:03", text: "Collapsing-menu behavior on narrow widths — testing at 320px." },
  { kind: "tool", t: "09:04", call: "edit nav-mobile.tsx", result: "+24" },
  { kind: "tool", t: "09:05", call: "bun test nav-mobile", result: "11/11" },
  { kind: "evidence", t: "09:05", label: "nav-mobile-320.png" },
  { kind: "say", t: "09:06", text: "Hiding admin affordances behind the role check — final sweep before handoff." },
  { kind: "tool", t: "09:07", call: "edit nav-mobile.tsx", result: "+9" },
];

function EvRow({ ev }: { ev: Ev }) {
  if (ev.kind === "tool") {
    return (
      <div className="flex flex-wrap items-center gap-2 pl-10">
        <span className="flex items-center gap-1.5 rounded-full border border-border bg-muted/30 px-2.5 py-1 font-mono text-[10px] text-muted-foreground">
          <WrenchIcon className="size-3" />
          {ev.call}
          <CheckIcon className="size-3 text-muted-foreground/60" />
        </span>
        <span
          className={cn(
            "font-mono text-[10px]",
            ev.result.startsWith("FAIL") ? "text-destructive/80" : "text-muted-foreground/60",
          )}
        >
          {ev.result}
        </span>
      </div>
    );
  }
  if (ev.kind === "evidence") {
    return (
      <div className="pl-10">
        <EvidenceThumb evidence={{ label: ev.label, age: ev.t }} />
      </div>
    );
  }
  if (ev.kind === "marker") {
    return (
      <div className="flex items-center gap-2 py-0.5">
        <span className="h-px w-3 shrink-0 bg-border" />
        <span className="min-w-0 rounded-full border border-dashed border-border px-2.5 py-0.5 font-mono text-[9px] leading-relaxed text-muted-foreground">
          {ev.t} · {ev.text}
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }
  if (ev.kind === "finding") {
    return (
      <div className="flex items-start gap-2 pl-10">
        <EyeIcon className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <p className="min-w-0 text-xs leading-relaxed text-foreground/85">{ev.text}</p>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2">
      <span className="w-8 shrink-0 pt-0.5 text-right font-mono text-[9px] text-muted-foreground/50">
        {ev.t}
      </span>
      <p className="min-w-0 flex-1 pl-2 text-xs leading-relaxed text-foreground/90">{ev.text}</p>
    </div>
  );
}

function FlowCard({
  node,
  selected,
  onOpen,
}: {
  node: FlowNode;
  selected: boolean;
  onOpen: () => void;
}) {
  const v = NODE_VISUAL[node.state === "wait" ? "wait" : node.state];
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group w-full rounded-xl border bg-card p-3 text-left transition-colors",
        selected ? "border-foreground/30" : "border-border hover:border-foreground/20",
        node.state === "wait" && "opacity-60",
      )}
    >
      <div className="flex items-center gap-2">
        <StateIcon visual={v} className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate text-xs font-medium">{node.title}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <MessageSquareTextIcon className="size-3 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/60" />
          {node.lane && (
            <span className="rounded border border-border px-1 py-0.5 font-mono text-[9px] text-muted-foreground">
              lane {node.lane}
            </span>
          )}
        </span>
      </div>
      <p className="mt-1.5 truncate font-mono text-[9px] text-muted-foreground/60">
        manifest: {node.manifest}
      </p>
    </button>
  );
}

export function ThreadBody() {
  // Drawer starts CLOSED (session verdict: never auto-open a transcript) —
  // the page must stand on its own; conversations open when asked.
  const [open, setOpen] = useState<AgentId | null>(null);
  const [streamed, setStreamed] = useState(0);
  const [playing, setPlaying] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(
      () => setStreamed((n) => (n < STREAM.length ? n + 1 : n)),
      2400,
    );
    return () => clearInterval(id);
  }, [playing]);

  const events =
    open === "builder-b"
      ? [...TRANSCRIPTS["builder-b"], ...STREAM.slice(0, streamed)]
      : open
        ? TRANSCRIPTS[open]
        : [];

  useEffect(() => {
    const el = scrollRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [events.length, open]);

  const laneA = THREAD_FLOW.filter((n) => n.lane === "A");
  const laneB = THREAD_FLOW.filter((n) => n.lane === "B");
  const spine = THREAD_FLOW.filter((n) => !n.lane);
  const meta = open ? AGENT_META[open] : null;
  const streaming = playing && streamed < STREAM.length;

  const card = (node: FlowNode) => (
    <FlowCard
      key={node.id}
      node={node}
      selected={open !== null && NODE_OWNER[node.id] === open}
      onOpen={() => setOpen(NODE_OWNER[node.id])}
    />
  );

  return (
    <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-5xl gap-6 px-6 py-6">
            {/* the compiled flow — every node is a door to its owner's transcript */}
            <div className="min-w-0 flex-1 space-y-4">
              <div className="flex items-center gap-2">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Compiled flow
                </h2>
                <span className="font-mono text-[9px] text-muted-foreground/50">
                  click a node for its owner’s transcript
                </span>
              </div>

              {card(spine[0])}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-2.5 rounded-xl border border-dashed border-border p-2.5">
                  <p className="font-mono text-[9px] text-muted-foreground/60">
                    lane A · worktree wt-a
                  </p>
                  {laneA.map(card)}
                </div>
                <div className="space-y-2.5 rounded-xl border border-dashed border-border p-2.5">
                  <p className="flex items-center gap-1.5 font-mono text-[9px] text-muted-foreground/60">
                    lane B · worktree wt-b
                    {streaming && (
                      <span className="relative flex size-1.5">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-foreground/40" />
                        <span className="relative inline-flex size-1.5 rounded-full bg-foreground/70" />
                      </span>
                    )}
                  </p>
                  {laneB.map(card)}
                </div>
              </div>

              {spine.slice(1).map(card)}

              <button
                type="button"
                onClick={() => setOpen("lead")}
                className="w-full rounded-lg border border-dashed border-border px-3 py-2 text-left hover:border-foreground/20"
              >
                <div className="flex items-start gap-2">
                  <ActorTag actor="orchestrator" />
                  <p className="min-w-0 font-mono text-[10px] leading-relaxed text-muted-foreground">
                    {RECOMPILE}
                  </p>
                </div>
              </button>
            </div>

            {/* thread-altitude verification: the rungs */}
            <aside className="w-72 shrink-0 space-y-4">
              <div>
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Rungs
                </h2>
                <div className="mt-2 overflow-hidden rounded-xl border border-border bg-card">
                  {THREAD_RUNGS.map((r: Rung, i) => {
                    const visual =
                      r.state === "pass"
                        ? ASSERT_VISUAL.pass
                        : r.state === "run"
                          ? ASSERT_VISUAL.running
                          : ASSERT_VISUAL.pending;
                    const isReview = r.label.startsWith("review");
                    const row = (
                      <div
                        className={cn(
                          "flex items-center gap-2 px-3 py-2",
                          r.state === "queued" && "opacity-50",
                        )}
                      >
                        <StateIcon visual={visual} className="size-3.5 shrink-0" />
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate text-xs text-foreground/85",
                            isReview && "group-hover:underline",
                          )}
                        >
                          {r.label}
                        </span>
                        <span className="shrink-0 font-mono text-[9px] text-muted-foreground/50">
                          {r.age}
                        </span>
                      </div>
                    );
                    return isReview ? (
                      <button
                        key={r.label}
                        type="button"
                        onClick={() => setOpen("reviewer")}
                        className={cn(
                          "group block w-full text-left",
                          i > 0 && "border-t border-border/60",
                        )}
                        title="Open the reviewer's transcript"
                      >
                        {row}
                      </button>
                    ) : (
                      <div key={r.label} className={cn(i > 0 && "border-t border-border/60")}>
                        {row}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div>
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Latest evidence
                </h2>
                <div className="mt-2">
                  <EvidenceThumb
                    evidence={
                      streamed >= 4
                        ? { label: "nav-mobile-320.png", age: "just now" }
                        : { label: "client-nav.png", age: "2m" }
                    }
                    wide
                  />
                </div>
              </div>

            </aside>
          </div>
        </div>

        {/* the transcript drawer — a right sidebar, one conversation per agent,
            indexed by the flow */}
        {open && meta && (
          <aside className="flex w-96 shrink-0 flex-col border-l border-border bg-muted/10">
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
              <span className="min-w-0 truncate font-mono text-xs font-medium">
                {meta.label}
              </span>
              <span className="min-w-0 truncate font-mono text-[9px] text-muted-foreground/50">
                {meta.role}
              </span>
              {meta.live && (
                <button
                  type="button"
                  onClick={() => setPlaying((p) => !p)}
                  className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted/40"
                >
                  {playing ? <PauseIcon className="size-3" /> : <PlayIcon className="size-3" />}
                  {playing ? "pause" : "resume"}
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(null)}
                className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 hover:bg-muted"
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
            <div
              ref={scrollRef}
              onScroll={() => {
                const el = scrollRef.current;
                if (el)
                  followRef.current =
                    el.scrollHeight - el.scrollTop - el.clientHeight < 60;
              }}
              className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 py-3"
            >
              {events.map((ev, i) => (
                <EvRow key={`${ev.t}-${i}`} ev={ev} />
              ))}
              {meta.live && (
                <div className="flex items-center gap-2 pl-10">
                  <span className="font-mono text-[10px] text-muted-foreground/60">
                    {streamed >= STREAM.length ? "editing nav-mobile.tsx" : "working"}
                  </span>
                  <span className="h-3.5 w-1.5 animate-pulse bg-foreground/60" />
                </div>
              )}
            </div>
          </aside>
        )}
    </div>
  );
}
