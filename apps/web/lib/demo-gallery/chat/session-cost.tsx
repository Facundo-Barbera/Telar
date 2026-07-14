"use client";

// 1.6 — Session cost that counts the whole weave.
// CURRENT: the heartbeat bar shows fmtCost(sessionCost), where sessionCost
// only accumulates the MAIN agent's usage events — every sub-agent's spend is
// invisible, so the number understates real cost, sometimes badly. REDESIGN:
// the pill shows the AGGREGATE (main + all sub-agents); hovering it floats an
// anchored, zero-reflow overlay with each agent's cost, tokens, and share of
// the total (click pins it open).

import { useState } from "react";
import { BotIcon, UserRoundIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { fmtCost, fmtTokens } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Caption, DemoShell, Section, ThemePair } from "./_shared";
import { ContextPill } from "./session-context";

type AgentCost = {
  id: string;
  label: string;
  kind: "main" | "sub";
  costUsd: number;
  inTok: number;
  outTok: number;
};

const AGENTS: AgentCost[] = [
  { id: "main", label: "Main", kind: "main", costUsd: 0.1841, inTok: 48210, outTok: 9120 },
  { id: "s1", label: "Audit auth middleware", kind: "sub", costUsd: 0.2104, inTok: 61400, outTok: 7330 },
  { id: "s2", label: "Port tests to vitest", kind: "sub", costUsd: 0.0973, inTok: 22800, outTok: 4110 },
  { id: "s3", label: "Draft migration plan", kind: "sub", costUsd: 0.0442, inTok: 9800, outTok: 2260 },
];

const total = (a: AgentCost[]) => a.reduce((s, x) => s + x.costUsd, 0);

// The floating breakdown card. text-card-foreground is explicit on purpose:
// the rows otherwise inherit `color` from the dark app shell, so on a LIGHT
// panel (ThemePair) the un-classed label/cost text stayed near-white on white.
// Binding to the card-foreground token re-themes it legibly in both themes.
function Breakdown({ agents, className }: { agents: AgentCost[]; className?: string }) {
  const grand = total(agents);
  const mainOnly = agents.find((a) => a.kind === "main")?.costUsd ?? 0;
  return (
    <div
      className={cn(
        "w-80 rounded-xl border border-border bg-card p-2 text-card-foreground shadow-lg",
        className,
      )}
    >
      <div className="mb-1.5 flex items-center justify-between px-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
          Cost breakdown
        </span>
        <span className="font-mono text-xs font-semibold">{fmtCost(grand)}</span>
      </div>
      <ul className="space-y-0.5">
        {agents.map((a) => {
          const share = grand > 0 ? a.costUsd / grand : 0;
          return (
            <li key={a.id} className="rounded-md px-1.5 py-1 hover:bg-muted/50">
              <div className="flex items-center gap-1.5 text-xs">
                {a.kind === "main" ? (
                  <UserRoundIcon className="size-3 shrink-0 text-muted-foreground" />
                ) : (
                  <BotIcon className="size-3 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate">{a.label}</span>
                <span className="shrink-0 font-mono text-[11px]">{fmtCost(a.costUsd)}</span>
              </div>
              <div className="mt-1 flex items-center gap-2 pl-5">
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn("h-full rounded-full", a.kind === "main" ? "bg-muted-foreground/50" : "bg-primary/60")}
                    style={{ width: `${Math.max(2, share * 100)}%` }}
                  />
                </div>
                <span className="shrink-0 font-mono text-[9px] text-muted-foreground/60">
                  {fmtTokens(a.inTok)}↑ {fmtTokens(a.outTok)}↓
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="mt-1.5 border-t border-border px-1.5 pt-1.5 text-[10px] text-muted-foreground">
        Old bar showed <span className="font-mono text-destructive">{fmtCost(mainOnly)}</span> (main only) —
        hiding <span className="font-mono">{fmtCost(grand - mainOnly)}</span> of sub-agent spend.
      </div>
    </div>
  );
}

// The pill as it sits in the heartbeat bar. The breakdown opens on HOVER as an
// absolutely-positioned overlay anchored to the pill — it is out of flow, so the
// bar never reflows/grows when it appears. Click pins it open (and unpins).
function CostPanel({ agents }: { agents: AgentCost[] }) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hovered || pinned;
  const grand = total(agents);
  const subCount = agents.filter((a) => a.kind === "sub").length;

  return (
    <div
      className="relative inline-flex"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        onClick={() => setPinned((v) => !v)}
        className="self-start"
        aria-expanded={open}
        title={pinned ? "Click to unpin" : "Hover to preview · click to pin"}
      >
        <Badge
          variant="outline"
          className={cn(
            "cursor-pointer gap-1.5 font-mono text-xs hover:bg-muted",
            pinned && "ring-1 ring-ring",
          )}
        >
          {fmtCost(grand)}
          <span className="text-[10px] text-muted-foreground/70">
            main + {subCount}
          </span>
        </Badge>
      </button>

      {/* absolute → zero layout reflow; anchored to the pill's right edge */}
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1.5">
          <Breakdown agents={agents} />
        </div>
      )}
    </div>
  );
}

// Mock heartbeat bar so the pill is shown in context.
function HeartbeatBar() {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-4 py-1.5">
      <Badge variant="outline" className="gap-1.5 font-mono text-xs">
        <UserRoundIcon className="size-3" />
        anthropic · sonnet
      </Badge>
      <Badge variant="secondary" className="font-mono text-xs">
        a1b2c3d4
      </Badge>
      <div className="ml-auto flex items-center gap-2">
        <ContextPill />
        <CostPanel agents={AGENTS} />
      </div>
    </div>
  );
}

export function SessionCostDemo() {
  return (
    <DemoShell>
      <Section
        title="Aggregate cost in the bar"
        note="Both hovers now live in one bar: hover CTX for the /context-style window breakdown, hover the cost pill for the per-agent breakdown. Each floats an anchored overlay — the bar never reflows; click either to pin it open."
      >
        <HeartbeatBar />
      </Section>
      <Section title="Per-agent breakdown" note="The floating card, shown open: each agent's cost, share bar, and token split — with an explicit callout of what the main-only number was hiding.">
        <ThemePair className="items-start">
          <Breakdown agents={AGENTS} />
        </ThemePair>
      </Section>
    </DemoShell>
  );
}
