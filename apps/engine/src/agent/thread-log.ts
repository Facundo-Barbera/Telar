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

/**
 * ── THE SAME SEARCH `/v2/sessions/find` HAS, OVER THE AGENT'S OWN ROWS ──────
 *
 * `recall` answers "what did we decide about the dictation work" from the
 * Agent's own conversation, and it has to keep answering it after the summary
 * compaction has folded that turn out of the prompt. The rows are still here —
 * that is the whole point of the transcript being its own table — so the only
 * thing missing was an index.
 *
 * FTS5 IS PROBED, NEVER ASSUMED. `execution-store.ts` states the reason and
 * this is the same two sqlite builds: `bun:sqlite` has the module, `node:sqlite`
 * under Electron-as-Node may not. A store that cannot have the virtual table
 * says `like` and searches with a bounded scan of the same rows. No new
 * dependency either way.
 *
 * WHAT IS INDEXED IS A PROJECTION, not the raw `detail` JSON. A row's detail
 * carries ids, statuses and whole tool arguments; indexing them would match
 * `run_1a2b` against a search for a word. `searchText` below decides what a row
 * SAYS, per kind, and that is what goes in.
 */
const CREATE_SEARCH = `CREATE VIRTUAL TABLE IF NOT EXISTS agent_search USING fts5(
    text, row_id UNINDEXED, thread_id UNINDEXED, tokenize='unicode61 remove_diacritics 2')`;

/** How many rows one backfill pass indexes. A thread that predates the index is
 *  caught up in one open; a pathological one is caught up over a few, and
 *  searches the rest with the `LIKE` path meanwhile. */
const BACKFILL_LIMIT = 20_000;

/** How many matching rows a search looks at before it answers — `FIND_SCAN`'s
 *  own argument, one conversation wide instead of one engine wide. */
const RECALL_SCAN = 200;

export type AgentRecallHit = { id: number; runId: string; at: number; kind: AgentRowKind; why: string };

/**
 * WHAT A ROW SAYS, as opposed to what it records.
 *
 * A tool call is indexed by its NAME AND ITS ANSWER, because "which session did
 * I find" is a question about what came back. A request is indexed by the tool
 * it was about. `turn_started` says nothing and is not indexed at all — an
 * empty row in an index is a row every query has to skip.
 */
export function searchText(kind: AgentRowKind, detail: Record<string, unknown>): string {
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  if (kind === "user_message" || kind === "assistant_message") return text(detail.text);
  if (kind === "turn_done") return text(detail.text);
  if (kind === "tool_call") return [text(detail.name), text(detail.output)].filter(Boolean).join("\n");
  if (kind === "request_opened" || kind === "request_resolved") return [text(detail.tool), text(detail.reason)].filter(Boolean).join(" ");
  return "";
}

export class AgentThreadLog {
  /** Which engine `recall` runs on — probed on open, exactly as the execution
   *  store probes its own. */
  readonly searchIndex: "fts5" | "like";

  constructor(private readonly db: NativeDatabase) {
    this.db.exec(CREATE);
    this.searchIndex = this.openSearchIndex();
    if (this.searchIndex === "fts5") this.backfill();
  }

  private openSearchIndex(): "fts5" | "like" {
    try {
      this.db.exec(CREATE_SEARCH);
      return "fts5";
    } catch {
      return "like";
    }
  }

