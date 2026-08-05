"use client";

// The Queue surface (CAP-4: dynamic lanes; CAP-5: sub-tasks and the one
// human-only promotion path). Consumes GET /api/workspace/queue, which
// already joins every lane with its own ranked rows (lib/workspace-api's
// getQueueView) — this component is a straight render of that shape plus the
// mutations a human can make from here.
//
// SCOPE, DELIBERATELY NARROWER THAN THE DEMO SOURCE
// (lib/demo-gallery/workspace/queue.tsx, never imported — hand-ported by eye
// per that directory's rule 7). Cut, and why:
//   - No "What's next" recommendation card: hardcoded demo content, no spec'd
//     capability behind it in this story.
//   - No batch-selection checkboxes or "Weave as one loom" bar: loom creation
//     from the queue is a different capability, not CAP-4/5/6.
//   - No per-row attachment icons: getQueueView() deliberately does not tally
//     attachments per row (that read belongs to the packet-detail page, where
//     it's already available via getPacketView).
//   - No "+ item" quick-capture: store.ts's createItem stamps
//     `provenance: "session"` unconditionally today, with its own comment
//     that direct-from-UI capture is a later story's widening (5.4/5.5).
//   - No Desk rendering here: the Desk is a different surface's concern; this
//     view only reads `desk` off the response for a future consumer.
// Lane structure (create/rename/retire) is reached through window.prompt /
// window.confirm rather than a new dialog component — deliberately simple,
// since no dev server can be run in this environment to visually verify a
// richer one, and native prompts are functionally correct either way.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ChevronRightIcon,
  ListTodoIcon,
  PencilIcon,
  PlusIcon,
  RotateCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import type { Item } from "@telar/core";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Chip, GroupHeader, SearchField } from "@/components/common/list-controls";
import { dispatchTelarRefresh } from "@/lib/telar-refresh";
import { cn } from "@/lib/utils";
import {
  DeadlineChip,
  ProjectChip,
  ProvenanceTag,
  VerdictChip,
  WorkspaceTabs,
} from "@/components/workspace/chips";
import type { QueueView } from "@/lib/workspace-api";

