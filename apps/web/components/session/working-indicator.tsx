"use client";

// 1.4 — A working indicator that means something. While a turn runs the header
// used to show a bare `working · 12s` Shimmer: the user couldn't tell what the
// agent was doing or whether it was alive. This names the current tool + its
// target with a live elapsed clock, and flips to an amber "still working — no
// output" reassurance once a step goes quiet for a while.
//
// Ported from the owner-verdicted demo (lib/demo-gallery/chat/working-
// indicator.tsx). The demo used a lane-local Shimmer because the old
// production one washed out on light panels; that Shimmer is now mask-based
// (see ai-elements/shimmer) so we use it directly.

import { useEffect, useState } from "react";
import { Loader2Icon, WrenchIcon } from "lucide-react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { TOOL_ICONS } from "@/components/session/tool-step";
import { cn } from "@/lib/utils";

// Seconds of no streamed output before the indicator flips to its long-silence
// reassurance state.
const SILENCE_THRESHOLD = 20;

export type WorkState =
  | { kind: "starting" }
  | { kind: "thinking"; startedAt: number }
  | { kind: "working"; startedAt: number }
  | { kind: "tool"; tool: string; target: string; startedAt: number; lastActivityAt: number };

const fmtElapsed = (s: number) => {
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

export function WorkingIndicator({
  state,
  className,
}: {
  state: WorkState;
  className?: string;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (state.kind === "starting") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [state.kind]);

  const base = "flex items-center gap-2 rounded-lg border bg-card px-3 py-1.5 text-xs";

  if (state.kind === "starting") {
    return (
      <div className={cn(base, "border-border", className)}>
        <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        <Shimmer as="span" className="font-medium">
          Starting turn
        </Shimmer>
      </div>
    );
  }

  if (state.kind === "thinking" || state.kind === "working") {
    const elapsed = Math.max(0, Math.floor((now - state.startedAt) / 1_000));
    return (
      <div className={cn(base, "border-border", className)}>
        <span aria-hidden className="text-sm">
          ✻
        </span>
        <Shimmer as="span" className="font-medium">
          {state.kind === "thinking" ? "Thinking" : "Working"}
        </Shimmer>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/70">
          {fmtElapsed(elapsed)}
        </span>
      </div>
    );
  }

  const Icon = TOOL_ICONS[state.tool] ?? WrenchIcon;
  const elapsed = Math.max(0, Math.floor((now - state.startedAt) / 1_000));
  const silentFor = Math.max(0, Math.floor((now - state.lastActivityAt) / 1_000));
  const silent = silentFor >= SILENCE_THRESHOLD;
  return (
    <div className={cn(base, silent ? "border-amber-500/40" : "border-border", className)}>
      <Icon
        className={cn("size-3.5 shrink-0", silent ? "text-amber-500" : "text-muted-foreground")}
      />
      <span className="shrink-0 font-medium text-foreground">
        {state.tool === "Bash" ? "Running" : "Using"} {state.tool}
      </span>
      {state.target && (
        <span className="min-w-0 flex-1 truncate">
          <Shimmer as="span" className="font-mono text-[11px]">
            {state.target}
          </Shimmer>
        </span>
      )}
      {silent ? (
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className="text-[10px] text-amber-500">still working</span>
          <span className="font-mono text-[10px] text-muted-foreground/70">
            no output {fmtElapsed(silentFor)}
          </span>
        </span>
      ) : (
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/70">
          {fmtElapsed(elapsed)}
        </span>
      )}
    </div>
  );
}
