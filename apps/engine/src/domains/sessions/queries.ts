import {
  Turn as TurnSchema,
  type EngineRequest,
  type Item,
  type Task,
  type Turn,
} from "@telar/engine-client";
import { EngineStateError, type Kernel } from "../../platform/kernel";
import { boundedOutline, context, FIND_SCAN, firstLine, GREP_CONTEXT_CHARS, ITEM_TITLE_CHARS, type OutlineRow, outlineRow, TURN_ANSWER_NO_SUCH_RUN, TURN_ANSWER_NONE, WHY_CHARS } from "../turns";
import type { SessionItems } from "./items";
import { sessionQueueFile, sessionQueueIndexFile, type SessionQueue } from "./queue";
import type { SessionRecords } from "./records";
import type { SessionRequests } from "./requests";
import { rowIsShelved } from "./session-index";
import type { SessionTasks } from "./tasks";

// `steered` is terminal: its words live inside the run it joined.
export const ACTIVE_TURN_STATES = new Set<Turn["state"]>(["queued", "claimed", "running", "steering"]);
// Nothing renders settled requests beyond a handful above the composer; open ones are never dropped.
const SNAPSHOT_SETTLED_REQUESTS = 50;

function boundedRequests(all: EngineRequest[], chosen?: Set<string>): EngineRequest[] {
  const carried = chosen === undefined ? all : all.filter((request) => chosen.has(request.runId) || request.state === "open");
  const settled = carried.filter((request) => request.state !== "open");
  if (settled.length <= SNAPSHOT_SETTLED_REQUESTS) return carried;
  const dropped = new Set(settled.slice(0, settled.length - SNAPSHOT_SETTLED_REQUESTS));
  return carried.filter((request) => !dropped.has(request));
}

// Shared by the indexed read and the whole-document fallback so the two cannot disagree about a page.
function planWindow(
  rows: Array<{ key: string; tag?: string }>,
  window: { limit: number; before?: string },
): { chosen: Set<string>; page: { before: string | null; more: boolean; total: number } } {
  let end = rows.length;
  if (window.before !== undefined) {
    end = rows.findIndex((row) => row.key === window.before);
    if (end === -1) throw new EngineStateError("not_found", "page cursor names no turn in this session");
  }
  const active = (row: { tag?: string }): boolean => ACTIVE_TURN_STATES.has(row.tag as Turn["state"]);
  const settled = rows.slice(0, end).filter((row) => !active(row));
  const start = Math.max(0, settled.length - window.limit);
  const paged = settled.slice(start);
  // The active tail is never paged out — but only on the FIRST page; an older
  // page is history and must not repeat rows the client already has.
  const unsettled = window.before === undefined ? rows.filter(active) : [];
  return {
    chosen: new Set([...paged, ...unsettled].map((row) => row.key)),
    page: { before: start > 0 ? (paged[0]?.key ?? null) : null, more: start > 0, total: rows.length },
  };
}

type QueryDeps = {
  records: SessionRecords;
  items: SessionItems;
  tasks: SessionTasks;
  requests: SessionRequests;
  readQueue: (sessionId: string) => SessionQueue;
  autoSettleAfterHours: () => number | null;
};

/** The bounded reads an orchestrator asks of a conversation, each from the projection or one indexed span. */
export class SessionQueries {
  constructor(
    private readonly kernel: Kernel,
    private readonly deps: QueryDeps,
  ) {}

  /** The newest `limit` turns, keyset by sequence so appends underneath cannot shift the window. */
  turnOutline(sessionId: string, window: { limit: number; before?: number }): {
    turns: OutlineRow[];
    total: number;
    more: boolean;
    next?: number;
  } {
    this.assertSessionExists(sessionId);
    const store = this.kernel.executionStore;
    const read = store.outlineRows(sessionId, window.before, window.limit + 1);
    const page = boundedOutline(read.map(outlineRow), window.limit);
    const more = page.length < read.length;
    return {
      turns: page,
      total: store.turnSummaryCount(sessionId),
      more,
      ...(more ? { next: page.at(-1)!.sequence } : {}),
    };
  }

  /** One run's steps with their size, so a reader knows what a step costs before fetching it. */
  runItems(sessionId: string, runId: string): Array<{ index: number; id: string; title: string; status: Item["status"]; bytes: number }> {
    this.assertSessionExists(sessionId);
    return this.runItemsInOrder(sessionId, runId).map((item, index) => ({
      index,
      id: item.id,
      title: firstLine(item.title ?? item.detail.type, ITEM_TITLE_CHARS),
      status: item.status,
      bytes: Buffer.byteLength(JSON.stringify(item.detail), "utf8"),
    }));
  }

