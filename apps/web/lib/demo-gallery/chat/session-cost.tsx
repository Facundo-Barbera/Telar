"use client";

// 1.6 — Session cost that counts the whole weave.
// CURRENT: the heartbeat bar shows fmtCost(sessionCost), where sessionCost
// only accumulates the MAIN agent's usage events — every sub-agent's spend is
// invisible, so the number understates real cost, sometimes badly. REDESIGN:
// the pill shows the AGGREGATE (main + all sub-agents), and expands to a
// per-agent breakdown with each agent's cost, tokens, and share of the total.

import { useState } from "react";
import { BotIcon, ChevronDownIcon, UserRoundIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { fmtCost, fmtTokens } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Caption, DemoShell, Section, ThemePair } from "./_shared";

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

function CostPanel({ agents }: { agents: AgentCost[] }) {
  const [open, setOpen] = useState(true);
  const grand = total(agents);
  const mainOnly = agents.find((a) => a.kind === "main")?.costUsd ?? 0;
  const subCount = agents.filter((a) => a.kind === "sub").length;

  return (
    <div className="inline-flex flex-col">
      {/* the pill as it sits in the heartbeat bar */}
      <button type="button" onClick={() => setOpen((v) => !v)} className="self-start">
        <Badge variant="outline" className="cursor-pointer gap-1.5 font-mono text-xs hover:bg-muted">
          {fmtCost(grand)}
          <span className="text-[10px] text-muted-foreground/70">
            main + {subCount}
          </span>
          <ChevronDownIcon className={cn("size-3 transition-transform", open && "rotate-180")} />
        </Badge>
      </button>

      {open && (
        <div className="mt-1.5 w-80 rounded-xl border border-border bg-card p-2 shadow-sm">
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
        <Badge variant="outline" className="font-mono text-xs">
          CTX 58.2k
        </Badge>
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
        note="The pill totals main + every sub-agent and labels the makeup (main + 3). Click to expand the per-agent breakdown."
      >
        <HeartbeatBar />
      </Section>
      <Section title="Per-agent breakdown" note="Each agent's cost, share bar, and token split — with an explicit callout of what the main-only number was hiding.">
        <ThemePair className="items-start">
          <CostPanel agents={AGENTS} />
        </ThemePair>
      </Section>
    </DemoShell>
  );
}
