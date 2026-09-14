"use client";

/**
 * THE CALENDAR — `docs/spool-loops.md` §7.3, governed by §3.2 AS AMENDED
 * (2026-08-16): the calendar belongs to the human.
 *
 * The grid is drawn from the user's OWN dates and nothing else. Pinned items
 * sit on the day the user named; lane windows and deadline labels are stored
 * words that stay where they already are — chips on the items — and are NEVER
 * parsed into grid positions. The system draws your dates plainly and may
 * respect them; it never wields them.
 *
 * ── THE ONE CLOCK READ RIDES THE SANCTIONED HELPER ───────────────────────────
 * `todayDay()` (lib/spool-today.ts, which cites the amendment) tells this
 * renderer which day is today for exactly two quiet purposes: marking the
 * day's cell so your dates sit in the right place, and saying "you pinned
 * this to Tuesday — it's still here" about a pin whose day has passed. A
 * slipped pin renders in that same voice — no red, no "overdue", no
 * countdown, no badge. Nothing else in this file touches a clock; everything
 * else is pure arithmetic over the user's own `YYYY-MM-DD` strings.
 *
 * ── THE HAND EDITS THE STORE ─────────────────────────────────────────────────
 * Native HTML5 drag, same idiom as the board. Dragging a pinned card to
 * another day is `PATCH {pinned: {day}}`; dragging from the unpinned rail
 * onto a day sets the pin — the user dropping on a date IS the user stating
 * it. The small "unpin" control clears with `{pinned: null}`: it goes back to
 * its lane, nothing is deleted. A refusal is the engine's sentence, verbatim,
 * in the quiet inline idiom.
 */
import { useMemo, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { SpoolLane, SpoolSubject, SpoolSubjectGroup, SpoolSubjectRow } from "@telar/engine-client";
import { CloseCheckbox, SubjectDot } from "@/components/spool/chips";
import { AddTaskDialog } from "@/components/spool/add-task";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { closeItemByHand, reopenItemByHand } from "@/lib/spool-close";
import { addDays, addMonths, formatDay, monthGridOf, monthLabel, sameMonth, todayDay, weekOf } from "@/lib/spool-today";
import { cn } from "@/lib/utils";

const DRAG_TYPE = "application/x-spool-item";

async function patchItem(id: string, body: unknown) {
  const res = await fetch(`/api/spool/items/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? data?.error ?? `HTTP ${res.status}`);
}

/**
 * One pinned item on its day — ONE COMPACT LINE: identity dot, the user's
 * words truncated, and the unpin on hover. The mirror and deadline chips and
 * the slipped sentence do NOT render inside a cell — a cell that balloons is
 * a row of unequal days — they live in the packet (a click away), and the
 * slipped sentence keeps its two homes: the strip above the grid, and this
 * line's own `title`.
 */
function DayLine({
  row,
  color,
  slipped,
  onOpen,
  onClose,
  onUnpin,
  onDragStartId,
}: {
  row: SpoolSubjectRow;
  /** The subject's identity hue — the Apple Calendar overlay feel: many
   *  subjects, one grid, each line recognizably its own. Constant per
   *  subject, whichever side of today its day sits on: a slipped pin wears
   *  exactly the hue a resting one does. */
  color?: string | undefined;
  /** Its day is before today and it is still open — said in the quiet voice. */
  slipped: boolean;
  onOpen: (id: string) => void;
  /** §9.1 — the checkbox on every day line. Tick and the snapshot reload
   *  drops the line from the grid into the rail's done fold. */
  onClose: (id: string) => void;
  onUnpin: (id: string) => void;
  onDragStartId: (id: string) => void;
}) {
  const { item } = row;
  const said = (item.raw ?? "").trim().replace(/\s+/g, " ");
  const words = said || item.title;
  return (
    <li
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_TYPE, item.id);
        event.dataTransfer.effectAllowed = "move";
        onDragStartId(item.id);
      }}
      /* The amendment's own sentence rides as the line's title — quiet,
         never "overdue", never red. */
      title={slipped && item.pinned ? `you pinned this to ${formatDay(item.pinned.day)} — it's still here` : words}
      /* `w-full min-w-0` so the pill owns the whole cell line and the text
         truncates at the CELL edge, not before it. The unpin is OVERLAID
         (absolute, hover/focus-revealed) rather than in-flow: an invisible
         in-flow button was reserving ~40px of every pill, which is what made
         "Telar: revisar…" truncate to three characters with free width
         visibly left beside it. */
      className="group relative flex w-full min-w-0 cursor-grab items-center gap-1.5 rounded-md bg-card px-1.5 py-1 shadow-1 ring-1 ring-foreground/10 transition-colors hover:bg-muted/40 active:cursor-grabbing"
    >
      {/* THE PILL'S OWN CONTEXT MENU — drag stays on the `<li>` above
          (unchanged); only the pill's own content is wrapped in the trigger.
          "Unpin" fires the SAME `onUnpin` the hover-revealed "unpin" button
          fires; "Open packet" is the SAME `onOpen` the words button fires. */}
      <ContextMenu>
        <ContextMenuTrigger>
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <CloseCheckbox closed={false} label={`Close “${words}”`} onToggle={() => onClose(item.id)} className="size-3.5" />
            <SubjectDot color={color} />
            <button
              type="button"
              onClick={() => onOpen(item.id)}
              className="min-w-0 flex-1 truncate text-left text-xs leading-snug font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {words}
            </button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => onUnpin(item.id)}>Unpin</ContextMenuItem>
          <ContextMenuItem onClick={() => onOpen(item.id)}>Open packet</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <button
        type="button"
        onClick={() => onUnpin(item.id)}
        title="unpin — it goes back to its lane"
        className="absolute inset-y-0.5 right-1 rounded-sm bg-card px-1 text-3xs text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
      >
        unpin
      </button>
    </li>
  );
}

