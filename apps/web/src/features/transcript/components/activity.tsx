"use client";

import { useContext,useMemo,useState } from "react";
import {
BookOpenIcon,ChevronRightIcon
} from "lucide-react";
import { type JournalItem,type JournalTask } from "@/lib/engine/journal";
import { foldHarnessRows } from "../harness-paths";
import { ROW,StepFold } from "./transcript-fold";
import { cn } from "@/lib/utils";
import { RowGestures,WorkspaceContext } from "./tool-row";
import { cutAroundLiveAgents,itemFailed,renderable,segmentActivity,tallyParts } from "../model";
import { TranscriptItem } from "./transcript-item";

export function LiveActivity({
  items,
  tasks,
  liveTail = true,
  onOpenAgent,
  onInsert,
  onOpenFile,
  onOpenFileInNewTab,
}: {
  items: JournalItem[];
  tasks: JournalTask[];
  liveTail?: boolean;
  onOpenAgent?: (taskId: string) => void;
} & RowGestures) {
  const segments = segmentActivity(items);
  const tail = liveTail ? segments.length - 1 : -1;
  const open = { ...(onOpenAgent ? { onOpenAgent } : {}), ...(onInsert ? { onInsert } : {}), ...(onOpenFile ? { onOpenFile } : {}), ...(onOpenFileInNewTab ? { onOpenFileInNewTab } : {}) };
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === "row" ? (
          <TranscriptItem key={segment.item.id} item={segment.item} tasks={tasks} {...open} />
        ) : (
          // Keyed by the run's FIRST item so the fold's open state survives
          // rows appending to it, and so a run that just settled keeps the
          // same element when its neighbour opens.
          <ActivityGroup key={segment.items[0]!.id} items={segment.items} tasks={tasks} live={index === tail} {...open} />
        ),
      )}
    </>
  );
}

export function ActivityGroup({
  items,
  live,
  tasks,
  onOpenAgent,
  onInsert,
  onOpenFile,
  onOpenFileInNewTab,
}: {
  items: JournalItem[];
  live: boolean;
  tasks: JournalTask[];
  onOpenAgent?: (taskId: string) => void;
} & RowGestures) {
  const rows = useMemo(() => renderable(items, tasks), [items, tasks]);
  const open = { ...(onOpenAgent ? { onOpenAgent } : {}), ...(onInsert ? { onInsert } : {}), ...(onOpenFile ? { onOpenFile } : {}), ...(onOpenFileInNewTab ? { onOpenFileInNewTab } : {}) };
  if (rows.length === 0) return null;
  if (live) return <LiveRun rows={rows} tasks={tasks} {...open} />;
  const cuts = cutAroundLiveAgents(rows, tasks);
  return (
    <div className="flex w-full min-w-0 flex-col gap-0.5 text-xs">
      {cuts.map((cut) =>
        cut.kind === "agent" ? (
          <TranscriptItem key={cut.item.id} item={cut.item} tasks={tasks} {...open} />
        ) : (
          <SettledRun key={cut.items[0]!.id} rows={cut.items} tasks={tasks} {...open} />
        ),
      )}
    </div>
  );
}

function HarnessConsultRow({ label, items, tasks, ...gestures }: { label: string; items: JournalItem[]; tasks: JournalTask[]; onOpenAgent?: (taskId: string) => void } & RowGestures) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md">
      <button type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)} className={cn(ROW, "text-muted-foreground hover:bg-muted/60")}>
        <BookOpenIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        {items.length > 1 && <span className="shrink-0 text-muted-foreground/60">{items.length} steps</span>}
        <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="ml-3 flex flex-col gap-0.5 border-l border-border/70 py-1 pl-3">
          {items.map((item) => (
            <TranscriptItem key={item.id} item={item} tasks={tasks} {...gestures} />
          ))}
        </div>
      )}
    </div>
  );
}

function TranscriptRows({ rows, tasks, ...gestures }: { rows: readonly JournalItem[]; tasks: JournalTask[]; onOpenAgent?: (taskId: string) => void } & RowGestures) {
  const workspace = useContext(WorkspaceContext);
  const segments = useMemo(() => foldHarnessRows(rows, workspace), [rows, workspace]);
  return (
    <>
      {segments.map((segment) =>
        segment.kind === "consult" ? (
          <HarnessConsultRow key={segment.items[0]!.id} label={segment.label} items={segment.items} tasks={tasks} {...gestures} />
        ) : (
          segment.items.map((item) => <TranscriptItem key={item.id} item={item} tasks={tasks} {...gestures} />)
        ),
      )}
    </>
  );
}

function LiveRun({ rows, tasks, onOpenAgent, onInsert, onOpenFile, onOpenFileInNewTab }: { rows: JournalItem[]; tasks: JournalTask[]; onOpenAgent?: (taskId: string) => void } & RowGestures) {
  const pass = { ...(onOpenAgent ? { onOpenAgent } : {}), ...(onInsert ? { onInsert } : {}), ...(onOpenFile ? { onOpenFile } : {}), ...(onOpenFileInNewTab ? { onOpenFileInNewTab } : {}) };
  return (
    <div className="flex w-full min-w-0 flex-col gap-0.5 text-xs">
      <StepFold
        rows={rows}
        live
        failed={(item) => itemFailed(item, tasks)}
        // A live window says how many steps are behind it and nothing about
        // what they were, so this is never read.
        tally={() => ""}
        renderRows={(shown) => <TranscriptRows rows={shown} tasks={tasks} {...pass} />}
      />
    </div>
  );
}

function SettledRun({ rows, tasks, onOpenAgent, onInsert, onOpenFile, onOpenFileInNewTab }: { rows: JournalItem[]; tasks: JournalTask[]; onOpenAgent?: (taskId: string) => void } & RowGestures) {
  const workspace = useContext(WorkspaceContext);
  const pass = { ...(onOpenAgent ? { onOpenAgent } : {}), ...(onInsert ? { onInsert } : {}), ...(onOpenFile ? { onOpenFile } : {}), ...(onOpenFileInNewTab ? { onOpenFileInNewTab } : {}) };
  return (
    <StepFold
      rows={rows}
      live={false}
      failed={(item) => itemFailed(item, tasks)}
      tally={() => tallyParts(rows, workspace).join(" · ")}
      renderRows={(shown) => <TranscriptRows rows={shown} tasks={tasks} {...pass} />}
    />
  );
}
