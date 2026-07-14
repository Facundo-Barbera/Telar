"use client";

// LANE: project (NEW) — Variant B "Project command view". A compact project hero
// strip (name, 14-day activity sparkline, running-now indicators, quick actions
// incl. New session) sits over a two-column body: recent sessions (dense rows) |
// project looms (state-toned cards, the data-light loom pattern). An "Everything"
// tab reveals the full grouped list. This variant judges how much project-level
// orientation belongs above the list — the hero answers "how's this repo doing?"
// before you dive into the work. Same UI-v2 language as the lists lane.
import { useMemo, useState } from "react";
import {
  ActivityIcon,
  CalendarClockIcon,
  FolderGit2Icon,
  HistoryIcon,
  LayoutGridIcon,
  ListTreeIcon,
  MessagesSquareIcon,
  PlusIcon,
  SearchXIcon,
  SettingsIcon,
  SparklesIcon,
  SunriseIcon,
  TriangleAlertIcon,
  WorkflowIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ACTIVITY_14D,
  DEMO_LOOMS,
  DEMO_PROJECT,
  DEMO_SESSIONS,
  type DemoLoom,
  type DemoSession,
} from "./fixtures";
import {
  Chip,
  GroupHeader,
  LoomCard,
  SearchField,
  SessionRow,
  StageFrame,
  ageBucket,
  isLoomActive,
  isLoomNeedsYou,
  matchLoom,
  matchSession,
  type AgeBucket,
} from "./shared";

type Tab = "overview" | "everything";

function LiveDot() {
  return (
    <span className="relative flex size-2">
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-400 opacity-60" />
      <span className="relative inline-flex size-2 rounded-full bg-sky-400" />
    </span>
  );
}

// A tiny 14-day activity sparkline — sessions + looms per day. Bars, not a path,
// so nothing floats over a transformed ancestor; height scales to the busiest
// day. Purely orientation: "hot lately, quiet before".
function Sparkline({ data }: { data: number[] }) {
  const max = Math.max(1, ...data);
  return (
    <div className="flex h-8 items-end gap-[3px]" aria-hidden>
      {data.map((v, i) => {
        const recent = i >= data.length - 3;
        return (
          <div
            key={i}
            className={cn(
              "w-1.5 rounded-sm transition-all",
              recent ? "bg-sky-400/80" : "bg-muted-foreground/30",
            )}
            style={{ height: `${Math.max(8, (v / max) * 100)}%` }}
            title={`${v} on day ${i + 1}`}
          />
        );
      })}
    </div>
  );
}

