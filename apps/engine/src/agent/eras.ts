/**
 * THE CONVERSATION IN CACHITOS — a fold, summarised once (#599, owner's own ask).
 *
 * > Deberíamos cortar el transcript en cachitos. Para que cuando vaya pasando el
 * > tiempo, en vez de ir guardando todos los archivos, vamos haciendo pequeños
 * > resúmenes. Muy poco probable que dentro de dos meses una conversación que
 * > tuve hoy sea relevante, pero tal vez un detalle muy mínimo sí.
 *
 * ── THIS IS NOT A DISK CHANGE, AND THAT IS THE FIRST THING TO GET RIGHT ─────
 * The 1.53 GB was `checkpoints`, and `./retention.ts` is what took it to three
 * megabytes. `agent_rows` plus its FTS index is under 5 MB on the same machine
 * and will stay small. So NOTHING HERE DELETES OR REPLACES A TRANSCRIPT ROW.
 * `recall` searches this conversation's own history for the WORDS rather than
 * the gist (`./briefing.ts`), and the owner named the case exactly: a
 * conversation from today is unlikely to matter in two months, but one tiny
 * detail might. A summary destroys precisely that detail. The raw rows and the
 * index are the record; an era is only a cheaper way to carry the past into a
 * PROMPT.
 *
 * ── WHAT IT IS FOR, THEN ────────────────────────────────────────────────────
 * `foldOldTurns` re-derives its whole fold FROM RAW on every lap of every turn:
 * it stringifies every message in the conversation to weigh it, and writes the
 * line for every folded turn again. On a 119-turn thread that is the same old
 * history folded 119 times, and the work grows with the conversation while the
 * ANSWER for an old turn never changes — a turn is closed the moment the next
 * one starts, so its line is settled forever.
 *
 * So the settled part is stored. An era is a run of `ERA_TURNS` consecutive
 * turns, and it holds, per turn, the LINE that stands in for it and the WEIGHT
 * of the turns it replaces. A later turn reads those instead of re-deriving
 * them, and only the tail — the turns behind the live window but not yet a
 * whole era — is computed fresh.
 *
 * ── SEALED WHEN IT AGES OUT, AND ONLY THEN ──────────────────────────────────
 * An era is written when every one of its turns is behind the fold's frontier.
 * A conversation that has never folded stores nothing at all, which is every
 * ordinary one; a conversation that folds stores what it actually folded. And
 * `seal` is `INSERT OR IGNORE`, so "summarised once" is a property of the
 * storage rather than a rule a caller has to remember.
 *
 * ── ON THE SAME HANDLE, SCOPED BY THREAD ────────────────────────────────────
 * Beside `agent_rows` and `agent_inbox`, for `thread-log.ts`'s own reason: one
 * file is one thing to back up, one thing to close and one thing for a reset to
 * move aside. A reset mints a new thread id AND archives the file, so an era
 * can never outlive the conversation it summarises — which matters more here
 * than anywhere else, because an era that survived would be prose about turns
 * that no longer exist.
 */
import type { NativeDatabase } from "./checkpointer";

/**
 * HOW MANY TURNS ONE ERA IS — twenty.
 *
 * The number trades two things against each other. Larger eras mean fewer rows
 * and fewer reads, and mean more turns recomputed per lap while the newest era
 * is still filling — at most `ERA_TURNS - 1` of them. Smaller eras recompute
 * almost nothing and turn a long conversation into a lot of little rows.
 *
 * Twenty is about a day of the owner's use, which makes an era a legible unit
 * when somebody opens the table, and caps the per-lap recompute at nineteen
 * turns against the several hundred the fold used to redo.
 *
 * CHANGING IT DOES NOT INVALIDATE WHAT IS STORED and that is deliberate: an era
 * carries its own turns, so a stored one is read back at the length it was
 * written at. See `sealedEras`, which stops at the first era that is not the
 * length this build seals — the honest answer for a row this build cannot map
 * onto turn indices, and it leaves the transcript untouched either way.
 */
export const ERA_TURNS = 20;

