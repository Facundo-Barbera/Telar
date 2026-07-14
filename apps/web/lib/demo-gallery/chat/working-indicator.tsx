"use client";

// 1.4 — A working indicator that means something.
// CURRENT: while a turn runs the bar shows `working · 12s` (a Shimmer) or, mid
// tool-call before a preview lands, effectively a bare "…" — the user can't
// tell what the agent is doing or whether it is alive. REDESIGN: current tool
// + target + live elapsed + subtle motion, with an explicit long-silence
// reassurance state ("still working — no output for 1m 20s").

import { useEffect, useRef, useState } from "react";
import { Loader2Icon, WrenchIcon } from "lucide-react";
// Lane-local shimmer: the production one washes out on light panels (see note
// in ./shimmer). Swap back to @/components/ai-elements/shimmer once that ships.
import { Shimmer } from "./shimmer";
import { TOOL_ICONS } from "@/components/session/tool-step";
import { cn } from "@/lib/utils";
import { Caption, DemoShell, Section, ThemePair } from "./_shared";

type WorkState =
  | { kind: "starting" }
  | { kind: "thinking"; elapsed: number }
  | { kind: "tool"; tool: string; target: string; elapsed: number; silentFor?: number };

const fmtElapsed = (s: number) => {
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

// The bar itself. Motion is a Shimmer on the label (the app's WebKit-safe busy
// treatment) plus a slow-spinning loader — no opacity keyframes on positioned
// layers.
function WorkingIndicator({ state }: { state: WorkState }) {
  if (state.kind === "starting") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs">
        <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        <Shimmer as="span" className="font-medium">
          Starting turn
        </Shimmer>
      </div>
    );
  }

  if (state.kind === "thinking") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs">
        <span aria-hidden className="text-sm">
          ✻
        </span>
        <Shimmer as="span" className="font-medium">
          Thinking
        </Shimmer>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/70">
          {fmtElapsed(state.elapsed)}
        </span>
      </div>
    );
  }

  const Icon = TOOL_ICONS[state.tool] ?? WrenchIcon;
  const silent = state.silentFor != null && state.silentFor >= 20;
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-xs",
        silent ? "border-amber-500/40" : "border-border",
      )}
    >
      <Icon className={cn("size-3.5 shrink-0", silent ? "text-amber-500" : "text-muted-foreground")} />
      <span className="shrink-0 font-medium text-foreground">
        {state.tool === "Bash" ? "Running" : "Using"} {state.tool}
      </span>
      <span className="min-w-0 flex-1 truncate">
        <Shimmer as="span" className="font-mono text-[11px]">
          {state.target}
        </Shimmer>
      </span>
      {silent ? (
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className="text-[10px] text-amber-500">still working</span>
          <span className="font-mono text-[10px] text-muted-foreground/70">
            no output {fmtElapsed(state.silentFor ?? 0)}
          </span>
        </span>
      ) : (
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/70">
          {fmtElapsed(state.elapsed)}
        </span>
      )}
    </div>
  );
}

const SCRIPT: { tool: string; target: string; hold: number }[] = [
  { tool: "Bash", target: "bun test packages/core", hold: 6 },
  { tool: "Read", target: "packages/core/src/executor.ts", hold: 3 },
  { tool: "Grep", target: "parentOf( · packages/core/src", hold: 3 },
  { tool: "Edit", target: "session-view.tsx · fold sub-agent usage", hold: 4 },
  { tool: "Bash", target: "bun run build  (compiling — quiet)", hold: 30 },
];

function LiveSim() {
  const [tick, setTick] = useState(0);
  const step = useRef(0);
  const stepStart = useRef(0);
  const [state, setState] = useState<WorkState>({ kind: "starting" });

  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    // advance the scripted tool sequence based on total elapsed
    const cur = SCRIPT[step.current % SCRIPT.length];
    const inStep = tick - stepStart.current;
    if (inStep >= cur.hold) {
      step.current += 1;
      stepStart.current = tick;
    }
    const c = SCRIPT[step.current % SCRIPT.length];
    const elapsedInStep = tick - stepStart.current;
    // the long "compiling" step trips the silence state after 20s
    setState({
      kind: "tool",
      tool: c.tool,
      target: c.target,
      elapsed: tick,
      silentFor: c.hold >= 30 ? elapsedInStep : undefined,
    });
  }, [tick]);

  return (
    <div className="rounded-xl border border-border bg-card/40 p-4">
      <Caption>Live — scripted tool sequence, real elapsed clock (watch it hit the silence state)</Caption>
      <WorkingIndicator state={state} />
    </div>
  );
}

export function WorkingIndicatorDemo() {
  return (
    <DemoShell>
      <Section title="Live" note="The bar tracks the current tool + target and a real elapsed clock; a long quiet step flips to the amber long-silence reassurance.">
        <LiveSim />
      </Section>
      <Section title="The states" note="Starting · thinking · running a tool · long-silence — each names what is happening.">
        <ThemePair className="items-start">
          <div className="space-y-2">
            <WorkingIndicator state={{ kind: "starting" }} />
            <WorkingIndicator state={{ kind: "thinking", elapsed: 3 }} />
            <WorkingIndicator state={{ kind: "tool", tool: "Bash", target: "bun test packages/core", elapsed: 12 }} />
            <WorkingIndicator
              state={{ kind: "tool", tool: "Bash", target: "bun run build (compiling)", elapsed: 134, silentFor: 80 }}
            />
          </div>
        </ThemePair>
      </Section>
    </DemoShell>
  );
}
