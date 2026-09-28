import { pickPrefix } from "@/platform/engine/journal-items";
import { pluginJournalRow } from "@/platform/engine/plugin-journal";
import type { EngineEvent, Item, RateLimitType, Task, Turn, TurnAttachment, TurnFailureCode, TurnState, UsageSnapshot } from "@telar/engine-client";

// The client-side fold over the journal. Items sort by the event id that opened them, never by
// timestamp: two events can share a millisecond, and the id is monotonic per session.

export type JournalItem = Item & {
  /** Deltas accumulated in arrival order. Empty for items that never stream. */
  streamedText: string;
  /** A figure the kernel drew during this turn — the attachment behind it.
   *  Set only on the synthetic `unknown` rows the plot fold produces. */
  plotAttachmentId?: string;
  /** The event id that opened this item — the sort key, not a display value. */
  openedBy: number;
};

/** A sub-agent, with the rows it produced. */
export type JournalTask = Task & { items: JournalItem[] };

export type JournalTurn = {
  runId: string;
  prompt: string;
  /** `compact` is the compaction gesture; `import` an adopted conversation's history. Neither was typed. */
  kind?: "message" | "compact" | "import";
  /** Who started the turn: anything but `user` is drawn as a wake-up line, not a bubble. */
  origin?: "user" | "provider" | "session" | "schedule" | "restart";
  /** Present only on `origin: "restart"`; see `Turn.restartOrigin`. */
  restartOrigin?: Turn["restartOrigin"];
  /** For a provider turn: the row whose ending woke it, when known. */
  wokenBy?: string;
  /** For a turn opened so a live task's tool call could be decided: the row that asked. Nothing woke the model. */
  askedBy?: string;
  /** That turn exists for the claim, not for a reply. True even when the
   *  asking task could not be named. */
  decidedForBackgroundWork?: boolean;
  /** For a session turn: what the other session did, and which one. */
  wakeReason?: Turn["wakeReason"];
  /** For a session turn an AGENT sent directly (`sessions_send`): who. Drawn
   *  as an agent's bubble, never as the person's — the words are a peer's. */
  sender?: Turn["sender"];
  agentDelivery?: Turn["agentDelivery"];
  /** `task` renders as a full message; a report stays collapsed. */
  agentIntent?: Turn["agentIntent"];
  /** The engine's one-line announcement of that message — the collapsed row's
   *  label, and what the recipient's model was handed instead of `prompt`. */
  agentNotice?: Turn["agentNotice"];
  /** A peer's message, a wake or a parked request: drawn as a notification row. */
  notification?: Turn["notification"];
  /** What the sender said the task covers. Descriptive; confers nothing. */
  assignmentScope?: Turn["assignmentScope"];
  /** Files sent with this message. */
  attachments?: TurnAttachment[];
  state: TurnState;
  /** Queued but waiting for a human to re-read it, so no worker may take it. Not a state. */
  held?: boolean;
  /** WHY it is held: a restart's re-read, or the session being paused. The
   *  transcript offers different verbs for the two. */
  heldReason?: NonNullable<Turn["held"]>["reason"];
  /** The main loop's timeline only: a sub-agent's rows are on `tasks`, so concurrent agents don't interleave. */
  items: JournalItem[];
  /** Sub-agents and background work launched by this turn. */
  tasks: JournalTask[];
  /** When the engine took the message — for a passive arrival, WHEN it
   *  arrived, which is what places it inside the turn that was running. */
  acceptedAt?: number;
  /** When the provider actually started, for the live elapsed clock. Absent
   *  until the turn is claimed and running. */
  startedAt?: number;
  /** When the turn reached a terminal state, however it got there. */
  endedAt?: number;
  /** When anything last happened on this turn, deltas included: what "gone quiet" is measured from. */
  lastActivityAt?: number;
  /** The assistant's final text, as the engine recorded it on completion. */
  resultText: string;
  failure?: string;
  /** Which kind of failure: `rate_limited` is a wait with a known end, not a fault. */
  failureCode?: TurnFailureCode;
  /** `rate_limited`: when the limit lifts, in MILLISECONDS. The engine converted
   *  it from the provider's seconds — see `TurnFailure.resumeAt`. */
  resumeAt?: number;
  /** `rate_limited`: which limit, so the row can name it. */
  limitType?: RateLimitType;
  /** The engine brought this turn back after a limit lifted. Kept even though
   *  the turn is `queued` again, so scrolling back shows the session sat one
   *  out rather than an unexplained gap. */
  resumedAfterRateLimit?: number;
  usage?: UsageSnapshot;
};

// Every sub-agent the session knows, the journal's copy first since it has applied every event.
// The snapshot is merged in: a background task outlives its turn, which the fold may never have seen.
export function taskRoster(snapshot: readonly Task[], journal: readonly JournalTask[]): JournalTask[] {
  const known = new Set(journal.map((task) => task.id));
  return [...journal, ...snapshot.filter((task) => !known.has(task.id)).map((task) => ({ ...task, items: [] }))];
}

