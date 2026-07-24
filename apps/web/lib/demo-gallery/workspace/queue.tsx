"use client";
// LANE: workspace (UX 5) — the queue: the app's proven list idiom (search-
// first toolbar, lane filter chips, collapsible groups, dense rows). No
// clocks: groups are lanes, order is the stack, deadlines are chips (data),
// never scheduling. The batch weave follows the loom-birth doctrine (UX 0):
// the workspace hands over premise + context and the loom DETACHES — the
// receipt below is the same one a session gets.
import { useState } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  LayoutTemplateIcon,
  PaperclipIcon,
  SearchIcon,
  SparklesIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { WS_LANES, WS_ITEM_COUNT, type WsItem } from "./fixtures";
import {
  DeadlineChip,
  ProjectChip,
  ProvenanceTag,
  VerdictChip,
  WorkspaceTabs,
} from "./shared";

// Static selection state: the two rows that both touch aurora's exports module
// are "checked", feeding the batch action bar at the bottom.
const SELECTED = new Set(["ws-aurora-export", "ws-diego-pr"]);

function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span
      className={cn(
        "flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border",
        checked
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border text-transparent",
      )}
    >
      <CheckIcon className="size-2.5" />
    </span>
  );
}

function ItemRow({ item }: { item: WsItem }) {
  const selected = SELECTED.has(item.id);
  const sub = item.subtasks;
  const done = sub?.filter((s) => s.done).length ?? 0;
  return (
    <div
      className={cn(
        "flex items-center gap-3 px-3 py-2 transition-colors hover:bg-muted/40",
        selected ? "bg-primary/5" : item.rank === 1 && "bg-muted/20",
      )}
    >
      <Checkbox checked={selected} />
      <span className="w-4 shrink-0 text-right font-mono text-[10px] text-muted-foreground/50">
        {item.rank}
      </span>
      {sub ? (
        <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground/60" />
      ) : (
        <span className="w-3 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
      {sub && (
        <span
          className="shrink-0 font-mono text-[10px] text-muted-foreground/60"
          title="Sub-tasks — decomposition lives inside the item; the queue count never grows from it"
        >
          {done}/{sub.length}
        </span>
      )}
      {item.packet && (
        <span
          className="flex shrink-0 items-center gap-1.5 text-muted-foreground/60"
          title="Work packet — holds files beyond the one-liner"
        >
          {item.packet.files > 0 && (
            <span className="flex items-center gap-0.5 font-mono text-[10px]">
              <PaperclipIcon className="size-3" />
              {item.packet.files}
            </span>
          )}
          {item.packet.mockups > 0 && (
            <span className="flex items-center gap-0.5 font-mono text-[10px]">
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
      {item.verdict ? (
        <VerdictChip verdict={item.verdict} />
      ) : (
        <span className="w-14 shrink-0" />
      )}
      <span className="w-24 shrink-0 text-right">
        <ProjectChip name={item.project} mirrored={item.mirrored} />
      </span>
    </div>
  );
}

// Sub-task rows, rendered expanded under their parent (static: essay is open).
function SubtaskRows({ item }: { item: WsItem }) {
  if (!item.subtasks) return null;
  return (
    <div className="border-t border-border/40 bg-muted/10 py-1 pl-[4.75rem]">
      {item.subtasks.map((s) => (
        <div key={s.title} className="flex items-center gap-2 py-1 pr-3">
          <span
            className={cn(
              "flex size-3 shrink-0 items-center justify-center rounded-[3px] border",
              s.done
                ? "border-muted-foreground/40 bg-muted text-muted-foreground"
                : "border-border text-transparent",
            )}
          >
            <CheckIcon className="size-2" />
          </span>
          <span
            className={cn(
              "min-w-0 truncate text-xs",
              s.done ? "text-muted-foreground/60 line-through" : "text-foreground/80",
            )}
          >
            {s.title}
          </span>
        </div>
      ))}
    </div>
  );
}

export function WorkspaceQueueDemo() {
  const [woven, setWoven] = useState(false);
  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-6">
        <h1 className="text-sm font-semibold tracking-tight">Workspace</h1>
        <WorkspaceTabs active="queue" />
        <span className="ml-auto text-xs text-muted-foreground">
          the drawer behind the desk — dismissed items land here
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-6 py-6">
          <div className="mb-4 flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
            <SparklesIcon className="size-4 shrink-0 text-muted-foreground" />
            <p className="min-w-0 flex-1 text-sm">
              <span className="font-medium">What’s next:</span> accept the aurora{" "}
              <span className="font-mono text-xs">payments-retry</span> loom — ~10 minutes,
              and it’s the only item someone else is waiting on.
            </p>
            <span className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">
              Open
            </span>
            <span className="shrink-0 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted">
              Not this
            </span>
          </div>

          <div className="mb-4 flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
              <div className="w-full rounded-md border border-border bg-background py-1.5 pl-8 pr-3 text-xs text-muted-foreground/50">
                Filter the queue…
              </div>
            </div>
            {["All", ...WS_LANES.map((l) => l.label)].map((label, i) => (
              <span
                key={label}
                className={cn(
                  "shrink-0 rounded-full border px-2.5 py-1 text-xs",
                  i === 0
                    ? "border-primary/40 bg-primary/10 font-medium text-foreground"
                    : "border-border text-muted-foreground hover:bg-muted",
                )}
              >
                {label}
                {i > 0 && (
                  <span className="ml-1 font-mono text-[10px] text-muted-foreground/60">
                    {WS_LANES[i - 1].items.length}
                  </span>
                )}
              </span>
            ))}
            <span
              className="shrink-0 rounded-full border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground/60 hover:bg-muted"
              title="Lanes are yours — split, rename, retire them as life changes"
            >
              + lane
            </span>
          </div>

          <div className="overflow-hidden rounded-lg border border-border">
            {WS_LANES.map((lane, li) => (
              <section key={lane.key} className={cn(li > 0 && "border-t border-border")}>
                <div className="sticky top-0 z-10 flex items-baseline gap-2 border-b border-border bg-muted/40 px-3 py-1.5 backdrop-blur">
                  <ChevronDownIcon className="size-3 self-center text-muted-foreground/60" />
                  <h2 className="text-xs font-semibold tracking-tight">{lane.label}</h2>
                  <span className="font-mono text-[10px] text-muted-foreground/60">
                    {lane.items.length}
                  </span>
                  {lane.note && (
                    <span className="hidden font-mono text-[9px] text-muted-foreground/40 sm:inline">
                      · {lane.note}
                    </span>
                  )}
                  <span className="ml-auto text-[10px] text-muted-foreground/50">
                    {lane.window}
                  </span>
                </div>
                <div className="divide-y divide-border/60">
                  {lane.items.map((item) => (
                    <div key={item.id}>
                      <ItemRow item={item} />
                      <SubtaskRows item={item} />
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>

          <p className="mt-6 text-center font-mono text-[10px] text-muted-foreground/50">
            {WS_ITEM_COUNT} items — every one traces to something you fed in or a mirror ·
            agents added 0 · sub-tasks live inside items, the count never grows from breakdown
          </p>

          <div className="sticky bottom-4 mt-4">
            {woven ? (
              <div className="mx-auto flex w-fit max-w-full items-start gap-2 rounded-xl border border-border bg-card px-4 py-2.5 shadow-lg">
                <CircleCheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
                  loom created — loom/exports-series · premise + context: 2 items and their
                  attachments · detached from the workspace · both rows now track the loom
                  and leave the queue when it lands and you accept
                </p>
              </div>
            ) : (
              <div className="mx-auto flex w-fit max-w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-2.5 shadow-lg">
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  2 selected
                </span>
                <span className="hidden min-w-0 items-center gap-1.5 text-xs text-muted-foreground sm:flex">
                  <SparklesIcon className="size-3.5 shrink-0" />
                  <span className="truncate">
                    both touch aurora’s exports module — they’d weave well as one series
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => setWoven(true)}
                  className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
                >
                  Weave as one loom
                </button>
                <button
                  type="button"
                  className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground hover:bg-muted"
                >
                  Sessions, one each
                </button>
                <button
                  type="button"
                  className="shrink-0 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted"
                >
                  Clear
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
