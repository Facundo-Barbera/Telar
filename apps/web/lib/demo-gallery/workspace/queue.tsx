"use client";
// LANE: workspace (UX 5) — the queue: the app's proven list idiom (search-
// first toolbar, lane filter chips, collapsible groups, dense rows). No
// clocks: groups are lanes, order is the stack, deadlines are chips (data),
// never scheduling. The batch weave follows the loom-birth doctrine (UX 0):
// the workspace hands over premise + context and the loom DETACHES — the
// receipt below is the same one a session gets.
//
// ── RE-SKIN PASS (2026-08-08): THIS SURFACE NOW HAS A PRODUCTION TWIN ───────
// components/workspace/queue-view.tsx was hand-ported from this file by eye
// (rule 7 forbids importing the other way), and in the porting it acquired the
// idiom this prototype predates. So the re-dress here is not a fresh set of
// judgement calls — it is MIRRORING THE TWIN, class string for class string,
// so the design source and the shipped surface stop being two drawings:
//
//   · toolbar        → PageHeader + WorkspaceTabs leading, then the shared
//                      SearchField and `Chip count={…}` from
//                      components/common/list-controls (the counts the
//                      hand-rolled chips carried in a nested span are the
//                      control's OWN `count` slot).
//   · lane container → `<section className="overflow-hidden rounded-xl border
//                      border-border bg-card">` with the shared `GroupHeader`,
//                      and `divide-border/70` for the hairlines INSIDE it (the
//                      card's own edge stays full-strength).
//   · checkboxes     → the native input with `accent-primary`, not a hand-drawn
//                      span with a CheckIcon in it — an unstyled checkbox
//                      paints its tick in the user agent's blue, and that is
//                      the one raw colour a class list cannot spell.
//   · batch receipt  → <DetachReceipt bare>, composed by weaveDetachReceipt.
//
// THE RECEIPT IS THE BIGGEST CHANGE AND THE LEAST OPTIONAL. Cross-surface
// invariant 2 — "the detach receipt is one line, one grammar, identical from
// birth session, batch weave, or packet handoff" — was a promise three
// prototypes made by each spelling their own sentence; lib/detach-receipt.ts
// exists because that is not a mechanism. This file used to hold one of the
// three phrasings the module replaced. It now renders the module.
//
// WHAT DID NOT CHANGE: the content and the information architecture, which
// ui-contract.md §3 freezes — what's-next card, chips ending in a dashed
// `+ lane`, sticky group header with the window right-aligned, the row's
// left-to-right order, sub-tasks indented inside the group, the conservation
// footer, the batch bar's three buttons.
import { useMemo, useState } from "react";
import {
  LayoutTemplateIcon,
  ListTodoIcon,
  MessageSquareIcon,
  PaperclipIcon,
  SparklesIcon,
  ChevronRightIcon,
  WorkflowIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, GroupHeader, SearchField } from "@/components/common/list-controls";
import { DetachReceipt } from "@/components/common/detach-receipt";
import { PageHeader } from "@/components/common/page-header";
import { weaveDetachReceipt } from "@/lib/detach-receipt";
import { cn } from "@/lib/utils";
import { WS_LANES, WS_ITEM_COUNT, type WsItem } from "./fixtures";
import {
  DeadlineChip,
  ProjectChip,
  ProvenanceTag,
  VerdictChip,
  WorkspaceTabs,
} from "./shared";

// Fixture state, not contract (ui-contract.md's own caveat): the two rows that
// both touch aurora's exports module start "checked", feeding the batch bar.
const PRESELECTED = ["ws-aurora-export", "ws-diego-pr"];

const ALL_ITEMS: WsItem[] = WS_LANES.flatMap((l) => l.items);

