import {
BotIcon
} from "lucide-react";
import { type Item } from "@telar/engine-client";
import { itemLabel, itemText, type JournalItem, type JournalTask, type JournalTurn } from "@/platform/engine";
import { notificationHead, notificationVerbs, quotedMessage, type NotificationSubject } from "./notifications";
import { CONSULT_TALLY_LABEL, harnessConsult } from "./harness-paths";
import { toolInputSummary } from "./tool-input-summary";
import { rowPath } from "./components/tool-row";

/** The verb a row leads with. Past tense: the transcript is a record. */
export function actionLabel(item: JournalItem): string {
  switch (item.detail.type) {
    case "command_execution":
      return "Ran command";
    case "file_read":
      return "Read file";
    case "file_change":
      return item.detail.change.kind === "create"
        ? "Created file"
        : item.detail.change.kind === "delete"
          ? "Deleted file"
          : "Edited file";
    case "web_search":
      return "Searched web";
    case "browser_action":
      return "Browsed";
    case "assistant_message":
      return "Said";
    default:
      return itemLabel(item);
  }
}

/** The verb a RUNNING row leads with. Present tense: it has not happened yet. */
export function liveActionLabel(item: JournalItem): string {
  switch (item.detail.type) {
    case "command_execution":
      return "Running command";
    case "file_read":
      return "Reading file";
    case "file_change":
      return item.detail.change.kind === "create"
        ? "Creating file"
        : item.detail.change.kind === "delete"
          ? "Deleting file"
          : "Editing file";
    case "web_search":
      return "Searching web";
    case "browser_action":
      return "Browsing";
    default:
      return actionLabel(item);
  }
}

export function preview(item: JournalItem): string {
  const raw =
    item.detail.type === "command_execution"
      ? item.detail.command.command
      : item.detail.type === "file_read" || item.detail.type === "file_change"
        ? (rowPath(item) ?? "")
        : item.detail.type === "web_search"
            ? item.detail.query
            : item.detail.type === "mcp_tool_call" || item.detail.type === "dynamic_tool_call" || item.detail.type === "browser_action"
              ? toolInputSummary(item.detail.call.input) ?? ""
              : itemLabel(item);
  const flat = raw.replace(/\s+/g, " ").trim();
  const points = Array.from(flat);
  return points.length > 80 ? `${points.slice(0, 80).join("")}…` : flat;
}

export const failed = (item: JournalItem) => item.status === "failed";

export const running = (item: JournalItem) => item.status === "inProgress";

/** The provider's size estimate for a thought, when it gave one. */
export function reasoningTokens(item: JournalItem): number | undefined {
  return item.detail.type === "reasoning" ? item.detail.estimatedTokens : undefined;
}

export function reasoningPaints(item: JournalItem): boolean {
  return itemText(item).trim().length > 0 || running(item) || reasoningTokens(item) !== undefined;
}

export function notificationLabel(
  detail: NotificationSubject & { body?: string },
  /** The peer's message as sent, when the surface has it: the turn's own `prompt`. */
  message?: string,
): { verb: string; Icon: typeof BotIcon; head?: string } {
  const { verb } = notificationVerbs(detail);
  const said = message ?? (detail.body ? quotedMessage(detail.body) : undefined);
  const head = detail.kind === "peer_message" && said ? notificationHead(said) : undefined;
  return { verb, Icon: BotIcon, ...(head ? { head } : {}) };
}

/** `Ran command ×12 · Read file ×2`, in FIRST-APPEARANCE order — that preserves
 *  the shape of the turn: what the agent reached for first stays first.
 *
 *  A ROW THE LIST FOLDED IS TALLIED AS WHAT THE FOLD CALLS IT. Otherwise the
 *  summary re-states the noise the fold just removed — "Read file ×3 · Ran
 *  command" over a line that says the harness consulted a skill (#354). */
export function tallyParts(items: readonly JournalItem[], workspace?: string): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const action = harnessConsult(item, workspace)
      ? CONSULT_TALLY_LABEL
      : item.detail.type === "reasoning"
        ? "Thought"
        : item.detail.type === "task"
          ? "Ran agent"
          : actionLabel(item);
    const label = /^Reconnecting(?:\.{3}|…)\s*\d+\/\d+$/i.test(action.trim()) ? "Reconnect attempt" : action;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => (count > 1 ? `${label} ×${count}` : label));
}

export function renderable(items: JournalItem[], tasks: readonly JournalTask[] = []): JournalItem[] {
  return items.filter((item) => {
    if (item.detail.type === "task") {
      const taskId = item.detail.taskId;
      const task = tasks.find((candidate) => candidate.id === taskId);
      return !task || transcriptTasks([task]).length > 0;
    }
    return item.detail.type === "reasoning" ? reasoningPaints(item) : true;
  });
}

