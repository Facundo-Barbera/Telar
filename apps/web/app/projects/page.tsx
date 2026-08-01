"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ActivityIcon,
  FolderGit2Icon,
  MessagesSquareIcon,
  MoonIcon,
  PinIcon,
  RotateCwIcon,
  SearchXIcon,
  ShieldIcon,
  TriangleAlertIcon,
  WorkflowIcon,
} from "lucide-react";
import type { Loom, ProjectManifest, RegistryEntry } from "@telar/core";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import {
  AccountBadge,
  Chip,
  GroupHeader,
  SearchField,
  SortSelect,
} from "@/components/common/list-controls";
import { RegisterProjectDialog } from "@/components/projects/register-dialog";
import { UnregisterButton } from "@/components/projects/project-card";
import { cn } from "@/lib/utils";
import { fmtAgo } from "@/lib/format";
import {
  byLastActivity,
  byOpenWork,
  deriveProjectSignals,
  type ProjectSignal,
} from "@/lib/project-signal";

type ProjectEntry = {
  entry: RegistryEntry;
  manifest: ProjectManifest | null;
  error: string | null;
};

// The chat fields the index reads — declared locally so this client component
// never pulls the fs-backed store into its bundle (see dashboard/page.tsx).
type ChatMeta = { id: string; project?: string; updatedAt: number };

// A registry entry fused with the live signal derived from looms + chats, so a
// dense row can show which repo is busy at a glance. The counts come straight
// off lib/project-signal; what stays local is the manifest presentation — the
// em-dash fallbacks and the gate tally are how this row reads a telar.yaml, not
// how the app decides a project is busy.
type ProjectRow = {
  entry: RegistryEntry;
  manifest: ProjectManifest | null;
  broken: boolean;
  account: string;
  adapter: string;
  gates: number;
  counts: ProjectSignal["counts"];
  sessionsToday: number;
  lastActivity: number;
};

type Sort = "activity" | "name" | "work";

const PINNED_KEY = "telar:pinnedProjects";

// One repo is worth the reader's attention when there is open work in it or
// somebody sat down with it today. `counts.open` already contains the in-flight
// looms, so it is the only loom number this question needs.
const isBusy = (r: ProjectRow): boolean =>
  r.counts.open > 0 || r.sessionsToday > 0;

function LiveDot() {
  return (
    <span className="relative flex size-2">
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-400 opacity-60" />
      <span className="relative inline-flex size-2 rounded-full bg-sky-400" />
    </span>
  );
}

function Metric({
  icon: Icon,
  value,
  label,
  tint,
}: {
  icon: typeof ShieldIcon;
  value: number;
  label: string;
  tint?: string;
}) {
  return (
    <span
      className={cn(
        "flex w-11 shrink-0 items-center justify-end gap-1 font-mono text-xs tabular-nums",
        value === 0 ? "text-muted-foreground/40" : "text-muted-foreground",
      )}
      title={`${value} ${label}`}
    >
      <Icon
        className={cn("size-3.5", value > 0 ? tint : "text-muted-foreground/40")}
      />
      {value}
    </span>
  );
}

