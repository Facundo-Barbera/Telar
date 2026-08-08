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
//   - No "Weave as one loom" batch bar: loom creation from the queue is a
//     different capability (5.5's handoff), not CAP-4/5/6. Selection here
//     exists ONLY to name which rows a lane-split moves — it does not become
//     an ApprovalCard or a loom-creation path.
//   - No per-row attachment icons: getQueueView() deliberately does not tally
//     attachments per row (that read belongs to the packet-detail page, where
//     it's already available via getPacketView).
//   - No "+ item" quick-capture: store.ts's createItem stamps
//     `provenance: "session"` unconditionally today, with its own comment
//     that direct-from-UI capture is a later story's widening (5.4/5.5).
//   - No Desk rendering here: the Desk is a different surface's concern; this
//     view only reads `desk` off the response for a future consumer.
// Lane structure (create/rename/retire/split) and stack reorder are reached
// through window.prompt / window.confirm / plain up-down buttons rather than
// drag-and-drop or a new dialog component — deliberately simple, since no dev
// server can be run in this environment to visually verify a richer one, and
// these are functionally correct either way. CAP-4 requires that a human can
// split a lane and reorder a stack; it does not require a particular input
// device for either — reorderLane/splitLaneIntoNew (store.ts/workspace-api.ts)
// already exist and were reachable only from route handlers with no caller
// until this pass wired them to these controls.
//
// TOKEN/CHROME SWEEP (this pass, no data behaviour touched): this view already
// composed the shared chrome (PageHeader / EmptyState / Alert / Skeleton /
// Chip / GroupHeader / SearchField), so the sweep was about the scale it drew
// them at — bare `rounded` on the native checkboxes → `rounded-sm` plus
// `accent-primary` (the one raw colour left on the surface: an unstyled
// checkbox paints its tick in the user agent's own blue), `divide-border` →
// `divide-border/70` for the hairlines INSIDE a lane card, `size=icon
// className=size-7` → the `icon-sm` variant that already means that, and
// `transition-colors` on the small controls that were the only hoverable
// things here without it. The lane filter chips gained the counts
// ui-contract.md §3 asks for, through `Chip`'s existing `count` slot.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ListTodoIcon,
  PencilIcon,
  PlusIcon,
  RotateCwIcon,
  SplitIcon,
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
            // `accent-primary` is the token fix, not decoration: a bare native
            // checkbox paints its checked box in the USER-AGENT accent (Safari
            // blue), which is the one raw colour this surface could not have
            // spelled out in a class list. Routing it through --primary is how
            // the mark joins the palette.
            className="size-3.5 shrink-0 rounded-sm border-border accent-primary"
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
            className="shrink-0 text-[10px] text-muted-foreground/70 underline decoration-dotted transition-colors hover:text-foreground"
          >
            promote
          </button>
        </div>
      ))}
    </div>
  );
}

