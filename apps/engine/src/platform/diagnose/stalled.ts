import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { STALLED_AFTER_MS } from "@telar/engine-client";

type StalledRun = {
  sessionId: string;
  runId: string;
  kind: "never_claimed" | "no_progress";
  lastRecordAt: number;
  silentForMs: number;
};

type StalledScan = {
  scannedAt: number;
  thresholdMs: number;
  runsExamined: number;
  counts: { neverClaimed: number; noProgress: number };
  runs: StalledRun[];
};

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

export function executionDatabase(engineRoot: string): string {
  return path.join(engineRoot, "execution.sqlite");
}

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
      `no execution database at ${file} — is this a Telar engine root?`,
    );
  }
  const native = createRequire(import.meta.url)(process.versions.bun ? "bun:sqlite" : "node:sqlite");
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
      if (!sessionId || !runId || !Number.isFinite(lastRecordAt) || lastRecordAt <= 0) continue;
      if (Number(row.ended) === 1) continue;
      const silentForMs = scannedAt - lastRecordAt;
      if (silentForMs < thresholdMs) continue;
      if (Number(row.started) === 1) {
        runs.push({ sessionId, runId, kind: "no_progress", lastRecordAt, silentForMs });
        continue;
      }
      if (Number(row.claimed) === 0 && Number(row.acceptedAt ?? 0) > 0) {
        runs.push({ sessionId, runId, kind: "never_claimed", lastRecordAt, silentForMs });
      }
    }
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
