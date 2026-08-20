"use client";

/**
 * THE BOARD — `docs/spool-loops.md` §7.2, the desk as a tangible surface.
 *
 * The room stays the front door (whose-turn-is-it); the board is where you go
 * to ARRANGE. Lanes render as columns in their STORED order, items as cards in
 * stack order — order is stack position, nothing here is a schedule — and the
 * hand moves them directly: you moved the thing, so you know where it is.
 *
 * ── ONE POSTURE OF ONE ROOM, NOT A ROUTE ─────────────────────────────────────
 * Rendered inside `/spool`'s main column by the posture switch. Nothing here
 * navigates: a card click SUMMONS the packet into the tray, same verb as every
 * line in the room.
 *
 * ── DRAG IS THE APP'S NATIVE IDIOM ───────────────────────────────────────────
 * HTML5 drag events, like the right panel's reference drags — no library. Two
 * gestures, two verbs, both the engine's own:
 *   · drop on another COLUMN   → `PATCH /api/spool/items/:id {lane}` — re-file,
 *     appended to that lane's stack; an unknown lane comes back refused with a
 *     sentence, surfaced in place.
 *   · drop on a CARD           → `POST /api/spool/lanes/:key/reorder` with the
 *     full stored stack, the dragged id inserted before the target. One verb
 *     for in-lane and cross-lane placement — the engine adopts a foreign id.
 * Optimistic: the card lands where the hand put it, then the snapshot reload
 * settles the truth. A refusal is the engine's sentence in the quiet inline
 * idiom — words, no state colour, and the reload puts the card back.
 *
 * ── SCOPE-AWARE ──────────────────────────────────────────────────────────────
 * Focused shows that subject's cards only; wide shows all, each card naming
 * its subject. Reorders always send the FULL stored stack — the visible slice
 * decides only where the dragged card lands relative to its neighbours.
 */
import { useMemo, useState } from "react";
import { ChevronRightIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react";
import type { SpoolLane, SpoolSubject, SpoolSubjectGroup, SpoolSubjectRow } from "@telar/engine-client";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { CloseCheckbox, DeadlineChip, PinChip, SelectHotspot, SubjectDot } from "@/components/spool/chips";
import { ConfirmDialog, LaneFormDialog, type LaneFormValues } from "@/components/spool/dialogs";
import { closeItemByHand, reopenItemByHand } from "@/lib/spool-close";
import { cn } from "@/lib/utils";

const DRAG_TYPE = "application/x-spool-item";

async function patch(url: string, method: string, body: unknown) {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? data?.error ?? `HTTP ${res.status}`);
}

