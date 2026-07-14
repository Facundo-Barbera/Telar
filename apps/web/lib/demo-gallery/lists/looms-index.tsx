"use client";

// LANE: lists — Looms index at scale (concern 2 + 5).
// CURRENT: one flat divide-y list of LoomCards, max-w-4xl, sorted by nothing in
// particular — at 24 looms you scroll past nine finished runs to find the two
// that need you. REDESIGN: search-first sticky toolbar, state + kind filters,
// and three collapsible groups (Running now / Needs you / Recent) so the
// terminal noise folds away and what's live or waiting sits above the fold.
import { useMemo, useState } from "react";
import {
  ActivityIcon,
  ClockIcon,
  FolderGit2Icon,
  HistoryIcon,
  PlusIcon,
  RotateCwIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { WorkUnitState } from "@telar/core";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { StateBadge } from "@/components/common/state-badge";
import { fmtAgo, fmtCost } from "../now";
import {
  DEMO_LOOMS,
  isLoomActive,
  isLoomNeedsYou,
  isLoomTerminal,
  type DemoLoom,
} from "./fixtures";
import {
  Chip,
  GroupHeader,
  SearchField,
  SortSelect,
  ThreadProgress,
  WeaveChip,
  railClass,
} from "./shared";

type Sort = "recent" | "cost" | "attempts";
type KindFilter = "all" | "single" | "woven" | "verify";

function LoomRow({ loom }: { loom: DemoLoom }) {
  const showProgress = loom.role === "woven" && isLoomActive(loom.state);
  return (
    <div className="relative flex items-center gap-3 py-2 pr-3 pl-4 transition-colors hover:bg-muted/40">
      <span
        aria-hidden
        className={cn(
          "absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full",
          railClass(loom.state),
        )}
      />
      <StateBadge state={loom.state} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{loom.title}</span>
          <WeaveChip
            role={loom.role}
            threads={loom.threads}
            threadsDone={loom.threadsDone}
          />
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <FolderGit2Icon className="size-3 shrink-0" />
          <span className="truncate">{loom.project}</span>
          <span className="text-border">·</span>
          <span className="font-mono">{loom.kind}</span>
          {loom.attempts > 1 && (
            <>
              <span className="text-border">·</span>
              <span className="shrink-0">{loom.attempts} attempts</span>
            </>
          )}
          {loom.error && (
            <span
              className={cn(
                "hidden min-w-0 truncate lg:inline",
                loom.state === "failed" ? "text-destructive/80" : "text-amber-300/80",
              )}
            >
              — {loom.error}
            </span>
          )}
        </div>
      </div>
      {showProgress && (
        <div className="hidden items-center gap-2 sm:flex">
          <ThreadProgress threads={loom.threads ?? 0} threadsDone={loom.threadsDone} />
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
            {loom.threadsDone}/{loom.threads}
          </span>
        </div>
      )}
      <div className="flex w-16 shrink-0 flex-col items-end gap-0.5">
        <span className="font-mono text-xs tabular-nums">{fmtCost(loom.cost)}</span>
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <ClockIcon className="size-3" />
          {fmtAgo(loom.updatedAt)}
        </span>
      </div>
    </div>
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
  looms: DemoLoom[];
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

export function LoomsIndexDemo() {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("recent");
  const [kind, setKind] = useState<KindFilter>("all");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = DEMO_LOOMS.filter(
      (l) =>
        !needle ||
        l.title.toLowerCase().includes(needle) ||
        l.project.toLowerCase().includes(needle),
    );
    if (kind !== "all") out = out.filter((l) => l.role === kind);
    const dir: Record<Sort, (a: DemoLoom, b: DemoLoom) => number> = {
      recent: (a, b) => b.updatedAt - a.updatedAt,
      cost: (a, b) => b.cost - a.cost,
      attempts: (a, b) => b.attempts - a.attempts,
    };
    return [...out].sort(dir[sort]);
  }, [q, sort, kind]);

  const running = filtered.filter((l) => isLoomActive(l.state));
  const needsYou = filtered.filter((l) => isLoomNeedsYou(l.state));
  const recent = filtered.filter((l) => isLoomTerminal(l.state));

  const kindOptions: { value: KindFilter; label: string }[] = [
    { value: "all", label: "All kinds" },
    { value: "single", label: "Single" },
    { value: "woven", label: "Woven" },
    { value: "verify", label: "Verify" },
  ];

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header + sticky search-first toolbar */}
      <div className="shrink-0 border-b border-border">
        <div className="flex items-center gap-3 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <h1 className="font-heading text-base font-semibold tracking-tight">
              Looms
            </h1>
            <p className="text-xs text-muted-foreground">
              {running.length} weaving · {needsYou.length} waiting on you ·{" "}
              {recent.length} recent
            </p>
          </div>
          <Button size="sm">
            <SparklesIcon />
            New loom session
          </Button>
        </div>
        <div className="flex items-center gap-2 px-4 pb-2.5">
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

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl space-y-3 px-4 py-4">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
              <TriangleAlertIcon className="size-6 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                No looms match “{q}”.
              </p>
              <Button variant="outline" size="sm" onClick={() => setQ("")}>
                <RotateCwIcon />
                Clear search
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
        </div>
      </div>
    </div>
  );
}
