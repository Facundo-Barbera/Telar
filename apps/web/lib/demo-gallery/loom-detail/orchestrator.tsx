// LANE: loom-detail (UX brainstorm 2026-07-23) — Drill-in: the conductor's
// seat. The orchestrator is a ROLE, not a log: it holds no pen (constitution
// wall #2), its whole output is decisions, and its whole anxiety is progress
// liveness. This page shows its heartbeat (flatline = dire, the one thing
// that knocks), its decision log, the loom-branch merge queue, and the
// escalation ladder with today's traffic per rung.
import { ActivityIcon, GitMergeIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { DECISIONS, HEARTBEAT, LADDER, MERGE_QUEUE } from "./fixtures";

function Panel({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h2>
        {meta && <span className="font-mono text-[9px] text-muted-foreground/50">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

export function OrchestratorBody() {
  return (
    <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-6 px-6 py-6 lg:grid-cols-2">
          <Panel title="Progress heartbeat">
            <div className="rounded-xl border border-border bg-card p-3">
              <div className="flex items-center gap-2 border-b border-border/60 pb-2.5">
                <ActivityIcon className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                <span className="text-xs text-foreground/90">
                  last beat 1m ago · flatline threshold 12m
                </span>
              </div>
              <div className="space-y-1.5 pt-2.5">
                {HEARTBEAT.map((b) => (
                  <div key={b.time + b.text} className="flex items-baseline gap-2.5">
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
                      {b.time}
                    </span>
                    <span className="min-w-0 truncate text-xs text-foreground/85">{b.text}</span>
                  </div>
                ))}
              </div>
            </div>
          </Panel>

          <Panel title="Decision log">
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              {DECISIONS.map((d, i) => (
                <div
                  key={d.time}
                  className={cn(
                    "flex items-baseline gap-2.5 px-3 py-2",
                    i > 0 && "border-t border-border/60",
                  )}
                >
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
                    {d.time}
                  </span>
                  <span className="min-w-0 text-xs leading-relaxed text-foreground/85">
                    {d.text}
                  </span>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="Loom-branch merge queue">
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              {MERGE_QUEUE.map((m, i) => (
                <div
                  key={m.id}
                  className={cn(
                    "flex items-center gap-2.5 px-3 py-2",
                    i > 0 && "border-t border-border/60",
                    m.state.startsWith("blocked") && "opacity-60",
                  )}
                >
                  <GitMergeIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
                  <span className="font-mono text-xs text-foreground/90">{m.id}</span>
                  <span className="ml-auto font-mono text-[9px] text-muted-foreground/60">
                    {m.state}
                  </span>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="Escalation ladder">
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              {LADDER.map((l, i) => (
                <div
                  key={l.rung}
                  className={cn("flex items-center gap-3 px-3 py-2.5", i > 0 && "border-t border-border/60")}
                >
                  <span className="w-20 shrink-0 font-mono text-[10px] text-foreground/80">
                    {l.rung}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded-full border border-border px-1.5 py-0.5 font-mono text-[10px]",
                      l.count === 0 ? "text-muted-foreground/50" : "text-foreground",
                    )}
                  >
                    ×{l.count} today
                  </span>
                  <span className="min-w-0 truncate text-[10px] text-muted-foreground">
                    {l.note}
                  </span>
                </div>
              ))}
            </div>
          </Panel>
    </div>
  );
}
