import { displayToolName, type EngineEvent, type Item, type Session, type Task, type Turn, type TurnAttachment, type TurnState, type UsageSnapshot } from "@telar/engine-client";

/**
 * The client-side fold over protocol v2's journal.
 *
 * WHAT CHANGED FROM v1: the fold used to produce `{ prompt, text }` — one
 * string of accumulated prose per turn — because that is all the engine sent.
 * v2 carries a timeline, so a turn now owns an ordered list of ITEMS (tool
 * calls, reasoning, assistant messages) and streaming text lands on the item it
 * belongs to instead of being concatenated into one blob.
 *
 * THE FOLD IS THE ONLY SOURCE OF TRUTH FOR ORDER. Items sort by the event id
 * that opened them, never by timestamp: two events can share a millisecond, and
 * `at` is when the engine recorded a row rather than when the provider produced
 * it. The id is monotonic per session by construction.
 */

export type JournalItem = Item & {
  /** Deltas accumulated in arrival order. Empty for items that never stream. */
  streamedText: string;
  /** The event id that opened this item — the sort key, not a display value. */
  openedBy: number;
};

/** A sub-agent, with the rows it produced. */
export type JournalTask = Task & { items: JournalItem[] };

export type JournalTurn = {
  runId: string;
  prompt: string;
  /** `compact` when the turn is the compaction gesture, not a message — the
   *  transcript draws a system row instead of a bubble. */
  kind?: "message" | "compact";
  /** `provider` when the CLI started this turn on its own — a background
   *  task's ending woke the model. `session` when the ENGINE queued it because
   *  a session this one subscribed to did something. Both are drawn as a
   *  wake-up line, not a bubble: no human typed `prompt`. */
  origin?: "user" | "provider" | "session";
  /** For a provider turn: the row whose ending woke it, when known. */
  wokenBy?: string;
  /** For a session turn: what the other session did, and which one. */
  wakeReason?: Turn["wakeReason"];
  /** Files sent WITH this message. On the turn because that is what they
   *  describe — a transcript that showed the words and not the screenshot has
   *  lost half of what was said. */
  attachments?: TurnAttachment[];
  state: TurnState;
  /**
   * The MAIN LOOP's timeline only.
   *
   * Rows a sub-agent produced are on `tasks`, not here, and that separation is
   * the point of `Item.taskId`. Five agents running concurrently interleave
   * their tool calls on one stream; rendered flat they read as one agent doing
   * five contradictory things at once.
   */
  items: JournalItem[];
  /** Sub-agents and background work launched by this turn. */
  tasks: JournalTask[];
  /** When the provider actually started, for the live elapsed clock. Absent
   *  until the turn is claimed and running. */
  startedAt?: number;
  /**
   * When anything last happened on this turn — a row opened or closed, a delta,
   * a sub-agent reporting in.
   *
   * WHAT "GONE QUIET" IS MEASURED FROM. The working indicator used the turn's
   * total elapsed time for both readouts, so every turn over twenty seconds
   * announced "no output 43s" beside forty-three seconds of visible output.
   * Silence is a gap since the LAST thing that happened, which is a different
   * number and the only one that can tell slow from stuck.
   */
  lastActivityAt?: number;
  /** The assistant's final text, as the engine recorded it on completion. */
  resultText: string;
  failure?: string;
  usage?: UsageSnapshot;
};

/**
 * EVERY SUB-AGENT THE SESSION KNOWS ABOUT, freshest copy first.
 *
 * THE PANEL AND THE TRANSCRIPT WERE READING DIFFERENT LISTS, and the difference
 * was the whole feature: the transcript folds `task.started`/`progress`/
 * `completed` off the live event tail, while the panel took the snapshot's
 * `tasks` array — which only changes when a tail response happens to carry a new
 * snapshot. So two sub-agents could be visibly running in the conversation while
 * the Agents panel showed "Sub-agents appear here as they work" and a tab with
 * no count. The panel was not empty by accident; it was reading a list that had
 * not been told yet.
 *
 * THE JOURNAL WINS where both have a task, because it has applied every event up
 * to now. The snapshot is still merged in rather than discarded: `projectJournal`
 * files a task under the turn that launched it and drops one whose turn it has
 * never seen, and a BACKGROUND task is defined by outliving its turn — so the
 * snapshot is what keeps such a task in the roster.
 */
export function taskRoster(snapshot: readonly Task[], journal: readonly JournalTask[]): JournalTask[] {
  const known = new Set(journal.map((task) => task.id));
  return [...journal, ...snapshot.filter((task) => !known.has(task.id)).map((task) => ({ ...task, items: [] }))];
}

