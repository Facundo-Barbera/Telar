"use client";

// LANE: project (NEW) — Variant A "Work-first". The session/loom LIST is the
// hero: a dense grouped rail (Today / This week / Older, collapsible) with a
// search-first toolbar and entity/state filter chips, New session as the primary
// action, and an inline PREVIEW pane that opens the selected row (last exchange,
// cost, quick open) — no navigation, minimal scroll. Harmonizes with the applied
// UI-v2 lists language: SearchField, Chip, sticky GroupHeader, state rails,
// StateBadge vocabulary, quiet mono metadata.
import { useMemo, useState } from "react";
import {
  CalendarClockIcon,
  ClockIcon,
  CoinsIcon,
  FolderGit2Icon,
  HistoryIcon,
  InboxIcon,
  MessagesSquareIcon,
  PlusIcon,
  SearchXIcon,
  SparklesIcon,
  SunriseIcon,
  WorkflowIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { StateBadge } from "@/components/common/state-badge";
import { fmtAgo, fmtCost } from "@/lib/format";
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
  SearchField,
  SessionRow,
  StageFrame,
  WeaveChip,
  ageBucket,
  isLoomActive,
  isLoomNeedsYou,
  matchLoom,
  matchSession,
  railClass,
  type AgeBucket,
} from "./shared";

type Entity = "all" | "sessions" | "looms";
type StateFilter = "any" | "active" | "needs-you" | "done";

type Item =
  | { kind: "session"; id: string; updatedAt: number; s: DemoSession }
  | { kind: "loom"; id: string; updatedAt: number; l: DemoLoom };

const BUCKETS: { key: AgeBucket; label: string; icon: typeof SunriseIcon }[] = [
  { key: "today", label: "Today", icon: SunriseIcon },
  { key: "week", label: "This week", icon: CalendarClockIcon },
  { key: "older", label: "Older", icon: HistoryIcon },
];

// A loom passes the state filter on its own state; a session passes on the state
// of the loom it wove (a session with no loom only shows under "any").
function passesState(item: Item, f: StateFilter): boolean {
  if (f === "any") return true;
  const state =
    item.kind === "loom" ? item.l.state : item.s.loom?.state ?? null;
  if (!state) return false;
  if (f === "active") return isLoomActive(state);
  if (f === "needs-you") return isLoomNeedsYou(state);
  return state === "done" || state === "ready";
}

/* --------------------------------------------------------------- loom row */

// A dense loom row for the unified list (sessions use SessionRow). Same rail +
// StateBadge grammar so sessions and looms read as one scannable column.
function LoomListRow({
  loom,
  selected,
  onSelect,
}: {
  loom: DemoLoom;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "relative flex w-full items-center gap-3 py-2.5 pr-3 pl-4 text-left transition-colors",
        selected ? "bg-primary/10" : "hover:bg-muted/40",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full",
          selected ? "bg-primary" : railClass(loom.state),
        )}
      />
      <StateBadge state={loom.state} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <WorkflowIcon className="size-3 shrink-0 text-indigo-300/80" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {loom.title}
          </span>
          <WeaveChip
            role={loom.role}
            threads={loom.threads}
            threadsDone={loom.threadsDone}
          />
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-mono">{loom.kind}</span>
          <span className="text-border">·</span>
          <span>{loom.attempts === 1 ? "1 attempt" : `${loom.attempts} attempts`}</span>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span className="font-mono text-xs tabular-nums">{fmtCost(loom.cost)}</span>
        <span className="text-xs text-muted-foreground">{fmtAgo(loom.updatedAt)}</span>
      </div>
    </button>
  );
}

/* --------------------------------------------------------------- preview */

