import { displayToolName, type EngineEvent, type Item, type RateLimitType, type Session, type Task, type Turn, type TurnAttachment, type TurnFailureCode, type TurnState, type UsageSnapshot } from "@telar/engine-client";

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
  /** `compact` when the turn is the compaction gesture, not a message — the
   *  transcript draws a system row instead of a bubble. `import` is the same
   *  rule for an adopted Claude Code conversation (#616): the engine wrote the
   *  turn, nobody typed `prompt`, and its items are history rather than work
   *  this session did. */
  kind?: "message" | "compact" | "import";
  /** `provider` when the CLI started this turn on its own — a background
   *  task's ending woke the model. `session` when the ENGINE queued it because
   *  a session this one subscribed to did something. Both are drawn as a
   *  wake-up line, not a bubble: no human typed `prompt`. */
  /** `schedule` since #543 — a turn a CLOCK started, drawn as what it is
   *  rather than as something a person typed. */
  origin?: "user" | "provider" | "session" | "schedule" | "restart";
  /** Why the engine wrote this turn itself after a restart — see
   *  `Turn.restartOrigin`. Present only on `origin: "restart"`. */
  restartOrigin?: Turn["restartOrigin"];
  /** For a provider turn: the row whose ending woke it, when known. */
  wokenBy?: string;
  /**
   * For a provider turn the engine opened so a LIVE task could have a tool
   * call decided (#891): the row that asked. Kept apart from `wokenBy`
   * deliberately — nothing woke the model here, no prose was written, and
   * drawing it as "Sub-agent reported" would be a sentence about something
   * that did not happen.
   */
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
  /**
   * THIS TURN IS A NOTIFICATION — a peer's message, a wake, a parked request.
   * Nobody typed `prompt`, and the transcript draws a notification row rather
   * than any kind of bubble. See `NotificationDetail`.
   */
  notification?: Turn["notification"];
  /** What the sender said the task covers. Descriptive; confers nothing. */
  assignmentScope?: Turn["assignmentScope"];
  /** Files sent WITH this message. On the turn because that is what they
   *  describe — a transcript that showed the words and not the screenshot has
   *  lost half of what was said. */
  attachments?: TurnAttachment[];
  state: TurnState;
  /**
   * Queued, but written before the turn this session lost — so it waits for a
   * human to re-read it rather than running on its own. Not a state: the turn
   * is `queued` either way, and the difference is whether a worker may take it.
   */
  held?: boolean;
  /** WHY it is held: a restart's re-read, or the session being paused. The
   *  transcript offers different verbs for the two. */
  heldReason?: NonNullable<Turn["held"]>["reason"];
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
  /** When the engine took the message — for a passive arrival, WHEN it
   *  arrived, which is what places it inside the turn that was running. */
  acceptedAt?: number;
  /** When the provider actually started, for the live elapsed clock. Absent
   *  until the turn is claimed and running. */
  startedAt?: number;
  /** When the turn reached a terminal state, however it got there. */
  endedAt?: number;
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
  /**
   * WHICH KIND of failure, because one of them is not a fault.
   *
   * The transcript drew every failure as one attention marker holding the
   * message. That is right for a crash and wrong for a usage limit, which is a
   * wait with a known end — so the code comes through and `rate_limited` gets a
   * row that says when it lifts instead of a sentence about the provider.
   */
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

/**
 * Fold turns, the engine's item projection, and the event tail into a
 * renderable transcript.
 *
 * ITEMS COME FROM BOTH SIDES ON PURPOSE. The snapshot's `items` is what makes
 * opening a long session cheap — no replay from event 1 — while the event tail
 * is what makes a live turn stream. Applying the tail second means a row the
 * snapshot caught mid-flight is corrected by the events that followed it.
 */