async function postJson(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function SubtaskRows({ item }: { item: Item }) {
  const subtasks = item.subtasks ?? [];
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = useCallback(
    async (subtaskId: string, done: boolean) => {
      setBusy(subtaskId);
      try {
        await postJson(`/api/workspace/items/${item.id}/subtasks/${subtaskId}`, "PATCH", { done });
        dispatchTelarRefresh({ domains: ["workspace"] });
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [item.id],
  );

  // NFR-OW-15: this is the only place in the whole app a promotion can be
  // triggered from — a human's own click, never an MCP tool.
  const promote = useCallback(
    async (subtaskId: string) => {
      if (!confirm("Promote this sub-task to its own item on the desk?")) return;
      setBusy(subtaskId);
      try {
        await postJson(`/api/workspace/items/${item.id}/subtasks/${subtaskId}/promote`, "POST");
        dispatchTelarRefresh({ domains: ["workspace"] });
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [item.id],
  );

  if (subtasks.length === 0) {
    return (
      <div className="py-2 pr-3 pl-12 text-xs text-muted-foreground/70">
        No sub-tasks yet.
      </div>
    );
  }

  return (
    <div className="space-y-1 py-1.5 pr-3 pl-12">
      {subtasks.map((s) => (
        <div key={s.id} className="flex items-center gap-2 py-0.5 text-xs">
          <input
            type="checkbox"
            checked={!!s.done}
            disabled={busy === s.id}
            onChange={(e) => void toggle(s.id, e.target.checked)}
            className="size-3.5 shrink-0 rounded border-border"
          />
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              s.done ? "text-muted-foreground/60 line-through" : "text-foreground",
            )}
          >
            {s.title}
          </span>
          <button
            type="button"
            disabled={busy === s.id}
            onClick={() => void promote(s.id)}
            className="shrink-0 text-[10px] text-muted-foreground/70 underline decoration-dotted hover:text-foreground"
          >
            promote
          </button>
        </div>
      ))}
    </div>
  );
}

function ItemRow({ rank, item }: { rank: number; item: Item }) {
  const [open, setOpen] = useState(false);
  const subtasks = item.subtasks ?? [];
  const done = subtasks.filter((s) => s.done).length;
  const hasSubtasks = subtasks.length > 0;

  return (
    <div>
      <div className="flex items-center gap-2 py-2 pr-3 pl-2 transition-colors hover:bg-muted/40">
        <button
          type="button"
          onClick={() => hasSubtasks && setOpen((o) => !o)}
          className={cn(
            "flex size-5 shrink-0 items-center justify-center",
            !hasSubtasks && "invisible",
          )}
        >
          <ChevronRightIcon
            className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")}
          />
        </button>
        <span className="w-5 shrink-0 font-mono text-[11px] text-muted-foreground/60 tabular-nums">
          {rank}
        </span>
        <Link
          href={`/workspace/${item.id}`}
          className="min-w-0 flex-1 truncate text-sm text-foreground hover:underline"
        >
          {item.title}
        </Link>
        {hasSubtasks && (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
            {done}/{subtasks.length}
          </span>
        )}
        <ProvenanceTag label={item.provenance} />
        {item.deadline ? <DeadlineChip deadline={item.deadline} /> : <span className="w-8 shrink-0" />}
        {item.verdict ? <VerdictChip verdict={item.verdict} /> : <span className="w-14 shrink-0" />}
        <span className="w-24 shrink-0 text-right">
          <ProjectChip name={item.project} mirrored={item.mirrored} />
        </span>
      </div>
      {open && <SubtaskRows item={item} />}
    </div>
  );
}

function LaneSection({
  lane,
  onRenamed,
  onRetired,
}: {
  lane: QueueView["lanes"][number];
  onRenamed: () => void;
  onRetired: () => void;
}) {
  const [openState, setOpenState] = useState(true);

  const rename = useCallback(async () => {
    const label = prompt("Rename lane", lane.label);
    if (!label || !label.trim() || label === lane.label) return;
    try {
      await postJson(`/api/workspace/lanes/${lane.key}`, "PATCH", { label });
      onRenamed();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }, [lane.key, lane.label, onRenamed]);

  const retire = useCallback(async () => {
    if (!confirm(`Retire "${lane.label}"? This only works while it's empty.`)) return;
    try {
      await postJson(`/api/workspace/lanes/${lane.key}`, "DELETE");
      onRetired();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }, [lane.key, lane.label, onRetired]);

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <GroupHeader
        icon={ListTodoIcon}
        label={`${lane.label} · ${lane.window}${lane.note ? ` · ${lane.note}` : ""}`}
        count={lane.rows.length}
        open={openState}
        onToggle={() => setOpenState((o) => !o)}
        action={
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="size-7" onClick={() => void rename()} title="Rename lane">
              <PencilIcon className="size-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="size-7" onClick={() => void retire()} title="Retire lane">
              <Trash2Icon className="size-3.5" />
            </Button>
          </div>
        }
      />
      {openState && (
        <div className="divide-y divide-border">
          {lane.rows.length === 0 ? (
            <div className="py-4 text-center text-xs text-muted-foreground/60">Nothing filed here.</div>
          ) : (
            lane.rows.map((r) => <ItemRow key={r.item.id} rank={r.rank} item={r.item} />)
          )}
        </div>
      )}
    </section>
  );
}

export function QueueView() {
  const [view, setView] = useState<QueueView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [laneFilter, setLaneFilter] = useState<string>("all");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/workspace/queue");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setView(await res.json());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setView((prev) => prev ?? null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onRefresh = (e: Event) => {
      const detail = (e as CustomEvent<{ domains?: readonly string[] } | undefined>).detail;
      if (!detail?.domains || detail.domains.includes("workspace")) void load();
    };
    window.addEventListener("telar:refresh", onRefresh);
    return () => window.removeEventListener("telar:refresh", onRefresh);
  }, [load]);

  const addLane = useCallback(async () => {
    const label = prompt("New lane's label (e.g. \"Weekend\")");
    if (!label || !label.trim()) return;
    const window_ = prompt("When does this lane's work tend to happen? (e.g. \"evenings\")");
    if (!window_ || !window_.trim()) return;
    try {
      await postJson("/api/workspace/lanes", "POST", { label, window: window_ });
      dispatchTelarRefresh({ domains: ["workspace"] });
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const filteredLanes = useMemo(() => {
    if (!view) return [];
    const needle = q.trim().toLowerCase();
    return view.lanes
      .filter((l) => laneFilter === "all" || l.key === laneFilter)
      .map((l) => ({
        ...l,
        rows: needle ? l.rows.filter((r) => r.item.title.toLowerCase().includes(needle)) : l.rows,
      }));
  }, [view, q, laneFilter]);

  const populated = view !== null && view.lanes.length > 0;

  return (
    <div className="flex h-dvh flex-col">
      <PageHeader
        title="Workspace"
        description={
          view
            ? `${view.totalItems} items across ${view.lanes.length} lane${view.lanes.length === 1 ? "" : "s"}`
            : "Everything filed, waiting or ripening."
        }
        leading={<WorkspaceTabs active="queue" />}
        actions={
          <Button variant="outline" size="sm" onClick={() => void addLane()}>
            <PlusIcon />
            Lane
          </Button>
        }
      />

      {populated && (
        <div className="shrink-0 border-b border-border">
          <div className="mx-auto flex w-full max-w-4xl items-center gap-2 px-4 py-2.5">
            <SearchField value={q} onChange={setQ} placeholder="Search items by title…" />
            <Chip active={laneFilter === "all"} onClick={() => setLaneFilter("all")}>
              All lanes
            </Chip>
            {view!.lanes.map((l) => (
              <Chip key={l.key} active={laneFilter === l.key} onClick={() => setLaneFilter(l.key)}>
                {l.label}
              </Chip>
            ))}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl space-y-3 px-4 py-4">
          {view === null && !error && (
            <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-3 py-3">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-4 w-16" />
                </div>
              ))}
            </div>
          )}

          {view === null && error && (
            <EmptyState
              icon={TriangleAlertIcon}
              iconClassName="text-destructive/60"
              title="Couldn't load the workspace"
              description={<span className="font-mono text-xs break-words">{error}</span>}
              action={
                <Button variant="outline" size="sm" onClick={() => void load()}>
                  <RotateCwIcon />
                  Retry
                </Button>
              }
            />
          )}

          {view !== null && view.lanes.length === 0 && (
            <EmptyState
              icon={ListTodoIcon}
              title="No lanes yet"
              description="A lane is a dynamic bucket of work — the Weekend, Office, whatever life demands. Add the first one."
              action={
                <Button variant="outline" size="sm" onClick={() => void addLane()}>
                  <PlusIcon />
                  Lane
                </Button>
              }
            />
          )}

          {populated && (
            <>
              {error && (
                <Alert variant="destructive" className="mb-3">
                  <TriangleAlertIcon />
                  <AlertTitle>Refresh failed</AlertTitle>
                  <AlertDescription className="font-mono text-xs break-words">{error}</AlertDescription>
                </Alert>
              )}
              {filteredLanes.map((l) => (
                <LaneSection key={l.key} lane={l} onRenamed={() => void load()} onRetired={() => void load()} />
              ))}
              <p className="px-1 py-2 text-center text-[11px] text-muted-foreground/60">
                {view!.totalItems} items — every one traces to something you fed in or a mirror · agents added{" "}
                {view!.agentsAdded} · sub-tasks live inside items, the count never grows from breakdown
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