/** A spawn row never folds while its agent is still out, and an artifact never folds. */
export function cutAroundStandingRows(items: JournalItem[], tasks: readonly JournalTask[]): Array<{ kind: "run"; items: JournalItem[] } | { kind: "row"; item: JournalItem }> {
  const out: Array<{ kind: "run"; items: JournalItem[] } | { kind: "row"; item: JournalItem }> = [];
  for (const item of items) {
    const taskId = item.detail.type === "task" ? item.detail.taskId : undefined;
    const task = taskId ? tasks.find((candidate) => candidate.id === taskId) : undefined;
    const liveAgent = task !== undefined && (task.state === "running" || task.state === "pending" || task.state === "waiting");
    if (liveAgent || item.detail.type === "artifact") {
      out.push({ kind: "row", item });
      continue;
    }
    const last = out.at(-1);
    if (last?.kind === "run") last.items.push(item);
    else out.push({ kind: "run", items: [item] });
  }
  return out;
}

/** The tasks the conversation shows, which is not every task in the turn. */
export function transcriptTasks(tasks: readonly JournalTask[]): JournalTask[] {
  return tasks.filter((task) => task.kind !== "background");
}

export type ActivitySegment = { kind: "run"; items: JournalItem[] } | { kind: "row"; item: JournalItem };

const SEAM = new Set<Item["detail"]["type"]>(["assistant_message", "user_message", "notification", "plan", "context_compaction", "provider_wait", "conversation_import", "artifact"]);

export type TurnResponse = { boundary?: JournalItem; items: JournalItem[] };

/** One arrival, one row: the notification that opened a turn is not drawn again inside it. */
export function withoutOpeningNotification(turn: Pick<JournalTurn, "runId" | "origin" | "items" | "notification">): readonly JournalItem[] {
  if (!turn.notification || (turn.origin !== "session" && turn.origin !== "provider")) return turn.items;
  const drawn = `notification_${turn.runId}`;
  return turn.items.filter((item) => item.id !== drawn);
}

/** A turn that is nothing but an arrival. */
export function bareNotificationTurn(turn: JournalTurn): boolean {
  if (!turn.notification) return false;
  if (withoutOpeningNotification(turn).length > 0) return false;
  if (turn.resultText || turn.failure || turn.usage) return false;
  if (turn.resumedAfterRateLimit !== undefined) return false;
  return turn.state !== "failed" && turn.state !== "stopped" && turn.state !== "discarded";
}

/** Consecutive arrivals render as one strip. */
export function groupNotificationTurns(turns: readonly JournalTurn[], activeRunId?: string): readonly (readonly JournalTurn[])[] {
  const groups: JournalTurn[][] = [];
  for (const turn of turns) {
    const open = groups.at(-1);
    const previous = open?.at(-1);
    const joins = open && previous && turn.notification && bareNotificationTurn(previous) && previous.runId !== activeRunId;
    if (joins) open.push(turn);
    else groups.push([turn]);
  }
  return groups;
}

/** Cuts a turn into responses at its message boundaries; a steer starts a new response. */
export function splitAtMessageBoundaries(items: readonly JournalItem[]): TurnResponse[] {
  const responses: TurnResponse[] = [{ items: [] }];
  for (const item of items) {
    if (item.detail.type === "user_message" || item.detail.type === "notification") responses.push({ boundary: item, items: [] });
    else responses.at(-1)!.items.push(item);
  }
  // A turn whose only message is its own prompt is one response, and renders
  // exactly as it always did.
  return responses.length > 1 && responses[0]!.items.length === 0 ? responses.slice(1) : responses;
}

export function segmentActivity(items: readonly JournalItem[]): ActivitySegment[] {
  const segments: ActivitySegment[] = [];
  for (const item of items) {
    if (SEAM.has(item.detail.type)) {
      segments.push({ kind: "row", item });
      continue;
    }
    const last = segments.at(-1);
    if (last?.kind === "run") last.items.push(item);
    else segments.push({ kind: "run", items: [item] });
  }
  return segments;
}

export function itemFailed(item: JournalItem, tasks: readonly JournalTask[]): boolean {
  return (
    failed(item) ||
    (item.detail.type === "task" && tasks.find((task) => task.id === (item.detail as { taskId: string }).taskId)?.state === "failed")
  );
}

/** How many rows actually failed, not whether any did. */
export function failedCount(rows: readonly JournalItem[], tasks: readonly JournalTask[]): number {
  return rows.filter((item) => itemFailed(item, tasks)).length;
}

export function turnActivity(turn: Pick<JournalTurn, "items" | "tasks">): { label: string; delegated: boolean } {
  // A compaction outranks everything: while it runs the provider is not
  // working on the task, it is squeezing its memory, and "Thinking" over a
  // long silence is exactly the read this line exists to prevent.
  if (turn.items.some((item) => item.detail?.type === "context_compaction" && item.status === "inProgress")) {
    return { label: "Compacting context", delegated: false };
  }
  const live = turn.tasks.filter((task) => task.state === "running" || task.state === "pending" || task.state === "waiting");
  const agents = live.filter((task) => task.kind !== "background").length;
  if (agents > 0) return { label: `${agents} sub-agent${agents === 1 ? "" : "s"} working`, delegated: true };
  // Background work does not speak for the turn: a watch loop running does not
  // mean the main loop is doing anything, and it outlives the turn anyway.
  if (turn.items.some((item) => item.status === "inProgress")) return { label: "Working", delegated: false };
  return { label: "Thinking", delegated: false };
}
