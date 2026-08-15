"use client";

/**
 * The Queue — dynamic lanes, ordered stacks, sub-tasks inside items, and the one
 * human-only promotion path. Ported from
 * `apps/web_old/components/workspace/queue-view.tsx`.
 *
 * A STRAIGHT RENDER OF ONE READ. `GET /api/spool` already joins every lane with
 * its ranked rows, so this component holds no join of its own — which is what
 * keeps the rows and the lane list from ever disagreeing.
 *
 * SCOPE, deliberately narrower than the donor at this stage:
 *   - NO BATCH BAR. "Weave as one loom" is the handoff, and it lands with the
 *     handoff (stage D of `docs/spool-port.md`). Selection and the lane split
 *     are here because CAP-4 needs them; a weave button with no endpoint behind
 *     it would be a promise this stage does not keep.
 *   - NO "WHAT'S NEXT" CARD. Hardcoded demo content in the prototype, with no
 *     capability behind it until the briefing (stage H).
 *   - NO PER-ROW ATTACHMENT TALLY. The snapshot deliberately does not tally
 *     attachments per row — that read belongs to the packet detail, where it is
 *     already available.
 *   - NO QUICK CAPTURE. `createItem` stamps `provenance: "session"`
 *     unconditionally today; a direct-from-UI capture needs that widened first.
 *
 * LANE STRUCTURE AND REORDER GO THROUGH `prompt`/`confirm` AND UP-DOWN BUTTONS
 * rather than dialogs and drag-and-drop — the donor's own choice, and its
 * reasoning holds: CAP-4 requires that a human CAN split a lane and reorder a
 * stack, not that they do it with a particular input device. These are
 * functionally correct, and a richer affordance is a later pass over a surface
 * that already works.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  FolderIcon,
  ListTodoIcon,
  PencilIcon,
  PlusIcon,
  RotateCwIcon,
  SplitIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import type { SpoolItem, SpoolLane, SpoolQueueRow, SpoolSnapshot, SpoolSubjectGroup } from "@telar/engine-client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/empty-state";
import { Chip, GroupHeader, SearchField } from "@/components/common/list-controls";
import { DeadlineChip, ProjectChip, ProvenanceTag } from "@/components/spool/chips";
import { SpoolHeader } from "@/components/spool/header";
import { cn } from "@/lib/utils";

async function send(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? data?.error ?? `HTTP ${res.status}`);
  return data;
}

/** A lane, with the rows the snapshot ranked into it. Grouped here because the
 *  engine sends one flat ranked list — the grouping is a render concern. */
type LaneGroup = SpoolLane & { rows: SpoolQueueRow[] };