function PreviewShell({
  children,
  footer,
}: {
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
      <div className="shrink-0 border-t border-border p-4">{footer}</div>
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof CoinsIcon;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-card px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div className="font-mono text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function SessionPreview({ session }: { session: DemoSession }) {
  return (
    <PreviewShell
      footer={
        <div className="flex items-center gap-2">
          <Button size="sm" className="flex-1">
            <MessagesSquareIcon />
            Open session
          </Button>
          {session.loom && (
            <Button variant="outline" size="sm">
              <WorkflowIcon />
              View loom
            </Button>
          )}
        </div>
      }
    >
      <div className="mb-4 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold tracking-tight">
            {session.title}
          </h2>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <ClockIcon className="size-3" />
            {fmtAgo(session.updatedAt)}
          </p>
        </div>
        {session.loom && <StateBadge state={session.loom.state} />}
      </div>

      <div className="mb-5 grid grid-cols-3 gap-2">
        <Stat icon={CoinsIcon} label="Cost" value={fmtCost(session.costUsd)} />
        <Stat icon={MessagesSquareIcon} label="Turns" value={session.turns} />
        <Stat
          icon={SparklesIcon}
          label="Model"
          value={<span className="text-xs">{session.model}</span>}
        />
      </div>

      <div className="mb-1.5 text-[11px] font-medium tracking-wider text-muted-foreground/70 uppercase">
        Last exchange
      </div>
      <div className="space-y-2">
        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
          <div className="mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            You
          </div>
          <p className="text-sm">{session.lastUser}</p>
        </div>
        <div className="rounded-lg border border-border bg-card px-3 py-2">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            <SparklesIcon className="size-3" />
            Assistant
          </div>
          <p className="text-sm leading-relaxed">{session.lastAssistant}</p>
        </div>
      </div>
    </PreviewShell>
  );
}

function LoomPreview({ loom }: { loom: DemoLoom }) {
  return (
    <PreviewShell
      footer={
        <div className="flex items-center gap-2">
          <Button size="sm" className="flex-1">
            <WorkflowIcon />
            Open loom
          </Button>
          {loom.fromSession && (
            <Button variant="outline" size="sm">
              <MessagesSquareIcon />
              Source session
            </Button>
          )}
        </div>
      }
    >
      <div className="mb-4 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold tracking-tight">{loom.title}</h2>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <ClockIcon className="size-3" />
            {fmtAgo(loom.updatedAt)}
          </p>
        </div>
        <StateBadge state={loom.state} />
      </div>

      <div className="mb-5 grid grid-cols-3 gap-2">
        <Stat icon={CoinsIcon} label="Cost" value={fmtCost(loom.cost)} />
        <Stat icon={HistoryIcon} label="Attempts" value={loom.attempts} />
        <Stat
          icon={WorkflowIcon}
          label="Kind"
          value={<span className="text-xs">{loom.kind}</span>}
        />
      </div>

      {loom.role === "woven" && loom.threads != null && (
        <div className="mb-5">
          <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
            <span className="tracking-wider uppercase">Weave progress</span>
            <span className="font-mono tabular-nums">
              {loom.threadsDone}/{loom.threads} threads
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-indigo-400 transition-all"
              style={{
                width: `${(loom.threadsDone / loom.threads) * 100}%`,
              }}
            />
          </div>
        </div>
      )}

      <div className="mb-1.5 text-[11px] font-medium tracking-wider text-muted-foreground/70 uppercase">
        Status
      </div>
      <div
        className={cn(
          "rounded-lg border px-3 py-2.5 text-sm",
          loom.error
            ? loom.state === "failed"
              ? "border-destructive/30 bg-destructive/5 text-destructive"
              : "border-amber-500/30 bg-amber-500/5 text-amber-300"
            : "border-border bg-card text-muted-foreground",
        )}
      >
        {loom.error ??
          (loom.state === "done"
            ? "Verified through the gates and accepted. This loom is done."
            : loom.state === "ready"
              ? "Verified — the composed whole passed every gate. Awaiting your accept."
              : isLoomActive(loom.state)
                ? "In flight. The thread is planning, executing, and verifying on its own loop."
                : "Paused for you.")}
      </div>
    </PreviewShell>
  );
}

/* ------------------------------------------------------------------ group */

function Bucket({
  label,
  icon: Icon,
  items,
  selectedId,
  onSelect,
  defaultOpen,
}: {
  label: string;
  icon: typeof SunriseIcon;
  items: Item[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (items.length === 0) return null;
  return (
    <section className="overflow-hidden">
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
                selected={selectedId === it.id}
                onSelect={() => onSelect(it.id)}
              />
            ) : (
              <LoomListRow
                key={it.id}
                loom={it.l}
                selected={selectedId === it.id}
                onSelect={() => onSelect(it.id)}
              />
            ),
          )}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ demo */

export function ProjectHubWorkFirst() {
  const [q, setQ] = useState("");
  const [entity, setEntity] = useState<Entity>("all");
  const [stateF, setStateF] = useState<StateFilter>("any");
  const [selectedId, setSelectedId] = useState<string | null>("s-01");

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    if (entity !== "looms") {
      for (const s of DEMO_SESSIONS) {
        if (matchSession(s, q))
          out.push({ kind: "session", id: s.id, updatedAt: s.updatedAt, s });
      }
    }
    if (entity !== "sessions") {
      for (const l of DEMO_LOOMS) {
        if (matchLoom(l, q))
          out.push({ kind: "loom", id: l.id, updatedAt: l.updatedAt, l });
      }
    }
    return out
      .filter((it) => passesState(it, stateF))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [q, entity, stateF]);

  const byBucket = useMemo(() => {
    const map: Record<AgeBucket, Item[]> = { today: [], week: [], older: [] };
    for (const it of items) map[ageBucket(it.updatedAt)].push(it);
    return map;
  }, [items]);

  const selected = items.find((it) => it.id === selectedId) ?? null;

  const runningCount = DEMO_LOOMS.filter((l) => isLoomActive(l.state)).length;
  const needsYouCount = DEMO_LOOMS.filter((l) => isLoomNeedsYou(l.state)).length;

  const entityChips: { value: Entity; label: string; count: number }[] = [
    { value: "all", label: "All", count: DEMO_SESSIONS.length + DEMO_LOOMS.length },
    { value: "sessions", label: "Sessions", count: DEMO_SESSIONS.length },
    { value: "looms", label: "Looms", count: DEMO_LOOMS.length },
  ];
  const stateChips: { value: StateFilter; label: string }[] = [
    { value: "any", label: "Any state" },
    { value: "active", label: "Active" },
    { value: "needs-you", label: "Needs you" },
    { value: "done", label: "Done" },
  ];

  return (
    <StageFrame>
      {() => (
        <div className="flex h-full flex-col lg:flex-row">
          {/* LIST rail — the hero */}
          <div className="flex min-h-0 w-full flex-col border-border lg:w-[27rem] lg:border-r">
            {/* project heading + primary action */}
            <div className="shrink-0 border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card">
                  <FolderGit2Icon className="size-4 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <h1 className="truncate font-heading text-sm font-semibold tracking-tight">
                    {DEMO_PROJECT.name}
                  </h1>
                  <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                    <span>{DEMO_SESSIONS.length} sessions</span>
                    <span className="text-border">·</span>
                    <span>{DEMO_LOOMS.length} looms</span>
                    {runningCount > 0 && (
                      <>
                        <span className="text-border">·</span>
                        <span className="text-sky-300">{runningCount} running</span>
                      </>
                    )}
                  </p>
                </div>
                <Button size="sm">
                  <PlusIcon />
                  New session
                </Button>
              </div>
            </div>

            {/* search-first toolbar */}
            <div className="shrink-0 space-y-2 border-b border-border px-4 py-2.5">
              <SearchField
                value={q}
                onChange={setQ}
                placeholder="Search sessions & looms…"
              />
              <div className="flex flex-wrap items-center gap-1.5">
                {entityChips.map((c) => (
                  <Chip
                    key={c.value}
                    active={entity === c.value}
                    onClick={() => setEntity(c.value)}
                    count={c.count}
                  >
                    {c.label}
                  </Chip>
                ))}
                <span className="mx-0.5 h-4 w-px bg-border" />
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

            {/* grouped list */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {items.length === 0 ? (
                <div className="flex flex-col items-center gap-3 px-4 py-16 text-center">
                  <SearchXIcon className="size-6 text-muted-foreground/50" />
                  <p className="text-sm text-muted-foreground">
                    Nothing matches your filters.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setQ("");
                      setEntity("all");
                      setStateF("any");
                    }}
                  >
                    Reset filters
                  </Button>
                </div>
              ) : (
                BUCKETS.map((b) => (
                  <Bucket
                    key={b.key}
                    label={b.label}
                    icon={b.icon}
                    items={byBucket[b.key]}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    defaultOpen={b.key !== "older"}
                  />
                ))
              )}
            </div>
          </div>

          {/* PREVIEW pane */}
          <div className="min-h-0 flex-1 bg-background/60">
            {selected ? (
              selected.kind === "session" ? (
                <SessionPreview session={selected.s} />
              ) : (
                <LoomPreview loom={selected.l} />
              )
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
                <InboxIcon className="size-7 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  Select a session or loom to preview it here.
                </p>
                <p className="max-w-xs text-xs text-muted-foreground/70">
                  The last exchange, cost, and a quick way in — without leaving
                  the hub.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </StageFrame>
  );
}
