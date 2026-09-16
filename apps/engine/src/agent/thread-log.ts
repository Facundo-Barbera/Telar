/**
 * THE CONVERSATION A PERSON READS — rows, not checkpoints (#531).
 *
 * ── WHY THE CHECKPOINT IS NOT THE TRANSCRIPT ────────────────────────────────
 * A LangGraph checkpoint is the graph's state in the framework's own serde: a
 * blob keyed by a checkpoint id, holding whatever the reducer last produced.
 * Three things make it the wrong thing to draw a conversation from:
 *
 *   · IT IS NOT APPENDED TO — it is REPLACED. There is no id a client can page
 *     from, so "what happened since I last looked" has no cheap answer, and the
 *     phone polling `/v2/agent/thread?after=` would have to diff two blobs.
 *   · IT IS TRIMMED. The pre-model step drops the oldest blocks once a
 *     conversation passes 120k characters — correctly, because that is what the
 *     MODEL should see. A person scrolling up has not agreed to forget.
 *   · IT IS THE FRAMEWORK'S FORMAT. Rendering it would tie the cockpit and iOS
 *     to a package version.
 *
 * So the rows are their own append-only table, with an integer primary key that
 * only ever goes up — which is exactly the keyset `sessions_read` already
 * gives every other surface in this engine.
 *
 * ── IN THE SAME FILE, ON PURPOSE ────────────────────────────────────────────
 * `threads.sqlite` holds both, sharing one handle. One file is one thing to
 * back up, one thing to close, and one thing for a reset to move aside; a
 * transcript that survived a reset of the conversation it describes would be a
 * scroll-back about a thread that no longer exists.
 *
 * ── DELTAS ARE NOT ROWS ─────────────────────────────────────────────────────
 * A token is written nowhere. It is pushed to whoever is watching and then
 * folded into the ONE assistant row written when the message completes. Storing
 * per-token rows would multiply the transcript by a hundred to answer a
 * question — "what did it say" — that the completed row answers exactly.
 */
import type { NativeDatabase } from "./checkpointer";

/** What a row is about. Deliberately close to `ItemDetail`'s vocabulary so a
 *  client that already renders a session's transcript recognises the shapes. */
export type AgentRowKind =
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "request_opened"
  | "request_resolved"
  | "turn_started"
  | "turn_done";

export type AgentRow = {
  /** Monotonic within a thread. The cursor every reader pages by. */
  id: number;
  threadId: string;
  runId: string;
  at: number;
  kind: AgentRowKind;
  /** The row's own payload, shaped by `kind`. Kept as one JSON column rather
   *  than as columns per kind: nothing queries inside it, and a schema change
   *  in the cockpit should not be a migration here. */
  detail: Record<string, unknown>;
};

const CREATE = `CREATE TABLE IF NOT EXISTS agent_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS agent_rows_thread ON agent_rows(thread_id, id);`;

/**
 * THE BOUND ON ONE PAGE — `#515`'s rule, applied to the Agent's transcript.
 *
 * Two numbers, whichever is reached first, because a row is mostly free text
 * somebody typed: a count alone lets fifty rows carrying a megabyte through,
 * and a byte budget alone returns four thousand tiny ones. The first row always
 * goes through whatever it costs, so a cursor can never fail to advance.
 */
export const THREAD_PAGE_DEFAULT = 50;
export const THREAD_PAGE_MAX = 200;
const THREAD_PAGE_CHARS = 64_000;

export class AgentThreadLog {
  constructor(private readonly db: NativeDatabase) {
    this.db.exec(CREATE);
  }

  /** Append one row and answer it, id and all — the caller pushes exactly what
   *  it stored, so a live watcher and a later page cannot disagree. */
  append(input: { threadId: string; runId: string; at: number; kind: AgentRowKind; detail: Record<string, unknown> }): AgentRow {
    this.db
      .prepare("INSERT INTO agent_rows (thread_id, run_id, at, kind, detail) VALUES (?, ?, ?, ?, ?)")
      .run(input.threadId, input.runId, input.at, input.kind, JSON.stringify(input.detail));
    const row = this.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number | bigint };
    return { id: Number(row.id), ...input };
  }

  /**
   * A PAGE FORWARD FROM A CURSOR — the shape every other read in this engine
   * has, so a client written for `sessions_read` needs no second idea.
   *
   * `after` IS EXCLUSIVE and `0` means the beginning, which is what a first
   * read passes. `more` is exact because one row past the limit is read and
   * dropped rather than guessed at.
   */
  page(threadId: string, after: number, limit: number): { rows: AgentRow[]; cursor: number; more: boolean } {
    const wanted = Math.max(1, Math.min(limit, THREAD_PAGE_MAX));
    const read = this.db
      .prepare("SELECT id, thread_id, run_id, at, kind, detail FROM agent_rows WHERE thread_id = ? AND id > ? ORDER BY id LIMIT ?")
      .all(threadId, after, wanted + 1) as Array<{ id: number | bigint; thread_id: string; run_id: string; at: number; kind: string; detail: string }>;

    const rows: AgentRow[] = [];
    let chars = 0;
    let more = read.length > wanted;
    for (const raw of read.slice(0, wanted)) {
      const row = decode(raw);
      const size = raw.detail.length;
      if (rows.length > 0 && chars + size > THREAD_PAGE_CHARS) {
        more = true;
        break;
      }
      rows.push(row);
      chars += size;
    }
    return { rows, cursor: rows.at(-1)?.id ?? after, more };
  }

  /** The last row's id, so a client opening on the tail can subscribe from the
   *  end without paging a whole conversation to reach it. */
  cursor(threadId: string): number {
    const row = this.db.prepare("SELECT MAX(id) AS id FROM agent_rows WHERE thread_id = ?").get(threadId) as { id: number | bigint | null } | undefined;
    return row?.id ? Number(row.id) : 0;
  }
}

function decode(raw: { id: number | bigint; thread_id: string; run_id: string; at: number; kind: string; detail: string }): AgentRow {
  let detail: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw.detail);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) detail = parsed as Record<string, unknown>;
  } catch {
    // A row whose payload will not parse is still a row that happened; it is
    // shown as an empty one rather than taking down the page around it.
  }
  return { id: Number(raw.id), threadId: raw.thread_id, runId: raw.run_id, at: Number(raw.at), kind: raw.kind as AgentRowKind, detail };
}
