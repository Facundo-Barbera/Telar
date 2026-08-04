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
import { Shimmer } from "@/components/ai-elements/shimmer";
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

// WHAT THIS ROW NO LONGER SAYS, AND WHY. It used to name the running tool and
// its target ("Running Bash · bun test") because it lived in the HEADER, where
// it had no neighbours and was the turn's only description of itself. It is now
// the transcript's tail row, and the activity lane directly above it already
// renders that same running step, shimmering, with the same label — so naming
// the tool here printed it twice, one line apart. What is left is the part
// nothing else carries: that the turn is alive, roughly what it is doing, how
// long it has been at it, and whether it has gone quiet. `state.tool`/`target`
// stay in WorkState because `silent` is derived from that arm and the gallery
// drives all four states from it — this component just stops rendering them.
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

  // No border, no card, no background: a status LINE, at the same 11px muted
  // weight as a tool row's metadata. The old bordered card gave a transient
  // affordance the visual weight of a permanent one, which is most of why a
  // finished turn and a running turn looked equally loud.
  const base = "flex items-center gap-2 text-[11px] text-muted-foreground/70";

  if (state.kind === "starting") {
    return (
      <div className={cn(base, className)}>
        <PulseDot />
        <Shimmer as="span" className="text-[11px]">
          Starting
        </Shimmer>
      </div>
    );
  }

  const elapsed = Math.max(0, Math.floor((now - state.startedAt) / 1_000));
  const silentFor =
    state.kind === "tool" ? Math.max(0, Math.floor((now - state.lastActivityAt) / 1_000)) : 0;
  const silent = silentFor >= SILENCE_THRESHOLD;
  // A tool call reads as "Working": the lane above says WHICH tool, and the two
  // rows disagreeing about the verb ("Ran command" / "Using Read") was noise.
  const label = state.kind === "thinking" ? "Thinking" : "Working";

  return (
    <div className={cn(base, silent && "text-amber-500/80", className)}>
      <PulseDot silent={silent} />
      <Shimmer as="span" className={cn("text-[11px]", silent && "text-amber-500/80")}>
        {label}
      </Shimmer>
      <span className="shrink-0 font-mono tabular-nums">{fmtElapsed(elapsed)}</span>
      {silent && (
        <span className="shrink-0 font-mono tabular-nums text-amber-500">
          · no output {fmtElapsed(silentFor)}
        </span>
      )}
    </div>
  );
}

/** The liveness glyph: one small pulsing dot, replacing a spinner and a ✻ that
 *  each carried more visual weight than the sentence beside them. */
function PulseDot({ silent = false }: { silent?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full motion-safe:animate-pulse",
        silent ? "bg-amber-500" : "bg-muted-foreground/50",
      )}
    />
  );
}