/** Merges a cursor page without duplicating durable journal records. */
export function appendJournalEvents(existing: EngineEvent[], incoming: EngineEvent[]): EngineEvent[] {
  const events = new Map(existing.map((event) => [event.id, event]));
  for (const event of incoming) events.set(event.id, event);
  return [...events.values()].sort((left, right) => left.id - right.id);
}

export function journalCursor(events: EngineEvent[]): number {
  return events.reduce((cursor, event) => Math.max(cursor, event.id), 0);
}

/**
 * Fold turns, the engine's item projection, and the event tail into a
 * renderable transcript.
 *
 * ITEMS COME FROM BOTH SIDES ON PURPOSE. The snapshot's `items` is what makes
 * opening a long session cheap — no replay from event 1 — while the event tail
 * is what makes a live turn stream. Applying the tail second means a row the
 * snapshot caught mid-flight is corrected by the events that followed it.
 */
export function projectJournal(turns: Turn[], items: Item[], events: EngineEvent[], tasks: Task[] = []): JournalTurn[] {
  const byRun = new Map<string, JournalTurn>(
    turns.map((turn) => [
      turn.runId,
      {
        runId: turn.runId,
        prompt: turn.input,
        ...(turn.kind ? { kind: turn.kind } : {}),
        ...(turn.origin ? { origin: turn.origin } : {}),
        ...(turn.providerReason?.taskId ? { wokenBy: turn.providerReason.taskId } : {}),
        ...(turn.wakeReason ? { wakeReason: turn.wakeReason } : {}),
        ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
        state: turn.state,
        items: [],
        tasks: [],
        ...(turn.startedAt ? { startedAt: turn.startedAt } : {}),
        resultText: turn.resultText ?? "",
        ...(turn.failure ? { failure: turn.failure.message } : {}),
        ...(turn.usage ? { usage: turn.usage } : {}),
      },
    ]),
  );
  const seenItems = new Map<string, JournalItem>();
  const seenTasks = new Map<string, JournalTask>();

  const upsertTask = (task: Task): JournalTask | undefined => {
    const turn = byRun.get(task.runId);
    if (!turn) return undefined;
    const existing = seenTasks.get(task.id);
    // The items already collected survive the update: every task event repeats
    // the whole task, and a replace would empty the list each time one arrives.
    const merged: JournalTask = { ...task, items: existing?.items ?? [] };
    seenTasks.set(task.id, merged);
    const index = turn.tasks.findIndex((candidate) => candidate.id === task.id);
    if (index === -1) turn.tasks.push(merged);
    else turn.tasks[index] = merged;
    return merged;
  };

  const upsert = (item: Item, openedBy: number): JournalItem | undefined => {
    const turn = byRun.get(item.runId);
    if (!turn) return undefined;
    const existing = seenItems.get(item.id);
    const merged: JournalItem = {
      ...item,
      streamedText: existing?.streamedText ?? "",
      openedBy: existing?.openedBy ?? openedBy,
    };
    seenItems.set(item.id, merged);
    /**
     * A row filed under a task the fold has not met yet stays on the main
     * timeline rather than being dropped. The task event may simply be later in
     * the same page — but an invisible row is worse than a misplaced one, and
     * the next snapshot repairs the placement.
     */
    const owner = item.taskId ? seenTasks.get(item.taskId) : undefined;
    const list = owner ? owner.items : turn.items;
    const index = list.findIndex((candidate) => candidate.id === item.id);
    if (index === -1) list.push(merged);
    else list[index] = merged;
    return merged;
  };

  // The snapshot first, so a session that has been running for an hour renders
  // without replaying its whole journal. Event id 0 is not a real id, so these
  // sort before anything the tail opens — which is the correct relative order
  // for rows that already existed when the page loaded.
  // Tasks BEFORE items, so a snapshot's sub-agent rows find their owner on the
  // first pass instead of landing on the main timeline and staying there.
  for (const task of tasks) upsertTask(task);
  for (const item of items) upsert(item, 0);
  /**
   * The quiet clock, seeded from the snapshot so a page opened onto a running
   * turn does not start by claiming it has been silent since it began.
   */
  for (const turn of byRun.values()) {
    const latest = Math.max(
      turn.startedAt ?? 0,
      ...turn.items.map((item) => item.completedAt ?? item.startedAt),
      ...turn.tasks.map((task) => task.updatedAt),
    );
    if (latest > 0) turn.lastActivityAt = latest;
  }

  // The last journalled tab set per session, for the quiet open/close rows.
  const lastBrowserTabs = new Map<string, { url: string; title: string }[]>();
  for (const event of events) {
    const turn = event.runId ? byRun.get(event.runId) : undefined;
    /**
     * ANY event on this turn is activity, deltas included — which is the point.
     * A row's timestamps do not move while it streams, so a long answer measured
     * by item stamps alone reads as silence while it is being written.
     */
    if (turn) turn.lastActivityAt = Math.max(turn.lastActivityAt ?? 0, event.at);

    switch (event.type) {
      case "turn.accepted":
        if (!byRun.has(event.turn.runId)) {
          byRun.set(event.turn.runId, {
            runId: event.turn.runId,
            prompt: event.turn.input,
            ...(event.turn.kind ? { kind: event.turn.kind } : {}),
            ...(event.turn.origin ? { origin: event.turn.origin } : {}),
            ...(event.turn.providerReason?.taskId ? { wokenBy: event.turn.providerReason.taskId } : {}),
            ...(event.turn.wakeReason ? { wakeReason: event.turn.wakeReason } : {}),
            ...(event.turn.attachments?.length ? { attachments: event.turn.attachments } : {}),
            state: event.turn.state,
            items: [],
            tasks: [],
            resultText: "",
          });
        }
        break;
      case "turn.claimed":
        if (turn) turn.state = "claimed";
        break;
      case "turn.started":
        if (turn) { turn.state = "running"; turn.startedAt = turn.startedAt ?? event.at; }
        break;
      case "turn.requeued":
        if (turn) turn.state = "queued";
        break;
      // Send now: promoted into the running turn, then delivered. The
      // delivered turn is TERMINAL — its words render inside the run they
      // joined (a user_message item), not as a turn of their own.
      case "turn.steering":
        if (turn) turn.state = "steering";
        break;
      case "turn.steered":
        if (turn) turn.state = "steered";
        break;
      case "turn.completed":
        if (turn) {
          turn.state = "completed";
          turn.resultText = event.resultText;
          if (event.usage) turn.usage = event.usage;
        }
        break;
      case "turn.failed":
        if (turn) {
          turn.state = "failed";
          turn.failure = event.message;
        }
        break;
      case "turn.stopped":
        if (turn) turn.state = "stopped";
        break;
      case "turn.ambiguous":
        if (turn) turn.state = "ambiguous";
        break;
      case "turn.discarded":
        if (turn) turn.state = "discarded";
        break;
      case "item.started":
      case "item.updated":
      case "item.completed":
        upsert(event.item, event.id);
        break;
      case "content.delta": {
        // A delta for an item this client has not seen is DROPPED, not
        // buffered. It means the fold is missing the row that opened it, and
        // inventing a placeholder would render a message with no idea what
        // kind of row it belongs to. The next snapshot repairs it.
        const item = seenItems.get(event.itemId);
        if (item) item.streamedText += event.text;
        break;
      }
      case "task.started":
      case "task.progress":
      case "task.completed":
        upsertTask(event.task);
        break;
      case "usage.updated":
        if (turn) turn.usage = event.usage;
        break;
      case "browser.state.changed": {
        /**
         * The QUIET tab rows: an agent opening or closing a tab is worth one
         * line in the turn, not a card. Diffed by count with a url lookup —
         * desktop tab ids are positional, so an id diff would misread every
         * close as churn. Only agent-driven changes carry a runId (the socket
         * journals them from inside the turn), so the guard is the filter.
         */
        if (!turn) break;
        const previous = lastBrowserTabs.get(event.sessionId);
        const current = event.tabs;
        if (previous && current.length !== previous.length) {
          const grew = current.length > previous.length;
          const known = new Set((grew ? previous : current).map((tab) => tab.url));
          const changed = (grew ? current : previous).find((tab) => !known.has(tab.url));
          turn.items.push({
            id: `tabs_${event.id}`,
            runId: event.runId!,
            sessionId: event.sessionId,
            status: "completed",
            startedAt: event.at,
            completedAt: event.at,
            detail: {
              type: "unknown",
              label: grew
                ? `Opened a tab${changed?.title || changed?.url ? ` — ${changed.title || changed.url}` : ""}`
                : `Closed a tab${changed?.title || changed?.url ? ` — ${changed.title || changed.url}` : ""}`,
            },
            streamedText: "",
            openedBy: event.id,
          });
        }
        lastBrowserTabs.set(event.sessionId, current);
        break;
      }
      case "browser.control.changed":
        /**
         * "You interacted with the browser" belongs INSIDE the turn it
         * touched — it explains the agent's deferred or refused action right
         * above it. Rendered through the unknown-detail arm on purpose: a
         * one-line labeled row is exactly what this is, and inventing a
         * detail type for it would be a schema for a sentence.
         *
         * ONLY THE HUMAN'S SIDE IS A ROW. There is no ownership to hand back
         * in the shared browser: the agent resuming is routine and would only
         * be noise (it used to print "handed back to the agent", which claimed
         * a ritual that no longer exists). Historical "agent" events keep
         * their semantics in the journal; they simply do not draw. Session-
         * level changes (no runId) stay off the transcript; the panel's
         * activity mark is the live view of those.
         */
        if (turn && event.controller === "human") {
          turn.items.push({
            id: `control_${event.id}`,
            runId: event.runId!,
            sessionId: event.sessionId,
            status: "completed",
            startedAt: event.at,
            completedAt: event.at,
            detail: { type: "unknown", label: "You interacted with the browser" },
            streamedText: "",
            openedBy: event.id,
          });
        }
        break;
      default:
        // Every other family (runtime.*, request.*, browser.*, mcp.*) is
        // contract but not yet rendered. Ignoring them here is deliberate;
        // dropping them at PARSE time would not be, which is why
        // safeParseEvent only skips rows it cannot understand at all.
        break;
    }
  }

  const byOpen = (left: JournalItem, right: JournalItem) =>
    left.openedBy - right.openedBy || left.startedAt - right.startedAt;
  for (const turn of byRun.values()) {
    turn.items.sort(byOpen);
    for (const task of turn.tasks) task.items.sort(byOpen);
    turn.tasks.sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
  }
  return [...byRun.values()];
}

