"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ActivityIcon,
  ClockIcon,
  FolderGit2Icon,
  HistoryIcon,
  RotateCwIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { Loom } from "@telar/core";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { StateBadge } from "@/components/common/state-badge";
import {
  Chip,
  GroupHeader,
  SearchField,
  SortSelect,
  WeaveChip,
  isLoomNeedsYou,
  isLoomRecent,
  isLoomRunning,
} from "@/components/common/list-controls";
import { PlanLoomButton } from "@/components/looms/plan-loom-button";
import { loomRole, stateRailClass, sumCost } from "@/components/looms/utils";
import { fmtAgo, fmtCost } from "@/lib/format";
import { cn } from "@/lib/utils";

type Sort = "recent" | "cost" | "attempts";
type KindFilter = "all" | "single" | "woven" | "verify";

// A dense loom row for the grouped index — rail + state badge + title/weave, a
// project · kind · attempts line, an error snippet on failed/needs-review, and a
// stacked cost/age on the right. Same visual language as the LoomCard, denser.
function LoomRow({ loom }: { loom: Loom }) {
  const attempts = loom.attempts.length;
  const showError =
    !!loom.error &&
    (loom.state === "failed" || loom.state === "needs-review");
  return (
    <Link
      href={`/looms/${loom.id}`}
      className="relative flex items-start gap-3 py-2 pr-3 pl-4 transition-colors hover:bg-muted/40"
    >
      <span
        aria-hidden
        className={cn(
          "absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full",
          stateRailClass(loom.state),
        )}
      />
      <StateBadge state={loom.state} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {loom.title}
          </span>
          <WeaveChip loom={loom} />
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <FolderGit2Icon className="size-3 shrink-0" />
          <span className="truncate">{loom.project}</span>
          <span className="text-border">·</span>
          <span className="font-mono">{loom.kind}</span>
          {attempts > 1 && (
            <>
              <span className="text-border">·</span>
              <span className="shrink-0">{attempts} attempts</span>
            </>
          )}
          {showError && (
            <span
              className={cn(
                "hidden min-w-0 truncate lg:inline",
                loom.state === "failed"
                  ? "text-destructive/80"
                  : "text-amber-300/80",
              )}
            >
              — {loom.error}
            </span>
          )}
        </div>
      </div>
      <div className="flex w-16 shrink-0 flex-col items-end gap-0.5">
        <span className="font-mono text-xs tabular-nums">
          {fmtCost(sumCost(loom.attempts))}
        </span>
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <ClockIcon className="size-3" />
          {fmtAgo(loom.updatedAt)}
        </span>
      </div>
    </Link>
  );
}

function Group({
  icon,
  label,
  tint,
  looms,
  defaultOpen,
}: {
  icon: typeof ActivityIcon;
  label: string;
  tint?: string;
  looms: Loom[];
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (looms.length === 0) return null;
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <GroupHeader
        icon={icon}
        label={label}
        count={looms.length}
        open={open}
        onToggle={() => setOpen((o) => !o)}
        tint={tint}
      />
      {open && (
        <div className="divide-y divide-border">
          {looms.map((l) => (
            <LoomRow key={l.id} loom={l} />
          ))}
        </div>
      )}
    </section>
  );
}

function LoomsInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [looms, setLooms] = useState<Loom[] | null>(null);
  const [active, setActive] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const autoRedirected = useRef(false);

  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("recent");
  const [kind, setKind] = useState<KindFilter>("all");

  const loadLooms = useCallback(async () => {
    try {
      const res = await fetch("/api/looms");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setLooms(data.looms ?? []);
      setActive(data.active ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Keep null until a load succeeds so first-load failure is distinct from
      // "loaded, but empty" — mirrors the projects page's error handling.
      setLooms((prev) => prev ?? null);
    }
  }, []);

  useEffect(() => {
    loadLooms();
  }, [loadLooms]);

  // Sidebar and sibling mutations broadcast telar:refresh — refetch on it.
  useEffect(() => {
    const onRefresh = () => loadLooms();
    window.addEventListener("telar:refresh", onRefresh);
    return () => window.removeEventListener("telar:refresh", onRefresh);
  }, [loadLooms]);

  // Legacy `?new=1&project=<name>` deep links (dashboard/project-page "New
  // loom" CTAs predating the loom-session front door) now redirect straight
  // into a loom session for that project — a loom begins only from a
  // session, never a one-click dialog. No project hint: land on the tab
  // itself, where "New loom session" offers the picker.
  useEffect(() => {
    if (autoRedirected.current) return;
    if (searchParams.get("new") === "1") {
      autoRedirected.current = true;
      const project = searchParams.get("project");
      router.replace(
        project ? `/looms/plan/${encodeURIComponent(project)}` : "/looms",
      );
    }
  }, [searchParams, router]);

  // Poll while anything is in flight.
  useEffect(() => {
    if (!looms) return;
    const inFlight =
      active.length > 0 || looms.some((r) => isLoomRunning(r.state));
    if (!inFlight) return;
    const t = setInterval(loadLooms, 3000);
    return () => clearInterval(t);
  }, [looms, active, loadLooms]);

  const filtered = useMemo(() => {
    if (!looms) return [];
    const needle = q.trim().toLowerCase();
    let out = looms.filter(
      (l) =>
        !needle ||
        l.title.toLowerCase().includes(needle) ||
        l.project.toLowerCase().includes(needle),
    );
    if (kind !== "all") out = out.filter((l) => loomRole(l) === kind);
    const dir: Record<Sort, (a: Loom, b: Loom) => number> = {
      recent: (a, b) => b.updatedAt - a.updatedAt,
      cost: (a, b) => sumCost(b.attempts) - sumCost(a.attempts),
      attempts: (a, b) => b.attempts.length - a.attempts.length,
    };
    return [...out].sort(dir[sort]);
  }, [looms, q, sort, kind]);

  const running = filtered.filter((l) => isLoomRunning(l.state));
  const needsYou = filtered.filter((l) => isLoomNeedsYou(l.state));
  const recent = filtered.filter((l) => isLoomRecent(l.state));

  const kindOptions: { value: KindFilter; label: string }[] = [
    { value: "all", label: "All kinds" },
    { value: "single", label: "Single" },
    { value: "woven", label: "Woven" },
    { value: "verify", label: "Verify" },
  ];

  const populated = looms !== null && looms.length > 0;

  return (
    <div className="flex h-dvh flex-col">
      <PageHeader
        title="Looms"
        description={
          populated
            ? `${running.length} weaving · ${needsYou.length} waiting on you · ${recent.length} recent`
            : "Autonomous work on your projects — attempt, verify, retry."
        }
        actions={<PlanLoomButton />}
      />

      {/* Search-first toolbar — only once there's something to filter. */}
      {populated && (
        <div className="shrink-0 border-b border-border">
          <div className="mx-auto flex w-full max-w-4xl items-center gap-2 px-4 py-2.5">
            <SearchField
              value={q}
              onChange={setQ}
              placeholder="Search looms by title or project…"
            />
            {kindOptions.map((o) => (
              <Chip
                key={o.value}
                active={kind === o.value}
                onClick={() => setKind(o.value)}
              >
                {o.label}
              </Chip>
            ))}
            <SortSelect
              value={sort}
              onChange={setSort}
              options={[
                { value: "recent", label: "Sort: recent" },
                { value: "cost", label: "Sort: cost" },
                { value: "attempts", label: "Sort: attempts" },
              ]}
            />
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl space-y-3 px-4 py-4">
          {/* Loading */}
          {looms === null && !error && (
            <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-3 py-3">
                  <Skeleton className="h-5 w-20 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-1/2" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                  <Skeleton className="h-4 w-16" />
                </div>
              ))}
            </div>
          )}

          {/* First-load failure */}
          {looms === null && error && (
            <EmptyState
              icon={TriangleAlertIcon}
              iconClassName="text-destructive/60"
              title="Couldn't load looms"
              description={
                <span className="font-mono text-xs break-words">{error}</span>
              }
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void loadLooms()}
                >
                  <RotateCwIcon />
                  Retry
                </Button>
              }
            />
          )}

          {/* Empty */}
          {looms !== null && looms.length === 0 && (
            <EmptyState
              icon={SparklesIcon}
              title="No looms yet"
              description="A loom begins from a planning session — describe what you want, then make it real."
              action={<PlanLoomButton />}
            />
          )}

          {/* Populated */}
          {populated && (
            <>
              {error && (
                <Alert variant="destructive" className="mb-3">
                  <TriangleAlertIcon />
                  <AlertTitle>Refresh failed</AlertTitle>
                  <AlertDescription className="font-mono text-xs break-words">
                    {error}
                  </AlertDescription>
                </Alert>
              )}
              {filtered.length === 0 ? (
                <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
                  <TriangleAlertIcon className="size-6 text-muted-foreground/50" />
                  <p className="text-sm text-muted-foreground">
                    No looms match your filters.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setQ("");
                      setKind("all");
                    }}
                  >
                    <RotateCwIcon />
                    Clear filters
                  </Button>
                </div>
              ) : (
                <>
                  <Group
                    icon={ActivityIcon}
                    label="Running now"
                    tint="text-sky-400"
                    looms={running}
                    defaultOpen
                  />
                  <Group
                    icon={TriangleAlertIcon}
                    label="Needs you"
                    tint="text-amber-400"
                    looms={needsYou}
                    defaultOpen
                  />
                  <Group
                    icon={HistoryIcon}
                    label="Recent"
                    looms={recent}
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

export default function LoomsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-dvh flex-col">
          <PageHeader title="Looms" description="Loading…" />
        </div>
      }
    >
      <LoomsInner />
    </Suspense>
  );
}
