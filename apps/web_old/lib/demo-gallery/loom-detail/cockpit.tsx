"use client";
// LANE: loom-detail (UX brainstorm 2026-07-23) — the FINAL design's shared
// cockpit kit. Both variants (baseline and at-scale) render from these exact
// components, so the design is ONE: same tabs, same conductor card, same
// thread rows, same contract rows, same prep nodes, same lab rows, same
// sizes. Only the data and the grouping differ between the two looms.
import { useState } from "react";
import {
  ChevronRightIcon,
  CircleAlertIcon,
  LockIcon,
  OctagonXIcon,
  PauseIcon,
  PenOffIcon,
  PlayIcon,
  RotateCcwIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { LabService } from "./fixtures";
import { ASSERT_VISUAL, ActorTag, NODE_VISUAL, StateIcon } from "./shared";

export type CockpitState =
  | "done"
  | "build"
  | "verify"
  | "repair"
  | "blocked"
  | "wait";

const REPAIR_VISUAL = { Icon: RotateCcwIcon, icon: "text-destructive", spin: true };
const BLOCKED_VISUAL = {
  Icon: CircleAlertIcon,
  icon: "text-amber-600 dark:text-amber-400",
};

export function cockpitVisual(state: CockpitState) {
  if (state === "repair") return REPAIR_VISUAL;
  if (state === "blocked") return BLOCKED_VISUAL;
  return NODE_VISUAL[state];
}

export function ActTab({
  label,
  meta,
  active,
  locked,
  onClick,
}: {
  label: string;
  meta: string;
  active: boolean;
  locked?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-baseline gap-2 border-b-2 px-1 pb-2.5 text-sm transition-colors",
        active
          ? "border-foreground font-medium text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground/80",
      )}
    >
      {locked && <LockIcon className="size-3 self-center text-muted-foreground/60" />}
      {label}
      <span className="font-mono text-[10px] text-muted-foreground/60">{meta}</span>
    </button>
  );
}

// ---- Loom verbs: park and kill, always in the header. Park keeps the
// window warm and resumes on your say; kill archives branch + evidence —
// stopping a wrong-direction loom at 20% spend is one glance, two clicks.
export function LoomVerbs() {
  const [state, setState] = useState<"live" | "confirm" | "parked" | "killed">("live");

  if (state === "parked") {
    return (
      <span className="flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 font-mono text-[9px] text-muted-foreground">
        <PauseIcon className="size-3" />
        parked by you · window stays warm
        <button
          type="button"
          onClick={() => setState("live")}
          className="ml-0.5 flex items-center gap-1 text-foreground transition-colors hover:underline"
        >
          <PlayIcon className="size-3" />
          resume
        </button>
      </span>
    );
  }
  if (state === "killed") {
    return (
      <span className="flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 font-mono text-[9px] text-muted-foreground">
        <OctagonXIcon className="size-3 text-destructive" />
        killed · branch + evidence archived
      </span>
    );
  }
  if (state === "confirm") {
    return (
      <span className="flex items-center gap-1.5 rounded-full border border-destructive/40 px-2 py-0.5 font-mono text-[9px] text-muted-foreground">
        kill this loom? branch + evidence kept
        <button
          type="button"
          onClick={() => setState("killed")}
          className="text-destructive transition-colors hover:underline"
        >
          kill it
        </button>
        <button
          type="button"
          onClick={() => setState("live")}
          className="transition-colors hover:text-foreground"
        >
          cancel
        </button>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => setState("parked")}
        className="flex items-center gap-1 rounded-md border border-border px-2 py-1 font-mono text-[10px] text-muted-foreground transition-colors hover:bg-muted/40"
      >
        <PauseIcon className="size-3" />
        park
      </button>
      <button
        type="button"
        onClick={() => setState("confirm")}
        className="flex items-center gap-1 rounded-md border border-border px-2 py-1 font-mono text-[10px] text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
      >
        <OctagonXIcon className="size-3" />
        kill
      </button>
    </span>
  );
}

export function Room({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl space-y-4 px-6 py-6">{children}</div>
    </div>
  );
}

// ---- Prepare kit: one node size everywhere in the planning graph.
export function PrepNode({
  title,
  sub,
  state,
  wide,
  onOpen,
}: {
  title: string;
  sub: string;
  state: "done" | "dormant" | "gate";
  wide?: boolean;
  onOpen?: () => void;
}) {
  const inner = (
    <>
      <div className="flex items-center gap-2">
        {state === "done" && <StateIcon visual={NODE_VISUAL.done} className="size-3.5 shrink-0" />}
        {state === "gate" && <LockIcon className="size-3.5 shrink-0 text-muted-foreground/70" />}
        {state === "dormant" && (
          <span className="size-3 shrink-0 rounded-full border border-dashed border-muted-foreground/40" />
        )}
        <span className="truncate text-xs font-medium">{title}</span>
      </div>
      <p className="mt-1 truncate font-mono text-[9px] text-muted-foreground/60">{sub}</p>
    </>
  );
  const classes = cn(
    "min-w-0 rounded-xl border bg-card p-2.5",
    wide ? "w-full" : "flex-1 basis-40",
    state === "dormant" ? "border-dashed border-border opacity-60" : "border-border",
    state === "gate" && "border-foreground/25",
  );
  if (onOpen) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className={cn(classes, "text-left transition-colors hover:border-foreground/25")}
      >
        {inner}
      </button>
    );
  }
  return <div className={classes}>{inner}</div>;
}

export function FlowDown() {
  return (
    <div className="flex justify-center font-mono text-[10px] leading-none text-muted-foreground/40">
      ↓
    </div>
  );
}