function ItemRow({
  item,
  selected,
  onToggleSelect,
  open,
  onToggleOpen,
}: {
  item: WsItem;
  selected: boolean;
  onToggleSelect: () => void;
  open: boolean;
  onToggleOpen: () => void;
}) {
  const sub = item.subtasks;
  const done = sub?.filter((s) => s.done).length ?? 0;
  return (
    <div
      className={cn(
        "flex items-center gap-2 py-2 pr-3 pl-2 transition-colors hover:bg-muted/40",
        selected && "bg-primary/5",
      )}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggleSelect}
        title="Select rows to weave as one loom, or to split into a new lane"
        className="size-3.5 shrink-0 rounded-sm border-border accent-primary"
      />
      <button
        type="button"
        onClick={onToggleOpen}
        aria-expanded={sub ? open : undefined}
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-md transition-colors",
          sub ? "hover:bg-muted/60" : "invisible",
        )}
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
      </button>
      <span className="w-5 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/60">
        {item.rank}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
      {sub && (
        <span
          className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70"
          title="Sub-tasks — decomposition lives inside the item; the queue count never grows from it"
        >
          {done}/{sub.length}
        </span>
      )}
      {item.packet && (
        <span
          className="flex shrink-0 items-center gap-1.5 text-muted-foreground/70"
          title="Work packet — holds files beyond the one-liner"
        >
          {item.packet.files > 0 && (
            <span className="flex items-center gap-0.5 font-mono text-[10px] tabular-nums">
              <PaperclipIcon className="size-3" />
              {item.packet.files}
            </span>
          )}
          {item.packet.mockups > 0 && (
            <span className="flex items-center gap-0.5 font-mono text-[10px] tabular-nums">
              <LayoutTemplateIcon className="size-3" />
              {item.packet.mockups}
            </span>
          )}
        </span>
      )}
      <span className="hidden shrink-0 sm:block">
        <ProvenanceTag label={item.provenance} />
      </span>
      {item.deadline ? (
        <DeadlineChip deadline={item.deadline} />
      ) : (
        <span className="w-8 shrink-0" />
      )}
      {item.verdict ? <VerdictChip verdict={item.verdict} /> : <span className="w-14 shrink-0" />}
      <span className="w-24 shrink-0 text-right">
        <ProjectChip name={item.project} mirrored={item.mirrored} />
      </span>
    </div>
  );
}

// Sub-task rows, expanded under their parent and INSIDE the same group — never
// as queue entries (ui-contract.md §3). The indent and the native checkbox are
// queue-view.tsx's SubtaskRows verbatim; what the production twin also has and
// this does not is the `promote` control, because promotion is a mutation and a
// gallery stage mutates nothing.
function SubtaskRows({ item }: { item: WsItem }) {
  if (!item.subtasks) return null;
  return (
    <div className="space-y-1 py-1.5 pr-3 pl-12">
      {item.subtasks.map((s) => (
        <div key={s.title} className="flex items-center gap-2 py-0.5 text-xs">
          <input
            type="checkbox"
            checked={!!s.done}
            readOnly
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
        </div>
      ))}
    </div>
  );
}

