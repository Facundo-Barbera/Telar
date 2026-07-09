// Run persistence in ~/.telar/runs/<id>/ — run.json (current state, atomic
// rewrite) + events.ndjson (append-only log, tailed by the UI via line offset).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Verdict, VerifierReport, WorkUnitState } from "./schemas";
import type { GateResult } from "./gates";

const telarDir = () => process.env.TELAR_HOME ?? path.join(os.homedir(), ".telar");
const runsDir = () => path.join(telarDir(), "runs");
export const runDir = (id: string) => path.join(runsDir(), id);

export type RunKind = "quickfix" | "story" | "custom" | "verify";

export type RunEvent = { ts: number; type: string } & Record<string, unknown>;

export type AttemptRecord = {
  n: number;
  role: string;
  model: string;
  startedAt: number;
  endedAt?: number;
  sessionId?: string;
  verdict?: Verdict | null;
  verifierReport?: VerifierReport | null;
  gates?: GateResult[];
  costUsd?: number;
};

export type Run = {
  id: string;
  project: string;
  kind: RunKind;
  title: string;
  prompt: string;
  account: string;
  acceptanceCriteria?: string[];
  target?: "dev" | "preview" | "prod";
  state: WorkUnitState;
  createdAt: number;
  updatedAt: number;
  attempts: AttemptRecord[];
  error: string | null;
};

export function createRun(init: {
  project: string;
  kind: RunKind;
  title: string;
  prompt: string;
  account: string;
}): Run {
  const now = Date.now();
  const id = `run_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const run: Run = {
    id,
    ...init,
    state: "queued",
    createdAt: now,
    updatedAt: now,
    attempts: [],
    error: null,
  };
  fs.mkdirSync(runDir(id), { recursive: true });
  saveRun(run);
  return run;
}

export function saveRun(run: Run): void {
  run.updatedAt = Date.now();
  const dir = runDir(run.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "run.json");
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(run, null, 2));
  fs.renameSync(tmp, file);
}

export function getRun(id: string): Run | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir(id), "run.json"), "utf8")) as Run;
  } catch {
    return null;
  }
}

export function listRuns(): Run[] {
  let ids: string[];
  try {
    ids = fs.readdirSync(runsDir());
  } catch {
    return [];
  }
  return ids
    .map((id) => getRun(id))
    .filter((r): r is Run => r !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function appendEvent(id: string, ev: { type: string } & Record<string, unknown>): void {
  const dir = runDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "events.ndjson"), JSON.stringify({ ...ev, ts: Date.now() }) + "\n");
}

// afterLine = complete lines already consumed; pass back nextLine to tail incrementally.
export function readEvents(id: string, afterLine = 0): { events: RunEvent[]; nextLine: number } {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(runDir(id), "events.ndjson"), "utf8");
  } catch {
    return { events: [], nextLine: afterLine };
  }
  const lines = raw.split("\n");
  lines.pop(); // "" after a final \n, or a partial line mid-append — either way not a complete event
  const events: RunEvent[] = [];
  for (const line of lines.slice(afterLine)) {
    try {
      events.push(JSON.parse(line) as RunEvent);
    } catch {
      // corrupt line: skip but still count it as consumed
    }
  }
  return { events, nextLine: lines.length };
}