export function projectJournal(
  turns: Turn[],
  items: Item[],
  events: EngineEvent[],
  tasks: Task[] = [],
  /**
   * The tab set in force BEFORE each `browser.state.changed` event, when a
   * caller has already worked it out — see `createJournalProjector`.
   *
   * THE ONE PIECE OF STATE THIS FOLD CARRIES ACROSS TURNS. Everything else is
   * filed under a runId and can be folded a turn at a time; the open/close row
   * is a DIFF against whatever the last journalled tab set was, which may have
   * been established by an earlier turn. A projector folding one turn cannot see
   * that, so it computes the diffs' left-hand sides in one pass and hands them
   * in. Absent, the fold keeps its own running copy and behaves exactly as it
   * always has.
   */
  previousTabs?: ReadonlyMap<number, readonly { url: string; title: string }[] | undefined>,
): JournalTurn[] {
  const byRun = new Map<string, JournalTurn>(
    turns.map((turn) => [
      turn.runId,
      {
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
    /**
     * THE SNAPSHOT'S `streamed` IS A PREFIX, AND DELTAS ABOVE ITS WATERMARK
     * APPEND TO IT (#214).
     *
     * A remount throws the event tail away and re-opens on a snapshot whose
     * cursor is already stamped past every delta so far — so without a seed the
     * fold starts from "" and the reader loses everything streamed before they
     * looked away.
     *
     * THE LONGEST PREFIX WINS, AND ITS WATERMARK COMES WITH IT. A reconnect
     * brings a newer snapshot with a longer prefix; a companion snapshot on a
     * quiet turn brings the same one again. Keeping whichever reaches further
     * and remembering where it ends means the fold never has to know which
     * kind it just received — the watermark below decides what still appends.
     */
    const seeded = pickPrefix(existing, item);
    const merged: JournalItem = {
      ...item,
      ...seeded,
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
    if (turn && TERMINAL_EVENTS.has(event.type)) turn.endedAt = event.at;
    // A turn a lifted limit brought back is not over after all.
    if (turn && event.type === "turn.requeued") delete turn.endedAt;

    switch (event.type) {
      case "turn.accepted":
        if (!byRun.has(event.turn.runId)) {
          byRun.set(event.turn.runId, {
            runId: event.turn.runId,
            prompt: event.turn.input,
            ...(event.turn.kind ? { kind: event.turn.kind } : {}),
            ...(event.turn.origin ? { origin: event.turn.origin } : {}),
            ...(event.turn.restartOrigin ? { restartOrigin: event.turn.restartOrigin } : {}),
            ...(event.turn.providerReason?.kind === "background_task"
              ? { decidedForBackgroundWork: true, ...(event.turn.providerReason.taskId ? { askedBy: event.turn.providerReason.taskId } : {}) }
              : event.turn.providerReason?.taskId
                ? { wokenBy: event.turn.providerReason.taskId }
                : {}),
            ...(event.turn.wakeReason ? { wakeReason: event.turn.wakeReason } : {}),
            ...(event.turn.sender ? { sender: event.turn.sender } : {}),
            ...(event.turn.agentDelivery ? { agentDelivery: event.turn.agentDelivery } : {}),
            ...(event.turn.agentIntent ? { agentIntent: event.turn.agentIntent } : {}),
            ...(event.turn.agentNotice ? { agentNotice: event.turn.agentNotice } : {}),
            ...(event.turn.notification ? { notification: event.turn.notification } : {}),
            ...(event.turn.assignmentScope ? { assignmentScope: event.turn.assignmentScope } : {}),
            ...(event.turn.attachments?.length ? { attachments: event.turn.attachments } : {}),
            state: event.turn.state,
            ...(event.turn.held ? { held: true, heldReason: event.turn.held.reason } : {}),
            items: [],
            tasks: [],
            acceptedAt: event.turn.acceptedAt,
            ...(event.turn.completedAt ? { endedAt: event.turn.completedAt } : {}),
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
        if (turn) {
          turn.state = "queued";
          // The engine brought it back after a limit lifted. Remembered so the
          // transcript can say so — the turn is no longer failed, and without
          // this the wait would read as an unexplained gap.
          if (event.reason === "rate_limit_reset") turn.resumedAfterRateLimit = event.at;
        }
        break;
      // The hold came off. NOT a state change — the turn was `queued` before
      // and after — so only the flag the transcript reads is cleared.
      case "turn.released":
        if (turn) {
          turn.held = false;
          delete turn.heldReason;
        }
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
          turn.failureCode = event.code;
          // Carried on the event as well as the snapshot, so a client watching
          // the tail can draw the waiting row without re-reading the session.
          if (event.resumeAt !== undefined) turn.resumeAt = event.resumeAt;
          if (event.limitType) turn.limitType = event.limitType;
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
        if (!item) break;
        // ALREADY IN THE PREFIX. A snapshot's `streamed` runs through
        // `streamedThrough`, and the tail legitimately overlaps it — the two
        // are separate reads. Appending this again would double the text.
        if (item.streamedThrough !== undefined && event.id <= item.streamedThrough) break;
        item.streamedText += event.text;
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
        const previous = previousTabs ? previousTabs.get(event.id) : lastBrowserTabs.get(event.sessionId);
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
         * ONLY WHEN IT INTERRUPTED SOMETHING. Every human touch used to draw
         * this row, so scrolling a page the agent was not working in put a
         * line in the conversation that explained nothing — reported from the
         * dogfood app as constant noise. It now draws only when the input
         * landed while the agent was acting on that tab, which is the case it
         * was written to explain.
         *
         * ONLY THE HUMAN'S SIDE IS A ROW. There is no ownership to hand back
         * in the shared browser: the agent resuming is routine and would only
         * be noise (it used to print "handed back to the agent", which claimed
         * a ritual that no longer exists). Historical "agent" events keep
         * their semantics in the journal; they simply do not draw. Session-
         * level changes (no runId) stay off the transcript; the panel's
         * activity mark is the live view of those.
         */
        if (turn && event.controller === "human" && event.interrupted) {
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
      case "notebook.cell.output": {
        /**
         * ONLY THE FIGURES BECOME ROWS. Text and tables are already in the
         * tool result the model read; a plot is the one output a human wants
         * to SEE where it was made, and the gallery holds the rest. Outputs
         * with no turn (a cell run from the panel) stay off the transcript.
         */
        const output = event.output as { kind?: string; attachmentId?: string } | null;
        if (!turn || output?.kind !== "image" || !output.attachmentId) break;
        turn.items.push({
          id: `plot_${output.attachmentId}`,
          runId: event.runId!,
          sessionId: event.sessionId,
          status: "completed",
          startedAt: event.at,
          completedAt: event.at,
          detail: { type: "unknown", label: `Drew a figure${event.producer ? ` — ${event.producer}` : ""}` },
          streamedText: "",
          openedBy: event.id,
          plotAttachmentId: output.attachmentId,
        });
        break;
      }
      case "latex.compile.finished":
        /**
         * ONE ROW PER COMPILE — the counts and the first error, never the
         * log; the LaTeX surface holds the full diagnostics. A compile with
         * no turn (pressed on the panel) stays off the transcript.
         */
        if (turn) {
          turn.items.push({
            id: `latex_${event.id}`,
            runId: event.runId!,
            sessionId: event.sessionId,
            status: event.ok ? "completed" : "failed",
            startedAt: event.at,
            completedAt: event.at,
            detail: event.ok
              ? { type: "unknown", label: `Compiled ${event.path}${event.warnings ? ` — ${event.warnings} warning${event.warnings === 1 ? "" : "s"}` : ""}` }
              : { type: "error", error: { message: `Compile of ${event.path} failed — ${event.errors} error${event.errors === 1 ? "" : "s"}${event.firstError ? `, first: ${event.firstError}` : ""}` } },
            streamedText: "",
            openedBy: event.id,
          });
        }
        break;
      case "ds.watch.violated":
        if (turn) {
          turn.items.push({
            id: `watch_${event.id}`,
            runId: event.runId!,
            sessionId: event.sessionId,
            status: "failed",
            startedAt: event.at,
            completedAt: event.at,
            detail: { type: "error", error: { message: `Watch "${event.watch}" violated: ${event.assert}${event.detail ? ` (${event.detail})` : ""}` } },
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

/**
 * A PASSIVE ARRIVAL IS DRAWN INSIDE THE TURN IT ARRIVED DURING.
 *
 * A peer's report, or a `result` nobody is waiting on, reaching a BUSY session
 * is not a turn: the engine writes its row, holds it for the next idle moment
 * and completes it at once. It is still a turn with its own sequence, though,
 * and drawn as one it landed AFTER the running turn — below the working line
 * while the turn ran, and after everything the turn went on to do once it ended.
 * A coordinator with five workers ended every long turn with a column of them.
 *
 * So each one moves into the turn that was running when it was accepted, at
 * its time among that turn's rows, the way a steered notice already sits. One
 * with no such turn in view (an idle session with a report window, a page that
 * does not reach back that far) stays a row of its own. A copy of the host is
 * returned, never the projector's cached fold.
 */
export function hostPassiveArrivals(turns: readonly JournalTurn[]): JournalTurn[] {
  const guestsOf = new Map<string, JournalTurn[]>();
  const hosted = new Set<string>();
  for (const [index, turn] of turns.entries()) {
    const arrived = turn.acceptedAt;
    if (turn.agentDelivery !== "passive" || !turn.notification || arrived === undefined) continue;
    const host = turns
      .slice(0, index)
      .findLast(
        (candidate) =>
          candidate.agentDelivery !== "passive" &&
          !candidate.decidedForBackgroundWork &&
          candidate.startedAt !== undefined &&
          candidate.startedAt <= arrived &&
          (candidate.endedAt === undefined ? candidate.state === "claimed" || candidate.state === "running" : candidate.endedAt >= arrived),
      );
    if (!host) continue;
    guestsOf.set(host.runId, [...(guestsOf.get(host.runId) ?? []), turn]);
    hosted.add(turn.runId);
  }
  if (hosted.size === 0) return [...turns];
  return turns
    .filter((turn) => !hosted.has(turn.runId))
    .map((turn) => {
      const guests = guestsOf.get(turn.runId);
      if (!guests) return turn;
      const items = [...turn.items];
      for (const guest of guests) {
        const row = arrivalRow(guest);
        const at = items.findIndex((item) => item.startedAt > row.startedAt);
        items.splice(at === -1 ? items.length : at, 0, row);
      }
      return { ...turn, items };
    });
}

/** The arrival's own notification row, or one built from the turn when the
 *  page did not carry it. */
function arrivalRow(guest: JournalTurn): JournalItem {
  const own = guest.items.find((item) => item.detail.type === "notification");
  if (own) return own;
  const at = guest.acceptedAt ?? 0;
  return {
    id: `notification_${guest.runId}`,
    runId: guest.runId,
    sessionId: guest.notification!.fetch?.sessionId ?? "",
    status: "completed",
    title: guest.notification!.summary,
    detail: { type: "notification", notification: guest.notification! },
    startedAt: at,
    completedAt: at,
    openedBy: 0,
    streamedText: "",
  };
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
 * WHILE OPEN, THE STREAM IS THE TEXT: the engine only folds accumulated text
 * into `items.json` when the item closes — writing the whole document per token
 * would be absurd — so mid-flight the stored detail is deliberately stale.
 * `streamedText` is the snapshot's prefix plus every delta since (see `upsert`).
 *
 * ONCE CLOSED, THE STORED DETAIL WINS, and that is not the same as "whichever
 * is longer". A provider that revises its answer on close must be able to
 * SHORTEN it, and a length comparison would pin the draft on screen forever.
 * The close is the moment the engine's copy becomes complete, so it is also the
 * moment it becomes authoritative.
 */
export function itemText(item: JournalItem): string {
  if (item.status === "inProgress" && item.streamedText) return item.streamedText;
  if (item.streamedText && !storedText(item)) return item.streamedText;
  return storedText(item);
}

/**
 * Which streamed prefix this item should carry: the one already folded, or a
 * longer one a newer snapshot brought.
 *
 * REACH, NOT RECENCY. A companion snapshot rides any queue-changing event, so
 * the same prefix arrives repeatedly and an unconditional adopt would rewind a
 * fold that has been appending deltas past it. A reconnect brings a genuinely
 * longer one that must be adopted, or the deltas between the two watermarks are
 * gone. "Whichever reaches further" is the one rule that gets both right, and
 * it is safe because a prefix is append-only: the engine never un-streams text.
 */
function pickPrefix(existing: JournalItem | undefined, incoming: Item): Pick<JournalItem, "streamedText" | "streamedThrough"> {
  const held = existing?.streamedText ?? "";
  const heldThrough = existing?.streamedThrough;
  const offered = incoming.streamed ?? "";
  const offeredThrough = incoming.streamedThrough;
  // No watermark on the offer — an engine too old to send one. Its prefix
  // cannot be reconciled with a tail, so it is only usable as a first seed.
  if (offeredThrough === undefined) {
    return held ? { streamedText: held, ...(heldThrough === undefined ? {} : { streamedThrough: heldThrough }) } : { streamedText: offered };
  }
  if (heldThrough !== undefined && heldThrough >= offeredThrough) {
    return { streamedText: held, streamedThrough: heldThrough };
  }
  // A held prefix with no watermark came from an old engine or an unseeded
  // fold; the offered one is reconcilable, so it wins outright.
  return { streamedText: offered, streamedThrough: offeredThrough };
}

/** What the engine has FOLDED for this item — empty until it closes. */
function storedText(item: JournalItem): string {
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

// ── the memoised projection ────────────────────────────────────────────────

/**
 * THE SAME FOLD, BUT ONLY OVER WHAT MOVED (#407).
 *
 * `projectJournal` is pure and re-folds everything it is given. That is the
 * right shape for a function and the wrong amount of work for a cockpit: the
 * transcript is recomputed whenever `turns`, `items`, `events` or `tasks`
 * changes identity, and on a live conversation that is once per streamed chunk
 * — each time rebuilding ten settled turns and a few hundred items that cannot
 * possibly have changed, because a settled turn is settled.
 *
 * A JOURNAL IS ALREADY PARTITIONED BY TURN. Every row and every event names the
 * run it belongs to, so the fold of run A cannot be affected by anything filed
 * under run B — with exactly one exception, the browser tab diff, which this
 * projector resolves as it walks and hands to the fold (`previousTabs`). Each
 * run is therefore folded against its own slice, and the result cached against
 * the identity of that slice.
 *
 * AND THE PARTITION ITSELF IS INCREMENTAL, which is the difference between this
 * being a saving and being a second full pass wearing a cache. The journal is
 * append-only, so a tick that brought three deltas walks three events; the row
 * buckets are rebuilt only when the arrays holding them actually change.
 *
 * IDENTITY, NOT EQUALITY, IS THE KEY throughout. These rows come off
 * `JSON.parse`, so a fresh snapshot really does produce fresh objects and the
 * cache correctly misses. When no snapshot was fetched the client hands the same
 * objects back (see `mergeRows`), and that is precisely the case worth skipping.
 *
 * THE RETURNED TURNS ARE SHARED. A cached `JournalTurn` is the same object the
 * previous call returned, which is what lets React skip a subtree — so nothing
 * downstream may mutate one.
 */
export type JournalProjector = (turns: Turn[], items: Item[], events: EngineEvent[], tasks?: Task[]) => JournalTurn[];

/** A run's slice, and the fold it produced. Compared by identity — plus a
 *  count, because the event slices are APPENDED to in place rather than
 *  rebuilt, so their reference alone cannot say whether anything arrived. */
type ProjectedRun = {
  row: Turn | undefined;
  items: readonly Item[];
  tasks: readonly Task[];
  events: readonly EngineEvent[];
  eventCount: number;
  out: JournalTurn;
};

const NO_ITEMS: readonly Item[] = [];
const NO_TASKS: readonly Task[] = [];
const NO_EVENTS: readonly EngineEvent[] = [];

/** Whether `next` begins with the first `count` entries of `previous`, by
 *  identity. A journal is append-only, so this is the ordinary case — and it is
 *  what lets a tick partition only what arrived. */
function extendsPrefix(previous: readonly EngineEvent[], next: readonly EngineEvent[], count: number): boolean {
  if (next.length < count || previous.length < count) return false;
  for (let index = 0; index < count; index += 1) if (previous[index] !== next[index]) return false;
  return true;
}

/**
 * THE SAME ROWS, WHETHER OR NOT THEY ARRIVED IN THE SAME ARRAY.
 *
 * `mergeRows` hands back the array it was given when nothing moved, so the
 * usual quiet tick is caught by the reference check alone. This is the belt:
 * any caller that copies an array of unchanged rows — a test, a future merge,
 * the paging path — still gets the cheap path, and an identity sweep is
 * strictly cheaper than the map-building it avoids.
 */
function sameRows<T>(previous: readonly T[] | undefined, next: readonly T[]): boolean {
  if (previous === next) return true;
  if (previous === undefined || previous.length !== next.length) return false;
  for (let index = 0; index < next.length; index += 1) if (previous[index] !== next[index]) return false;
  return true;
}

/**
 * WHICH RUNS AN EVENT CAN AFFECT.
 *
 * Usually just its envelope's `runId`. The others are defensive rather than
 * theoretical: an item or task event carries the row's own run, a delta names an
 * item rather than a run, and the fold files each by the ROW's run — so
 * partitioning on the envelope alone could drop a delta whose envelope was bare.
 * Landing an event in two buckets is harmless: it is a no-op in the one whose
 * turn it does not name.
 */
function runsTouched(event: EngineEvent, runOfItem: ReadonlyMap<string, string>): string[] {
  const envelope = event.runId;
  const both = (owner: string | undefined): string[] => {
    if (!owner) return envelope ? [envelope] : [];
    if (!envelope || envelope === owner) return [owner];
    return [envelope, owner];
  };
  switch (event.type) {
    case "turn.accepted":
      return both(event.turn.runId);
    case "item.started":
    case "item.updated":
    case "item.completed":
    case "turn.plan.updated":
      return both(event.item.runId);
    case "task.started":
    case "task.progress":
    case "task.completed":
      return both(event.task.runId);
    case "content.delta":
      return both(runOfItem.get(event.itemId));
    default:
      return envelope ? [envelope] : [];
  }
}

export function createJournalProjector(): JournalProjector {
  let folds = new Map<string, ProjectedRun>();

  // The partition, kept between calls and rebuilt only where its inputs moved.
  let heldTurns: readonly Turn[] | undefined;
  let heldItems: readonly Item[] | undefined;
  let heldTasks: readonly Task[] | undefined;
  let heldEvents: readonly EngineEvent[] | undefined;
  let consumed = 0;

  let rowOf = new Map<string, Turn>();
  let itemsOf = new Map<string, Item[]>();
  let tasksOf = new Map<string, Task[]>();
  let eventsOf = new Map<string, EngineEvent[]>();
  /** Where a delta's text belongs: the fold files a row under the run its ITEM
   *  names, so a delta has to be partitioned the same way. */
  const runOfItem = new Map<string, string>();
  /** The tab set in force before each `browser.state.changed` event. */
  let previousTabs = new Map<number, readonly { url: string; title: string }[] | undefined>();
  let carry = new Map<string, { url: string; title: string }[]>();
  /**
   * The runs the fold knows about AT EACH POINT in the walk, which is why this
   * grows as events are read rather than being computed up front: `byRun` is
   * seeded from `turns` and then extended by `turn.accepted`, so a browser event
   * that precedes its own run's acceptance advances nothing. A set computed in
   * advance would quietly disagree with the fold about exactly that.
   */
  let live = new Set<string>();
  /** The output order, which is the fold's own: every turn in `turns`, then each
   *  run a `turn.accepted` introduced, in event order. */
  let order: string[] = [];

  return (turns, items, events, tasks = []) => {
    const turnsMoved = !sameRows(heldTurns, turns);
    if (turnsMoved) {
      rowOf = new Map(turns.map((turn) => [turn.runId, turn]));
      heldTurns = turns;
    }
    if (!sameRows(heldItems, items)) {
      itemsOf = new Map();
      for (const item of items) {
        const held = itemsOf.get(item.runId);
        if (held) held.push(item);
        else itemsOf.set(item.runId, [item]);
        runOfItem.set(item.id, item.runId);
      }
      heldItems = items;
    }
    if (!sameRows(heldTasks, tasks)) {
      tasksOf = new Map();
      for (const task of tasks) {
        const held = tasksOf.get(task.runId);
        if (held) held.push(task);
        else tasksOf.set(task.runId, [task]);
      }
      heldTasks = tasks;
    }

    /**
     * THE JOURNAL IS WALKED ONCE, AND ONLY FORWARD — the difference between a
     * streaming turn costing what it just produced and costing everything the
     * conversation has produced all session. The walk resumes where the last one
     * stopped, as long as the array it is handed still begins with what has
     * already been read. It does not when the tail is replaced wholesale (a
     * hydrate, a reconnect), nor when `turns` moved: the run set seeds the carry
     * rule below, and a different seed can reach a different answer for an event
     * that has already been walked.
     */
    if (turnsMoved || heldEvents === undefined || !extendsPrefix(heldEvents, events, consumed)) {
      eventsOf = new Map();
      previousTabs = new Map();
      carry = new Map();
      live = new Set(rowOf.keys());
      order = [...rowOf.keys()];
      consumed = 0;
    }
    for (let index = consumed; index < events.length; index += 1) {
      const event = events[index]!;
      if (event.type === "turn.accepted" && !live.has(event.turn.runId)) {
        live.add(event.turn.runId);
        order.push(event.turn.runId);
      }
      if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
        runOfItem.set(event.item.id, event.item.runId);
      }
      for (const runId of runsTouched(event, runOfItem)) {
        const held = eventsOf.get(runId);
        if (held) held.push(event);
        else eventsOf.set(runId, [event]);
      }
      // The carry advances only on an event the fold could FILE, which is the
      // rule `projectJournal` applies by returning before it writes.
      if (event.type === "browser.state.changed" && event.runId && live.has(event.runId)) {
        previousTabs.set(event.id, carry.get(event.sessionId));
        carry.set(event.sessionId, event.tabs);
      }
    }
    consumed = events.length;
    heldEvents = events;

    const slices = order.map((runId) => {
      const row = rowOf.get(runId);
      const runItems = itemsOf.get(runId) ?? NO_ITEMS;
      const runTasks = tasksOf.get(runId) ?? NO_TASKS;
      const runEvents = eventsOf.get(runId) ?? NO_EVENTS;
      const held = folds.get(runId);
      const reusable =
        held !== undefined &&
        held.row === row &&
        held.items === runItems &&
        held.tasks === runTasks &&
        held.events === runEvents &&
        held.eventCount === runEvents.length;
      return { runId, row, runItems, runTasks, runEvents, out: reusable ? held!.out : undefined };
    });

    /**
     * WHEN NOTHING CAN BE REUSED, FOLD THE WHOLE THING ONCE.
     *
     * A companion snapshot replaces every row with a fresh object, so every
     * entry misses — and ten one-turn folds are strictly more work than one
     * ten-turn fold, for an identical answer. Falling back here is what keeps
     * the memo from being a tax on the one case it cannot help with. The slices
     * above are still needed either way: they are what the NEXT tick compares
     * against.
     */
    const whole =
      slices.length > 1 && slices.every((slice) => slice.out === undefined)
        ? new Map(projectJournal(turns, items, events, tasks).map((turn) => [turn.runId, turn]))
        : undefined;

    // Rebuilt rather than pruned, so a run that left the window — a page
    // scrolled away, a conversation switched — takes its cache entry with it.
    const next = new Map<string, ProjectedRun>();
    const projected: JournalTurn[] = [];
    for (const slice of slices) {
      const folded =
        slice.out ??
        whole?.get(slice.runId) ??
        projectJournal(
          slice.row ? [slice.row] : [],
          slice.runItems as Item[],
          slice.runEvents as EngineEvent[],
          slice.runTasks as Task[],
          previousTabs,
        ).find((turn) => turn.runId === slice.runId);
      // A run named only by rows the fold drops (an item whose turn nobody sent)
      // produces nothing, exactly as the whole-journal fold does.
      if (!folded) continue;
      next.set(slice.runId, {
        row: slice.row,
        items: slice.runItems,
        tasks: slice.runTasks,
        events: slice.runEvents,
        eventCount: slice.runEvents.length,
        out: folded,
      });
      projected.push(folded);
    }
    folds = next;
    return projected;
  };
}
