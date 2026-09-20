/**
 * Read-only scans over a store nobody should be querying by hand — issue #813.
 *
 * ══ WHY THIS IS A COMMAND RATHER THAN A QUERY IN A COMMENT ══
 *
 * #813's investigation ended with a question it could not answer: how OFTEN
 * does a session end up in one of these states? Both shapes are gaps between
 * records that already exist, so no new instrumentation is needed — but
 * answering it meant somebody opening the live store with `sqlite3` and a
 * hand-written `json_extract`, which is exactly the thing the dispatch board
 * forbids and for good reason.
 *
 * Shipping it as a command removes the hand from the loop, and it buys a second
 * property that matters more: THE QUERY AND THE DETECTOR ARE THE SAME
 * DEFINITION. `noProgressSince` below is measured the way
 * `EngineStore.sweepStalledTurns` measures it — the newest journal record
 * naming the run — so the frequency this reports and the advisory the engine
 * raises cannot drift apart into two different meanings of "stalled".
 *
 * ══ READ-ONLY IS ENFORCED, NOT PROMISED ══
 *
 * The database is opened `readonly: true`, so a bug here raises SQLITE_READONLY
 * rather than writing to somebody's conversations. It deliberately does NOT go
 * through `EngineStore` or `ExecutionStore`: both take the daemon lock, run
 * migrations, reconcile projections and sweep receipts on open. Those are the
 * right things for the engine to do and the wrong things for a diagnostic to do
 * to a store that may have a daemon attached to it right now.
 *
 * ══ AND IT REPORTS IDS AND TIMES, NEVER CONTENT ══
 *
 * No titles, no message text, no tool arguments. The answer is a shape — which
 * runs, in which state, silent for how long — and that is all the question
 * needs. A diagnostic that printed conversations would be a new way to leak
 * them.
 *
 * ══ IT IS A FULL TABLE SCAN, SAID OUT LOUD ══
 *
 * `events` is keyed `(session_id, id)` and the predicates are `json_extract`s,
 * so nothing indexes this and every record is parsed. That is affordable for a
 * command a person runs when they want an answer, and would not be for anything
 * on a poll. Do not put this on a timer.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { STALLED_AFTER_MS } from "@telar/engine-client";

/** One run the scan has something to say about. Ids and times only. */
export type StalledRun = {
  sessionId: string;
  runId: string;
  /**
   * `never_claimed` — a `turn.accepted` with no `turn.claimed` and no ending.
   * The message was taken and no worker ever picked it up. #813's occurrence A:
   * the session had no checkout, so nothing could claim it, and it waited.
   *
   * `no_progress` — a `turn.started` with no ending whose newest record is old.
   * The turn is running as far as the store knows and has produced no evidence
   * since. What `Turn.stalled` advises on, counted after the fact.
   */
  kind: "never_claimed" | "no_progress";
  /** When the newest record naming this run was written. */
  lastRecordAt: number;
  /** How long it has been silent, at `scannedAt`. */
  silentForMs: number;
};

export type StalledScan = {
  scannedAt: number;
  thresholdMs: number;
  /** Every run the scan looked at, so a zero answer is distinguishable from an
   *  empty store — the distinction #813's frequency question turns on. */
  runsExamined: number;
  counts: { neverClaimed: number; noProgress: number };
  runs: StalledRun[];
};

/**
 * ONE PASS, GROUPED BY RUN, and every derived column is a `MAX` over the run's
 * records so the whole verdict comes back in one row each.
 *
 * The terminal set is every way a turn can END. `turn.requeued` is deliberately
 * NOT in it — a requeued turn is queued again and genuinely waiting, which is
 * the `never_claimed` question rather than an answer to it.
 */