/** One folded turn: the line that stands in for it, and what the turn it
 *  replaces weighed on `compact.ts`'s arithmetic. The weight is stored because
 *  the fold subtracts it to decide where to stop, and re-deriving it is the
 *  stringify this table exists to avoid. */
export type FoldedTurn = { line: string; chars: number };

/** A run of `ERA_TURNS` turns, already folded. `ordinal` is 0-based and eras
 *  are contiguous: era k covers turns `[k·ERA_TURNS, (k+1)·ERA_TURNS)` counted
 *  from the start of the conversation. */
export type AgentEra = { ordinal: number; turns: FoldedTurn[] };

/**
 * WHAT `foldOldTurns` IS HANDED — the port, not the table.
 *
 * INJECTED for `compact.ts`'s own reason: that file is a projection over
 * LangGraph messages with no idea that sqlite exists, and its whole suite tests
 * it as a pure function. A port keeps that true and keeps this table's SQL in
 * one place, and it is what lets a test assert an era was sealed ONCE by
 * counting the calls rather than by reading a database.
 */
export type EraStore = {
  /** Sealed eras, oldest first and contiguous from turn 0. */
  sealed(): readonly AgentEra[];
  /** Store one. Ignored if that ordinal is already sealed. */
  seal(era: AgentEra): void;
};

const CREATE = `CREATE TABLE IF NOT EXISTS agent_eras (
    thread_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    turns TEXT NOT NULL,
    PRIMARY KEY (thread_id, ordinal)
  );`;

export class AgentEraLog {
  constructor(private readonly db: NativeDatabase) {
    this.db.exec(CREATE);
  }

  /**
   * THE ERAS THIS THREAD HAS SETTLED, in order.
   *
   * TRUNCATED AT THE FIRST GAP, and at the first era that is not `ERA_TURNS`
   * long. The fold maps an ordinal onto turn indices by multiplication, so
   * contiguity and length are not niceties — an era at the wrong offset would
   * put one turn's line under another turn's number. Rows past the break are
   * left on disk rather than deleted: they are not wrong, they are just not
   * something this build can place, and a later one may read them.
   */
  sealed(threadId: string): AgentEra[] {
    const rows = this.db
      .prepare("SELECT ordinal, turns FROM agent_eras WHERE thread_id = ? ORDER BY ordinal")
      .all(threadId) as Array<{ ordinal: number | bigint; turns: string }>;
    const eras: AgentEra[] = [];
    for (const raw of rows) {
      const ordinal = Number(raw.ordinal);
      if (ordinal !== eras.length) break;
      const turns = decodeTurns(raw.turns);
      if (turns.length !== ERA_TURNS) break;
      eras.push({ ordinal, turns });
    }
    return eras;
  }

  /** Store one era. `OR IGNORE` is the "summarised once" guarantee — a second
   *  attempt at the same ordinal is a no-op rather than a rewrite, so a line
   *  cannot change under a conversation that has already been told it. */
  seal(threadId: string, era: AgentEra): void {
    this.db
      .prepare("INSERT OR IGNORE INTO agent_eras (thread_id, ordinal, turns) VALUES (?, ?, ?)")
      .run(threadId, era.ordinal, JSON.stringify(era.turns));
  }

  /** The port for one thread, with the read memoised. Handed to `foldOldTurns`,
   *  which asks on every lap; one graph is one turn, so a turn reads the table
   *  once and the laps after it read nothing. */
  port(threadId: string): EraStore {
    let cached: readonly AgentEra[] | undefined;
    return {
      sealed: () => (cached ??= this.sealed(threadId)),
      seal: (era) => {
        this.seal(threadId, era);
        cached = undefined;
      },
    };
  }
}

/** A row's payload, or nothing usable. A row somebody hand-edited into
 *  nonsense costs the eras after it rather than the conversation. */
function decodeTurns(raw: string): FoldedTurn[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.every((turn) => turn && typeof turn === "object" && typeof (turn as FoldedTurn).line === "string" && typeof (turn as FoldedTurn).chars === "number")
      ? (parsed as FoldedTurn[])
      : [];
  } catch {
    return [];
  }
}