export function SpoolCalendar({
  groups,
  subjects,
  lanes,
  scope,
  onOpenItem,
  onChanged,
  pass,
}: {
  groups: SpoolSubjectGroup[];
  /** The subject records, for the identity join — key → color. */
  subjects: SpoolSubject[];
  /** The lanes that exist — threaded through only for the day cell's own
   *  "Add a task for this day…" verb's `AddTaskDialog`, the same dialog the
   *  room's header already opens. */
  lanes: SpoolLane[];
  scope: string | undefined;
  onOpenItem: (id: string) => void;
  onChanged: () => Promise<void> | void;
  /** The room's quick-filter predicate — VIEW STATE carving the grid and the
   *  rail; the pins themselves are untouched by a squint. */
  pass?: (id: string) => boolean;
}) {
  /** Identity by key — the join, once, from the room's snapshot read. */
  const colorOf = useMemo(() => new Map(subjects.map((s) => [s.key, s.color])), [subjects]);
  /** THE SANCTIONED READ — once, to know where to draw the user's dates. */
  const today = todayDay();
  const [view, setView] = useState<"week" | "month">("week");
  const [anchor, setAnchor] = useState(today);
  const [dragging, setDragging] = useState<string | null>(null);
  /** The engine's refusal, verbatim — the quiet inline sentence, no red. */
  const [refused, setRefused] = useState<string | null>(null);
  /** The hand's optimistic day per item id, until the snapshot settles. */
  const [placed, setPlaced] = useState<Map<string, string | null>>(new Map());
  /** The unpinned rail's fold — open by default; folding it is a glance's
   *  choice, so it is plain component state, never persisted. */
  const [railOpen, setRailOpen] = useState(true);
  /** The done fold's own state — closed by default: the shelf is a record,
   *  not an arrival question. */
  const [doneOpen, setDoneOpen] = useState(false);
  /** THE DAY CELL'S "Add a task for this day…" — `null` closed, else the
   *  day the form's own pin field seeds. One dialog, shared with nothing
   *  else on this surface (the grid has no other creation control). */
  const [addingDay, setAddingDay] = useState<string | null>(null);

  const rows = useMemo(
    () => groups.flatMap((g) => g.rows).filter((row) => !scope || row.item.project === scope),
    [groups, scope],
  );

  const dayOf = (row: SpoolSubjectRow): string | null | undefined =>
    placed.has(row.item.id) ? placed.get(row.item.id) : row.item.pinned?.day;

  /* §9.3: closed items leave the ACTIVE grid and rail — the web's filter —
     and drain to the rail's done fold below. They keep their pins and their
     payload rows; nothing is deleted and no count moves. */
  // The quick filter carves the ACTIVE surfaces only — grid and rail; the
  // done fold is a record, and records are not what a filter squints at.
  const openRows = rows.filter((row) => !row.item.closed).filter((row) => !pass || pass(row.item.id));
  const doneRows = rows.filter((row) => row.item.closed);
  const pinnedRows = openRows.filter((row) => !!dayOf(row));
  const unpinnedRows = openRows.filter((row) => !dayOf(row));
  const byDay = new Map<string, SpoolSubjectRow[]>();
  for (const row of pinnedRows) {
    const day = dayOf(row)!;
    byDay.set(day, [...(byDay.get(day) ?? []), row]);
  }

  /** Pins whose day has passed while the item is still open — the strip says
   *  so in the amendment's own voice, wherever the grid is currently looking. */
  const slippedRows = pinnedRows.filter((row) => dayOf(row)! < today);

  const settle = (id: string, day: string | null, job: Promise<void>) => {
    setPlaced((prev) => new Map([...prev, [id, day]]));
    void job
      .then(() => setRefused(null))
      .catch((err) => setRefused(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        void Promise.resolve(onChanged()).finally(() => setPlaced(new Map()));
      });
  };

  const pinTo = (id: string, day: string) => settle(id, day, patchItem(id, { pinned: { day } }));
  const unpin = (id: string) => settle(id, null, patchItem(id, { pinned: null }));

  /**
   * THE HAND CLOSES, ON THE GRID — §9. The shared helper POSTs the dedicated
   * close/reopen routes; the cascade's sentence (when one was earned) rides
   * the same quiet inline slot the refusals use. No dialog on either verb.
   */
  const [closeNote, setCloseNote] = useState<string | null>(null);
  const closeLine = (id: string) => {
    void closeItemByHand(id)
      .then((sentence) => {
        setCloseNote(sentence);
        return Promise.resolve(onChanged());
      })
      .catch((err) => setCloseNote(err instanceof Error ? err.message : String(err)));
  };
  const reopenLine = (id: string) => {
    void reopenItemByHand(id)
      .then(() => {
        setCloseNote(null);
        return Promise.resolve(onChanged());
      })
      .catch((err) => setCloseNote(err instanceof Error ? err.message : String(err)));
  };

  const weeks = view === "week" ? [weekOf(anchor)] : monthGridOf(anchor);
  const caption = view === "week" ? `week of ${formatDay(weeks[0]![0]!)}` : monthLabel(anchor);

  return (
    <div className="min-w-0 px-6 py-6">
      <div className="mb-3 flex items-center gap-2 px-1">
        {/* Week | month — the same segmented pattern as the posture switch,
            at the app's control size. A toggle inside the posture, not a route. */}
        <div className="inline-flex items-center rounded-lg border border-border bg-muted/40 p-0.5">
          {(["week", "month"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={view === option}
              onClick={() => setView(option)}
              className={cn(
                "rounded-[7px] px-2.5 py-1 text-xs font-medium capitalize transition-colors",
                view === option
                  ? "bg-background text-foreground shadow-1 ring-1 ring-foreground/10"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option}
            </button>
          ))}
        </div>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{caption}</span>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Earlier"
          onClick={() => setAnchor(view === "week" ? addDays(anchor, -7) : addMonths(anchor, -1))}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeftIcon className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setAnchor(today)}
          className="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          today
        </button>
        <button
          type="button"
          aria-label="Later"
          onClick={() => setAnchor(view === "week" ? addDays(anchor, 7) : addMonths(anchor, 1))}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronRightIcon className="size-3.5" />
        </button>
      </div>

      {refused && <p className="mb-3 px-1 text-xs leading-relaxed text-muted-foreground">{refused}</p>}
      {closeNote && <p className="mb-3 px-1 text-xs leading-relaxed text-muted-foreground">{closeNote}</p>}

      {slippedRows.length > 0 && (
        /* Recorded honestly, not punished — one quiet line per slipped pin,
           teaching its two verbs: open it, or unpin it back to its lane. */
        <ul className="mb-3 space-y-1 px-1">
          {slippedRows.map((row) => (
            <li key={row.item.id} className="flex min-w-0 items-center gap-2 text-xs leading-relaxed text-muted-foreground">
              <span className="min-w-0 truncate">
                you pinned{" "}
                <button type="button" onClick={() => onOpenItem(row.item.id)} className="rounded-sm text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
                  {((row.item.raw ?? "").trim().replace(/\s+/g, " ") || row.item.title)}
                </button>{" "}
                to {formatDay(dayOf(row)!)} — it&apos;s still here
              </span>
              <button
                type="button"
                onClick={() => unpin(row.item.id)}
                title="unpin — it goes back to its lane"
                className="shrink-0 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                unpin
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex min-w-0 items-start gap-4">
        {/* ── THE GRID — the app's card language: one rounded-xl ring surface,
               hairline-divided cells, text-sm words. No room colour spent. */}
        <div className="min-w-0 flex-1 overflow-hidden rounded-xl bg-card shadow-1 ring-1 ring-foreground/10">
          <div className="grid grid-cols-7 border-b border-border/60">
            {weekOf(anchor).map((day) => (
              <div key={day} className="px-2 py-1.5 text-2xs font-semibold tracking-[0.12em] text-muted-foreground/70 uppercase">
                {formatDay(day).split(" ")[0]}
              </div>
            ))}
          </div>
          {/* ONE grid for all the days, `auto-rows-fr` — every row the same
              height whatever any one day holds, which one-line day entries
              keep honest. Cell hairlines come from nth-child edges. */}
          <div className={cn("grid grid-cols-7", view === "month" && "auto-rows-fr")}>
            {weeks.flat().map((day) => {
              const isToday = day === today;
              const dimmed = view === "month" && !sameMonth(day, anchor);
              return (
                // THE DAY CELL'S OWN CONTEXT MENU — the cell is a drop
                // TARGET only (onDragOver/onDrop below), never a drag
                // source, so wrapping the whole cell in the trigger cannot
                // race any drag. "Add a task for this day…" opens the SAME
                // `AddTaskDialog` the room's own "Add a task" button opens,
                // merely pre-picking this day in the form's existing pin
                // field (`defaultPinDay`) — the same `{pinned:{day}}` POST,
                // never a second write path.
                <ContextMenu key={day}>
                  <ContextMenuTrigger>
                    <div
                      onDragOver={(event) => {
                        if (event.dataTransfer.types.includes(DRAG_TYPE)) event.preventDefault();
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        const id = dragging ?? event.dataTransfer.getData(DRAG_TYPE);
                        setDragging(null);
                        if (id) pinTo(id, day);
                      }}
                      className={cn(
                    "min-h-28 border-r border-b border-border/40 p-1.5 [&:nth-child(7n)]:border-r-0 [&:nth-last-child(-n+7)]:border-b-0",
                    view === "week" && "min-h-56",
                    dimmed && "bg-muted/30",
                    /* Today is marked on the CELL — a quiet inset ring, no
                       hue, no claim — so your own dates sit in the right
                       place at a glance in both schemes. */
                    isToday && "inset-ring-2 inset-ring-foreground/15",
                  )}
                >
                  <p className={cn("px-0.5 pb-1 text-xs font-medium tabular-nums", isToday ? "font-semibold text-foreground" : "text-muted-foreground", dimmed && "text-muted-foreground/50")}>
                    {Number(day.slice(8))}
                    {/* Today is NAMED, quietly — a place marker so your own
                        dates sit right, never a claim on you. */}
                    {isToday && <span className="ml-1 font-normal text-muted-foreground">· today</span>}
                  </p>
                  <ul className="space-y-1">
                    {(byDay.get(day) ?? []).map((row) => (
                      <DayLine
                        key={row.item.id}
                        row={row}
                        color={row.item.project ? colorOf.get(row.item.project) : undefined}
                        slipped={day < today}
                        onOpen={onOpenItem}
                        onClose={closeLine}
                        onUnpin={unpin}
                        onDragStartId={setDragging}
                      />
                    ))}
                  </ul>
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onClick={() => setAddingDay(day)}>Add a task for this day…</ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
          </div>
        </div>

        {/* ── THE UNPINNED RAIL — everything without a day, draggable onto
               one. Dropping on a date is you STATING that date. Narrow, its
               items one compact line each, and COLLAPSIBLE behind a quiet
               toggle (open by default) so the grid can own the width. */}
        <aside className={cn("shrink-0 rounded-xl bg-muted/40 p-2 ring-1 ring-border/60", railOpen && "w-48")}>
          <button
            type="button"
            aria-expanded={railOpen}
            onClick={() => setRailOpen((o) => !o)}
            title={railOpen ? "Fold the rail away — the grid keeps the width" : "Unpinned items, back on the rail"}
            className="flex w-full items-center gap-1 rounded-md px-1 pb-1 text-2xs font-semibold tracking-[0.12em] text-muted-foreground uppercase outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", railOpen && "rotate-90")} aria-hidden />
            Unpinned
          </button>
          {railOpen && (
            <>
              <p className="px-1 pb-2 text-xs leading-relaxed text-muted-foreground/70">
                Drag one onto a day to pin it there. It keeps its lane either way.
              </p>
              <ul className="space-y-1">
                {unpinnedRows.map((row) => {
                  const said = (row.item.raw ?? "").trim().replace(/\s+/g, " ");
                  const words = said || row.item.title;
                  return (
                    <li
                      key={row.item.id}
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData(DRAG_TYPE, row.item.id);
                        event.dataTransfer.effectAllowed = "move";
                        setDragging(row.item.id);
                      }}
                      title={!scope && row.item.project ? `${words} — ${row.item.project}` : words}
                      className="flex w-full min-w-0 cursor-grab items-center gap-1.5 rounded-md bg-card px-2 py-1.5 shadow-1 ring-1 ring-foreground/10 transition-colors hover:bg-muted/40 active:cursor-grabbing"
                    >
                      <CloseCheckbox
                        closed={false}
                        label={`Close “${words}”`}
                        onToggle={() => closeLine(row.item.id)}
                        className="size-3.5"
                      />
                      <SubjectDot color={row.item.project ? colorOf.get(row.item.project) : undefined} className="size-1.5" />
                      <button
                        type="button"
                        onClick={() => onOpenItem(row.item.id)}
                        className="min-w-0 flex-1 truncate text-left text-xs leading-snug font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {words}
                      </button>
                    </li>
                  );
                })}
                {unpinnedRows.length === 0 && (
                  <li className="px-1 py-1 text-xs leading-relaxed text-muted-foreground/60">Everything has its day, or none asked for one.</li>
                )}
              </ul>

              {/* §9.3 — THE RAIL'S DONE FOLD. Closed items leave the grid
                  (pinned or not) and drain here, ticked; unticking reopens,
                  instantly. The closed label is the store's own, quoted. */}
              {doneRows.length > 0 && (
                <div className="mt-2 border-t border-border/60 pt-1">
                  <button
                    type="button"
                    aria-expanded={doneOpen}
                    onClick={() => setDoneOpen((o) => !o)}
                    className="flex items-center gap-1 rounded-md px-1 py-1 text-xs text-muted-foreground/70 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", doneOpen && "rotate-90")} aria-hidden />
                    {doneRows.length} done
                  </button>
                  {doneOpen && (
                    <ul className="space-y-1 pt-0.5">
                      {doneRows.map((row) => {
                        const said = (row.item.raw ?? "").trim().replace(/\s+/g, " ");
                        const words = said || row.item.title;
                        return (
                          <li key={row.item.id} className="flex items-start gap-1.5 rounded-md px-1.5 py-1">
                            <CloseCheckbox
                              closed
                              label={`Reopen “${words}”`}
                              onToggle={() => reopenLine(row.item.id)}
                              className="mt-0.5 size-3.5"
                            />
                            <button
                              type="button"
                              onClick={() => onOpenItem(row.item.id)}
                              className="min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <span className="block truncate text-xs leading-snug font-medium text-muted-foreground/60">{words}</span>
                              {row.item.closed && (
                                <span className="block truncate text-3xs text-muted-foreground/60">
                                  “closed {row.item.closed.label}”
                                </span>
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </aside>
      </div>

      <AddTaskDialog
        open={addingDay !== null}
        onOpenChange={(open) => {
          if (!open) setAddingDay(null);
        }}
        subjects={subjects.map((s) => s.key)}
        lanes={lanes}
        {...(scope ? { defaultSubject: scope } : {})}
        {...(addingDay ? { defaultPinDay: addingDay } : {})}
        onCreated={() => {
          setAddingDay(null);
          void onChanged();
        }}
      />
    </div>
  );
}