function Card({
  row,
  wide,
  color,
  onOpen,
  onClose,
  onDragStartId,
  onDropBefore,
  select,
}: {
  row: SpoolSubjectRow;
  /** Wide names the subject on the card; focused already said it. */
  wide: boolean;
  /** The subject's identity hue (loops §8.2) — joined by key in the room's
   *  one snapshot read, never fetched here. Constant per subject: it says
   *  whose the card is, and nothing about its state. */
  color?: string | undefined;
  onOpen: (id: string) => void;
  /** §9.1 — the checkbox on every card. One click, the shared control POSTs
   *  the dedicated close route, and the snapshot reload drops the card to
   *  the lane's own done fold. */
  onClose: (id: string) => void;
  onDragStartId: (id: string) => void;
  /** A drop on a card places the dragged card before it. */
  onDropBefore: (targetId: string) => void;
  /** Select mode's hotspot — the square beside the round tick, rendered only
   *  while the toolbar's Select toggle is up. Gathers; writes nothing. */
  select?: { selected: boolean; toggle: (shiftKey: boolean) => void };
}) {
  const { item } = row;
  const said = (item.raw ?? "").trim().replace(/\s+/g, " ");
  return (
    <li
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_TYPE, item.id);
        event.dataTransfer.effectAllowed = "move";
        onDragStartId(item.id);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes(DRAG_TYPE)) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onDropBefore(item.id);
      }}
      className="cursor-grab rounded-lg bg-card px-3 py-2 shadow-sm ring-1 ring-foreground/10 transition-colors hover:bg-muted/40 active:cursor-grabbing"
    >
      {/* THE CARD'S OWN CONTEXT MENU — drag stays on THIS `<li>` (draggable,
          onDragStart/onDragOver/onDrop above are untouched); only the card's
          own content, below, is wrapped in the trigger, so a right-click can
          never race the drag machinery. "Close" fires the SAME `onClose` the
          checkbox fires; "Open packet" is the SAME `onOpen` the title button
          fires. OMITTED, and named rather than faked: "Pin to…", "Move to
          lane…", "Tag…" — the board moves a card between lanes only by drag
          (`onDropBefore`/the column's own drop target), pins nowhere on this
          surface, and no tag control reaches an individual card here at all;
          the Tasks tab's row menu names the identical gap for the same
          reason (`stance.tsx`'s `RowContextMenu`). */}
      <ContextMenu>
        <ContextMenuTrigger>
          <div className="flex items-start gap-2">
            {select && (
              <SelectHotspot
                selected={select.selected}
                label={`Select “${said || item.title}”`}
                onToggle={select.toggle}
                className="mt-0.5"
              />
            )}
            <CloseCheckbox
              closed={false}
              label={`Close “${said || item.title}”`}
              onToggle={() => onClose(item.id)}
              className="mt-0.5"
            />
            <button type="button" onClick={() => onOpen(item.id)} className="block min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <span className="block text-sm leading-snug font-medium text-foreground">{said || item.title}</span>
            </button>
          </div>
          {(wide || item.mirrored || item.deadline || item.pinned) && (
            /* ONE metadata row: the identity dot with the subject's name said
               ONCE (wide only — focused already named whose board this is), then
               the mirror mark only when a mirror exists, the deadline and pin
               chips only when they exist. The old ProjectChip repeated the name
               the dot already claimed and chipped "floating" onto every loose
               card — the noise this row replaces. */
            <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
              {wide && <SubjectDot color={color} />}
              {wide && (
                <span className="min-w-0 truncate text-xs text-muted-foreground">{item.project ?? "floating"}</span>
              )}
              {item.mirrored && (
                <span className="font-mono text-[10px] text-muted-foreground/70">{item.mirrored}</span>
              )}
              {item.deadline && <DeadlineChip deadline={item.deadline} />}
              {item.pinned && <PinChip pinned={item.pinned} />}
            </div>
          )}
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => onClose(item.id)}>Close</ContextMenuItem>
          <ContextMenuItem onClick={() => onOpen(item.id)}>Open packet</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}

/**
 * A LANE'S DONE, folded at the column foot — §9.3: closed drains off the
 * column into a visible fold, never out of the record. One quiet "N done"
 * line, expandable; each row keeps its TICKED checkbox, and unticking is the
 * reopen — instant, no dialog, same as everywhere a closed item renders. The
 * closed label is the store's own, quoted.
 */
