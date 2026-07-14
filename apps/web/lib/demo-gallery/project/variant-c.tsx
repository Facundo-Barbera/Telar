"use client";

// LANE: project (NEW) — Variant C "Hybrid" (OWNER-SELECTED). The synthesis the
// owner picked from rounds 17 A/B: B's TAB structure, A's dense grouped list, and
// the approved project-settings side-nav — with the two hard notes A/B each got
// wrong dropped.
//
//  • STRUCTURE from B: a COMPACT project header (name, minimal identity, New
//    session as the primary action — no command hero, no sparkline) over tabs:
//    Sessions | Looms | Settings.
//  • SESSIONS tab: A's visually-appealing dense grouped list, SESSIONS ONLY
//    ("I don't like mixing looms and sessions") — search-first toolbar, state
//    filter chips, Today/This week/Older collapsible groups, loom pill on rows
//    that wove a loom (clicking jumps to the Looms tab). NO right-side preview
//    ("hard to gather context for the right side"); the list gets full width.
//  • LOOMS tab: the project's looms as B's state-toned, data-light cards,
//    grouped Running / Needs you / Ready / Done, searchable + collapsible.
//  • SETTINGS tab: the approved project-settings side-nav folded in as the tab's
//    content (replaces a separate settings route in the project context).
//
// Same UI-v2 language as the applied lists/loom lanes; both themes via the lane
// StageFrame; reuses project/shared.tsx primitives + fixtures verbatim.
import { useMemo, useState } from "react";
import {
  ActivityIcon,
  CalendarClockIcon,
  CheckCheckIcon,
  CircleCheckIcon,
  FolderGit2Icon,
  HistoryIcon,
  MessagesSquareIcon,
  PlusIcon,
  SearchXIcon,
  SlidersHorizontalIcon,
  SunriseIcon,
  TriangleAlertIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react";
import type { WorkUnitState } from "@telar/core";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProjectSettingsDemo } from "../settings/project";
import {
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

type Tab = "sessions" | "looms" | "settings";
type StateFilter = "any" | "active" | "needs-you" | "done";

const AGE_BUCKETS: { key: AgeBucket; label: string; icon: LucideIcon }[] = [
  { key: "today", label: "Today", icon: SunriseIcon },
  { key: "week", label: "This week", icon: CalendarClockIcon },
  { key: "older", label: "Older", icon: HistoryIcon },
];

// A session passes the state filter on the state of the loom it wove; a session
// with no loom only survives "any" (mirrors variant A, sessions-only).
function sessionPassesState(s: DemoSession, f: StateFilter): boolean {
  if (f === "any") return true;
  const state = s.loom?.state ?? null;
  if (!state) return false;
  if (f === "active") return isLoomActive(state);
  if (f === "needs-you") return isLoomNeedsYou(state);
  return state === "done" || state === "ready";
}

/* ---------------------------------------------------------------- sessions */

function SessionBucket({
  label,
  icon,
  sessions,
  onOpenLoom,
  defaultOpen,
}: {
  label: string;
  icon: LucideIcon;
  sessions: DemoSession[];
  onOpenLoom: (loomId: string) => void;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (sessions.length === 0) return null;
  return (
    <section className="overflow-hidden">
      <GroupHeader
        icon={icon}
        label={label}
        count={sessions.length}
        open={open}
        onToggle={() => setOpen((o) => !o)}
      />
      {open && (
        <div className="divide-y divide-border">
          {sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              selected={false}
              onSelect={() => s.loom && onOpenLoom(s.loom.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SessionsTab({ onOpenLoom }: { onOpenLoom: (loomId: string) => void }) {
  const [q, setQ] = useState("");
  const [stateF, setStateF] = useState<StateFilter>("any");

  const sessions = useMemo(
    () =>
      DEMO_SESSIONS.filter(
        (s) => matchSession(s, q) && sessionPassesState(s, stateF),
      ).sort((a, b) => b.updatedAt - a.updatedAt),
    [q, stateF],
  );

  const byBucket = useMemo(() => {
    const map: Record<AgeBucket, DemoSession[]> = {
      today: [],
      week: [],
      older: [],
    };
    for (const s of sessions) map[ageBucket(s.updatedAt)].push(s);
    return map;
  }, [sessions]);

  const needsYouCount = DEMO_SESSIONS.filter(
    (s) => s.loom && isLoomNeedsYou(s.loom.state),
  ).length;

  const stateChips: { value: StateFilter; label: string }[] = [
    { value: "any", label: "Any state" },
    { value: "active", label: "Active" },
    { value: "needs-you", label: "Needs you" },
    { value: "done", label: "Done" },
  ];

  return (
    <div className="flex h-full flex-col">
      {/* search-first toolbar */}
      <div className="shrink-0 space-y-2 border-b border-border px-4 py-2.5">
        <SearchField
          value={q}
          onChange={setQ}
          placeholder="Search sessions…"
        />
        <div className="flex flex-wrap items-center gap-1.5">
          {stateChips.map((c) => (
            <Chip
              key={c.value}
              active={stateF === c.value}
              onClick={() => setStateF(c.value)}
            >
              {c.label}
              {c.value === "needs-you" && needsYouCount > 0 ? (
                <span className="font-mono tabular-nums text-amber-300">
                  {needsYouCount}
                </span>
              ) : null}
            </Chip>
          ))}
        </div>
      </div>

      {/* full-width grouped list — no preview pane */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          <EmptyState
            onReset={() => {
              setQ("");
              setStateF("any");
            }}
          />
        ) : (
          AGE_BUCKETS.map((b) => (
            <SessionBucket
              key={b.key}
              label={b.label}
              icon={b.icon}
              sessions={byBucket[b.key]}
              onOpenLoom={onOpenLoom}
              defaultOpen={b.key !== "older"}
            />
          ))
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- looms */

type LoomGroupKey = "running" | "needs-you" | "ready" | "done";

const LOOM_GROUPS: {
  key: LoomGroupKey;
  label: string;
  icon: LucideIcon;
  tint: string;
  match: (state: WorkUnitState) => boolean;
}[] = [
  {
    key: "running",
    label: "Running",
    icon: ActivityIcon,
    tint: "text-sky-400",
    match: isLoomActive,
  },
  {
    key: "needs-you",
    label: "Needs you",
    icon: TriangleAlertIcon,
    tint: "text-amber-400",
    // needs-review / charter-review / blocked, plus a failed loom that's parked
    // for a human — anything demanding attention lands here.
    match: (s) => isLoomNeedsYou(s) || s === "failed",
  },
  {
    key: "ready",
    label: "Ready",
    icon: CircleCheckIcon,
    tint: "text-emerald-400",
    match: (s) => s === "ready",
  },
  {
    key: "done",
    label: "Done",
    icon: CheckCheckIcon,
    tint: "text-muted-foreground",
    match: (s) => s === "done",
  },
];

function LoomGroup({
  label,
  icon,
  tint,
  looms,
  highlightId,
  defaultOpen,
}: {
  label: string;
  icon: LucideIcon;
  tint: string;
  looms: DemoLoom[];
  highlightId: string | null;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (looms.length === 0) return null;
  return (
    <section className="overflow-hidden">
      <GroupHeader
        icon={icon}
        tint={tint}
        label={label}
        count={looms.length}
        open={open}
        onToggle={() => setOpen((o) => !o)}
      />
      {open && (
        <div className="space-y-2 p-3">
          {looms.map((l) => (
            <div
              key={l.id}
              className={cn(
                "rounded-xl transition-shadow",
                highlightId === l.id &&
                  "ring-2 ring-primary ring-offset-2 ring-offset-background",
              )}
            >
              <LoomCard loom={l} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function LoomsTab({
  highlightId,
  onClearHighlight,
}: {
  highlightId: string | null;
  onClearHighlight: () => void;
}) {
  const [q, setQ] = useState("");

  const grouped = useMemo(() => {
    const matched = DEMO_LOOMS.filter((l) => matchLoom(l, q)).sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    return LOOM_GROUPS.map((g) => ({
      ...g,
      looms: matched.filter((l) => g.match(l.state)),
    }));
  }, [q]);

  const total = grouped.reduce((n, g) => n + g.looms.length, 0);

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border px-4 py-2.5">
        <SearchField
          value={q}
          onChange={(v) => {
            setQ(v);
            onClearHighlight();
          }}
          placeholder="Search looms…"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {total === 0 ? (
          <EmptyState onReset={() => setQ("")} label="No looms match your search." />
        ) : (
          grouped.map((g) => (
            <LoomGroup
              key={g.key}
              label={g.label}
              icon={g.icon}
              tint={g.tint}
              looms={g.looms}
              highlightId={highlightId}
              defaultOpen
            />
          ))
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ shared */

function EmptyState({
  onReset,
  label = "Nothing matches your filters.",
}: {
  onReset: () => void;
  label?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-16 text-center">
      <SearchXIcon className="size-6 text-muted-foreground/50" />
      <p className="text-sm text-muted-foreground">{label}</p>
      <Button variant="outline" size="sm" onClick={onReset}>
        Reset
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------- demo */

export function ProjectHubHybrid() {
  const [tab, setTab] = useState<Tab>("sessions");
  const [highlightLoom, setHighlightLoom] = useState<string | null>(null);

  const runningCount = DEMO_LOOMS.filter((l) => isLoomActive(l.state)).length;
  const needsYouCount = DEMO_LOOMS.filter(
    (l) => isLoomNeedsYou(l.state) || l.state === "failed",
  ).length;

  const openLoom = (loomId: string) => {
    setHighlightLoom(loomId);
    setTab("looms");
  };

  const tabs: { key: Tab; label: string; icon: LucideIcon; count?: number }[] = [
    {
      key: "sessions",
      label: "Sessions",
      icon: MessagesSquareIcon,
      count: DEMO_SESSIONS.length,
    },
    {
      key: "looms",
      label: "Looms",
      icon: WorkflowIcon,
      count: DEMO_LOOMS.length,
    },
    { key: "settings", label: "Settings", icon: SlidersHorizontalIcon },
  ];

  return (
    <StageFrame>
      {() => (
        <div className="flex h-full flex-col">
          {/* COMPACT header — identity + primary action, then tabs. No hero. */}
          <div className="shrink-0 border-b border-border bg-background/60 px-4 pt-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card">
                <FolderGit2Icon className="size-4.5 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h1 className="truncate font-heading text-sm font-semibold tracking-tight">
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
                <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                  {runningCount > 0 && (
                    <span className="text-sky-300">{runningCount} running</span>
                  )}
                  {runningCount > 0 && needsYouCount > 0 && (
                    <span className="text-border">·</span>
                  )}
                  {needsYouCount > 0 && (
                    <span className="text-amber-300">{needsYouCount} need you</span>
                  )}
                  {runningCount === 0 && needsYouCount === 0 && (
                    <span>All quiet</span>
                  )}
                </p>
              </div>
              <Button size="sm">
                <PlusIcon />
                New session
              </Button>
            </div>

            {/* tabs */}
            <div className="mt-3 flex items-center gap-1">
              {tabs.map((t) => {
                const on = tab === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setTab(t.key)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-2 text-xs font-medium transition-colors",
                      on
                        ? "border-primary text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <t.icon className="size-3.5" />
                    {t.label}
                    {t.count != null && (
                      <span
                        className={cn(
                          "font-mono text-[10px] tabular-nums",
                          on
                            ? "text-muted-foreground"
                            : "text-muted-foreground/60",
                        )}
                      >
                        {t.count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* BODY — one tab at a time */}
          <div className="min-h-0 flex-1">
            {tab === "sessions" && <SessionsTab onOpenLoom={openLoom} />}
            {tab === "looms" && (
              <LoomsTab
                highlightId={highlightLoom}
                onClearHighlight={() => setHighlightLoom(null)}
              />
            )}
            {tab === "settings" && <ProjectSettingsDemo />}
          </div>
        </div>
      )}
    </StageFrame>
  );
}