function ItemRow({
  rank,
  item,
  selected,
  onToggleSelect,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
}: {
  rank: number;
  item: Item;
  selected: boolean;
  onToggleSelect: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const [open, setOpen] = useState(false);
  const subtasks = item.subtasks ?? [];
  const done = subtasks.filter((s) => s.done).length;
  const hasSubtasks = subtasks.length > 0;

  return (
    <div>
      <div className="flex items-center gap-2 py-2 pr-3 pl-2 transition-colors hover:bg-muted/40">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          title="Select to split into a new lane"
          className="size-3.5 shrink-0 rounded-sm border-border accent-primary"
        />
        <button
          type="button"
          onClick={() => hasSubtasks && setOpen((o) => !o)}
          aria-expanded={hasSubtasks ? open : undefined}
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-md transition-colors",
            hasSubtasks && "hover:bg-muted/60",
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
        {/* Stack order IS the queue's order (NFR-OW-11: no clock anywhere) — these
            two buttons are the only way a human moves a row without editing
            lanes.yaml by hand, so reorderLane's tested "moves the id and keeps
            everything else's order" guarantee has a caller. */}
        <div className="flex shrink-0 flex-col">
          <button
            type="button"
            disabled={!canMoveUp}
            onClick={onMoveUp}
            title="Move up"
            className="flex size-3.5 items-center justify-center rounded-sm text-muted-foreground/70 transition-colors hover:text-foreground disabled:opacity-20"
          >
            <ChevronUpIcon className="size-3" />
          </button>
          <button
            type="button"
            disabled={!canMoveDown}
            onClick={onMoveDown}
            title="Move down"
            className="flex size-3.5 items-center justify-center rounded-sm text-muted-foreground/70 transition-colors hover:text-foreground disabled:opacity-20"
          >
            <ChevronDownIcon className="size-3" />
          </button>
        </div>
        <Link
          href={`/workspace/${item.id}`}
          className="min-w-0 flex-1 truncate text-sm text-foreground hover:underline"
        >
          {item.title}
        </Link>
        {hasSubtasks && (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70 tabular-nums">
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
  onChanged,
}: {
  lane: QueueView["lanes"][number];
  onChanged: () => void;
}) {
  const [openState, setOpenState] = useState(true);
  // Selection is scoped to this lane and exists for exactly one purpose: naming
  // which rows a split carries into the new lane. It is not a batch-action bar
  // (see the module header) and it is cleared on every reload, so it never
  // outlives the render it was made in.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const orderedIds = useMemo(() => lane.rows.map((r) => r.item.id), [lane.rows]);

  const rename = useCallback(async () => {
    const label = prompt("Rename lane", lane.label);
    if (!label || !label.trim() || label === lane.label) return;
    try {
      await postJson(`/api/workspace/lanes/${lane.key}`, "PATCH", { label });
      onChanged();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }, [lane.key, lane.label, onChanged]);

  const retire = useCallback(async () => {
    if (!confirm(`Retire "${lane.label}"? This only works while it's empty.`)) return;
    try {
      await postJson(`/api/workspace/lanes/${lane.key}`, "DELETE");
      onChanged();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }, [lane.key, lane.label, onChanged]);

  // Sends this lane's FULL id order (not just the two that swapped) to
  // reorderLane, which sets the stack to exactly the array it is given —
  // matching store.ts's own contract ("this lane's stack becomes exactly
  // these ids, in this order"), never a partial patch.
  const reorderTo = useCallback(
    async (nextIds: string[]) => {
      try {
        await postJson(`/api/workspace/lanes/${lane.key}/reorder`, "POST", { itemIds: nextIds });
        onChanged();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      }
    },
    [lane.key, onChanged],
  );

  const moveBy = useCallback(
    (id: string, delta: 1 | -1) => {
      const idx = orderedIds.indexOf(id);
      const swapIdx = idx + delta;
      if (idx < 0 || swapIdx < 0 || swapIdx >= orderedIds.length) return; // no-op at either end
      const next = orderedIds.slice();
      const a = next[idx]!;
      const b = next[swapIdx]!;
      next[idx] = b;
      next[swapIdx] = a;
      void reorderTo(next);
    },
    [orderedIds, reorderTo],
  );

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // CAP-4: "the master may PROPOSE a split, human-approval-gated, never
  // auto-applied" — there is no agent path into this function at all (it is
  // reached only from this button, behind two human-typed prompts), so the
  // approval gate is structural here, not a card to render.
  const split = useCallback(async () => {
    if (selected.size === 0) return;
    const label = prompt(
      `Split ${selected.size} item${selected.size === 1 ? "" : "s"} out of "${lane.label}" into a new lane — its label?`,
    );
    if (!label || !label.trim()) return;
    const window_ = prompt('When does this new lane\'s work tend to happen? (e.g. "evenings")');
    if (!window_ || !window_.trim()) return;
    try {
      await postJson("/api/workspace/lanes/split", "POST", {
        sourceKey: lane.key,
        label,
        window: window_,
        itemIds: [...selected],
      });
      setSelected(new Set());
      onChanged();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }, [lane.key, lane.label, onChanged, selected]);

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
            {selected.size > 0 && (
              <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={() => void split()}>
                <SplitIcon className="size-3.5" />
                Split {selected.size} into new lane
              </Button>
            )}
            {/* `icon-sm` IS size-7 with the matched corner radius — the variant
                the design system already owns, rather than a `size-8` icon
                button overridden back down to 7 with a bare `size-7`. */}
            <Button variant="ghost" size="icon-sm" onClick={() => void rename()} title="Rename lane">
              <PencilIcon className="size-3.5" />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={() => void retire()} title="Retire lane">
              <Trash2Icon className="size-3.5" />
            </Button>
          </div>
        }
      />
      {openState && (
        // border-border/70 is the idiom's INTERNAL divider step — the card's
        // own edge stays full-strength border-border, the hairlines between its
        // rows sit one step back so the card reads as one object.
        <div className="divide-y divide-border/70">
          {lane.rows.length === 0 ? (
            <div className="py-4 text-center text-xs text-muted-foreground/60">Nothing filed here.</div>
          ) : (
            lane.rows.map((r, idx) => (
              <ItemRow
                key={r.item.id}
                rank={r.rank}
                item={r.item}
                selected={selected.has(r.item.id)}
                onToggleSelect={() => toggleSelect(r.item.id)}
                canMoveUp={idx > 0}
                canMoveDown={idx < lane.rows.length - 1}
                onMoveUp={() => moveBy(r.item.id, -1)}
                onMoveDown={() => moveBy(r.item.id, 1)}
              />
            ))
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

  // SEARCH FIRST, LANE SECOND, and the split matters: the lane chips ARE the
  // lane filter, so a count on one has to answer "how many will I see if I
  // click this" — which tracks the search needle but must NOT track the lane
  // selection. Deriving both the chips and the rendered lanes from one
  // search-filtered list is what keeps a chip from claiming 12 over a list of
  // 3 while the user is typing.
  const searchedLanes = useMemo(() => {
    if (!view) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return view.lanes;
    return view.lanes.map((l) => ({
      ...l,
      rows: l.rows.filter((r) => r.item.title.toLowerCase().includes(needle)),
    }));
  }, [view, q]);

  const filteredLanes = useMemo(
    () => searchedLanes.filter((l) => laneFilter === "all" || l.key === laneFilter),
    [searchedLanes, laneFilter],
  );

  // The "All lanes" tally, summed off the same list for the same reason.
  const matchedTotal = useMemo(
    () => searchedLanes.reduce((n, l) => n + l.rows.length, 0),
    [searchedLanes],
  );

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
          {/* flex-wrap, because lane labels are the USER's words and a lane
              count is a lane the user made — neither has a width this row can
              assume. Wrapping grows the toolbar; the alternative clips a filter
              the user cannot then reach. */}
          <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-2 px-4 py-2.5">
            <SearchField value={q} onChange={setQ} placeholder="Search items by title…" />
            {/* Counts through Chip's own `count` slot (mono, tabular, and
                already toned for the active state) rather than baked into the
                label — ui-contract.md §3 asks for "lane filter chips with
                counts" and the shared control has carried the affordance since
                the Looms index. Both tallies come off `searchedLanes`, so they
                shrink with the needle and always describe the list below. */}
            <Chip
              active={laneFilter === "all"}
              onClick={() => setLaneFilter("all")}
              count={matchedTotal}
            >
              All lanes
            </Chip>
            {searchedLanes.map((l) => (
              <Chip
                key={l.key}
                active={laneFilter === l.key}
                onClick={() => setLaneFilter(l.key)}
                count={l.rows.length}
              >
                {l.label}
              </Chip>
            ))}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl space-y-3 px-4 py-4">
          {/* The skeleton wears the LaneSection's own shell (rounded-xl,
              border-border, bg-card, /70 hairlines) so first paint does not
              change container geometry when the data lands — only the row
              contents resolve. */}
          {view === null && !error && (
            <div className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border bg-card">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-2 px-3 py-3">
                  <Skeleton className="size-3.5 shrink-0 rounded-sm" />
                  <Skeleton className="h-4 min-w-0 flex-1" />
                  <Skeleton className="h-4 w-16 shrink-0 rounded-full" />
                  <Skeleton className="h-4 w-20 shrink-0 rounded-md" />
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
                <LaneSection key={l.key} lane={l} onChanged={() => void load()} />
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