function LaneDoneFold({
  rows,
  onOpen,
  onReopen,
}: {
  rows: SpoolSubjectRow[];
  onOpen: (id: string) => void;
  onReopen: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  return (
    <div className="mt-1.5 border-t border-border/60 pt-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded-md px-1 py-1 text-xs text-muted-foreground/70 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} aria-hidden />
        {rows.length} done
      </button>
      {open && (
        <ul className="space-y-1 pt-0.5">
          {rows.map((row) => {
            const said = (row.item.raw ?? "").trim().replace(/\s+/g, " ");
            const words = said || row.item.title;
            return (
              <li key={row.item.id} className="flex items-start gap-2 rounded-lg px-1.5 py-1">
                <ContextMenu>
                  <ContextMenuTrigger>
                    <div className="flex min-w-0 flex-1 items-start gap-2">
                      <CloseCheckbox closed label={`Reopen “${words}”`} onToggle={() => onReopen(row.item.id)} className="mt-0.5" />
                      <button
                        type="button"
                        onClick={() => onOpen(row.item.id)}
                        className="min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="block truncate text-sm leading-snug font-medium text-muted-foreground/60">{words}</span>
                        {row.item.closed && (
                          <span className="block truncate text-[10px] text-muted-foreground/60">
                            “closed {row.item.closed.label}”
                          </span>
                        )}
                      </button>
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onClick={() => onReopen(row.item.id)}>Reopen</ContextMenuItem>
                    <ContextMenuItem onClick={() => onOpen(row.item.id)}>Open packet</ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function SpoolBoard({
  lanes,
  groups,
  subjects,
  scope,
  onOpenItem,
  onChanged,
  pass,
  selection,
}: {
  lanes: SpoolLane[];
  groups: SpoolSubjectGroup[];
  /** The subject records, for the identity join — key → color. */
  subjects: SpoolSubject[];
  scope: string | undefined;
  onOpenItem: (id: string) => void;
  onChanged: () => Promise<void> | void;
  /** The room's quick-filter predicate — VIEW STATE carving the active
   *  columns; the stacks and the store are untouched by it. */
  pass?: (id: string) => boolean;
  /** Select mode's shared state — the same gathering the stance rows use. */
  selection?: { selected: (id: string) => boolean; toggle: (id: string, shiftKey: boolean) => void } | null;
}) {
  /** Identity by key. A card carries only `item.project`; the hue lives on
   *  the subject record, joined here once. */
  const colorOf = useMemo(() => new Map(subjects.map((s) => [s.key, s.color])), [subjects]);
  /** Every readable item by id — the columns resolve their stacks against it. */
  const byId = useMemo(() => {
    const map = new Map<string, SpoolSubjectRow>();
    for (const group of groups) for (const row of group.rows) map.set(row.item.id, row);
    return map;
  }, [groups]);

  /** The hand's optimistic copy of the stacks — painted the instant a drop
   *  lands, replaced by the reloaded snapshot when the engine answers. */
  const [moved, setMoved] = useState<Map<string, string[]> | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  /** The engine's sentence when a move is refused — words, in place, no red. */
  const [refused, setRefused] = useState<string | null>(null);

  /**
   * THE HAND CLOSES, ON THE BOARD — §9. Tick a card and the shared helper
   * POSTs the dedicated close route (no dialog, no PATCH); the cascade's one
   * sentence, when it earned one, lands in the same quiet inline slot the
   * refusals use. Untick lives in each lane's done fold below.
   */
  const [closeNote, setCloseNote] = useState<string | null>(null);
  const closeCard = (id: string) => {
    void closeItemByHand(id)
      .then((sentence) => {
        setCloseNote(sentence);
        return Promise.resolve(onChanged());
      })
      .catch((err) => setCloseNote(err instanceof Error ? err.message : String(err)));
  };
  const reopenCard = (id: string) => {
    void reopenItemByHand(id)
      .then(() => {
        setCloseNote(null);
        return Promise.resolve(onChanged());
      })
      .catch((err) => setCloseNote(err instanceof Error ? err.message : String(err)));
  };

  const stacks = (lane: SpoolLane) => moved?.get(lane.key) ?? lane.items;
  const laneOf = (id: string) => lanes.find((lane) => stacks(lane).includes(id));

  /**
   * THE WAREHOUSE'S HAND-TOOLS — loops §7's principle applied to the shelving
   * itself: the lanes are the user's own furniture, so the hand can mint,
   * rename and retire them here, through the SAME human-only routes the chat
   * cannot reach. Zero model calls; the store's rules stay in the store — a
   * refusal comes back as the engine's sentence and renders in the dialog that
   * asked, never pre-judged here.
   */
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<SpoolLane | null>(null);
  const [retiring, setRetiring] = useState<SpoolLane | null>(null);
  const [laneBusy, setLaneBusy] = useState(false);
  /** The engine's sentence when a lane change is refused — shown in the open
   *  dialog's own error slot, in the store's words. */
  const [laneError, setLaneError] = useState<string | null>(null);

  const laneJob = (job: () => Promise<void>, close: () => void) => {
    setLaneBusy(true);
    setLaneError(null);
    void job()
      .then(async () => {
        close();
        await onChanged();
      })
      .catch((err) => setLaneError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLaneBusy(false));
  };

  /** Mint a lane — the ONE place this surface POSTs the lanes route. The key
   *  is the store's to mint from the label; this sends only the words. */
  const createLane = (values: LaneFormValues) =>
    laneJob(() => patch("/api/spool/lanes", "POST", values), () => setCreating(false));

  /** The label only — the key never moves, so a rename can never redirect
   *  where new work lands (the store's own seed-lane law). */
  const renameLane = (values: LaneFormValues) =>
    laneJob(
      () => patch(`/api/spool/lanes/${encodeURIComponent(renaming?.key ?? "")}`, "PATCH", { label: values.label }),
      () => setRenaming(null),
    );

  /**
   * Retire a lane. THE ENGINE'S REFUSAL IS A 200 RESULT carrying the sentence
   * that names what to move first — surfaced as the dialog's error so the
   * instruction stays in front of the question it answers. Nothing is ever
   * moved or removed on the human's behalf: only an empty lane retires.
   */
  const retireLane = () => {
    if (!retiring) return;
    laneJob(async () => {
      const res = await fetch(`/api/spool/lanes/${encodeURIComponent(retiring.key)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message ?? data?.error ?? `HTTP ${res.status}`);
      if (data.ok === false) throw new Error(String(data.reason));
    }, () => setRetiring(null));
  };

  const settle = (job: Promise<void>) => {
    void job
      .then(() => setRefused(null))
      .catch((err) => setRefused(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        void Promise.resolve(onChanged()).finally(() => setMoved(null));
      });
  };

  /** Card → other column: re-file. Same column's empty space: send to the end. */
  const dropOnLane = (target: SpoolLane) => {
    if (!dragging) return;
    const from = laneOf(dragging);
    setDragging(null);
    if (from?.key === target.key) {
      const next = [...stacks(target).filter((id) => id !== dragging), dragging];
      setMoved(new Map([...(moved ?? []), [target.key, next]]));
      settle(patch(`/api/spool/lanes/${encodeURIComponent(target.key)}/reorder`, "POST", { items: next }));
      return;
    }
    const optimistic = new Map(moved ?? []);
    if (from) optimistic.set(from.key, stacks(from).filter((id) => id !== dragging));
    optimistic.set(target.key, [...stacks(target), dragging]);
    setMoved(optimistic);
    settle(patch(`/api/spool/items/${encodeURIComponent(dragging)}`, "PATCH", { lane: target.key }));
  };

  /** Drop on a card: the dragged card takes its place — one reorder verb for
   *  in-lane and cross-lane, because the engine adopts a foreign id. */
  const dropBefore = (target: SpoolLane, targetId: string) => {
    if (!dragging || dragging === targetId) return;
    const from = laneOf(dragging);
    setDragging(null);
    const without = stacks(target).filter((id) => id !== dragging);
    const at = without.indexOf(targetId);
    const next = [...without.slice(0, at), dragging, ...without.slice(at)];
    const optimistic = new Map(moved ?? []);
    if (from && from.key !== target.key) optimistic.set(from.key, stacks(from).filter((id) => id !== dragging));
    optimistic.set(target.key, next);
    setMoved(optimistic);
    settle(patch(`/api/spool/lanes/${encodeURIComponent(target.key)}/reorder`, "POST", { items: next }));
  };

  return (
    <div className="min-w-0 px-6 py-6">
      {refused && (
        /* The quiet inline sentence idiom — the engine's own words, no red. */
        <p className="mb-3 px-1 text-xs leading-relaxed text-muted-foreground">{refused}</p>
      )}
      {closeNote && <p className="mb-3 px-1 text-xs leading-relaxed text-muted-foreground">{closeNote}</p>}
      <div className="flex min-w-0 items-start gap-4 overflow-x-auto pb-4">
        {lanes.map((lane) => {
          const visible = stacks(lane)
            .map((id) => byId.get(id))
            .filter((row): row is SpoolSubjectRow => !!row)
            .filter((row) => !scope || row.item.project === scope)
            // The quick filter carves the ACTIVE column only — a glance's
            // squint, never a change to the stack it looks at.
            .filter((row) => !pass || pass(row.item.id));
          /* §9.3: closed cards leave the column — the active slice is the
             web's to filter — and drain to the lane's own fold at the foot.
             They stay in the payload and the stacks; the conservation counts
             are the stance footer's and unchanged. */
          const rows = visible.filter((row) => !row.item.closed);
          const done = visible.filter((row) => row.item.closed);
          return (
            <section
              key={lane.key}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes(DRAG_TYPE)) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                dropOnLane(lane);
              }}
              /* A COLUMN GROUND, not a card: a quiet tinted lane with a
                 hairline ring, so the columns read as columns at a glance and
                 the CARDS get to be the raised objects (the app's card
                 language, on each card). No room colour is spent here. */
              className="flex w-72 shrink-0 flex-col rounded-xl bg-muted/40 p-2.5 ring-1 ring-border/60"
            >
              <header className="mb-2 flex items-start gap-1 border-b border-border/60 px-1 pb-2">
                <div className="min-w-0 flex-1">
                  {/* SECTION-HEADER level, same register as the stance's bands. */}
                  <h3 className="text-xs font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                    {lane.label}
                  </h3>
                  {/* The window is coarse stored prose, QUOTED — never a
                      schedule this code reads. */}
                  {lane.window && <p className="mt-0.5 text-xs text-muted-foreground/70">{lane.window}</p>}
                </div>
                {/* The lane's own tools, in the app's menu idiom — quiet until
                    asked for, like the permit chip's. Both verbs open dialogs;
                    neither changes anything by itself. */}
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Arrange the ${lane.label} lane`}
                        title={`Rename or retire ${lane.label}`}
                        className="size-5 shrink-0 text-muted-foreground/50 hover:text-foreground"
                      />
                    }
                  >
                    <MoreHorizontalIcon className="size-3.5" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => {
                        setLaneError(null);
                        setRenaming(lane);
                      }}
                    >
                      Rename lane
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        setLaneError(null);
                        setRetiring(lane);
                      }}
                    >
                      Retire lane
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </header>
              <ul className={cn("min-h-16 space-y-1.5", dragging && "rounded-lg outline-1 outline-dashed outline-border")}>
                {rows.map((row) => (
                  <Card
                    key={row.item.id}
                    row={row}
                    wide={!scope}
                    color={row.item.project ? colorOf.get(row.item.project) : undefined}
                    onOpen={onOpenItem}
                    onClose={closeCard}
                    onDragStartId={setDragging}
                    onDropBefore={(targetId) => dropBefore(lane, targetId)}
                    {...(selection
                      ? {
                          select: {
                            selected: selection.selected(row.item.id),
                            toggle: (shiftKey: boolean) => selection.toggle(row.item.id, shiftKey),
                          },
                        }
                      : {})}
                  />
                ))}
                {rows.length === 0 && (
                  <li className="px-1 py-2 text-xs leading-relaxed text-muted-foreground/60">
                    {scope ? `Nothing of ${scope}'s waits here.` : "Nothing waits here."}
                  </li>
                )}
              </ul>
              <LaneDoneFold rows={done} onOpen={onOpenItem} onReopen={reopenCard} />
            </section>
          );
        })}
        {lanes.length === 0 && (
          <p className="px-1 text-xs leading-relaxed text-muted-foreground/60">
            No lanes yet — add one here, or ask the chat, and the board draws them as columns.
          </p>
        )}
        {/* THE NEW-LANE AFFORDANCE, at the row's end — the hand's own way to
            grow the shelving. It opens the form; only the form's confirm
            POSTs, so a stray click mints nothing. */}
        <button
          type="button"
          onClick={() => {
            setLaneError(null);
            setCreating(true);
          }}
          className="flex w-72 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-dashed border-border px-2.5 py-8 text-xs text-muted-foreground transition-colors hover:border-spool/40 hover:text-foreground"
        >
          <PlusIcon className="size-3.5" aria-hidden />
          New lane
        </button>
      </div>

      <LaneFormDialog
        open={creating}
        onOpenChange={(next) => !next && setCreating(false)}
        title="New lane"
        description="A column of the board — a place work waits, in your own words."
        confirmLabel="Create"
        busy={laneBusy}
        error={laneError}
        onSubmit={createLane}
      />
      <LaneFormDialog
        open={!!renaming}
        onOpenChange={(next) => !next && setRenaming(null)}
        title="Rename lane"
        description="The label only — the lane keeps its items, its order and its window."
        confirmLabel="Rename"
        withWindow={false}
        initial={{ label: renaming?.label ?? "" }}
        busy={laneBusy}
        error={laneError}
        onSubmit={renameLane}
      />
      {/* THE RETIRE DIALOG SAYS WHAT THE STORE ACTUALLY DOES — drain wording,
          read from the engine's own retire rules: it refuses while any item is
          still filed here and names what to move first; it never evicts, and
          nothing anywhere in this module deletes an item. */}
      <ConfirmDialog
        open={!!retiring}
        onOpenChange={(next) => !next && setRetiring(null)}
        title="Retire this lane?"
        body={
          <>
            “{retiring?.label}” leaves the board. No item goes with it: the engine refuses to retire a lane that still
            holds items — its refusal names what to move first — so retiring never evicts anything on your behalf, and
            nothing is deleted.
          </>
        }
        confirmLabel="Retire"
        busy={laneBusy}
        error={laneError}
        onConfirm={retireLane}
      />
    </div>
  );
}
