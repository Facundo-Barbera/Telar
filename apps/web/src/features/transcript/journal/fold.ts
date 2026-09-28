import { pluginJournalRow } from "@/lib/plugins/journal";
import type { EngineEvent, Item, Task, Turn } from "@telar/engine-client";
import { inStartOrder } from "./arrivals";
import { pickPrefix } from "./items";
import type { JournalItem, JournalTask, JournalTurn } from "./types";

// Items sort by the event id that opened them, never by timestamp: two events can share a millisecond.
const TERMINAL_EVENTS: ReadonlySet<EngineEvent["type"]> = new Set([
  "turn.completed",
  "turn.failed",
  "turn.stopped",
  "turn.ambiguous",
  "turn.discarded",
  "turn.steered",
]);

type Tabs = readonly { url: string; title: string }[];

type Fold = {
  byRun: Map<string, JournalTurn>;
  seenItems: Map<string, JournalItem>;
  seenTasks: Map<string, JournalTask>;
  lastBrowserTabs: Map<string, Tabs>;
  previousTabs: ReadonlyMap<number, Tabs | undefined> | undefined;
};

/** A turn as the fold holds it. `accepted` is the event's lighter copy: nothing has run yet. */
function journalTurn(turn: Turn, accepted = false): JournalTurn {
  const reason = turn.providerReason;
  return {
    runId: turn.runId,
    prompt: turn.input,
    ...(turn.kind ? { kind: turn.kind } : {}),
    ...(turn.origin ? { origin: turn.origin } : {}),
    ...(turn.restartOrigin ? { restartOrigin: turn.restartOrigin } : {}),
    ...(reason?.kind === "background_task"
      ? { decidedForBackgroundWork: true, ...(reason.taskId ? { askedBy: reason.taskId } : {}) }
      : reason?.taskId
        ? { wokenBy: reason.taskId }
        : {}),
    ...(turn.wakeReason ? { wakeReason: turn.wakeReason } : {}),
    ...(turn.sender ? { sender: turn.sender } : {}),
    ...(turn.agentDelivery ? { agentDelivery: turn.agentDelivery } : {}),
    ...(turn.agentIntent ? { agentIntent: turn.agentIntent } : {}),
    ...(turn.agentNotice ? { agentNotice: turn.agentNotice } : {}),
    ...(turn.notification ? { notification: turn.notification } : {}),
    ...(turn.assignmentScope ? { assignmentScope: turn.assignmentScope } : {}),
    ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
    state: turn.state,
    ...(turn.held ? { held: true, heldReason: turn.held.reason } : {}),
    items: [],
    tasks: [],
    acceptedAt: turn.acceptedAt,
    ...(!accepted && turn.startedAt ? { startedAt: turn.startedAt } : {}),
    ...(turn.completedAt ? { endedAt: turn.completedAt } : {}),
    resultText: accepted ? "" : (turn.resultText ?? ""),
    ...(accepted ? {} : snapshotOutcome(turn)),
  };
}

function snapshotOutcome(turn: Turn): Partial<JournalTurn> {
  return {
    ...(turn.failure ? { failure: turn.failure.message, failureCode: turn.failure.code } : {}),
    ...(turn.failure?.resumeAt === undefined ? {} : { resumeAt: turn.failure.resumeAt }),
    ...(turn.failure?.limitType ? { limitType: turn.failure.limitType } : {}),
    ...(turn.resumedAfterRateLimit === undefined ? {} : { resumedAfterRateLimit: turn.resumedAfterRateLimit }),
    ...(turn.usage ? { usage: turn.usage } : {}),
  };
}

function upsertTask(fold: Fold, task: Task): void {
  const turn = fold.byRun.get(task.runId);
  if (!turn) return;
  // Every task event repeats the whole task; keep the items already collected.
  const merged: JournalTask = { ...task, items: fold.seenTasks.get(task.id)?.items ?? [] };
  fold.seenTasks.set(task.id, merged);
  const index = turn.tasks.findIndex((candidate) => candidate.id === task.id);
  if (index === -1) turn.tasks.push(merged);
  else turn.tasks[index] = merged;
}

function upsertItem(fold: Fold, item: Item, openedBy: number): void {
  const turn = fold.byRun.get(item.runId);
  if (!turn) return;
  const existing = fold.seenItems.get(item.id);
  // A snapshot's `streamed` is a prefix; the longest wins, with its watermark, so deltas past it append.
  const merged: JournalItem = { ...item, ...pickPrefix(existing, item), openedBy: existing?.openedBy ?? openedBy };
  fold.seenItems.set(item.id, merged);
  // A row whose task has not been seen yet stays on the main timeline; the next snapshot repairs it.
  const owner = item.taskId ? fold.seenTasks.get(item.taskId) : undefined;
  const list = owner ? owner.items : turn.items;
  const index = list.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) list.push(merged);
  else list[index] = merged;
}

/** Turn lifecycle events. Returns false for any other event type. */
function applyTurnEvent(turn: JournalTurn | undefined, event: EngineEvent): boolean {
  switch (event.type) {
    case "turn.claimed":
    case "turn.steering":
    case "turn.steered":
    case "turn.stopped":
    case "turn.ambiguous":
    case "turn.discarded":
      if (turn) turn.state = event.type.slice("turn.".length) as JournalTurn["state"];
      return true;
    case "turn.started":
      if (turn) {
        turn.state = "running";
        turn.startedAt = turn.startedAt ?? event.at;
      }
      return true;
    case "turn.requeued":
      if (turn) {
        turn.state = "queued";
        if (event.reason === "rate_limit_reset") turn.resumedAfterRateLimit = event.at;
      }
      return true;
    case "turn.released":
      // Not a state change: the turn was queued before and after.
      if (turn) {
        turn.held = false;
        delete turn.heldReason;
      }
      return true;
    case "turn.completed":
      if (turn) {
        turn.state = "completed";
        turn.resultText = event.resultText;
        if (event.usage) turn.usage = event.usage;
      }
      return true;
    case "turn.failed":
      if (turn) {
        turn.state = "failed";
        turn.failure = event.message;
        turn.failureCode = event.code;
        if (event.resumeAt !== undefined) turn.resumeAt = event.resumeAt;
        if (event.limitType) turn.limitType = event.limitType;
      }
      return true;
    default:
      return false;
  }
}