const TERMINAL_EVENTS: ReadonlySet<EngineEvent["type"]> = new Set([
  "turn.completed",
  "turn.failed",
  "turn.stopped",
  "turn.ambiguous",
  "turn.discarded",
  "turn.steered",
]);

/** Merges a cursor page without duplicating durable journal records. */
export function appendJournalEvents(existing: EngineEvent[], incoming: EngineEvent[]): EngineEvent[] {
  const events = new Map(existing.map((event) => [event.id, event]));
  for (const event of incoming) events.set(event.id, event);
  return [...events.values()].sort((left, right) => left.id - right.id);
}

export function journalCursor(events: EngineEvent[]): number {
  return events.reduce((cursor, event) => Math.max(cursor, event.id), 0);
}

function journalTurn(turn: Turn): JournalTurn {
  return {
    runId: turn.runId,
    prompt: turn.input,
    ...(turn.kind ? { kind: turn.kind } : {}),
    ...(turn.origin ? { origin: turn.origin } : {}),
    ...(turn.restartOrigin ? { restartOrigin: turn.restartOrigin } : {}),
    ...(turn.providerReason?.kind === "background_task"
      ? { decidedForBackgroundWork: true, ...(turn.providerReason.taskId ? { askedBy: turn.providerReason.taskId } : {}) }
      : turn.providerReason?.taskId
        ? { wokenBy: turn.providerReason.taskId }
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
    ...(turn.startedAt ? { startedAt: turn.startedAt } : {}),
    ...(turn.completedAt ? { endedAt: turn.completedAt } : {}),
    resultText: turn.resultText ?? "",
    ...(turn.failure ? { failure: turn.failure.message, failureCode: turn.failure.code } : {}),
    ...(turn.failure?.resumeAt === undefined ? {} : { resumeAt: turn.failure.resumeAt }),
    ...(turn.failure?.limitType ? { limitType: turn.failure.limitType } : {}),
    ...(turn.resumedAfterRateLimit === undefined ? {} : { resumedAfterRateLimit: turn.resumedAfterRateLimit }),
    ...(turn.usage ? { usage: turn.usage } : {}),
  };
}

type Tabs = readonly { url: string; title: string }[];

type Fold = {
  byRun: Map<string, JournalTurn>;
  seenItems: Map<string, JournalItem>;
  seenTasks: Map<string, JournalTask>;
  previousTabs?: ReadonlyMap<number, Tabs | undefined>;
  /** The last journalled tab set per session, for the quiet open/close rows. */
  lastBrowserTabs: Map<string, { url: string; title: string }[]>;
};

function upsertTask(fold: Fold, task: Task): void {
  const turn = fold.byRun.get(task.runId);
  if (!turn) return;
  // Every task event repeats the whole task; the items already collected survive it.
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
  // The snapshot's `streamed` is a prefix that deltas above its watermark append to; without the seed
  // a remount would lose everything streamed before it.
  const merged: JournalItem = { ...item, ...pickPrefix(existing, item), openedBy: existing?.openedBy ?? openedBy };
  fold.seenItems.set(item.id, merged);
  // A row under a task not met yet stays on the main timeline; the next snapshot repairs the placement.
  const owner = item.taskId ? fold.seenTasks.get(item.taskId) : undefined;
  const list = owner ? owner.items : turn.items;
  const index = list.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) list.push(merged);
  else list[index] = merged;
}