export function isActiveTurn(state: TurnState): boolean {
  return state === "queued" || state === "claimed" || state === "running";
}

/**
 * Whether the provider is squeezing its context RIGHT NOW: an open
 * `context_compaction` item on the turn. One fold shared by the working
 * indicator, the compact button and the queue's send-now gate, so the three
 * cannot disagree about whether a compaction is in flight — and the same
 * definition on both providers, because both open the item and close it.
 */
export function isCompacting(turn?: JournalTurn): boolean {
  return Boolean(turn?.items.some((item) => item.detail.type === "context_compaction" && item.status === "inProgress"));
}

/**
 * The text a rendered item should show.
 *
 * Streamed deltas WIN over the stored detail while a turn is live, because the
 * engine only folds accumulated text into `items.json` when the item closes —
 * writing the whole document per token would be absurd. Once closed, the two
 * agree and either is correct.
 */
export function itemText(item: JournalItem): string {
  if (item.streamedText) return item.streamedText;
  if (item.detail.type === "assistant_message" || item.detail.type === "reasoning") return item.detail.text;
  if (item.detail.type === "user_message") return item.detail.text;
  return "";
}

/** A one-line label for a collapsed row, preferring what the engine stored. */
export function itemLabel(item: JournalItem): string {
  if (item.title) return item.title;
  switch (item.detail.type) {
    case "command_execution":
      return item.detail.command.command || "command";
    case "file_change":
      return item.detail.change.path;
    case "file_read":
      return item.detail.read.path;
    case "mcp_tool_call":
    case "dynamic_tool_call":
    case "browser_action":
      // The stored name is fully qualified (`mcp__telar__browser_click`) because
      // that is what correlates a row with its approval. A label drops the
      // addressing — the contract owns that rule so three clients cannot invent
      // three ways to shorten it.
      return displayToolName(item.detail.call.name);
    case "web_search":
      return item.detail.query;
    case "error":
      return item.detail.error.message;
    // The label IS the row for a one-line notice ("You interacted with the browser",
    // "Opened a tab — …"). Falling through to the type name printed the word
    // "unknown" three times under a real answer.
    case "unknown":
      return item.detail.label ?? item.detail.type;
    default:
      return item.detail.type;
  }
}

/** Rows that render as a tool card rather than as prose. */
export function isToolItem(item: JournalItem): boolean {
  return (
    item.detail.type === "command_execution" ||
    item.detail.type === "file_change" ||
    item.detail.type === "file_read" ||
    item.detail.type === "mcp_tool_call" ||
    item.detail.type === "dynamic_tool_call" ||
    item.detail.type === "web_search" ||
    item.detail.type === "browser_action"
  );
}

/** The output body of a finished tool call, when it has one. */
export function toolOutput(item: JournalItem): string | undefined {
  if (item.detail.type === "command_execution") return item.detail.command.outputPreview;
  if (item.detail.type === "mcp_tool_call" || item.detail.type === "dynamic_tool_call") {
    const output = item.detail.call.output;
    return typeof output === "string" ? output : output === undefined ? undefined : JSON.stringify(output, null, 2);
  }
  return undefined;
}

export type { Session };