function SubtaskRows({ item, onChanged }: { item: SpoolItem; onChanged: () => void }) {
  const subtasks = item.subtasks ?? [];
  const [busy, setBusy] = useState<string | null>(null);

  const run = useCallback(
    async (subtaskId: string, work: () => Promise<unknown>) => {
      setBusy(subtaskId);
      try {
        await work();
        onChanged();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [onChanged],
  );

  if (subtasks.length === 0) {
    return <div className="py-2 pr-3 pl-12 text-xs text-muted-foreground/70">No sub-tasks yet.</div>;
  }

  return (
    <div className="space-y-1 py-1.5 pr-3 pl-12">
      {subtasks.map((s) => (
        <div key={s.id} className="flex items-center gap-2 py-0.5 text-xs">
          <input
            type="checkbox"
            checked={!!s.done}
            disabled={busy === s.id}
            onChange={(e) =>
              void run(s.id, () =>
                send(`/api/spool/items/${item.id}/subtasks/${s.id}`, "PATCH", { done: e.target.checked }),
              )
            }
            // `accent-primary` is a token fix, not decoration: a bare native
            // checkbox paints its checked box in the USER-AGENT accent, which is
            // the one raw colour this surface could not otherwise have spelled.
            className="size-3.5 shrink-0 rounded-sm border-border accent-primary"
          />
          <span className={cn("min-w-0 flex-1 truncate", s.done ? "text-muted-foreground/60 line-through" : "text-foreground")}>
            {s.title}
          </span>
          {/* THE ONLY PROMOTION TRIGGER IN THE WHOLE APP — a human's own click.
              No tool surface reaches the verb behind it, proposed or otherwise. */}
          <button
            type="button"
            disabled={busy === s.id}
            onClick={() => {
              if (!confirm("Promote this sub-task to an item of its own?")) return;
              void run(s.id, () => send(`/api/spool/items/${item.id}/subtasks/${s.id}/promote`, "POST"));
            }}
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
  onChanged,
}: {
  rank: number;
  item: SpoolItem;
  selected: boolean;
  onToggleSelect: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onChanged: () => void;
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
          title="Select rows to split into a new lane"
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
          <ChevronRightIcon className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
        </button>
        <span className="w-5 shrink-0 font-mono text-[11px] text-muted-foreground/60 tabular-nums">{rank}</span>
        {/* STACK ORDER IS THE QUEUE'S ORDER — no clock anywhere. These two
            buttons are the only way a human moves a row without editing
            lanes.json by hand. */}
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
        <Link href={`/spool/${item.id}`} className="min-w-0 flex-1 truncate text-sm text-foreground hover:underline">
          {item.title}
        </Link>
        {hasSubtasks && (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70 tabular-nums">
            {done}/{subtasks.length}
          </span>
        )}
        <ProvenanceTag label={item.provenance} />
        {item.deadline ? <DeadlineChip deadline={item.deadline} /> : <span className="w-8 shrink-0" />}
        <span className="w-24 shrink-0 text-right">
          <ProjectChip name={item.project} mirrored={item.mirrored} />
        </span>
      </div>
      {open && <SubtaskRows item={item} onChanged={onChanged} />}
    </div>
  );
}

function LaneSection({
  lane,
  onChanged,
  selection,
  onToggleSelect,
  onClearSelection,
}: {
  lane: LaneGroup;
  onChanged: () => void;
  // ONE SELECTION FOR THE WHOLE QUEUE. What stays lane-local is the SPLIT, and
  // it stays local by filtering the shared selection to its own rows rather than
  // by owning a second one — two selections would put two checkbox meanings on
  // one row.
  selection: ReadonlySet<string>;
  onToggleSelect: (id: string) => void;
  onClearSelection: (ids: string[]) => void;
}) {
  const [openState, setOpenState] = useState(true);
  const orderedIds = useMemo(() => lane.rows.map((r) => r.item.id), [lane.rows]);
  const selected = useMemo(() => orderedIds.filter((id) => selection.has(id)), [orderedIds, selection]);

  const guard = useCallback(
    async (work: () => Promise<unknown>) => {
      try {
        await work();
        onChanged();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      }
    },
    [onChanged],
  );

  const rename = useCallback(() => {
    const label = prompt("Rename lane", lane.label);
    if (!label?.trim() || label === lane.label) return;
    void guard(() => send(`/api/spool/lanes/${lane.key}`, "PATCH", { label }));
  }, [guard, lane.key, lane.label]);

  /**
   * RETIRING IS AN ANSWER, NOT AN ERROR. The engine returns `{ok: false, reason}`
   * with a sentence naming what has to move first, and that sentence is shown
   * verbatim — retiring never evicts an item on the human's behalf, and the
   * reason is how they find out what is still in there.
   */
  const retire = useCallback(() => {
    if (!confirm(`Retire "${lane.label}"? This only works while it is empty.`)) return;
    void guard(async () => {
      const result = await send(`/api/spool/lanes/${lane.key}`, "DELETE");
      if (result?.ok === false) alert(result.reason);
    });
  }, [guard, lane.key, lane.label]);

  /** Sends this lane's FULL id order, not just the two that swapped — the store's
   *  contract is "this lane's stack becomes exactly these ids", never a patch. */
  const moveBy = useCallback(
    (id: string, delta: 1 | -1) => {
      const idx = orderedIds.indexOf(id);
      const swap = idx + delta;
      if (idx < 0 || swap < 0 || swap >= orderedIds.length) return;
      const next = orderedIds.slice();
      [next[idx], next[swap]] = [next[swap]!, next[idx]!];
      void guard(() => send(`/api/spool/lanes/${lane.key}/reorder`, "POST", { items: next }));
    },
    [guard, lane.key, orderedIds],
  );

  /** CAP-4: the master may PROPOSE a split, human-approval-gated, never
   *  auto-applied. There is no agent path into this at all — it is reached only
   *  from this button, behind two human-typed prompts — so the gate is
   *  structural here rather than a card to render. */
  const split = useCallback(() => {
    if (selected.length === 0) return;
    const label = prompt(
      `Split ${selected.length} item${selected.length === 1 ? "" : "s"} out of "${lane.label}" into a new lane — its label?`,
    );
    if (!label?.trim()) return;
    const when = prompt('When does this new lane\'s work tend to happen? (e.g. "evenings")');
    if (!when?.trim()) return;
    void guard(async () => {
      await send("/api/spool/lanes/split", "POST", {
        sourceKey: lane.key,
        label,
        window: when,
        note: `split from ${lane.label} — you accepted it`,
        items: selected,
      });
      // Only THIS lane's rows leave the selection: a batch the human was
      // assembling across other stacks survives its own split.
      onClearSelection(selected);
    });
  }, [guard, lane.key, lane.label, onClearSelection, selected]);

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <GroupHeader
        icon={ListTodoIcon}
        label={lane.label}
        count={lane.rows.length}
        open={openState}
        onToggle={() => setOpenState((o) => !o)}
        /**
         * `ui-contract.md` §3: "lane label, count, structural provenance note
         * when the lane was split, and its coarse window right-aligned." THREE
         * SEPARATE THINGS, and running them together as one uppercase label —
         * which is what this did first — shouted the seed lane's whole
         * explanatory note and then truncated it mid-word.
         *
         * THE NOTE IS PERMANENT PROVENANCE, so it is rendered rather than
         * dropped: a lane created by an accepted proposal says so forever. It
         * takes the truncation before the window does, because the window is
         * four words and the note can be a sentence.
         */
        meta={
          <>
            {lane.note && (
              <span className="min-w-0 truncate text-[11px] text-muted-foreground/70" title={lane.note}>
                {lane.note}
              </span>
            )}
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">{lane.window}</span>
          </>
        }
        action={
          <div className="flex shrink-0 items-center gap-1">
            {selected.length > 0 && (
              <Button variant="outline" size="sm" className="gap-1" onClick={split}>
                <SplitIcon className="size-3.5" />
                Split {selected.length} into new lane
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" onClick={rename} title="Rename lane">
              <PencilIcon className="size-3.5" />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={retire} title="Retire lane">
              <Trash2Icon className="size-3.5" />
            </Button>
          </div>
        }
      />
      {openState && (
        // border-border/70 is the INTERNAL divider step — the card's own edge
        // stays full-strength, the hairlines between its rows sit one step back
        // so the card reads as one object.
        <div className="divide-y divide-border/70">
          {lane.rows.length === 0 ? (
            <div className="py-4 text-center text-xs text-muted-foreground/60">Nothing filed here.</div>
          ) : (
            lane.rows.map((r, idx) => (
              <ItemRow
                key={r.item.id}
                rank={r.rank}
                item={r.item}
                selected={selection.has(r.item.id)}
                onToggleSelect={() => onToggleSelect(r.item.id)}
                canMoveUp={idx > 0}
                canMoveDown={idx < lane.rows.length - 1}
                onMoveUp={() => moveBy(r.item.id, -1)}
                onMoveDown={() => moveBy(r.item.id, 1)}
                onChanged={onChanged}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}

/** Which axis the queue groups by. Subject leads; the lane is a lens. */
type QueueAxis = "subject" | "lane";

/**
 * The React key for the floating group, which has no `project` to key on.
 *
 * A NAMED CONSTANT RATHER THAN A LITERAL AT THE CALL SITE, and that is not
 * style: the first spelling of this was an invisible character that survived
 * typecheck, lint and the whole suite, because a control character inside a
 * string literal is legal in every one of them. A name is greppable and a
 * reviewer can see it.
 *
 * IT CANNOT COLLIDE WITH A REAL SUBJECT because a subject is `SpoolItem.project`
 * verbatim, and the projection emits the floating group only when `project` is
 * absent — so a user who literally names a project this still gets two distinct
 * groups with two distinct keys.
 */
const FLOATING_KEY = "spool:floating";

const AXIS_TAB = "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors";
const AXIS_ON = "bg-muted font-medium text-foreground";
const AXIS_OFF = "text-muted-foreground hover:bg-muted/60 hover:text-foreground";

/**
 * ONE SUBJECT'S WORK — the queue's primary grouping.
 *
 * WHY THIS EXISTS BESIDE `LaneSection` RATHER THAN REPLACING IT. A lane answers
 * "when and where would I do this"; a subject answers "what is this about", and
 * the second is what the user actually holds in their head. `ozom-gv`'s four
 * months are cut by milestone, category and dependency, so all of its work would
 * land in one lane and the lane axis would say nothing — see
 * `docs/spool-definition.md` §6.
 *
 * BUT LANES ARE NOT DELETED, and this component is why they need not be: the
 * split, the rename, the retire and the hand-ordering are real tools the human
 * made their own structure with, and they all live on the lane. The subject is
 * the default LENS over the same stacks, not a replacement store.
 *
 * NO REORDER ARROWS HERE, deliberately. Order within a subject is INHERITED from
 * the lane stacks — the projection walks them — so an arrow on this surface
 * would have to guess which lane's stack it meant. Ordering stays where the
 * stack is, which is the lane view.
 */
function SubjectSection({
  group,
  selection,
  onToggleSelect,
  onChanged,
}: {
  group: SpoolSubjectGroup;
  selection: ReadonlySet<string>;
  onToggleSelect: (id: string) => void;
  onChanged: () => void;
}) {
  const [openState, setOpenState] = useState(true);

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <GroupHeader
        icon={FolderIcon}
        // ABSENT IS `floating`, named rather than blank: an item belonging to no
        // subject is in a valid resting state, and an unlabelled group would
        // read as a rendering fault.
        label={group.project ?? "floating"}
        count={group.rows.length}
        open={openState}
        onToggle={() => setOpenState((o) => !o)}
        meta={
          group.project ? undefined : (
            <span className="text-[11px] text-muted-foreground/60">not filed to a subject yet</span>
          )
        }
      />
      {openState && (
        <div className="divide-y divide-border/70">
          {group.rows.map((r, idx) => (
            <ItemRow
              key={r.item.id}
              // THE RANK SHOWN IS THIS GROUP'S OWN 1-BASED POSITION, not the
              // lane rank the row carries: two items from different lanes would
              // otherwise both render "1" inside one subject.
              rank={idx + 1}
              item={r.item}
              selected={selection.has(r.item.id)}
              onToggleSelect={() => onToggleSelect(r.item.id)}
              canMoveUp={false}
              canMoveDown={false}
              onMoveUp={() => undefined}
              onMoveDown={() => undefined}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function QueueView() {
  const [view, setView] = useState<SpoolSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  /** SUBJECT BY DEFAULT — see `SubjectSection`. Not persisted: the default is
   *  the module's opinion about how work divides, and a remembered toggle would
   *  quietly let one session's experiment become the arrival state forever. */
  const [axis, setAxis] = useState<QueueAxis>("subject");
  const [laneFilter, setLaneFilter] = useState<string>("all");
  // Kept as IDS rather than items, so a reload can drop the ones that no longer
  // exist without the set ever holding a stale packet.
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());

  const toggleSelect = useCallback((id: string) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback((ids?: string[]) => {
    if (!ids) return setSelection(new Set());
    setSelection((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/spool");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setView(await res.json());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setView((prev) => prev ?? null);
    }
  }, []);

  useEffect(() => {
    // Deferred to a task rather than called in the effect body: a synchronous
    // fetch-and-setState on mount is a cascading render, and the rule that
    // catches it is the same one `workspace-environment.tsx` already answers
    // this way. No interval follows it — this surface is PULL-BASED and does not
    // poll; it reloads when a mutation on it succeeds, and not otherwise.
    const first = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(first);
  }, [load]);

  const addLane = useCallback(async () => {
    const label = prompt('New lane\'s label (e.g. "Weekend")');
    if (!label?.trim()) return;
    const when = prompt('When does this lane\'s work tend to happen? (e.g. "evenings")');
    if (!when?.trim()) return;
    try {
      await send("/api/spool/lanes", "POST", { label, window: when });
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }, [load]);

  /** The engine sends one flat ranked list; the queue renders it grouped. Every
   *  lane appears even when empty, because an empty lane is still structure the
   *  human made and can file into. */
  const lanes = useMemo<LaneGroup[]>(() => {
    if (!view) return [];
    return view.lanes.map((l) => ({ ...l, rows: view.rows.filter((r) => r.lane === l.key) }));
  }, [view]);

  /**
   * SEARCH FIRST, LANE SECOND, and the split matters: the lane chips ARE the
   * lane filter, so a count on one has to answer "how many will I see if I click
   * this" — which tracks the search needle but must NOT track the lane
   * selection. Deriving both the chips and the rendered lanes from one
   * search-filtered list is what keeps a chip claiming 12 over a list of 3.
   */
  const searchedLanes = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return lanes;
    return lanes.map((l) => ({ ...l, rows: l.rows.filter((r) => r.item.title.toLowerCase().includes(needle)) }));
  }, [lanes, q]);

  /**
   * The same needle over the subject axis. A group that matches nothing is
   * DROPPED rather than shown empty — unlike a lane, which is structure the user
   * made and stays visible so they can file into it. A subject is derived from
   * the items, so a subject with no matching rows is not a place, it is an
   * absence.
   */
  const searchedSubjects = useMemo<SpoolSubjectGroup[]>(() => {
    const groups = view?.subjects ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return groups;
    return groups
      .map((g) => ({ ...g, rows: g.rows.filter((r) => r.item.title.toLowerCase().includes(needle)) }))
      .filter((g) => g.rows.length > 0);
  }, [view, q]);

  const filteredLanes = useMemo(
    () => searchedLanes.filter((l) => laneFilter === "all" || l.key === laneFilter),
    [searchedLanes, laneFilter],
  );

  const matchedTotal = useMemo(() => searchedLanes.reduce((n, l) => n + l.rows.length, 0), [searchedLanes]);
  const populated = view !== null && view.lanes.length > 0;

  return (
    <div className="flex h-dvh flex-col">
      <SpoolHeader
        active="queue"
        description={
          view
            ? // COUNTED BY SUBJECT NOW, because that is what the surface groups
              // by — a header that counted lanes while the page grouped by
              // subject would describe a view the user is not looking at.
              `${view.totalItems} item${view.totalItems === 1 ? "" : "s"} across ${view.subjects.length} subject${view.subjects.length === 1 ? "" : "s"}`
            : "Everything filed, waiting or ripening."
        }
        actions={
          <Button variant="outline" size="sm" onClick={() => void addLane()}>
            <PlusIcon />
            Lane
          </Button>
        }
      />

      {populated && (
        <div className="shrink-0 border-b border-border">
          {/* flex-wrap, because lane labels are the USER's words and a lane count
              is a lane the user made — neither has a width this row can assume.
              Wrapping grows the toolbar; the alternative clips a filter the user
              then cannot reach. */}
          <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-2 px-4 py-2.5">
            <SearchField value={q} onChange={setQ} placeholder="Search items by title…" />
            {/* THE AXIS, AND SUBJECT LEADS. Grouping by lane is still one click
                away because a lane is where the split, the rename, the retire
                and the hand-ordering live — but it is no longer what you arrive
                at, because "when would I do this" is not how the work divides.
                See `docs/spool-definition.md` §6. */}
            <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
              <button
                type="button"
                onClick={() => setAxis("subject")}
                className={cn(AXIS_TAB, axis === "subject" ? AXIS_ON : AXIS_OFF)}
              >
                <FolderIcon className="size-3.5" />
                Subject
              </button>
              <button
                type="button"
                onClick={() => setAxis("lane")}
                className={cn(AXIS_TAB, axis === "lane" ? AXIS_ON : AXIS_OFF)}
              >
                <ListTodoIcon className="size-3.5" />
                Lane
              </button>
            </div>
            {axis === "lane" && (
              <>
                <Chip active={laneFilter === "all"} onClick={() => setLaneFilter("all")} count={matchedTotal}>
                  All lanes
                </Chip>
                {searchedLanes.map((l) => (
                  <Chip key={l.key} active={laneFilter === l.key} onClick={() => setLaneFilter(l.key)} count={l.rows.length}>
                    {l.label}
                  </Chip>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl space-y-3 px-4 py-4">
          {/* The skeleton wears the LaneSection's own shell so first paint does
              not change container geometry when the data lands. */}
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
              title="Couldn't load the spool"
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
              description="A lane is a coarse bucket of work — the Weekend, Office, whatever life demands. Add the first one, or file an item and one appears to catch it."
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
              {/* THE DIAGNOSTIC CHANNEL, rendered. A lane row the store could not
                  read is SKIPPED, and without this the human would watch a lane
                  vanish with no sign why — which is what makes tolerance
                  indistinguishable from silent loss. */}
              {view.unreadable.length > 0 && (
                <Alert className="mb-3">
                  <TriangleAlertIcon />
                  <AlertTitle>
                    {view.unreadable.length} thing{view.unreadable.length === 1 ? "" : "s"} could not be read
                  </AlertTitle>
                  <AlertDescription>
                    <ul className="space-y-1">
                      {view.unreadable.map((u) => (
                        <li key={`${u.id}:${u.reason}`} className="font-mono text-[11px] leading-relaxed break-words">
                          <span className="text-foreground">{u.id}</span> — {u.reason}
                        </li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
              {axis === "subject"
                ? searchedSubjects.map((g) => (
                    <SubjectSection
                      key={g.project ?? FLOATING_KEY}
                      group={g}
                      selection={selection}
                      onToggleSelect={toggleSelect}
                      onChanged={() => void load()}
                    />
                  ))
                : filteredLanes.map((l) => (
                    <LaneSection
                      key={l.key}
                      lane={l}
                      onChanged={() => void load()}
                      selection={selection}
                      onToggleSelect={toggleSelect}
                      onClearSelection={clearSelection}
                    />
                  ))}
              {/* THE CONSERVATION LAW, WITH LIVE NUMBERS — not a caption. Both
                  come off the same read the rows did. */}
              <p className="px-1 py-2 text-center text-[11px] text-muted-foreground/60">
                {view.totalItems} item{view.totalItems === 1 ? "" : "s"} — every one traces to something you fed in or a
                mirror · agents added {view.agentsAdded} · sub-tasks live inside items, the count never grows from
                breakdown
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