function ProjectRowItem({
  row,
  pinned,
  onTogglePin,
  onChanged,
}: {
  row: ProjectRow;
  pinned: boolean;
  onTogglePin: () => void;
  onChanged: () => void;
}) {
  const href = `/projects/${encodeURIComponent(row.entry.name)}`;
  return (
    <div className="group flex items-center gap-2 pr-2 pl-2 transition-colors hover:bg-muted/40">
      <button
        type="button"
        onClick={onTogglePin}
        className={cn(
          "shrink-0 rounded-md p-1 transition-colors",
          pinned
            ? "text-amber-400"
            : "text-muted-foreground/30 hover:text-muted-foreground group-hover:text-muted-foreground/60",
        )}
        title={pinned ? "Unpin" : "Pin"}
        aria-label={pinned ? `Unpin ${row.entry.name}` : `Pin ${row.entry.name}`}
      >
        <PinIcon className={cn("size-3.5", pinned && "fill-current")} />
      </button>

      <Link
        href={href}
        className="flex min-w-0 flex-1 items-center gap-3 py-2.5"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {row.counts.inFlight > 0 && <LiveDot />}
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              {row.broken ? (
                <TriangleAlertIcon className="size-3.5 shrink-0 text-destructive" />
              ) : (
                <FolderGit2Icon className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate text-sm font-medium">
                {row.manifest?.name ?? row.entry.name}
              </span>
              {row.broken && (
                <span className="shrink-0 rounded bg-destructive/10 px-1.5 py-0 font-mono text-[10px] text-destructive">
                  manifest error
                </span>
              )}
            </div>
            <p
              className="mt-0.5 hidden truncate font-mono text-[11px] text-muted-foreground/70 sm:block"
              title={row.entry.root}
            >
              {row.entry.root}
            </p>
          </div>
        </div>

        <AccountBadge account={row.account} />
        <span className="hidden w-16 shrink-0 truncate text-right font-mono text-[11px] text-muted-foreground md:block">
          {row.adapter}
        </span>

        <div className="flex shrink-0 items-center gap-1">
          <Metric
            icon={ActivityIcon}
            value={row.counts.inFlight}
            label="running looms"
            tint="text-sky-400"
          />
          <Metric
            icon={MessagesSquareIcon}
            value={row.sessionsToday}
            label="sessions today"
            tint="text-foreground"
          />
          <Metric
            icon={WorkflowIcon}
            value={row.counts.open}
            label="open looms"
            tint="text-indigo-300"
          />
          <Metric
            icon={ShieldIcon}
            value={row.gates}
            label="gates"
            tint="text-muted-foreground"
          />
        </div>

        <span className="w-14 shrink-0 text-right text-[11px] text-muted-foreground">
          {fmtAgo(row.lastActivity)}
        </span>
      </Link>

      <UnregisterButton
        name={row.entry.name}
        onDone={onChanged}
        className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      />
    </div>
  );
}

function Group({
  icon,
  label,
  tint,
  rows,
  pinnedSet,
  onTogglePin,
  onChanged,
  defaultOpen,
}: {
  icon: typeof ActivityIcon;
  label: string;
  tint?: string;
  rows: ProjectRow[];
  pinnedSet: Set<string>;
  onTogglePin: (name: string) => void;
  onChanged: () => void;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (rows.length === 0) return null;
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <GroupHeader
        icon={icon}
        label={label}
        count={rows.length}
        open={open}
        onToggle={() => setOpen((o) => !o)}
        tint={tint}
      />
      {open && (
        <div className="divide-y divide-border">
          {rows.map((r) => (
            <ProjectRowItem
              key={r.entry.name}
              row={r}
              pinned={pinnedSet.has(r.entry.name)}
              onTogglePin={() => onTogglePin(r.entry.name)}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export default function ProjectsPage() {
  const [entries, setEntries] = useState<ProjectEntry[] | null>(null);
  const [looms, setLooms] = useState<Loom[]>([]);
  const [chats, setChats] = useState<ChatMeta[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("activity");
  const [account, setAccount] = useState<string>("all");
  const [pinned, setPinned] = useState<Set<string>>(new Set());

  // Pinned projects persist client-side (no server prefs surface exists yet).
  // Hydration-guarded: read after mount so SSR and first paint agree.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PINNED_KEY);
      if (raw) setPinned(new Set(JSON.parse(raw) as string[]));
    } catch {
      /* ignore malformed/absent */
    }
  }, []);

  const togglePin = (name: string) =>
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      try {
        localStorage.setItem(PINNED_KEY, JSON.stringify([...next]));
      } catch {
        /* storage unavailable — pins stay in-memory for the session */
      }
      return next;
    });

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      if (!res.ok) throw new Error(`Couldn't load projects (${res.status})`);
      const data = await res.json();
      setEntries(Array.isArray(data.projects) ? data.projects : []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setEntries((prev) => prev ?? null);
    }
    // Looms + chats power the per-project signal columns. Best-effort: a
    // failure just leaves those metrics at zero rather than gating the list.
    fetch("/api/looms")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setLooms(Array.isArray(d.looms) ? d.looms : []))
      .catch(() => {});
    fetch("/api/chats")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setChats(Array.isArray(d.chats) ? d.chats : []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const onRefresh = () => void load();
    window.addEventListener("telar:refresh", onRefresh);
    return () => window.removeEventListener("telar:refresh", onRefresh);
  }, [load]);

  const rows = useMemo<ProjectRow[]>(() => {
    if (!entries) return [];
    return deriveProjectSignals({ projects: entries, looms, chats }).map(
      (signal) => {
        const { entry, manifest, error: manifestError } = signal.project;
        return {
          entry,
          manifest,
          broken: !manifest || !!manifestError,
          account: manifest?.account ?? "—",
          adapter: manifest?.adapter ?? "—",
          gates: manifest?.gates.length ?? 0,
          counts: signal.counts,
          sessionsToday: signal.chatsToday.length,
          lastActivity: signal.lastActivity,
        };
      },
    );
  }, [entries, looms, chats]);

  const accountOptions = useMemo(() => {
    const set = new Set(rows.map((r) => r.account).filter((a) => a !== "—"));
    return ["all", ...[...set].sort()];
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = rows.filter(
      (r) =>
        !needle ||
        r.entry.name.toLowerCase().includes(needle) ||
        r.adapter.toLowerCase().includes(needle) ||
        r.entry.root.toLowerCase().includes(needle),
    );
    if (account !== "all") out = out.filter((r) => r.account === account);
    const cmp: Record<Sort, (a: ProjectRow, b: ProjectRow) => number> = {
      activity: byLastActivity,
      name: (a, b) => a.entry.name.localeCompare(b.entry.name),
      work: byOpenWork,
    };
    return [...out].sort(cmp[sort]);
  }, [rows, q, account, sort]);

  const pinnedList = filtered.filter((r) => pinned.has(r.entry.name));
  const rest = filtered.filter((r) => !pinned.has(r.entry.name));
  const active = rest.filter(isBusy);
  const idle = rest.filter((r) => !isBusy(r));

  const activeNow = rows.filter((r) => r.counts.inFlight > 0).length;
  const populated = entries !== null && entries.length > 0;

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <PageHeader
        title="Projects"
        description={
          populated
            ? `${entries.length} ${entries.length === 1 ? "repo" : "repos"} on the loom · ${activeNow} active now`
            : "Repos on the loom — each carries its gates, guardrails, and account in a telar.yaml."
        }
        actions={<RegisterProjectDialog onRegistered={load} />}
      />

      {/* Search-first toolbar */}
      {populated && (
        <div className="shrink-0 border-b border-border">
          <div className="mx-auto flex w-full max-w-5xl items-center gap-2 px-4 py-2.5">
            <SearchField
              value={q}
              onChange={setQ}
              placeholder="Search projects by name, adapter, or path…"
            />
            {accountOptions.map((a) => (
              <Chip
                key={a}
                active={account === a}
                onClick={() => setAccount(a)}
              >
                {a === "all" ? "All" : a}
              </Chip>
            ))}
            <SortSelect
              value={sort}
              onChange={setSort}
              options={[
                { value: "activity", label: "Sort: last active" },
                { value: "work", label: "Sort: open work" },
                { value: "name", label: "Sort: name" },
              ]}
            />
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl space-y-3 px-4 py-4">
          {/* Loading */}
          {entries === null && !error && (
            <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-3 py-3">
                  <Skeleton className="size-4 rounded" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-1/3" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                  <Skeleton className="h-4 w-16" />
                </div>
              ))}
            </div>
          )}

          {/* First-load failure */}
          {entries === null && error && (
            <EmptyState
              icon={TriangleAlertIcon}
              iconClassName="text-destructive/60"
              title="Couldn't reach the registry"
              description={
                <span className="font-mono text-xs break-words">{error}</span>
              }
              action={
                <Button variant="outline" size="sm" onClick={() => void load()}>
                  <RotateCwIcon />
                  Retry
                </Button>
              }
            />
          )}

          {/* Empty */}
          {entries !== null && entries.length === 0 && (
            <EmptyState
              icon={FolderGit2Icon}
              title="No projects on the loom yet"
              description="A telar.yaml in a repo declares its gates, guardrails, and account — register one to let Telar weave changes there."
              action={<RegisterProjectDialog onRegistered={load} />}
            />
          )}

          {/* Populated */}
          {populated && (
            <>
              {error && (
                <Alert variant="destructive" className="mb-1">
                  <TriangleAlertIcon />
                  <AlertTitle>Refresh failed</AlertTitle>
                  <AlertDescription className="font-mono text-xs break-words">
                    {error}
                  </AlertDescription>
                </Alert>
              )}
              {filtered.length === 0 ? (
                <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
                  <SearchXIcon className="size-6 text-muted-foreground/50" />
                  <p className="text-sm text-muted-foreground">
                    No projects match your filters.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setQ("");
                      setAccount("all");
                    }}
                  >
                    Clear filters
                  </Button>
                </div>
              ) : (
                <>
                  <Group
                    icon={PinIcon}
                    label="Pinned"
                    tint="text-amber-400"
                    rows={pinnedList}
                    pinnedSet={pinned}
                    onTogglePin={togglePin}
                    onChanged={load}
                    defaultOpen
                  />
                  <Group
                    icon={ActivityIcon}
                    label="Active"
                    tint="text-sky-400"
                    rows={active}
                    pinnedSet={pinned}
                    onTogglePin={togglePin}
                    onChanged={load}
                    defaultOpen
                  />
                  <Group
                    icon={MoonIcon}
                    label="Idle"
                    rows={idle}
                    pinnedSet={pinned}
                    onTogglePin={togglePin}
                    onChanged={load}
                    defaultOpen={false}
                  />
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