  /** One step by position or id, its detail clamped to `maxChars` with a marker for the rest. */
  runItem(sessionId: string, runId: string, step: number | string, maxChars: number): {
    index: number;
    id: string;
    title: string;
    status: Item["status"];
    startedAt: number;
    completedAt?: number;
    taskId?: string;
    text: string;
    totalChars: number;
    more: boolean;
  } {
    this.assertSessionExists(sessionId);
    const items = this.runItemsInOrder(sessionId, runId);
    const index = typeof step === "number" ? step : items.findIndex((item) => item.id === step);
    const item = index >= 0 ? items[index] : undefined;
    if (!item) throw new EngineStateError("not_found", "that run has no such step");
    const text = JSON.stringify(item.detail, null, 2);
    return {
      index,
      id: item.id,
      title: firstLine(item.title ?? item.detail.type, ITEM_TITLE_CHARS),
      status: item.status,
      startedAt: item.startedAt,
      ...(item.completedAt === undefined ? {} : { completedAt: item.completedAt }),
      ...(item.taskId === undefined ? {} : { taskId: item.taskId }),
      text: text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[… ${text.length - maxChars} more characters]`,
      totalChars: text.length,
      more: text.length > maxChars,
    };
  }

  // By the index row: `getSession` would parse the whole queue to answer a 404.
  private assertSessionExists(sessionId: string): void {
    if (!this.kernel.executionStore.sessionRow(sessionId)) throw new EngineStateError("not_found", "session does not exist");
  }

  // One turn by the queue index, falling back to the whole document when there is none.
  private turnByIndex(sessionId: string, runId: string): Turn | undefined {
    const file = sessionQueueFile(this.kernel.paths, sessionId);
    const index = this.kernel.documentIndex(file, sessionQueueIndexFile(this.kernel.paths, sessionId));
    if (!index) return this.deps.readQueue(sessionId).turns.find((turn) => turn.runId === runId);
    const wanted = index.rows.filter((row) => row.key === runId);
    if (wanted.length === 0) return undefined;
    const parsed = TurnSchema.array().safeParse(this.kernel.readIndexedRows(file, wanted));
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid session queue");
    return parsed.data.find((turn) => turn.runId === runId);
  }

  private runItemsInOrder(sessionId: string, runId: string): Item[] {
    return this.deps.items.forRuns(sessionId, new Set([runId])).sort((a, b) => a.startedAt - b.startedAt);
  }

  /** The latest (or named) turn's answer, sliced; the default is the latest turn that left text. */
  turnAnswer(sessionId: string, options: { runId?: string; from: number; limit: number }): {
    runId: string;
    sequence: number;
    text: string;
    from: number;
    totalChars: number;
    more: boolean;
    next?: number;
  } {
    this.assertSessionExists(sessionId);
    const store = this.kernel.executionStore;
    const summary = options.runId === undefined
      ? store.latestAnsweredTurn(sessionId)
      : store.turnSummary(sessionId, options.runId);
    const runId = options.runId ?? summary?.runId;
    if (runId === undefined) throw new EngineStateError("not_found", TURN_ANSWER_NONE);
    const turn = this.turnByIndex(sessionId, runId);
    if (!turn) throw new EngineStateError("not_found", TURN_ANSWER_NO_SUCH_RUN);
    const answer = turn.resultText ?? "";
    const from = Math.min(Math.max(0, options.from), answer.length);
    const text = answer.slice(from, from + options.limit);
    const more = from + text.length < answer.length;
    return {
      runId,
      sequence: turn.sequence,
      text,
      from,
      totalChars: answer.length,
      more,
      ...(more ? { next: from + text.length } : {}),
    };
  }

  /** Journal events containing a substring, newest first; the scan runs in sqlite, never as a regex. */
  grepSession(sessionId: string, pattern: string, window: { limit: number; before?: number }): {
    matches: Array<{ id: number; at: number; type: string; runId?: string; context: string }>;
    more: boolean;
    next?: number;
  } {
    this.assertSessionExists(sessionId);
    const store = this.kernel.executionStore;
    const read = store.grepEvents(sessionId, pattern, window.before, window.limit + 1);
    const rows = read.length > window.limit ? read.slice(0, window.limit) : read;
    const more = read.length > window.limit;
    const needle = pattern.toLowerCase();
    const matches = rows.map((row) => {
      const at = row.value.toLowerCase().indexOf(needle);
      let event: { at?: number; type?: string; runId?: string } = {};
      try { event = JSON.parse(row.value) as typeof event; } catch {}
      return {
        id: row.id,
        at: Number(event.at ?? 0),
        type: String(event.type ?? "unknown"),
        ...(event.runId === undefined ? {} : { runId: String(event.runId) }),
        context: context(row.value, at < 0 ? 0 : at, GREP_CONTEXT_CHARS),
      };
    });
    return { matches, more, ...(more ? { next: rows.at(-1)!.id } : {}) };
  }

  /** Lexical search across sessions (FTS5 when present, else a bounded LIKE), each hit quoting itself. */
  findSessions(query: { q: string; projectId?: string; settled?: boolean; since?: number; limit: number }): {
    sessions: Array<{ id: string; title?: string; projectId?: string; activity: string; updatedAt: number; runId?: string; why: string }>;
    index: "fts5" | "like";
    more: boolean;
  } {
    const store = this.kernel.executionStore;
    const terms = query.q.split(/\s+/).map((term) => term.trim()).filter(Boolean);
    const hits = store.searchTurnText(terms, FIND_SCAN);
    const at = { now: this.kernel.now(), autoSettleAfterHours: this.deps.autoSettleAfterHours() };
    const chosen = new Map<string, { id: string; title?: string; projectId?: string; activity: string; updatedAt: number; runId?: string; why: string }>();
    let more = false;
    for (const hit of hits) {
      if (chosen.has(hit.sessionId)) continue;
      const row = store.sessionRow(hit.sessionId);
      if (!row) continue;
      if (query.projectId !== undefined && row.projectId !== query.projectId) continue;
      if (query.since !== undefined && row.updatedAt < query.since) continue;
      if (query.settled !== undefined) {
        const shelved = row.state !== "active" || rowIsShelved(row, at);
        if (shelved !== query.settled) continue;
      }
      if (chosen.size >= query.limit) { more = true; break; }
      const line = hit.text.split("\n").find((candidate) => terms.some((term) => candidate.toLowerCase().includes(term.toLowerCase()))) ?? hit.text;
      chosen.set(hit.sessionId, {
        id: row.id,
        ...(row.title === undefined ? {} : { title: row.title }),
        ...(row.projectId === undefined ? {} : { projectId: row.projectId }),
        activity: row.activity,
        updatedAt: row.updatedAt,
        ...(hit.runId ? { runId: hit.runId } : {}),
        why: firstLine(line, WHY_CHARS),
      });
    }
    return { sessions: [...chosen.values()], index: store.searchIndex, more };
  }

  /**
   * The newest `limit` settled turns and everything filed under them, plus every unsettled turn and open
   * request whatever the page, so a paged-out question still reaches the composer.
   */
  snapshotWindow(sessionId: string, window: { limit: number; before?: string }): {
    turns: Turn[];
    items: Item[];
    tasks: Task[];
    requests: EngineRequest[];
    page: { before: string | null; more: boolean; total: number };
  } {
    this.deps.records.require(sessionId);
    const plan = this.windowedTurns(sessionId, window);
    const chosen = new Set(plan.turns.map((turn) => turn.runId));
    return structuredClone({
      turns: plan.turns,
      items: this.deps.items.forRuns(sessionId, chosen),
      tasks: [...this.deps.tasks.read(sessionId).values()].filter((task) => chosen.has(task.runId)),
      requests: boundedRequests([...this.deps.requests.read(sessionId).values()], chosen),
      page: plan.page,
    });
  }

  // The index chooses the window without reading; only the chosen span is parsed.
  private windowedTurns(sessionId: string, window: { limit: number; before?: string }): { turns: Turn[]; page: { before: string | null; more: boolean; total: number } } {
    const file = sessionQueueFile(this.kernel.paths, sessionId);
    const index = this.kernel.documentIndex(file, sessionQueueIndexFile(this.kernel.paths, sessionId));
    if (!index) {
      // `readQueue` accounts for itself now (#547), so the explicit call that
      // used to be here would double this read.
      const all = this.deps.readQueue(sessionId).turns;
      const plan = planWindow(all.map((turn) => ({ key: turn.runId, tag: turn.state })), window);
      return { turns: all.filter((turn) => plan.chosen.has(turn.runId)), page: plan.page };
    }
    const plan = planWindow(index.rows, window);
    const span = this.kernel.readIndexedRows(file, index.rows.filter((row) => plan.chosen.has(row.key)));
    const parsed = TurnSchema.array().safeParse(span);
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid session queue");
    return { turns: parsed.data.filter((turn) => plan.chosen.has(turn.runId)), page: plan.page };
  }

  /** A snapshot's requests with no window, bounded like the windowed ones. */
  snapshotRequests(sessionId: string): EngineRequest[] {
    this.deps.records.require(sessionId);
    return structuredClone(boundedRequests([...this.deps.requests.read(sessionId).values()]));
  }
}
