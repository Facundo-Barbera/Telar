/**
 * THE AGENT'S INBOX — what happened while nobody was talking to it (#541 A).
 *
 * ── WHY A WAKE IS NO LONGER A TURN ──────────────────────────────────────────
 * A subscribed session finishing used to START AN AGENT TURN (#531 step 6): a
 * model call, a full lap of the graph, a row in the transcript, tokens spent —
 * to announce a fact nobody had asked about yet. Four workers under one Agent
 * meant four turns at 3am, each one reading the whole conversation to say "and
 * that one finished too". The Agent does not act on a completion; it tells the
 * PERSON about it, next time they speak.
 *
 * So the happening lands here instead, and starts nothing. `./digest.ts` renders
 * what is unread at the top of the next turn a person begins, as a projection
 * with no model call in it. That is the whole trade: a wake costs one INSERT
 * rather than one conversation.
 *
 * ── IN `threads.sqlite`, ON THE SAME HANDLE ─────────────────────────────────
 * Beside `agent_rows`, for `thread-log.ts`'s own reason: one file is one thing
 * to back up, one thing to close, and one thing for a reset to move aside. An
 * inbox that survived a reset of the conversation it was about would announce
 * four completions to a thread that had never heard of the work.
 *
 * ── SCOPED BY THREAD, LIKE EVERY ROW IN THIS FILE ───────────────────────────
 * `thread_id` is not on the wire shape — the issue's row is
 * `{id, at, sessionId, runId, kind, summary, read}` — it is the same internal
 * scoping `agent_rows` carries, so that a row written in the instant between a
 * reset aborting the live turn and that turn unwinding cannot land on the new
 * conversation.
 */
import type { AgentMessageIntent, NotificationDetail, WakeKind } from "@telar/engine-client";
import type { NativeDatabase } from "./checkpointer";

/**
 * WHAT ONE ROW IS ABOUT.
 *
 * The four wake transitions as they are named everywhere else in this engine —
 * NOT `NotificationKind`'s three, which collapse the three terminal ones into
 * "wake" and would make the digest's ranking (failed above completed) something
 * the renderer had to reconstruct from a second field.
 *
 * `peer_message` IS THE FIFTH, and it has no producer yet: nothing in this
 * engine can `sessions_send` to the Agent, because `submitAgentTurn` takes a
 * session id and the Agent is a LangGraph thread rather than a session (see
 * `./identity.ts`). It is in the vocabulary because the shape #541 asks for
 * names it, and because the day something CAN address the Agent, the row it
 * writes should not need a migration to exist.
 *
 * `request_timeout` IS THE SIXTH and it is #541 D: a request that ran out its
 * deadline and took the default its asker had stated, because nobody came. Its
 * producer is `EngineStore.sweepRequestDeadlines`.
 *
 * IT IS DELIBERATELY NOT `request_opened`. That kind ranks first in the digest,
 * under the heading WAITING ON YOU, and a request that has already resolved is
 * precisely the one thing nobody is waiting on — reusing the kind would have put
 * closed business at the top of every turn as an ask. See `./digest.ts`.
 */
export type AgentInboxKind = WakeKind | "peer_message" | "request_timeout";

export type AgentInboxRow = {
  /** Monotonic within the file. The cursor a reader pages by, and the id a
   *  client hands back to `markRead`. */
  id: number;
  at: number;
  /** The session this is ABOUT. */
  sessionId: string;
  /** Its turn — the one that ended, or the one a request belongs to. */
  runId: string;
  kind: AgentInboxKind;
  /** For a peer message: what the sender said it was. */
  intent?: AgentMessageIntent;
  /** ONE LINE, AND IT IS THE NOTIFICATION'S OWN — `notification.ts` already
   *  clamps a first line to 240 characters for exactly this job (#550), so a
   *  second phrasing here would be a fifth reader computing a fifth answer. */
  summary: string;
  read: boolean;
};

const CREATE = `CREATE TABLE IF NOT EXISTS agent_inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    intent TEXT,
    summary TEXT NOT NULL,
    read INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS agent_inbox_thread ON agent_inbox(thread_id, id);
  CREATE INDEX IF NOT EXISTS agent_inbox_unread ON agent_inbox(thread_id, read, id);`;

/** The page bounds, `thread-log.ts`'s own pair of numbers. A row here is one
 *  clamped line rather than free text, so there is no byte budget beside the
 *  count: 200 summaries cannot run away the way 200 transcript rows can. */
export const INBOX_PAGE_DEFAULT = 50;
export const INBOX_PAGE_MAX = 200;

/**
 * HOW MANY UNREAD ROWS THE DIGEST WILL EVER LOOK AT.
 *
 * The digest is capped in CHARACTERS (`./digest.ts`), and everything past the
 * cap becomes a count — so the only thing reading more rows buys is a bigger
 * number in "and N more". Past this the count is reported as "N+", which is
 * honest and bounded, where an unbounded read would have a machine that was
 * left running over a holiday walk ten thousand rows to compute it.
 */
export const INBOX_DIGEST_SCAN = 500;

export class AgentInbox {
  constructor(private readonly db: NativeDatabase) {
    this.db.exec(CREATE);
  }