  /**
   * ROWS WRITTEN BEFORE THE INDEX EXISTED, indexed now.
   *
   * KEYED ON THE HIGHEST ROW ALREADY IN, so the steady state is one `MAX` and
   * no work: `append` indexes as it writes, and a thread that has always had
   * this table finds nothing to do. A thread that predates it is a one-off
   * catch-up on the first open after upgrading.
   */
  private backfill(): void {
    try {
      const highest = this.db.prepare("SELECT MAX(row_id) AS id FROM agent_search").get() as { id: number | bigint | null } | undefined;
      const after = highest?.id ? Number(highest.id) : 0;
      const rows = this.db
        .prepare("SELECT id, thread_id, kind, detail FROM agent_rows WHERE id > ? ORDER BY id LIMIT ?")
        .all(after, BACKFILL_LIMIT) as Array<{ id: number | bigint; thread_id: string; kind: string; detail: string }>;
      for (const raw of rows) {
        let detail: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(raw.detail);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) detail = parsed as Record<string, unknown>;
        } catch {
          // A row whose payload will not parse is indexed as nothing rather
          // than stopping the catch-up around it.
        }
        this.index(Number(raw.id), raw.thread_id, raw.kind as AgentRowKind, detail);
      }
    } catch {
      // A catch-up that fails leaves `recall` finding fewer old rows, which is
      // not a reason the Agent cannot open its transcript.
    }
  }

  private index(id: number, threadId: string, kind: AgentRowKind, detail: Record<string, unknown>): void {
    if (this.searchIndex !== "fts5") return;
    const text = searchText(kind, detail);
    if (!text.trim()) return;
    this.db.prepare("INSERT INTO agent_search(text, row_id, thread_id) VALUES(?,?,?)").run(text, id, threadId);
  }

  /** Append one row and answer it, id and all — the caller pushes exactly what
   *  it stored, so a live watcher and a later page cannot disagree. */
  append(input: { threadId: string; runId: string; at: number; kind: AgentRowKind; detail: Record<string, unknown> }): AgentRow {
    this.db
      .prepare("INSERT INTO agent_rows (thread_id, run_id, at, kind, detail) VALUES (?, ?, ?, ?, ?)")
      .run(input.threadId, input.runId, input.at, input.kind, JSON.stringify(input.detail));
    const row = this.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number | bigint };
    const id = Number(row.id);
    this.index(id, input.threadId, input.kind, input.detail);
    return { id, ...input };
  }

  /**
   * WHAT THIS CONVERSATION SAID ABOUT SOMETHING — `recall`'s one read.
   *
   * NEWEST FIRST, because a coordinator asking "what did we decide" means the
   * last time it was decided. Bounded twice: the scan is capped, and the caller
   * takes a page off the front of it.
   *
   * EVERY TERM IS QUOTED AS A PHRASE for `findSessions`'s own reason — fts5's
   * query language has operators a person searching their own conversation
   * never meant to type.
   */
  search(threadId: string, terms: readonly string[], limit: number): AgentRecallHit[] {
    if (terms.length === 0) return [];
    const wanted = Math.max(1, Math.min(limit, 50));
    const rows =
      this.searchIndex === "fts5"
        ? (this.db
            .prepare(
              `SELECT r.id AS id, r.run_id AS run_id, r.at AS at, r.kind AS kind, s.text AS text
                 FROM agent_search s JOIN agent_rows r ON r.id = s.row_id
                 WHERE s.thread_id = ? AND agent_search MATCH ? ORDER BY r.id DESC LIMIT ?`,
            )
            .all(threadId, terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" AND "), RECALL_SCAN) as Array<{
            id: number | bigint;
            run_id: string;
            at: number;
            kind: string;
            text: string;
          }>)
        : (this.db
            .prepare(
              `SELECT id, run_id, at, kind, detail AS text FROM agent_rows
                 WHERE thread_id = ? AND detail LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?`,
            )
            .all(threadId, `%${terms[0]!.replace(/[\\%_]/g, (character) => `\\${character}`)}%`, RECALL_SCAN) as Array<{
            id: number | bigint;
            run_id: string;
            at: number;
            kind: string;
            text: string;
          }>);

    const hits: AgentRecallHit[] = [];
    for (const raw of rows) {
      if (hits.length >= wanted) break;
      const why = quote(String(raw.text), terms);
      if (!why) continue;
      hits.push({ id: Number(raw.id), runId: raw.run_id, at: Number(raw.at), kind: raw.kind as AgentRowKind, why });
    }
    return hits;
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

  /**
   * A PAGE BACKWARD FROM THE END — what opening a long conversation actually
   * wants (#580).
   *
   * `page` above answers "what is new", which is the right read for a poll and
   * the wrong one for an open: `after` is exclusive and `0` is the beginning,
   * so a phone opening a 584-row thread walked the whole of it, oldest first,
   * before it could draw a single line. This reads the OTHER end.
   *
   * `before` IS EXCLUSIVE, and omitting it means the tail. The rows come back
   * ASCENDING like every other read here, so a client PREPENDS a block rather
   * than reversing one, and `oldest` is the next `before`.
   *
   * `more` KEEPS ITS WORD and changes its direction: on `page` it means newer
   * rows are waiting, here it means older ones are. Both read as "there is
   * more where you are going", which is the only thing a pager does with it.
   *
   * `cursor` IS THE THREAD'S TIP, NOT THIS WINDOW'S TOP. A client pages
   * backward for history and polls forward from the tip; handing it the top of
   * an old window would send the next poll into the middle of the
   * conversation and replay everything after it.
   */
  window(threadId: string, options: { before?: number; limit: number }): { rows: AgentRow[]; cursor: number; oldest?: number; more: boolean } {
    const wanted = Math.max(1, Math.min(options.limit, THREAD_PAGE_MAX));
    // One over, to tell a full window from a full window with more behind it.
    const read = (options.before === undefined
      ? this.db
          .prepare("SELECT id, thread_id, run_id, at, kind, detail FROM agent_rows WHERE thread_id = ? ORDER BY id DESC LIMIT ?")
          .all(threadId, wanted + 1)
      : this.db
          .prepare("SELECT id, thread_id, run_id, at, kind, detail FROM agent_rows WHERE thread_id = ? AND id < ? ORDER BY id DESC LIMIT ?")
          .all(threadId, options.before, wanted + 1)) as Array<{ id: number | bigint; thread_id: string; run_id: string; at: number; kind: string; detail: string }>;

    // NEWEST FIRST WHILE SPENDING THE BUDGET, so a window that runs out of
    // bytes drops the OLDEST rows in it — the ones the next `before` will ask
    // for anyway — rather than the ones the reader is about to look at.
    const rows: AgentRow[] = [];
    let chars = 0;
    let more = read.length > wanted;
    for (const raw of read.slice(0, wanted)) {
      const size = raw.detail.length;
      if (rows.length > 0 && chars + size > THREAD_PAGE_CHARS) {
        more = true;
        break;
      }
      rows.push(decode(raw));
      chars += size;
    }
    rows.reverse();
    return { rows, cursor: this.cursor(threadId), ...(rows[0] ? { oldest: rows[0].id } : {}), more };
  }

  /** The last row's id, so a client opening on the tail can subscribe from the
   *  end without paging a whole conversation to reach it. */
  cursor(threadId: string): number {
    const row = this.db.prepare("SELECT MAX(id) AS id FROM agent_rows WHERE thread_id = ?").get(threadId) as { id: number | bigint | null } | undefined;
    return row?.id ? Number(row.id) : 0;
  }
}

/**
 * THE LINE A HIT IS IN, so a caller is not taking the engine's word for the
 * match — `findSessions`'s `why`, one conversation down.
 *
 * `WHY_CHARS` IS THE SAME NUMBER the session search uses, deliberately: a
 * quotation long enough to be a sentence and short enough that a page of them
 * is a page.
 */
const WHY_CHARS = 200;

function quote(text: string, terms: readonly string[]): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const found = lines.find((line) => terms.some((term) => line.toLowerCase().includes(term.toLowerCase()))) ?? lines.find((line) => line.trim());
  const line = (found ?? "").trim();
  if (!line) return "";
  return line.length <= WHY_CHARS ? line : `${line.slice(0, WHY_CHARS - 1)}…`;
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