const SCAN = `
  SELECT
    session_id AS sessionId,
    json_extract(value, '$.runId') AS runId,
    MAX(CASE WHEN json_extract(value, '$.type') = 'turn.accepted' THEN json_extract(value, '$.at') END) AS acceptedAt,
    MAX(CASE WHEN json_extract(value, '$.type') = 'turn.claimed' THEN 1 ELSE 0 END) AS claimed,
    MAX(CASE WHEN json_extract(value, '$.type') = 'turn.started' THEN 1 ELSE 0 END) AS started,
    MAX(CASE WHEN json_extract(value, '$.type') IN
      ('turn.completed', 'turn.failed', 'turn.stopped', 'turn.discarded', 'turn.ambiguous', 'turn.steered')
      THEN 1 ELSE 0 END) AS ended,
    MAX(json_extract(value, '$.at')) AS lastRecordAt
  FROM events
  WHERE json_extract(value, '$.runId') IS NOT NULL
  GROUP BY session_id, runId
`;

type ScanRow = {
  sessionId: unknown;
  runId: unknown;
  acceptedAt: unknown;
  claimed: unknown;
  started: unknown;
  ended: unknown;
  lastRecordAt: unknown;
};

export class DiagnoseError extends Error {}

/**
 * Where a store's journal lives. Named here so the refusal below can say which
 * file it looked for rather than "not found".
 */
export function executionDatabase(engineRoot: string): string {
  return path.join(engineRoot, "execution.sqlite");
}

/**
 * Which runs in this store have been silent for longer than `thresholdMs`.
 *
 * `now` is injected for the same reason the store's is: a test that had to wait
 * twenty minutes to assert a twenty-minute threshold would not be a test.
 */
export function scanStalled(input: {
  engineRoot: string;
  now?: () => number;
  thresholdMs?: number;
}): StalledScan {
  const now = input.now ?? Date.now;
  const thresholdMs = Math.max(1, input.thresholdMs ?? STALLED_AFTER_MS);
  const file = executionDatabase(input.engineRoot);
  if (!fs.existsSync(file)) {
    throw new DiagnoseError(
      `no execution database at ${file} — this scan reads the sqlite backend, which is what a Telar engine writes by default. ` +
        `A store still on the JSON backend (TELAR_EXECUTION_STORE=json) has no journal here to read.`,
    );
  }
  const native = createRequire(import.meta.url)(process.versions.bun ? "bun:sqlite" : "node:sqlite");
  // READONLY, so a defect in this file cannot write to a live store — and so
  // opening one a daemon already holds is safe rather than merely likely to be.
  const db = process.versions.bun
    ? new native.Database(file, { readonly: true })
    : new native.DatabaseSync(file, { readOnly: true });
  try {
    const scannedAt = now();
    const rows = db.prepare(SCAN).all() as ScanRow[];
    const runs: StalledRun[] = [];
    for (const row of rows) {
      const sessionId = String(row.sessionId ?? "");
      const runId = String(row.runId ?? "");
      const lastRecordAt = Number(row.lastRecordAt ?? 0);
      // A record with no usable stamp says nothing about time and must not be
      // reported as infinitely silent — which is what `0` would become below.
      if (!sessionId || !runId || !Number.isFinite(lastRecordAt) || lastRecordAt <= 0) continue;
      if (Number(row.ended) === 1) continue;
      const silentForMs = scannedAt - lastRecordAt;
      if (silentForMs < thresholdMs) continue;
      if (Number(row.started) === 1) {
        runs.push({ sessionId, runId, kind: "no_progress", lastRecordAt, silentForMs });
        continue;
      }
      // NEVER CLAIMED is asked of a run that was ACCEPTED, not of any run
      // without a `turn.claimed`: a synthetic provider turn is born running and
      // has no accepted record, and calling it unclaimed would be a lie in the
      // one direction this scan exists to avoid.
      if (Number(row.claimed) === 0 && Number(row.acceptedAt ?? 0) > 0) {
        runs.push({ sessionId, runId, kind: "never_claimed", lastRecordAt, silentForMs });
      }
    }
    // Longest silence first: the run most worth looking at is at the top, and a
    // truncated read of the answer is still the useful half of it.
    runs.sort((left, right) => right.silentForMs - left.silentForMs || left.runId.localeCompare(right.runId));
    return {
      scannedAt,
      thresholdMs,
      runsExamined: rows.length,
      counts: {
        neverClaimed: runs.filter((run) => run.kind === "never_claimed").length,
        noProgress: runs.filter((run) => run.kind === "no_progress").length,
      },
      runs,
    };
  } finally {
    db.close();
  }
}
