"use client";

// The project hub — variant-c "Hybrid" (owner-selected; spec in
// lib/demo-gallery/project/variant-c.tsx). A compact identity header over tabs
// Sessions | Looms | Settings. Sessions is a dense, grouped, search-first list
// (sessions only, no preview pane); Looms is state-toned data-light cards;
// Settings folds the standalone project-settings view in as the tab body. Tab
// lives in the URL (?tab=looms) so it's shareable. All @telar/core imports are
// type-only — nothing here reaches server-only modules (client-bundle rule).
import {
  Suspense,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ActivityIcon,
  ArrowLeftIcon,
  CalendarClockIcon,
  CheckCheckIcon,
  CircleCheckIcon,
  ChevronRightIcon,
  FolderGit2Icon,
  FolderXIcon,
  GitBranchIcon,
  HistoryIcon,
  MessagesSquareIcon,
  PlayIcon,
  PlusIcon,
  RotateCwIcon,
  SearchXIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  SunriseIcon,
  Trash2Icon,
  TriangleAlertIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react";
import type {
  Loom,
  ProjectManifest,
  RegistryEntry,
  WorkUnitState,
} from "@telar/core";
import type { ChatSummary } from "@/lib/store";
import { fmtAgo, fmtCost } from "@/lib/format";
import { modelById } from "@/lib/models";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/common/empty-state";
import { StateBadge } from "@/components/common/state-badge";
import {
  Chip,
  GroupHeader,
  SearchField,
  WeaveChip,
} from "@/components/common/list-controls";
import {
  isLoomAwaitingAccept,
  isLoomAwaitingDecision,
  isLoomClosed,
  isLoomRunning,
} from "@/lib/project-signal";
import { ArchiveButton } from "@/components/session/archive-button";
import { isTerminal, stateRailClass, sumCost } from "@/components/looms/utils";
import { ProjectSettings } from "@/components/projects/settings-view";
import { GitTab } from "@/components/projects/git-tab";

type ProjectEntry = {
  entry: RegistryEntry;
  manifest: ProjectManifest | null;
  error: string | null;
};

type ChatMeta = ChatSummary;
type Status = "loading" | "ready" | "missing" | "error";
type Tab = "sessions" | "looms" | "git" | "settings";
type StateFilter = "any" | "active" | "needs-you" | "done";

/* ---------------------------------------------------------------- age helpers */

const DAY = 24 * 60 * 60 * 1000;
type AgeBucket = "today" | "week" | "older";
function ageBucket(ts: number): AgeBucket {
  const age = Date.now() - ts;
  if (age < DAY) return "today";
  if (age < 7 * DAY) return "week";
  return "older";
}

const AGE_BUCKETS: { key: AgeBucket; label: string; icon: LucideIcon }[] = [
  { key: "today", label: "Today", icon: SunriseIcon },
  { key: "week", label: "This week", icon: CalendarClockIcon },
  { key: "older", label: "Older", icon: HistoryIcon },
];

function matchSession(c: ChatMeta, needle: string): boolean {
  if (!needle) return true;
  const n = needle.toLowerCase();
  const model = modelById(c.model)?.name ?? c.model;
  return (
    (c.title ?? "").toLowerCase().includes(n) ||
    (c.preview ?? "").toLowerCase().includes(n) ||
    model.toLowerCase().includes(n)
  );
}

function matchLoom(l: Loom, needle: string): boolean {
  if (!needle) return true;
  const n = needle.toLowerCase();
  return (
    l.title.toLowerCase().includes(n) ||
    l.kind.toLowerCase().includes(n) ||
    l.state.toLowerCase().includes(n)
  );
}

/* --------------------------------------------------------------- chrome bits */

function BackLink() {
  return (
    <Link
      href="/projects"
      className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      aria-label="Back to projects"
    >
      <ArrowLeftIcon className="size-4" />
    </Link>
  );
}

// Two-click confirm: opening the popover is the first click, "Unregister" the
// second. Navigates back to the projects list on success.
function UnregisterButton({ name }: { name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      await fetch(`/api/projects/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
    } catch {
      /* best-effort — navigating away, the list will show the true state */
    } finally {
      window.dispatchEvent(new Event("telar:refresh"));
      router.push("/projects");
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-destructive"
            aria-label={`Unregister ${name}`}
          />
        }
      >
        <Trash2Icon />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <PopoverHeader>
          <PopoverTitle>Unregister {name}?</PopoverTitle>
          <PopoverDescription>
            Removes it from the registry. The repo and its telar.yaml stay
            untouched.
          </PopoverDescription>
        </PopoverHeader>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => void remove()}
            disabled={busy}
          >
            {busy ? <Spinner /> : <Trash2Icon />}
            Unregister
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function EmptyFilter({
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

function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-4 w-14" />
        </div>
      ))}
    </div>
  );
}

function SectionError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <EmptyState
      icon={TriangleAlertIcon}
      iconClassName="text-destructive/60"
      title="Couldn't load this section"
      description={
        <span className="font-mono text-xs break-words">{message}</span>
      }
      action={
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCwIcon />
          Retry
        </Button>
      }
    />
  );
}

/* -------------------------------------------------------------- sessions tab */

// One dense session row. The body links to the session deep link (preserved);
// a session that wove a loom carries a state-toned rail + a loom pill that
// jumps to the Looms tab and highlights that loom (never opens the session).
function SessionRow({
  name,
  chat,
  loom,
  onOpenLoom,
}: {
  name: string;
  chat: ChatMeta;
  loom: Loom | undefined;
  onOpenLoom: (loomId: string) => void;
}) {
  const model = modelById(chat.model)?.name ?? chat.model;
  return (
    <div className="group relative flex items-center transition-colors hover:bg-muted/40">
      {loom && (
        <span
          aria-hidden
          className={cn(
            "absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full",
            stateRailClass(loom.state),
          )}
        />
      )}
      <Link
        href={`/projects/${encodeURIComponent(name)}/sessions/${chat.id}`}
        className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pr-2 pl-4"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {chat.title || "Untitled session"}
          </div>
          {chat.preview && (
            <div className="mt-0.5 truncate text-xs text-muted-foreground/80">
              {chat.preview}
            </div>
          )}
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-mono">{model}</span>
            <span className="text-border">·</span>
            <span>
              {chat.turns} {chat.turns === 1 ? "turn" : "turns"}
            </span>
          </div>
        </div>
      </Link>
      <div className="flex shrink-0 items-center gap-2 pr-2 pl-1">
        {loom && (
          <button
            type="button"
            onClick={() => onOpenLoom(loom.id)}
            className="rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            aria-label={`Show the loom this session wove (${loom.state})`}
            title="Show in Looms"
          >
            <StateBadge state={loom.state} className="shrink-0" />
          </button>
        )}
        <div className="flex flex-col items-end gap-0.5">
          <span className="font-mono text-xs tabular-nums">
            {fmtCost(chat.costUsd)}
          </span>
          <span className="text-xs text-muted-foreground">
            {fmtAgo(chat.updatedAt)}
          </span>
        </div>
        <ArchiveButton
          id={chat.id}
          className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        />
      </div>
    </div>
  );
}

function SessionBucket({
  label,
  icon,
  name,
  chats,
  loomById,
  onOpenLoom,
  defaultOpen,
}: {
  label: string;
  icon: LucideIcon;
  name: string;
  chats: ChatMeta[];
  loomById: Map<string, Loom>;
  onOpenLoom: (loomId: string) => void;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (chats.length === 0) return null;
  return (
    <section className="overflow-hidden">
      <GroupHeader
        icon={icon}
        label={label}
        count={chats.length}
        open={open}
        onToggle={() => setOpen((o) => !o)}
      />
      {open && (
        <div className="divide-y divide-border">
          {chats.map((c) => (
            <SessionRow
              key={c.id}
              name={name}
              chat={c}
              loom={c.loomId ? loomById.get(c.loomId) : undefined}
              onOpenLoom={onOpenLoom}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// A session passes the state filter on the state of the loom it wove; a session
// with no loom only survives "any".
function sessionPassesState(
  loom: Loom | undefined,
  f: StateFilter,
): boolean {
  if (f === "any") return true;
  if (!loom) return false;
  if (f === "active") return isLoomRunning(loom.state);
  if (f === "needs-you") return isLoomAwaitingDecision(loom.state);
  return isLoomAwaitingAccept(loom.state) || isLoomClosed(loom.state);
}

function SessionsTab({
  name,
  chats,
  chatsError,
  loomById,
  onOpenLoom,
  onRetry,
  newSessionHref,
}: {
  name: string;
  chats: ChatMeta[] | null;
  chatsError: string | null;
  loomById: Map<string, Loom>;
  onOpenLoom: (loomId: string) => void;
  onRetry: () => void;
  newSessionHref: string;
}) {
  const [q, setQ] = useState("");
  const [stateF, setStateF] = useState<StateFilter>("any");

  const filtered = useMemo(() => {
    if (!chats) return [];
    return chats
      .filter(
        (c) =>
          matchSession(c, q) &&
          sessionPassesState(
            c.loomId ? loomById.get(c.loomId) : undefined,
            stateF,
          ),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [chats, q, stateF, loomById]);

  const byBucket = useMemo(() => {
    const map: Record<AgeBucket, ChatMeta[]> = { today: [], week: [], older: [] };
    for (const c of filtered) map[ageBucket(c.updatedAt)].push(c);
    return map;
  }, [filtered]);

  const needsYouCount = useMemo(() => {
    if (!chats) return 0;
    return chats.filter((c) => {
      const l = c.loomId ? loomById.get(c.loomId) : undefined;
      return l && isLoomAwaitingDecision(l.state);
    }).length;
  }, [chats, loomById]);

  const stateChips: { value: StateFilter; label: string }[] = [
    { value: "any", label: "Any state" },
    { value: "active", label: "Active" },
    { value: "needs-you", label: "Needs you" },
    { value: "done", label: "Done" },
  ];

  if (chats === null) {
    return chatsError ? (
      <div className="p-4">
        <SectionError message={chatsError} onRetry={onRetry} />
      </div>
    ) : (
      <ListSkeleton rows={4} />
    );
  }

  if (chats.length === 0) {
    return (
      <div className="p-4">
        <EmptyState
          icon={MessagesSquareIcon}
          title="No sessions yet"
          description="Sessions explore and prepare; looms execute."
          action={
            <Button variant="outline" render={<Link href={newSessionHref} />}>
              <MessagesSquareIcon />
              New session
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 space-y-2 border-b border-border px-4 py-2.5">
        <SearchField value={q} onChange={setQ} placeholder="Search sessions…" />
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

      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <EmptyFilter
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
              name={name}
              chats={byBucket[b.key]}
              loomById={loomById}
              onOpenLoom={onOpenLoom}
              defaultOpen={b.key !== "older"}
            />
          ))
        )}
        <div className="px-4 py-3">
          <ArchivedSessions name={name} />
        </div>
      </div>
    </div>
  );
}

// A collapsed-by-default drawer of this project's archived sessions. Lazily
// fetches archived=only on first expand; telar:refresh keeps an open drawer
// fresh and invalidates a closed one so reopening refetches.
function ArchivedSessions({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ChatMeta[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchArchived = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/chats?project=${encodeURIComponent(name)}&archived=only`,
      );
      if (!res.ok)
        throw new Error(`Couldn't load archived sessions (${res.status}).`);
      const d = (await res.json()) as { chats?: ChatMeta[] };
      setRows(d.chats ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [name]);

  useEffect(() => {
    if (open && rows === null) void fetchArchived();
  }, [open, rows, fetchArchived]);

  useEffect(() => {
    const onRefresh = () => {
      if (open) void fetchArchived();
      else setRows(null);
    };
    window.addEventListener("telar:refresh", onRefresh);
    return () => window.removeEventListener("telar:refresh", onRefresh);
  }, [open, fetchArchived]);

  const count = rows?.length ?? 0;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="flex flex-col gap-2"
    >
      <CollapsibleTrigger className="group/arch flex w-fit items-center gap-1.5 px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase transition-colors hover:text-foreground">
        <ChevronRightIcon
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
        Archived
        {rows !== null && count > 0 && (
          <span className="font-mono text-[10px] normal-case">({count})</span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {loading ? (
          <ListSkeleton rows={1} />
        ) : error ? (
          <SectionError message={error} onRetry={() => void fetchArchived()} />
        ) : count === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            No archived sessions.
          </p>
        ) : (
          <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
            {rows?.map((chat) => (
              <div key={chat.id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-foreground/80">
                    {chat.title || "Untitled session"}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {fmtAgo(chat.updatedAt)}
                  </div>
                </div>
                <ArchiveButton
                  id={chat.id}
                  archived
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                />
              </div>
            ))}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/* ----------------------------------------------------------------- looms tab */

// The four groups are lib/project-signal's four buckets, in its order: this tab
// is the surface that shows `ready` apart from the rest, because a verified
// loom waiting to be accepted is a different ask from one waiting to be
// unblocked. The indexes fold the two together; both read the same partition.
type LoomGroupKey = "running" | "needs-you" | "ready" | "done";
const LOOM_GROUPS: {
  key: LoomGroupKey;
  label: string;
  icon: LucideIcon;
  tint: string;
  match: (s: WorkUnitState) => boolean;
}[] = [
  {
    key: "running",
    label: "Running",
    icon: ActivityIcon,
    tint: "text-sky-400",
    match: isLoomRunning,
  },
  {
    key: "needs-you",
    label: "Needs you",
    icon: TriangleAlertIcon,
    tint: "text-amber-400",
    match: isLoomAwaitingDecision,
  },
  {
    key: "ready",
    label: "Ready",
    icon: CircleCheckIcon,
    tint: "text-emerald-400",
    match: isLoomAwaitingAccept,
  },
  {
    key: "done",
    label: "Done",
    icon: CheckCheckIcon,
    tint: "text-muted-foreground",
    match: isLoomClosed,
  },
];

// A state-toned, data-light loom card — a left state rail, StateBadge, title +
// weave chip, quiet kind/attempts, cost/age. The whole card links to the loom.
function LoomCard({
  loom,
  highlighted,
}: {
  loom: Loom;
  highlighted: boolean;
}) {
  const attempts = loom.attempts.length;
  return (
    <div
      className={cn(
        "rounded-xl transition-shadow",
        highlighted &&
          "ring-2 ring-primary ring-offset-2 ring-offset-background",
      )}
    >
      <Link
        href={`/looms/${loom.id}`}
        className="relative block overflow-hidden rounded-xl border border-border bg-card p-3 transition-colors hover:border-foreground/25"
      >
        <span
          aria-hidden
          className={cn(
            "absolute top-0 bottom-0 left-0 w-[3px]",
            stateRailClass(loom.state),
          )}
        />
        <div className="flex items-start gap-2 pl-1.5">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {loom.title}
              </span>
              <WeaveChip loom={loom} />
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <StateBadge state={loom.state} className="shrink-0" />
              <span className="font-mono">{loom.kind}</span>
              {attempts > 1 && (
                <>
                  <span className="text-border">·</span>
                  <span>{attempts} attempts</span>
                </>
              )}
            </div>
            {loom.error && (
              <p
                className={cn(
                  "mt-1.5 truncate text-xs",
                  loom.state === "failed"
                    ? "text-destructive/80"
                    : "text-amber-300/80",
                )}
                title={loom.error}
              >
                {loom.error}
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-0.5">
            <span className="font-mono text-xs tabular-nums">
              {fmtCost(sumCost(loom.attempts))}
            </span>
            <span className="text-xs text-muted-foreground">
              {fmtAgo(loom.updatedAt)}
            </span>
          </div>
        </div>
      </Link>
    </div>
  );
}

function LoomGroupSection({
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
  looms: Loom[];
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
            <LoomCard key={l.id} loom={l} highlighted={highlightId === l.id} />
          ))}
        </div>
      )}
    </section>
  );
}

function LoomsTab({
  looms,
  loomsError,
  highlightId,
  onClearHighlight,
  onRetry,
  newLoomHref,
}: {
  looms: Loom[] | null;
  loomsError: string | null;
  highlightId: string | null;
  onClearHighlight: () => void;
  onRetry: () => void;
  newLoomHref: string;
}) {
  const [q, setQ] = useState("");

  const grouped = useMemo(() => {
    const matched = (looms ?? [])
      .filter((l) => matchLoom(l, q))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return LOOM_GROUPS.map((g) => ({
      ...g,
      looms: matched.filter((l) => g.match(l.state)),
    }));
  }, [looms, q]);

  const total = grouped.reduce((n, g) => n + g.looms.length, 0);

  if (looms === null) {
    return loomsError ? (
      <div className="p-4">
        <SectionError message={loomsError} onRetry={onRetry} />
      </div>
    ) : (
      <ListSkeleton rows={4} />
    );
  }

  if (looms.length === 0) {
    return (
      <div className="p-4">
        <EmptyState
          icon={SparklesIcon}
          title="No looms yet"
          description="Weave a loom to let Telar make the change and prove it through the gates."
          action={
            <Button variant="outline" render={<Link href={newLoomHref} />}>
              <PlayIcon />
              New loom session
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <SearchField
          value={q}
          onChange={(v) => {
            setQ(v);
            onClearHighlight();
          }}
          placeholder="Search looms…"
        />
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          render={<Link href={newLoomHref} />}
        >
          <PlayIcon />
          New loom
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {total === 0 ? (
          <EmptyFilter
            onReset={() => setQ("")}
            label="No looms match your search."
          />
        ) : (
          grouped.map((g) => (
            <LoomGroupSection
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

/* ----------------------------------------------------------------- edge UI */

function EdgeShell({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex h-dvh flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <BackLink />
        <h1 className="font-heading text-sm font-semibold tracking-tight">
          {title}
        </h1>
      </div>
      <div className="flex flex-1 items-center justify-center p-6">
        {children}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- hub */

function ProjectHub({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const tabParam = searchParams.get("tab");
  const tab: Tab =
    tabParam === "looms" || tabParam === "git" || tabParam === "settings"
      ? tabParam
      : "sessions";

  const [project, setProject] = useState<ProjectEntry | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatMeta[] | null>(null);
  const [looms, setLooms] = useState<Loom[] | null>(null);
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [loomsError, setLoomsError] = useState<string | null>(null);
  const [highlightLoom, setHighlightLoom] = useState<string | null>(null);

  const newSessionHref = `/projects/${encodeURIComponent(name)}/sessions/new`;
  const newLoomHref = `/looms?new=1&project=${encodeURIComponent(name)}`;

  const setTab = useCallback(
    (t: Tab) => {
      const p = new URLSearchParams(searchParams.toString());
      if (t === "sessions") p.delete("tab");
      else p.set("tab", t);
      const qs = p.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const openLoom = useCallback(
    (loomId: string) => {
      setHighlightLoom(loomId);
      setTab("looms");
    },
    [setTab],
  );

  const loomById = useMemo(
    () => new Map((looms ?? []).map((l) => [l.id, l] as const)),
    [looms],
  );

  const load = useCallback(async () => {
    let projectsRes: Response;
    let chatsRes: Response;
    let loomsRes: Response;
    try {
      [projectsRes, chatsRes, loomsRes] = await Promise.all([
        fetch("/api/projects"),
        fetch(`/api/chats?project=${encodeURIComponent(name)}`),
        fetch("/api/looms"),
      ]);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      setStatus((prev) => (prev === "loading" ? "error" : prev));
      return;
    }

    try {
      if (!projectsRes.ok)
        throw new Error(`Couldn't reach the registry (${projectsRes.status})`);
      const data = (await projectsRes.json()) as { projects?: ProjectEntry[] };
      const match =
        (data.projects ?? []).find((p) => p.entry.name === name) ?? null;
      if (!match) {
        setStatus("missing");
        return;
      }
      setProject(match);
      setStatus("ready");
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      setStatus((prev) => (prev === "loading" ? "error" : prev));
      return;
    }

    if (chatsRes.ok) {
      try {
        const d = (await chatsRes.json()) as { chats?: ChatMeta[] };
        setChats(d.chats ?? []);
        setChatsError(null);
      } catch {
        setChatsError("Couldn't parse the sessions response.");
      }
    } else {
      setChatsError(`Couldn't load sessions (${chatsRes.status}).`);
    }
    if (loomsRes.ok) {
      try {
        const d = (await loomsRes.json()) as { looms?: Loom[] };
        setLooms((d.looms ?? []).filter((r) => r.project === name));
        setLoomsError(null);
      } catch {
        setLoomsError("Couldn't parse the looms response.");
      }
    } else {
      setLoomsError(`Couldn't load looms (${loomsRes.status}).`);
    }
  }, [name]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onRefresh = () => void load();
    window.addEventListener("telar:refresh", onRefresh);
    return () => window.removeEventListener("telar:refresh", onRefresh);
  }, [load]);

  // Poll while any of this project's looms is still in flight.
  useEffect(() => {
    if (!looms) return;
    const inFlight = looms.some((r) => !isTerminal(r.state));
    if (!inFlight) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [looms, load]);

  if (status === "missing") {
    return (
      <EdgeShell title="Project">
        <EmptyState
          className="border-none"
          icon={FolderXIcon}
          title="Project not found"
          description={
            <>
              No project named{" "}
              <code className="font-mono text-foreground">{name}</code> is
              registered on the loom.
            </>
          }
          action={
            <Button variant="outline" render={<Link href="/projects" />}>
              Back to projects
            </Button>
          }
        />
      </EdgeShell>
    );
  }

  if (status === "error") {
    return (
      <EdgeShell title="Project">
        <EmptyState
          className="border-none"
          icon={TriangleAlertIcon}
          iconClassName="text-destructive/60"
          title="Couldn't load this project"
          description={
            <span className="font-mono text-xs break-words">{loadError}</span>
          }
          action={
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RotateCwIcon />
              Retry
            </Button>
          }
        />
      </EdgeShell>
    );
  }

  if (status === "loading" || !project) {
    return (
      <div className="flex h-dvh flex-col">
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
          <BackLink />
          <Skeleton className="h-5 w-40" />
          <div className="ml-auto">
            <Skeleton className="h-8 w-28 rounded-lg" />
          </div>
        </div>
        <ListSkeleton rows={6} />
      </div>
    );
  }

  const { entry, manifest } = project;
  const title = manifest?.name ?? entry.name;

  const runningCount = (looms ?? []).filter((l) => isLoomRunning(l.state))
    .length;
  const needsYouCount = (looms ?? []).filter((l) =>
    isLoomAwaitingDecision(l.state),
  ).length;

  const tabs: { key: Tab; label: string; icon: LucideIcon; count?: number }[] =
    [
      {
        key: "sessions",
        label: "Sessions",
        icon: MessagesSquareIcon,
        count: chats?.length,
      },
      {
        key: "looms",
        label: "Looms",
        icon: WorkflowIcon,
        count: looms?.length,
      },
      { key: "git", label: "Git", icon: GitBranchIcon },
      { key: "settings", label: "Settings", icon: SlidersHorizontalIcon },
    ];

  return (
    <div className="flex h-dvh flex-col">
      {/* COMPACT header — identity + primary action, then tabs. */}
      <div className="shrink-0 border-b border-border bg-background/60 px-4 pt-3">
        <div className="flex flex-wrap items-center gap-3">
          <BackLink />
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card">
            <FolderGit2Icon className="size-4.5 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate font-heading text-sm font-semibold tracking-tight">
                {title}
              </h1>
              {manifest ? (
                <>
                  <Badge
                    variant="outline"
                    className="shrink-0 px-1.5 py-0 text-[10px] text-muted-foreground"
                  >
                    {manifest.account}
                  </Badge>
                  <Badge
                    variant="outline"
                    className="shrink-0 px-1.5 py-0 font-mono text-[10px] text-muted-foreground"
                  >
                    {manifest.baseBranch}
                  </Badge>
                </>
              ) : (
                <Badge variant="destructive" className="shrink-0 text-[10px]">
                  manifest error
                </Badge>
              )}
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
          <Button size="sm" render={<Link href={newSessionHref} />}>
            <PlusIcon />
            New session
          </Button>
          <UnregisterButton name={entry.name} />
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
                      on ? "text-muted-foreground" : "text-muted-foreground/60",
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
        {tab === "sessions" && (
          <SessionsTab
            name={entry.name}
            chats={chats}
            chatsError={chatsError}
            loomById={loomById}
            onOpenLoom={openLoom}
            onRetry={() => void load()}
            newSessionHref={newSessionHref}
          />
        )}
        {tab === "looms" && (
          <LoomsTab
            looms={looms}
            loomsError={loomsError}
            highlightId={highlightLoom}
            onClearHighlight={() => setHighlightLoom(null)}
            onRetry={() => void load()}
            newLoomHref={newLoomHref}
          />
        )}
        {tab === "git" && <GitTab name={entry.name} />}
        {tab === "settings" && <ProjectSettings name={entry.name} embedded />}
      </div>
    </div>
  );
}

export default function ProjectDetailPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  return (
    <Suspense
      fallback={
        <div className="flex h-dvh flex-col">
          <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
            <BackLink />
            <Skeleton className="h-5 w-40" />
          </div>
          <ListSkeleton rows={6} />
        </div>
      }
    >
      <ProjectHub params={params} />
    </Suspense>
  );
}