// A hero KPI cluster item.
function HeroStat({
  icon: Icon,
  value,
  label,
  tint,
  live,
}: {
  icon: typeof ActivityIcon;
  value: number;
  label: string;
  tint?: string;
  live?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card">
        {live && value > 0 ? (
          <LiveDot />
        ) : (
          <Icon className={cn("size-4", value > 0 ? tint : "text-muted-foreground/50")} />
        )}
      </div>
      <div className="leading-tight">
        <div className="font-mono text-base font-semibold tabular-nums">
          {value}
        </div>
        <div className="text-[11px] text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}

function ColumnHeader({
  icon: Icon,
  label,
  count,
  action,
}: {
  icon: typeof MessagesSquareIcon;
  label: string;
  count: number;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-1 pb-2">
      <Icon className="size-4 text-muted-foreground" />
      <h2 className="text-xs font-semibold tracking-wide text-foreground uppercase">
        {label}
      </h2>
      <Badge
        variant="outline"
        className="px-1.5 py-0 font-mono text-[10px] text-muted-foreground"
      >
        {count}
      </Badge>
      <div className="ml-auto">{action}</div>
    </div>
  );
}

/* ------------------------------------------------------------- everything */

const BUCKETS: { key: AgeBucket; label: string; icon: typeof SunriseIcon }[] = [
  { key: "today", label: "Today", icon: SunriseIcon },
  { key: "week", label: "This week", icon: CalendarClockIcon },
  { key: "older", label: "Older", icon: HistoryIcon },
];

type Item =
  | { kind: "session"; id: string; updatedAt: number; s: DemoSession }
  | { kind: "loom"; id: string; updatedAt: number; l: DemoLoom };

function EverythingBucket({
  label,
  icon: Icon,
  items,
}: {
  label: string;
  icon: typeof SunriseIcon;
  items: Item[];
}) {
  const [open, setOpen] = useState(true);
  if (items.length === 0) return null;
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <GroupHeader
        icon={Icon}
        label={label}
        count={items.length}
        open={open}
        onToggle={() => setOpen((o) => !o)}
      />
      {open && (
        <div className="divide-y divide-border">
          {items.map((it) =>
            it.kind === "session" ? (
              <SessionRow
                key={it.id}
                session={it.s}
                selected={false}
                onSelect={() => {}}
              />
            ) : (
              <div key={it.id} className="p-2">
                <LoomCard loom={it.l} />
              </div>
            ),
          )}
        </div>
      )}
    </section>
  );
}

function EverythingTab() {
  const [q, setQ] = useState("");
  const [entity, setEntity] = useState<"all" | "sessions" | "looms">("all");

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    if (entity !== "looms")
      for (const s of DEMO_SESSIONS)
        if (matchSession(s, q))
          out.push({ kind: "session", id: s.id, updatedAt: s.updatedAt, s });
    if (entity !== "sessions")
      for (const l of DEMO_LOOMS)
        if (matchLoom(l, q))
          out.push({ kind: "loom", id: l.id, updatedAt: l.updatedAt, l });
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }, [q, entity]);

  const byBucket = useMemo(() => {
    const map: Record<AgeBucket, Item[]> = { today: [], week: [], older: [] };
    for (const it of items) map[ageBucket(it.updatedAt)].push(it);
    return map;
  }, [items]);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchField
          value={q}
          onChange={setQ}
          placeholder="Search everything in this project…"
        />
        {(["all", "sessions", "looms"] as const).map((e) => (
          <Chip key={e} active={entity === e} onClick={() => setEntity(e)}>
            <span className="capitalize">{e}</span>
          </Chip>
        ))}
      </div>
      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
          <SearchXIcon className="size-6 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            Nothing matches “{q}”.
          </p>
          <Button variant="outline" size="sm" onClick={() => setQ("")}>
            Clear search
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {BUCKETS.map((b) => (
            <EverythingBucket
              key={b.key}
              label={b.label}
              icon={b.icon}
              items={byBucket[b.key]}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- looms */

// Project looms as state-toned cards, grouped by the same vocabulary the loom
// lane uses: Running now / Needs you / Recent.
function LoomColumn() {
  const running = DEMO_LOOMS.filter((l) => isLoomActive(l.state));
  const needsYou = DEMO_LOOMS.filter((l) => isLoomNeedsYou(l.state));
  const recent = DEMO_LOOMS.filter(
    (l) => !isLoomActive(l.state) && !isLoomNeedsYou(l.state),
  ).sort((a, b) => b.updatedAt - a.updatedAt);

  const groups: {
    label: string;
    icon: typeof ActivityIcon;
    tint: string;
    looms: DemoLoom[];
  }[] = [
    { label: "Running now", icon: ActivityIcon, tint: "text-sky-400", looms: running },
    { label: "Needs you", icon: TriangleAlertIcon, tint: "text-amber-400", looms: needsYou },
    { label: "Recent", icon: HistoryIcon, tint: "text-muted-foreground", looms: recent },
  ];

  return (
    <div className="space-y-4">
      {groups.map(
        (g) =>
          g.looms.length > 0 && (
            <div key={g.label}>
              <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                <g.icon className={cn("size-3.5", g.tint)} />
                {g.label}
                <span className="font-mono text-[10px] text-muted-foreground/60">
                  {g.looms.length}
                </span>
              </div>
              <div className="space-y-2">
                {g.looms.map((l) => (
                  <LoomCard key={l.id} loom={l} />
                ))}
              </div>
            </div>
          ),
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ demo */

export function ProjectHubCommandView() {
  const [tab, setTab] = useState<Tab>("overview");

  const recentSessions = useMemo(
    () => [...DEMO_SESSIONS].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8),
    [],
  );

  const runningCount = DEMO_LOOMS.filter((l) => isLoomActive(l.state)).length;
  const needsYouCount = DEMO_LOOMS.filter((l) => isLoomNeedsYou(l.state)).length;

  return (
    <StageFrame>
      {() => (
        <div className="flex h-full flex-col">
          {/* HERO strip */}
          <div className="shrink-0 border-b border-border bg-background/60">
            <div className="mx-auto w-full max-w-5xl px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-card">
                    <FolderGit2Icon className="size-5 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h1 className="truncate font-heading text-base font-semibold tracking-tight">
                        {DEMO_PROJECT.name}
                      </h1>
                      <Badge
                        variant="outline"
                        className="shrink-0 border-sky-500/25 bg-sky-500/5 px-1.5 py-0 text-[10px] text-sky-300"
                      >
                        {DEMO_PROJECT.account}
                      </Badge>
                      <Badge
                        variant="outline"
                        className="shrink-0 px-1.5 py-0 font-mono text-[10px] text-muted-foreground"
                      >
                        {DEMO_PROJECT.branch}
                      </Badge>
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/80">
                      {DEMO_PROJECT.root}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-5">
                  <HeroStat
                    icon={ActivityIcon}
                    value={runningCount}
                    label="running"
                    tint="text-sky-400"
                    live
                  />
                  <HeroStat
                    icon={TriangleAlertIcon}
                    value={needsYouCount}
                    label="needs you"
                    tint="text-amber-400"
                  />
                  <HeroStat
                    icon={MessagesSquareIcon}
                    value={DEMO_SESSIONS.length}
                    label="sessions"
                    tint="text-foreground"
                  />
                  <HeroStat
                    icon={WorkflowIcon}
                    value={DEMO_LOOMS.length}
                    label="looms"
                    tint="text-indigo-300"
                  />
                </div>

                <div className="hidden flex-col gap-1 xl:flex">
                  <span className="text-[10px] tracking-wide text-muted-foreground/60 uppercase">
                    14-day activity
                  </span>
                  <Sparkline data={ACTIVITY_14D} />
                </div>

                <div className="ml-auto flex items-center gap-2">
                  <Button size="sm">
                    <PlusIcon />
                    New session
                  </Button>
                  <Button variant="outline" size="sm">
                    <SparklesIcon />
                    New loom
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label="Project settings"
                  >
                    <SettingsIcon />
                  </Button>
                </div>
              </div>

              {/* tabs */}
              <div className="mt-3 flex items-center gap-1">
                {(
                  [
                    { key: "overview", label: "Overview", icon: LayoutGridIcon },
                    { key: "everything", label: "Everything", icon: ListTreeIcon },
                  ] as const
                ).map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setTab(t.key)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
                      tab === t.key
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                    )}
                  >
                    <t.icon className="size-3.5" />
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* BODY */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === "overview" ? (
              <div className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
                {/* recent sessions */}
                <div className="min-w-0">
                  <ColumnHeader
                    icon={MessagesSquareIcon}
                    label="Recent sessions"
                    count={DEMO_SESSIONS.length}
                    action={
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => setTab("everything")}
                      >
                        View all
                      </Button>
                    }
                  />
                  <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                    {recentSessions.map((s) => (
                      <SessionRow
                        key={s.id}
                        session={s}
                        selected={false}
                        onSelect={() => {}}
                      />
                    ))}
                  </div>
                </div>

                {/* project looms */}
                <div className="min-w-0">
                  <ColumnHeader
                    icon={WorkflowIcon}
                    label="Looms"
                    count={DEMO_LOOMS.length}
                  />
                  <LoomColumn />
                </div>
              </div>
            ) : (
              <EverythingTab />
            )}
          </div>
        </div>
      )}
    </StageFrame>
  );
}
