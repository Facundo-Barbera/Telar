"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { BotIcon, ChevronRightIcon, TerminalIcon } from "lucide-react";
import type { TaskState } from "@telar/engine-client";
import type { JournalTask } from "@/features/transcript";
import { startReferenceDrag, taskReference } from "@/lib/drag-reference";
import { TranscriptItem } from "@/features/transcript";
import { PanelDivider, PanelEmpty, PanelRow } from "@/components/ui/panel";
import { RelatedConversations, HeldReports } from "@/features/sessions";
import { cn } from "@/lib/utils";
import { isLiveTask, splitRoster, type TaskFocus } from "../folds";

const TaskLog = dynamic(() => import("@/components/session/task-log").then((mod) => mod.TaskLog));

const TASK_STATE: Record<TaskState, string> = {
  pending: "Queued",
  running: "Running",
  waiting: "Waiting",
  completed: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

/** An absent figure is an em dash, never a zero. */
function figure(value: number | undefined): string {
  return value === undefined ? "—" : value.toLocaleString("en-US");
}

type TaskLogSource = { sessionId: string; hostId?: string; visible: boolean };

type TaskListProps = {
  tasks: readonly JournalTask[];
  focused?: TaskFocus;
  sessionId?: string;
  hostId?: string;
  visible?: boolean;
};

/** Opens once at mount when it is the task a chip asked for; a repeat press remounts it through its key. */
function TaskRow({ task, focused, log }: { task: JournalTask; focused?: boolean; log?: TaskLogSource }) {
  const body = task.failure ?? task.resultText;
  const steps = task.items ?? [];
  const logged = log !== undefined && task.kind === "background" && Boolean(task.outputFile);
  const detail = logged || steps.length > 0 || Boolean(body);
  const [open, setOpen] = useState(Boolean(focused));
  const anchor = useRef<HTMLDivElement>(null);
  const tokens = task.usage ? task.usage.tokens.input + task.usage.tokens.output : undefined;
  const RowIcon = task.kind === "background" ? TerminalIcon : BotIcon;

  useEffect(() => {
    if (focused) anchor.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);

  return (
    <div
      ref={anchor}
      draggable
      onDragStart={(event) =>
        startReferenceDrag(event.dataTransfer, taskReference({ id: task.id, ...(task.title ? { title: task.title } : {}), state: task.state }))
      }
    >
      <PanelRow className="p-0 pl-0">
        <button
          type="button"
          className={cn("flex w-full min-w-0 items-center gap-1.5 py-2 pr-3 pl-4 text-left text-xs", detail && "hover:bg-muted/60")}
          disabled={!detail}
          aria-expanded={detail ? open : undefined}
          onClick={() => setOpen((current) => !current)}
        >
          <RowIcon className={cn("size-3.5 shrink-0", task.state === "failed" ? "text-destructive" : "text-muted-foreground")} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{task.title ?? task.role ?? "Sub-agent"}</span>
            {task.role && task.title && <span className="truncate text-3xs text-muted-foreground">{task.role}</span>}
          </span>
          {steps.length > 0 && (
            <span className="shrink-0 text-3xs text-muted-foreground">
              {steps.length} step{steps.length === 1 ? "" : "s"}
            </span>
          )}
          {tokens !== undefined && <span className="shrink-0 font-mono text-3xs text-muted-foreground tabular-nums">{figure(tokens)}</span>}
          <span className={cn("shrink-0 font-mono text-3xs", task.state === "failed" ? "text-destructive" : "text-muted-foreground")}>
            {TASK_STATE[task.state]}
          </span>
          {detail && <ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />}
        </button>
      </PanelRow>
      {open && detail && (
        <div className="flex flex-col gap-0.5 px-4 pb-2 text-xs">
          {logged && log && (
            <Suspense fallback={<div className="h-60 rounded-md border border-border" />}>
              <TaskLog
                sessionId={log.sessionId}
                taskId={task.id}
                {...(log.hostId ? { hostId: log.hostId } : {})}
                live={isLiveTask(task)}
                visible={log.visible}
              />
            </Suspense>
          )}
          {steps.map((item) => (
            <TranscriptItem key={item.id} item={item} />
          ))}
          {body && (
            <p className={cn("pt-1 text-2xs whitespace-pre-wrap", task.failure ? "text-destructive" : "text-muted-foreground")}>{body}</p>
          )}
        </div>
      )}
    </div>
  );
}

function TaskList({ tasks, focused, log }: { tasks: readonly JournalTask[]; focused?: TaskFocus; log?: TaskLogSource }) {
  const live = tasks.filter(isLiveTask);
  const finished = tasks.filter((task) => !isLiveTask(task));
  const row = (task: JournalTask) =>
    focused?.id === task.id ? (
      <TaskRow key={`${task.id}:${focused.nonce}`} task={task} focused {...(log ? { log } : {})} />
    ) : (
      <TaskRow key={task.id} task={task} {...(log ? { log } : {})} />
    );
  return (
    <>
      {live.map(row)}
      {finished.length > 0 && live.length > 0 && <PanelDivider label={`done · ${finished.length}`} />}
      {finished.map(row)}
    </>
  );
}

/** Sub-agents on top; the conversations working for this one below, apart, because they are peers rather than sub-agents. */
export function AgentsSurface({ tasks, focused, sessionId, hostId, visible = true }: TaskListProps) {
  const { agents } = useMemo(() => splitRoster(tasks), [tasks]);
  const related = (
    <>
      <HeldReports {...(sessionId ? { sessionId } : {})} {...(hostId ? { hostId } : {})} visible={visible} />
      <RelatedConversations {...(sessionId ? { sessionId } : {})} {...(hostId ? { hostId } : {})} visible={visible} />
    </>
  );
  return (
    <div className="flex flex-col">
      {agents.length === 0 ? (
        <PanelEmpty icon={<BotIcon />} title="Sub-agents appear here as they work">
          Background work lives on the Processes tab.
        </PanelEmpty>
      ) : (
        <TaskList tasks={agents} {...(focused ? { focused } : {})} />
      )}
      {related}
    </div>
  );
}

export function ProcessesSurface({ tasks, focused, sessionId, hostId, visible = true }: TaskListProps) {
  const { processes } = useMemo(() => splitRoster(tasks), [tasks]);
  const log = sessionId ? { sessionId, ...(hostId ? { hostId } : {}), visible } : undefined;
  if (processes.length === 0) {
    return (
      <PanelEmpty icon={<TerminalIcon />} title="Background work appears here">
        Anything the agent leaves running. Codex sessions never file anything here: that provider reports every child as an agent.
      </PanelEmpty>
    );
  }
  return (
    <div className="flex flex-col">
      <TaskList tasks={processes} {...(focused ? { focused } : {})} {...(log ? { log } : {})} />
    </div>
  );
}
