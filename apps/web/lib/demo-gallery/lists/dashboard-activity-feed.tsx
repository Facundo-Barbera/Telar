"use client";

// LANE: lists — Dashboard, Variant B: Activity Feed (concern 2 + 5).
// CURRENT: the same stacked-sections scroll as Variant A's "current". This take
// is a genuinely different structure: instead of parallel section lists, one
// unified reverse-chronological stream of everything that happened — loom state
// changes, gate results, session replies, accepts — grouped into time buckets,
// with a type filter rail on the left and a sticky "Needs you" + plan column on
// the right. Answers "what changed while I was away?" in one scan.
import { useMemo, useState } from "react";
import {
  CheckCircle2Icon,
  CircleDotIcon,
  FlaskConicalIcon,
  HammerIcon,
  MessagesSquareIcon,
  RssIcon,
  SparklesIcon,
  TriangleAlertIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { StateBadge } from "@/components/common/state-badge";
import { fmtAgo, fmtCost } from "@/lib/format";
import {
  DEMO_LOOMS,
  DEMO_SESSIONS,
  needsYouLooms,
} from "./fixtures";
import { SearchField, railClass } from "./shared";

type EventType = "loom" | "gate" | "session" | "accept";

type FeedEvent = {
  id: string;
  type: EventType;
  ts: number;
  project: string;
  title: string;
  detail: string;
  tone: "sky" | "violet" | "emerald" | "amber" | "destructive" | "muted";
};

const TYPE_META: Record<
  EventType,
  { icon: LucideIcon; label: string }
> = {
  loom: { icon: HammerIcon, label: "Looms" },
  gate: { icon: FlaskConicalIcon, label: "Gates" },
  session: { icon: MessagesSquareIcon, label: "Sessions" },
  accept: { icon: CheckCircle2Icon, label: "Accepts" },
};

const TONE_TEXT: Record<FeedEvent["tone"], string> = {
  sky: "text-sky-400",
  violet: "text-violet-400",
  emerald: "text-emerald-400",
  amber: "text-amber-400",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};
const TONE_DOT: Record<FeedEvent["tone"], string> = {
  sky: "bg-sky-400",
  violet: "bg-violet-400",
  emerald: "bg-emerald-400",
  amber: "bg-amber-400",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground/40",
};

// Synthesize a plausible activity stream from the fixture looms + sessions plus
// a few gate/accept beats so the feed reads like a real operating day.
function buildFeed(): FeedEvent[] {
  const events: FeedEvent[] = [];

  for (const l of DEMO_LOOMS) {
    const tone: FeedEvent["tone"] =
      l.state === "failed"
        ? "destructive"
        : l.state === "needs-review" || l.state === "blocked" || l.state === "charter-review"
          ? "amber"
          : l.state === "ready"
            ? "emerald"
            : l.state === "verifying"
              ? "violet"
              : l.state === "done"
                ? "muted"
                : "sky";
    const detail =
      l.state === "done"
        ? `Verified and merged · ${fmtCost(l.cost)} · ${l.attempts} attempt${l.attempts === 1 ? "" : "s"}`
        : l.state === "ready"
          ? "Verified — awaiting your accept"
          : l.state === "needs-review"
            ? (l.error ?? "Couldn't self-verify — needs review")
            : l.state === "failed"
              ? (l.error ?? "Gate failed after retries")
              : l.state === "blocked"
                ? (l.error ?? "Paused on a prerequisite")
                : l.role === "woven"
                  ? `Weaving ${l.threadsDone}/${l.threads ?? "?"} threads`
                  : `${l.state} · ${fmtCost(l.cost)}`;
    events.push({
      id: `ev-${l.id}`,
      type: "loom",
      ts: l.updatedAt,
      project: l.project,
      title: l.title,
      detail,
      tone,
    });
  }

  // A handful of gate + accept beats interleaved with the recent looms.
  events.push(
    { id: "g1", type: "gate", ts: DEMO_LOOMS[0].updatedAt - 30_000, project: "telar-core", title: "Gate passed: unit", detail: "412 tests · 3.1s — dispatcher thread 2 green", tone: "emerald" },
    { id: "g2", type: "gate", ts: DEMO_LOOMS[3].updatedAt - 20_000, project: "relay-worker", title: "Gate passed: integration", detail: "backoff harness green on the 2nd attempt", tone: "emerald" },
    { id: "g3", type: "gate", ts: DEMO_LOOMS[10].updatedAt + 5_000, project: "sonar-metrics", title: "Gate warning: coverage", detail: "coverage dropped 4% on the touched module", tone: "amber" },
    { id: "a1", type: "accept", ts: DEMO_LOOMS[14].updatedAt + 4_000, project: "orbit-dashboard", title: "You accepted a loom", detail: "Dashboard skeleton footprint match → done", tone: "emerald" },
    { id: "a2", type: "accept", ts: DEMO_LOOMS[15].updatedAt + 4_000, project: "beacon-auth", title: "You accepted a loom", detail: "Token refresh leader election → done", tone: "emerald" },
  );

  for (const s of DEMO_SESSIONS.slice(0, 10)) {
    events.push({
      id: `es-${s.id}`,
      type: "session",
      ts: s.updatedAt,
      project: s.project,
      title: s.title,
      detail: s.live ? `Working — ${s.preview}` : s.preview,
      tone: s.live ? "sky" : "muted",
    });
  }

  return events.sort((a, b) => b.ts - a.ts);
}

function bucketOf(ts: number): string {
  const age = Date.now() - ts;
  if (age < 10 * 60_000) return "Just now";
  if (age < 3 * 3_600_000) return "Earlier today";
  if (age < 24 * 3_600_000) return "Today";
  if (age < 48 * 3_600_000) return "Yesterday";
  return "Earlier this week";
}

const BUCKET_ORDER = ["Just now", "Earlier today", "Today", "Yesterday", "Earlier this week"];

export function DashboardActivityFeedDemo() {
  const [q, setQ] = useState("");
  const [types, setTypes] = useState<Set<EventType>>(new Set());
  const feed = useMemo(buildFeed, []);

  const toggleType = (t: EventType) =>
    setTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return feed.filter(
      (e) =>
        (types.size === 0 || types.has(e.type)) &&
        (!needle ||
          e.title.toLowerCase().includes(needle) ||
          e.project.toLowerCase().includes(needle) ||
          e.detail.toLowerCase().includes(needle)),
    );
  }, [feed, q, types]);

  const buckets = useMemo(() => {
    const map = new Map<string, FeedEvent[]>();
    for (const e of filtered) {
      const b = bucketOf(e.ts);
      if (!map.has(b)) map.set(b, []);
      map.get(b)!.push(e);
    }
    return BUCKET_ORDER.filter((b) => map.has(b)).map((b) => ({
      label: b,
      events: map.get(b)!,
    }));
  }, [filtered]);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <div className="shrink-0">
          <h1 className="font-heading text-base font-semibold tracking-tight">telar</h1>
          <p className="text-xs text-muted-foreground">Activity</p>
        </div>
        <SearchField
          value={q}
          onChange={setQ}
          placeholder="Search everything that happened…"
        />
        <Button size="sm">
          <SparklesIcon />
          New loom session
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto grid h-full w-full max-w-6xl grid-cols-[10rem_1fr] gap-4 px-4 py-4 lg:grid-cols-[11rem_1fr_16rem]">
          {/* Filter rail */}
          <aside className="flex flex-col gap-1.5">
            <span className="px-1 text-[10px] font-semibold tracking-wide text-muted-foreground/70 uppercase">
              Filter
            </span>
            <button
              type="button"
              onClick={() => setTypes(new Set())}
              className={cn(
                "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors",
                types.size === 0
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted/50",
              )}
            >
              <RssIcon className="size-4" />
              All activity
            </button>
            {(Object.keys(TYPE_META) as EventType[]).map((t) => {
              const { icon: Icon, label } = TYPE_META[t];
              const on = types.has(t);
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleType(t)}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors",
                    on
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted/50",
                  )}
                >
                  <Icon className="size-4" />
                  {label}
                </button>
              );
            })}
          </aside>

          {/* Feed */}
          <div className="min-h-0 overflow-y-auto pr-1">
            {buckets.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
                <CircleDotIcon className="size-6 text-muted-foreground/40" />
                Nothing matches your filter.
              </div>
            ) : (
              <div className="space-y-5">
                {buckets.map((bucket) => (
                  <div key={bucket.label}>
                    <div className="sticky top-0 z-10 mb-1 bg-background/90 py-1 backdrop-blur">
                      <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                        {bucket.label}
                      </span>
                      <span className="ml-2 font-mono text-[10px] text-muted-foreground/50">
                        {bucket.events.length}
                      </span>
                    </div>
                    <div className="relative space-y-0.5 pl-4">
                      <span className="absolute top-1 bottom-1 left-[5px] w-px bg-border" />
                      {bucket.events.map((e) => {
                        const Icon = TYPE_META[e.type].icon;
                        return (
                          <div
                            key={e.id}
                            className="relative flex items-start gap-2.5 rounded-lg py-1.5 pr-2 transition-colors hover:bg-muted/40"
                          >
                            <span
                              className={cn(
                                "absolute top-2.5 -left-[13px] size-2 rounded-full ring-2 ring-background",
                                TONE_DOT[e.tone],
                              )}
                            />
                            <Icon className={cn("mt-0.5 size-4 shrink-0", TONE_TEXT[e.tone])} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="truncate text-sm font-medium">{e.title}</span>
                                <span className="shrink-0 rounded bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
                                  {e.project}
                                </span>
                              </div>
                              <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                                {e.detail}
                              </p>
                            </div>
                            <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                              {fmtAgo(e.ts)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Needs-you + plan sidebar */}
          <aside className="hidden min-h-0 flex-col gap-4 overflow-y-auto lg:flex">
            <section className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <TriangleAlertIcon className="size-4 text-amber-400" />
                <h2 className="text-xs font-semibold tracking-wide uppercase">Needs you</h2>
                <span className="rounded bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
                  {needsYouLooms.length}
                </span>
              </div>
              <div className="divide-y divide-border">
                {needsYouLooms.map((l) => (
                  <div key={l.id} className="relative py-2 pr-2 pl-3.5">
                    <span
                      aria-hidden
                      className={cn(
                        "absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full",
                        railClass(l.state),
                      )}
                    />
                    <span className="block truncate text-sm font-medium">{l.title}</span>
                    <div className="mt-1 flex items-center gap-1.5">
                      <StateBadge state={l.state} />
                      <span className="truncate text-[11px] text-muted-foreground">
                        {l.project}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-xl border border-border bg-card p-3">
              <div className="mb-2 flex items-center gap-2">
                <WorkflowIcon className="size-4 text-muted-foreground" />
                <h2 className="text-xs font-semibold tracking-wide uppercase">Plan usage</h2>
              </div>
              <div className="space-y-2.5">
                {[
                  { label: "Session · 5h", pct: 62 },
                  { label: "Weekly", pct: 44 },
                  { label: "Weekly · Opus", pct: 81 },
                ].map((m) => (
                  <div key={m.label} className="space-y-1">
                    <div className="flex items-baseline justify-between text-xs">
                      <span className="text-muted-foreground">{m.label}</span>
                      <span className="font-mono text-muted-foreground tabular-nums">
                        {m.pct}%
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn(
                          "h-full rounded-full",
                          m.pct >= 90 ? "bg-destructive" : m.pct >= 70 ? "bg-amber-400" : "bg-primary",
                        )}
                        style={{ width: `${m.pct}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
