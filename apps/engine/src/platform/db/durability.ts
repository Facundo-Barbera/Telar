import type { ExecutionStore } from "./execution-store";

/** The barrier needs a changed page to produce a WAL frame, so it records where it landed. */
const DURABILITY_BARRIER_KEY = "durability-barrier";

/**
 * One device barrier per settled turn: a second one-row commit at FULL + fullfsync, since sqlite refuses
 * `synchronous` inside a transaction. Runs before the command returns. A failure here does not fail the turn.
 */
export function maybeBarrier(store: ExecutionStore): void {
  const due = store.barrierDue;
  store.barrierDue = undefined;
  if (!due || store.closed) return;
  try {
    store.db.exec("PRAGMA synchronous=FULL; PRAGMA fullfsync=ON;");
    try {
      store.db.exec("BEGIN IMMEDIATE");
      try {
        store.statement("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .run(DURABILITY_BARRIER_KEY, `${due.sessionId}:${due.eventId}`);
        store.db.exec("COMMIT");
      } catch (error) { store.db.exec("ROLLBACK"); throw error; }
    } finally { store.db.exec("PRAGMA synchronous=NORMAL; PRAGMA fullfsync=OFF;"); }
  } catch { return; }
  store.onDurabilityBarrier?.(due);
}