function noticeRow(id: string, event: EngineEvent & { sessionId: string }, label: string): JournalItem {
  return {
    id,
    runId: event.runId!,
    sessionId: event.sessionId,
    status: "completed",
    startedAt: event.at,
    completedAt: event.at,
    detail: { type: "unknown", label },
    streamedText: "",
    openedBy: event.id,
  };
}

/** An agent opening or closing a tab is one quiet line. Diffed by count and url: desktop tab ids are positional. */
function tabRow(fold: Fold, turn: JournalTurn, event: Extract<EngineEvent, { type: "browser.state.changed" }>): void {
  const previous = fold.previousTabs ? fold.previousTabs.get(event.id) : fold.lastBrowserTabs.get(event.sessionId);
  const current = event.tabs;
  if (previous && current.length !== previous.length) {
    const grew = current.length > previous.length;
    const known = new Set((grew ? previous : current).map((tab) => tab.url));
    const changed = (grew ? current : previous).find((tab) => !known.has(tab.url));
    const name = changed?.title || changed?.url ? ` — ${changed.title || changed.url}` : "";
    turn.items.push(noticeRow(`tabs_${event.id}`, event, `${grew ? "Opened" : "Closed"} a tab${name}`));
  }
  fold.lastBrowserTabs.set(event.sessionId, current);
}

function applyEvent(fold: Fold, event: EngineEvent): void {
  const turn = event.runId ? fold.byRun.get(event.runId) : undefined;
  // Any event on the turn is activity: a streaming row's timestamps do not move.
  if (turn) turn.lastActivityAt = Math.max(turn.lastActivityAt ?? 0, event.at);
  if (turn && TERMINAL_EVENTS.has(event.type)) turn.endedAt = event.at;
  if (turn && event.type === "turn.requeued") delete turn.endedAt;
  if (applyTurnEvent(turn, event)) return;

  switch (event.type) {
    case "turn.accepted":
      if (!fold.byRun.has(event.turn.runId)) fold.byRun.set(event.turn.runId, journalTurn(event.turn, true));
      return;
    case "item.started":
    case "item.updated":
    case "item.completed":
      return upsertItem(fold, event.item, event.id);
    case "content.delta": {
      // A delta for an unseen row is dropped, not buffered; the next snapshot repairs it.
      const item = fold.seenItems.get(event.itemId);
      // Already in the snapshot's prefix, which the tail overlaps.
      if (!item || (item.streamedThrough !== undefined && event.id <= item.streamedThrough)) return;
      item.streamedText += event.text;
      return;
    }
    case "task.started":
    case "task.progress":
    case "task.completed":
      return upsertTask(fold, event.task);
    case "usage.updated":
      if (turn) turn.usage = event.usage;
      return;
    case "browser.state.changed":
      if (turn) tabRow(fold, turn, event);
      return;
    case "browser.control.changed":
      // Only a human touch that interrupted the agent explains anything worth a row.
      if (turn && event.controller === "human" && event.interrupted) turn.items.push(noticeRow(`control_${event.id}`, event, "You interacted with the browser"));
      return;
    default: {
      // A plugin's event draws the row its plugin registered; other families are not rendered yet.
      const pluginRow = turn ? pluginJournalRow(event) : undefined;
      if (turn && pluginRow) turn.items.push(pluginRow);
    }
  }
}

/**
 * Folds turns, the snapshot's items and the event tail into a transcript. The snapshot comes first so a long session
 * opens without replay; the tail second corrects rows the snapshot caught mid-flight. `previousTabs` is the only
 * cross-turn state, handed in by the projector when it folds one turn at a time.
 */
export function projectJournal(
  turns: Turn[],
  items: Item[],
  events: EngineEvent[],
  tasks: Task[] = [],
  previousTabs?: ReadonlyMap<number, Tabs | undefined>,
): JournalTurn[] {
  const fold: Fold = {
    byRun: new Map(turns.map((turn) => [turn.runId, journalTurn(turn)])),
    seenItems: new Map(),
    seenTasks: new Map(),
    lastBrowserTabs: new Map(),
    previousTabs,
  };
  // Tasks before items, so a sub-agent's rows find their owner on the first pass.
  for (const task of tasks) upsertTask(fold, task);
  for (const item of items) upsertItem(fold, item, 0);
  // Seed the quiet clock, so a page opened onto a running turn does not claim silence since it began.
  for (const turn of fold.byRun.values()) {
    const latest = Math.max(turn.startedAt ?? 0, ...turn.items.map((item) => item.completedAt ?? item.startedAt), ...turn.tasks.map((task) => task.updatedAt));
    if (latest > 0) turn.lastActivityAt = latest;
  }
  for (const event of events) applyEvent(fold, event);

  const byOpen = (left: JournalItem, right: JournalItem) => left.openedBy - right.openedBy || left.startedAt - right.startedAt;
  for (const turn of fold.byRun.values()) {
    turn.items.sort(byOpen);
    for (const task of turn.tasks) task.items.sort(byOpen);
    turn.tasks.sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
  }
  return inStartOrder([...fold.byRun.values()]);
}