// ---- Execute kit: ONE conductor card, ONE thread row, at any load.
export function ConductorCard({
  watching,
  statusLine,
  onOpen,
}: {
  watching: string;
  statusLine: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-xl border border-border bg-muted/20 p-3.5 text-left transition-colors hover:border-foreground/25"
    >
      <div className="flex items-center gap-2">
        <ActorTag actor="orchestrator" />
        <span className="text-xs font-medium text-foreground">conductor</span>
        <span className="flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 font-mono text-[9px] text-muted-foreground">
          <PenOffIcon className="size-3" />
          holds no pen
        </span>
        <ChevronRightIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground/50" />
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">{watching}</p>
      <p className="mt-1 font-mono text-[10px] text-muted-foreground/60">{statusLine}</p>
    </button>
  );
}

export type CockpitThread = {
  id: string;
  state: CockpitState;
  activity: string;
  evidenceAge?: string;
};

export function ThreadGroup({
  label,
  threads,
  onThread,
}: {
  label?: string;
  threads: CockpitThread[];
  onThread: (id: string) => void;
}) {
  const live = threads.filter(
    (t) => t.state === "build" || t.state === "verify" || t.state === "repair",
  ).length;
  return (
    <section className="space-y-1.5">
      {label && (
        <header className="flex items-center gap-2 px-1 pt-1">
          <span className="font-mono text-[11px] font-medium text-foreground/85">{label}</span>
          <span className="ml-auto font-mono text-[9px] text-muted-foreground/50">
            {live} live · {threads.length} threads
          </span>
        </header>
      )}
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {threads.map((t, i) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onThread(t.id)}
            className={cn(
              "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/30",
              i > 0 && "border-t border-border/60",
              (t.state === "wait" || t.state === "done") && "opacity-60",
            )}
          >
            <StateIcon visual={cockpitVisual(t.state)} className="size-3.5 shrink-0" />
            <span className="w-36 shrink-0 truncate font-mono text-xs text-foreground/90">
              {t.id}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {t.activity}
            </span>
            {t.evidenceAge && (
              <span className="shrink-0 font-mono text-[9px] text-muted-foreground/50">
                ev {t.evidenceAge}
              </span>
            )}
            <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/30" />
          </button>
        ))}
      </div>
    </section>
  );
}

// ---- Judge kit: ONE contract row; groups are optional labels on top of it.
export type ContractGroup = {
  label?: string;
  asserts: { id: string; desc: string; state: "pass" | "running" | "pending" }[];
};

export function ContractGroups({ groups }: { groups: ContractGroup[] }) {
  return (
    <>
      {groups.map((g) => {
        const pass = g.asserts.filter((a) => a.state === "pass").length;
        return (
          <section key={g.label ?? "contract"} className="space-y-1.5">
            {g.label && (
              <header className="flex items-baseline gap-2 px-1">
                <span className="font-mono text-[11px] font-medium text-foreground/85">
                  {g.label}
                </span>
                <span className="font-mono text-[9px] text-muted-foreground/50">
                  {pass}/{g.asserts.length} green
                </span>
              </header>
            )}
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              {g.asserts.map((a, i) => (
                <div
                  key={a.id}
                  className={cn(
                    "flex items-center gap-2.5 px-3 py-2",
                    i > 0 && "border-t border-border/60",
                    a.state === "pending" && "opacity-50",
                  )}
                >
                  <StateIcon visual={ASSERT_VISUAL[a.state]} className="size-3.5 shrink-0" />
                  <span className="font-mono text-[9px] text-muted-foreground/60">{a.id}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground/85">
                    {a.desc}
                  </span>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}

// ---- Lab kit: one registry row, one room shape.
export function LabRoom({
  topLine,
  services,
  metaLines,
}: {
  topLine?: string;
  services: LabService[];
  metaLines: string[];
}) {
  return (
    <Room>
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        The lab
      </h2>

      {topLine && (
        <div className="rounded-lg border border-border bg-muted/20 px-3 py-2">
          <p className="font-mono text-[10px] text-muted-foreground">{topLine}</p>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {services.map((s, i) => (
          <div
            key={s.name}
            className={cn(
              "px-3 py-2.5",
              i > 0 && "border-t border-border/60",
              s.state === "not-leased" && "opacity-60",
            )}
          >
            <div className="flex items-center gap-2">
              {s.state === "healthy" && (
                <StateIcon visual={NODE_VISUAL.done} className="size-3.5 shrink-0" />
              )}
              {s.state === "live" && (
                <StateIcon visual={ASSERT_VISUAL.running} className="size-3.5 shrink-0" />
              )}
              {s.state === "not-leased" && (
                <span className="size-3 shrink-0 rounded-full border border-dashed border-muted-foreground/40" />
              )}
              <span className="font-mono text-xs font-medium">{s.name}</span>
              <span className="rounded border border-border px-1 py-0.5 font-mono text-[9px] text-muted-foreground">
                scope: {s.scope}
              </span>
              <span className="ml-auto hidden truncate font-mono text-[9px] text-muted-foreground/50 sm:block">
                {s.policy}
              </span>
            </div>
            <p className="mt-1 pl-5.5 font-mono text-[10px] text-muted-foreground">{s.detail}</p>
          </div>
        ))}
      </div>

      <div className="space-y-1 rounded-lg bg-muted/20 p-2.5">
        {metaLines.map((m) => (
          <p key={m} className="font-mono text-[9px] leading-relaxed text-muted-foreground/60">
            {m}
          </p>
        ))}
      </div>
    </Room>
  );
}