function LaneSection({
  lane,
  selection,
  onToggleSelect,
}: {
  lane: (typeof WS_LANES)[number];
  selection: ReadonlySet<string>;
  onToggleSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  // The essay's breakdown starts expanded, as it did in the first drawing.
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(new Set(["ws-essay"]));

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <GroupHeader
        icon={ListTodoIcon}
        label={`${lane.label}${lane.note ? ` · ${lane.note}` : ""}`}
        count={lane.items.length}
        open={open}
        onToggle={() => setOpen((o) => !o)}
        // "…and its coarse window right-aligned" — the header's `action` slot
        // is where right-aligned belongs, rather than an `ml-auto` span
        // smuggled into the label.
        action={
          <span className="shrink-0 text-[10px] text-muted-foreground/60">{lane.window}</span>
        }
      />
      {open && (
        <div className="divide-y divide-border/70">
          {lane.items.map((item) => (
            <div key={item.id}>
              <ItemRow
                item={item}
                selected={selection.has(item.id)}
                onToggleSelect={() => onToggleSelect(item.id)}
                open={openRows.has(item.id)}
                onToggleOpen={() =>
                  setOpenRows((prev) => {
                    const next = new Set(prev);
                    if (next.has(item.id)) next.delete(item.id);
                    else next.add(item.id);
                    return next;
                  })
                }
              />
              {openRows.has(item.id) && <SubtaskRows item={item} />}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function WorkspaceQueueDemo() {
  const [q, setQ] = useState("");
  const [laneFilter, setLaneFilter] = useState("all");
  const [woven, setWoven] = useState(false);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set(PRESELECTED));

  const toggleSelect = (id: string) =>
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const lanes = WS_LANES.filter((l) => laneFilter === "all" || l.key === laneFilter);
  const selected = ALL_ITEMS.filter((i) => selection.has(i.id));

  // COMPOSED, NOT SPELLED — and composed from what the rows actually show. The
  // prototype's old line claimed "2 items and their attachments" over two rows
  // that carry no paperclip at all; the tallies below are read off the same
  // fixtures the rows render, so the receipt cannot say more than the queue
  // does. `fixed` is 0 because a queue row has no brief — the fixed brief is a
  // packet's field, and the packet surface's own handoff is where a receipt
  // gets to name one.
  const receipt = useMemo(
    () =>
      weaveDetachReceipt("loom/exports-series", {
        items: selected.length,
        fixed: 0,
        acceptance: 0,
        attachments: selected.reduce(
          (n, i) => n + (i.packet ? i.packet.files + i.packet.mockups : 0),
          0,
        ),
      }),
    [selected],
  );

  return (
    <div className="flex h-full flex-col bg-background">
      <PageHeader
        leading={<WorkspaceTabs active="queue" />}
        title="Workspace"
        description="the drawer behind the desk — dismissed items land here"
      />

      <div className="shrink-0 border-b border-border">
        <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-2 px-4 py-2.5">
          <SearchField value={q} onChange={setQ} placeholder="Filter the queue…" />
          <Chip
            active={laneFilter === "all"}
            onClick={() => setLaneFilter("all")}
            count={WS_ITEM_COUNT}
          >
            All
          </Chip>
          {WS_LANES.map((l) => (
            <Chip
              key={l.key}
              active={laneFilter === l.key}
              onClick={() => setLaneFilter(l.key)}
              count={l.items.length}
            >
              {l.label}
            </Chip>
          ))}
          {/* The chip row ENDS DASHED, and the dash is the message: lanes are
              the user's to split, rename and retire, so the affordance that
              makes one is a proposal-shaped control rather than a solid
              command. Same h-7 pill box as its siblings above. */}
          <span
            className="inline-flex h-7 shrink-0 items-center rounded-full border border-dashed border-border px-2.5 text-xs font-medium text-muted-foreground/70 transition-colors hover:bg-muted/50 hover:text-foreground"
            title="Lanes are yours — split, rename, retire them as life changes"
          >
            + lane
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl space-y-3 px-4 py-4">
          {/* What's next: pinned above the list. One suggested move, its reason
              and a rough size — and `Not this` carries the same weight as a
              dismissal anywhere else in the app, i.e. ghost. */}
          <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
            <SparklesIcon className="size-4 shrink-0 text-muted-foreground" />
            <p className="min-w-0 flex-1 text-sm">
              <span className="font-medium">What’s next:</span> accept the aurora{" "}
              <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">
                payments-retry
              </span>{" "}
              loom — ~10 minutes, and it’s the only item someone else is waiting on.
            </p>
            <Button size="sm" className="shrink-0">
              Open
            </Button>
            <Button variant="ghost" size="sm" className="shrink-0 text-muted-foreground">
              Not this
            </Button>
          </div>

          {lanes.map((lane) => (
            <LaneSection
              key={lane.key}
              lane={lane}
              selection={selection}
              onToggleSelect={toggleSelect}
            />
          ))}

          <p className="pt-3 text-center font-mono text-[10px] leading-relaxed text-muted-foreground/60">
            {WS_ITEM_COUNT} items — every one traces to something you fed in or a mirror ·
            agents added 0 · sub-tasks live inside items, the count never grows from breakdown
          </p>

          {selected.length > 0 && (
            <div className="sticky bottom-4 z-20 mt-4">
              <div className="mx-auto w-fit max-w-full rounded-xl border border-border bg-card px-4 py-2.5 shadow-lg">
                {woven ? (
                  // In place, as the contract says — and `bare`, because this
                  // card already draws the border and the shadow the boxed
                  // receipt would draw a second time.
                  <DetachReceipt receipt={receipt} bare />
                ) : (
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                      {selected.length} selected
                    </span>
                    <span className="hidden min-w-0 items-center gap-1.5 text-xs text-muted-foreground sm:flex">
                      <SparklesIcon className="size-3.5 shrink-0" />
                      <span className="truncate">
                        both touch aurora’s exports module — they’d weave well as one series
                      </span>
                    </span>
                    <Button size="xs" className="shrink-0" onClick={() => setWoven(true)}>
                      <WorkflowIcon />
                      Weave as one loom
                    </Button>
                    <Button variant="outline" size="xs" className="shrink-0">
                      <MessageSquareIcon />
                      Sessions, one each
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="shrink-0 text-muted-foreground"
                      onClick={() => setSelection(new Set())}
                    >
                      Clear
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