  /** Append one row and answer it, id and all — the caller pushes exactly what
   *  it stored, so a live watcher and a later page cannot disagree. */
  append(input: { threadId: string; at: number; sessionId: string; runId: string; kind: AgentInboxKind; intent?: AgentMessageIntent; summary: string }): AgentInboxRow {
    this.db
      .prepare("INSERT INTO agent_inbox (thread_id, at, session_id, run_id, kind, intent, summary, read) VALUES (?, ?, ?, ?, ?, ?, ?, 0)")
      .run(input.threadId, input.at, input.sessionId, input.runId, input.kind, input.intent ?? null, input.summary);
    const row = this.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number | bigint };
    return {
      id: Number(row.id),
      at: input.at,
      sessionId: input.sessionId,
      runId: input.runId,
      kind: input.kind,
      ...(input.intent ? { intent: input.intent } : {}),
      summary: input.summary,
      read: false,
    };
  }

  /**
   * A PAGE FORWARD FROM A CURSOR — the shape every other read in this engine
   * has. `after` is exclusive and `0` is the beginning.
   *
   * `unreadOnly` IS WHAT THE SECTION ABOVE THE COMPOSER ASKS FOR, and it is a
   * filter rather than a second method because the cursor contract has to be
   * the same either way: a client that pages unread rows and a client that pages
   * all of them both hand back the id they last saw.
   */
  page(threadId: string, options: { after?: number; limit?: number; unreadOnly?: boolean } = {}): { rows: AgentInboxRow[]; cursor: number; more: boolean } {
    const after = Math.max(0, options.after ?? 0);
    const wanted = Math.max(1, Math.min(options.limit ?? INBOX_PAGE_DEFAULT, INBOX_PAGE_MAX));
    const read = this.db
      .prepare(
        `SELECT id, at, session_id, run_id, kind, intent, summary, read FROM agent_inbox
         WHERE thread_id = ? AND id > ?${options.unreadOnly ? " AND read = 0" : ""} ORDER BY id LIMIT ?`,
      )
      .all(threadId, after, wanted + 1) as RawRow[];
    const rows = read.slice(0, wanted).map(decode);
    return { rows, cursor: rows.at(-1)?.id ?? after, more: read.length > wanted };
  }

  /** What the digest is built from: the unread rows, oldest first, bounded. */
  unread(threadId: string, limit = INBOX_DIGEST_SCAN): AgentInboxRow[] {
    return (
      this.db
        .prepare("SELECT id, at, session_id, run_id, kind, intent, summary, read FROM agent_inbox WHERE thread_id = ? AND read = 0 ORDER BY id LIMIT ?")
        .all(threadId, Math.max(1, limit)) as RawRow[]
    ).map(decode);
  }

  /** How many are waiting — the number the rail's row badges. */
  unreadCount(threadId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM agent_inbox WHERE thread_id = ? AND read = 0").get(threadId) as { n: number | bigint } | undefined;
    return row ? Number(row.n) : 0;
  }

  /**
   * MARK THESE READ, AND ANSWER HOW MANY ACTUALLY MOVED.
   *
   * SCOPED TO THE THREAD, so an id from an archived conversation cannot clear a
   * row in the live one, and COUNTED FROM THE ROWS RATHER THAN FROM THE IDS: a
   * client that sends the same id twice, or one that was already read, is told
   * `0` rather than being congratulated on a write that did nothing.
   */
  markRead(threadId: string, ids: readonly number[]): number {
    const wanted = [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (wanted.length === 0) return 0;
    let moved = 0;
    for (const id of wanted) {
      const before = this.db.prepare("SELECT read FROM agent_inbox WHERE thread_id = ? AND id = ?").get(threadId, id) as { read: number | bigint } | undefined;
      if (!before || Number(before.read) !== 0) continue;
      this.db.prepare("UPDATE agent_inbox SET read = 1 WHERE thread_id = ? AND id = ?").run(threadId, id);
      moved += 1;
    }
    return moved;
  }
}

type RawRow = {
  id: number | bigint;
  at: number | bigint;
  session_id: string;
  run_id: string;
  kind: string;
  intent: string | null;
  summary: string;
  read: number | bigint;
};

function decode(raw: RawRow): AgentInboxRow {
  return {
    id: Number(raw.id),
    at: Number(raw.at),
    sessionId: raw.session_id,
    runId: raw.run_id,
    kind: raw.kind as AgentInboxKind,
    ...(raw.intent ? { intent: raw.intent as AgentMessageIntent } : {}),
    summary: raw.summary,
    read: Number(raw.read) !== 0,
  };
}

/**
 * A NOTIFICATION AS THE ROW IT BECOMES — #550's shape, unchanged, read for the
 * four fields an inbox row keeps.
 *
 * THE KIND COMES OFF `wakeKind` WHERE THERE IS ONE, because `NotificationKind`
 * has already collapsed the three terminal transitions into "wake" and the
 * digest ranks failed above completed. A `request` with no `wakeKind` falls back
 * to `request_opened`, since that is the transition an ordinary request
 * notification is about.
 *
 * `kind` OVERRIDES ALL OF THAT, and exists for the one row whose transition
 * `NotificationKind` cannot express: a deadline taking a request's default
 * (#541 D). The alternative was a fourth `NotificationKind`, which would have
 * rippled into every surface that renders a SESSION's notification item — for a
 * distinction only the Agent's own inbox has any use for. The caller that knows
 * passes it; nothing else does.
 *
 * NO `sessionId` MEANS NO ROW. Every inbox row names a session a person can be
 * pointed at; a notification with none is an agent outside any session, which
 * nothing can produce for the Agent today and which the digest would have
 * nothing to say about.
 */
export function inboxRowFromNotification(detail: NotificationDetail, kindOverride?: AgentInboxKind): { sessionId: string; runId: string; kind: AgentInboxKind; intent?: AgentMessageIntent; summary: string } | undefined {
  const sessionId = detail.sessionId;
  if (!sessionId) return undefined;
  const kind: AgentInboxKind = kindOverride ?? detail.wakeKind ?? (detail.kind === "peer_message" ? "peer_message" : "request_opened");
  return {
    sessionId,
    runId: detail.runId ?? "",
    kind,
    ...(detail.intent ? { intent: detail.intent } : {}),
    summary: detail.summary,
  };
}