function noticeRow(id: string, event: EngineEvent, label: string): JournalItem {
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

/** Applies a `turn.*` event. False when the event is not one. */
function applyTurnEvent(fold: Fold, turn: JournalTurn | undefined, event: EngineEvent): boolean {
  switch (event.type) {
    case "turn.accepted":
      if (!fold.byRun.has(event.turn.runId)) fold.byRun.set(event.turn.runId, journalTurn(event.turn));
      return true;
    case "turn.claimed":
      if (turn) turn.state = "claimed";
      return true;
    case "turn.started":
      if (turn) { turn.state = "running"; turn.startedAt = turn.startedAt ?? event.at; }
      return true;
    case "turn.requeued":
      if (turn) {
        turn.state = "queued";
        if (event.reason === "rate_limit_reset") turn.resumedAfterRateLimit = event.at;
      }
      return true;
    // The hold came off: not a state change, only the flag.
    case "turn.released":
      if (turn) {
        turn.held = false;
        delete turn.heldReason;
      }
      return true;
    // A steered turn is terminal: its words render inside the run they joined.
    case "turn.steering":
      if (turn) turn.state = "steering";
      return true;
    case "turn.steered":
      if (turn) turn.state = "steered";
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
    case "turn.stopped":
      if (turn) turn.state = "stopped";
      return true;
    case "turn.ambiguous":
      if (turn) turn.state = "ambiguous";
      return true;
    case "turn.discarded":
      if (turn) turn.state = "discarded";
      return true;
    default:
      return false;
  }
}

// One quiet row per agent tab open or close. Diffed by count with a url lookup: desktop tab ids are
// positional. Only agent-driven changes carry a runId, so the turn guard is the filter.
function applyTabs(fold: Fold, turn: JournalTurn, event: Extract<EngineEvent, { type: "browser.state.changed" }>): void {
  const previous = fold.previousTabs ? fold.previousTabs.get(event.id) : fold.lastBrowserTabs.get(event.sessionId);
  const current = event.tabs;
  if (previous && current.length !== previous.length) {
    const grew = current.length > previous.length;
    const known = new Set((grew ? previous : current).map((tab) => tab.url));
    const changed = (grew ? current : previous).find((tab) => !known.has(tab.url));
    const name = changed?.title || changed?.url ? ` — ${changed.title || changed.url}` : "";
    turn.items.push(noticeRow(`tabs_${event.id}`, event, grew ? `Opened a tab${name}` : `Closed a tab${name}`));
  }
  fold.lastBrowserTabs.set(event.sessionId, current);
}

function applyRowEvent(fold: Fold, turn: JournalTurn | undefined, event: EngineEvent): void {
  switch (event.type) {
    case "item.started":
    case "item.updated":
    case "item.completed":
      upsertItem(fold, event.item, event.id);
      return;
    case "content.delta": {
      // A delta for an unseen item is dropped, not buffered; the next snapshot repairs it.
      const item = fold.seenItems.get(event.itemId);
      // At or below `streamedThrough` the text is already in the snapshot's prefix.
      if (!item || (item.streamedThrough !== undefined && event.id <= item.streamedThrough)) return;
      item.streamedText += event.text;
      return;
    }
    case "task.started":
    case "task.progress":
    case "task.completed":
      upsertTask(fold, event.task);
      return;
    case "usage.updated":
      if (turn) turn.usage = event.usage;
      return;
    case "browser.state.changed":
      if (turn) applyTabs(fold, turn, event);
      return;
    // Only the human's input that interrupted the agent on that tab is a row, inside the turn it touched.
    case "browser.control.changed":
      if (turn && event.controller === "human" && event.interrupted) {
        turn.items.push(noticeRow(`control_${event.id}`, event, "You interacted with the browser"));
      }
      return;
    default: {
      // A plugin's event draws the row its plugin registered; other families are not rendered yet.
      const pluginRow = turn ? pluginJournalRow(event) : undefined;
      if (turn && pluginRow) turn.items.push(pluginRow);
    }
  }
}

/**
 * Fold turns, the engine's item projection and the event tail into a transcript. The snapshot makes
 * opening cheap; the tail, applied second, streams and corrects rows the snapshot caught mid-flight.
 * `previousTabs` is the tab set before each browser event, when a per-run caller worked it out.
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
    ...(previousTabs ? { previousTabs } : {}),
    lastBrowserTabs: new Map(),
  };
  // Tasks before items, so a snapshot's sub-agent rows find their owner. Id 0 sorts before the tail.
  for (const task of tasks) upsertTask(fold, task);
  for (const item of items) upsertItem(fold, item, 0);
  // The quiet clock, seeded so a page opened onto a running turn does not call it silent since start.
  for (const turn of fold.byRun.values()) {
    const latest = Math.max(
      turn.startedAt ?? 0,
      ...turn.items.map((item) => item.completedAt ?? item.startedAt),
      ...turn.tasks.map((task) => task.updatedAt),
    );
    if (latest > 0) turn.lastActivityAt = latest;
  }

  for (const event of events) {
    const turn = event.runId ? fold.byRun.get(event.runId) : undefined;
    if (turn) turn.lastActivityAt = Math.max(turn.lastActivityAt ?? 0, event.at);
    if (turn && TERMINAL_EVENTS.has(event.type)) turn.endedAt = event.at;
    // A turn a lifted limit brought back is not over after all.
    if (turn && event.type === "turn.requeued") delete turn.endedAt;
    if (!applyTurnEvent(fold, turn, event)) applyRowEvent(fold, turn, event);
  }

  const byOpen = (left: JournalItem, right: JournalItem) =>
    left.openedBy - right.openedBy || left.startedAt - right.startedAt;
  for (const turn of fold.byRun.values()) {
    turn.items.sort(byOpen);
    for (const task of turn.tasks) task.items.sort(byOpen);
    turn.tasks.sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
  }
  return inStartOrder([...fold.byRun.values()]);
}

// A turn with no start that is not waiting (a passive arrival) sits where it was accepted.
const startKey = (turn: JournalTurn) =>
  turn.startedAt ?? (turn.state === "queued" || turn.state === "claimed" ? Infinity : (turn.acceptedAt ?? Infinity));

/** Turns in the order they started, the waiting ones last. Stable, so ties keep sequence order. */
export function inStartOrder(turns: JournalTurn[]): JournalTurn[] {
  return turns.sort((left, right) => {
    const a = startKey(left);
    const b = startKey(right);
    return a === b ? 0 : a < b ? -1 : 1;
  });
}
