// Loom persistence in ~/.telar/looms/<id>/ — loom.json (current state, atomic
// rewrite) + events.ndjson (append-only log, tailed by the UI via line offset).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Charter, PanelReport, Verdict, VerifierReport, WorkUnitState } from "./schemas";
import type { GateResult } from "./gates";

const telarDir = () => process.env.TELAR_HOME ?? path.join(os.homedir(), ".telar");
const loomsDir = () => path.join(telarDir(), "looms");

// Every consumer of a loom's on-disk location (spec/evidence dirs, loom.json,
// events.ndjson) routes through here, so this is the one place `id` needs
// guarding against path traversal (e.g. id="../../etc" relocating the whole
// per-loom sandbox off-disk). Reject anything that isn't a bare, separator-
// free path segment matching createLoom()'s own id shape.
export const loomDir = (id: string) => {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`invalid loom id: ${JSON.stringify(id)}`);
  }
  const dir = path.join(loomsDir(), id);
  const base = loomsDir();
  const withSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (!dir.startsWith(withSep)) {
    throw new Error(`invalid loom id: ${JSON.stringify(id)}`);
  }
  return dir;
};

export type LoomKind = "quickfix" | "story" | "custom" | "verify";

export type LoomEvent = { ts: number; type: string } & Record<string, unknown>;

export type AttemptRecord = {
  n: number;
  role: string;
  model: string;
  startedAt: number;
  endedAt?: number;
  sessionId?: string;
  verdict?: Verdict | null;
  verifierReport?: VerifierReport | null;
  // §4 Layer 2 (docs/loom-model.md): the Critic Panel's aggregated report,
  // present when the loom's verification was panel-driven (a Spec Bundle
  // contract exists) instead of the legacy single-Verifier path.
  panelReport?: PanelReport | null;
  gates?: GateResult[];
  costUsd?: number;
};

export type Loom = {
  id: string;
  project: string;
  kind: LoomKind;
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
  // Epic/child-Loom fields (docs/loom-orchestrator.md §4) — additive, absent on
  // today's plain looms.
  role?: "leaf" | "epic" | "thread";
  parentLoomId?: string; // set on a child; points at the epic
  subGoalId?: string; // which Charter.decomposition node this child proves
  charter?: Charter; // the approved scope (root/epic loom)
  // docs/loom-model.md §5/§M.6 — a loom whose Spec Bundle is still being
  // authored by a planning session. Exists on disk (so the god-view can
  // render the bundle-in-progress) but must not be listed or dispatched
  // until `startLoomFromBundle` commits it (stamps provenance, flips this
  // to false, and dispatches). Absent/false = a normal started loom.
  draft?: boolean;
  // §M.1: stamped true by startLoomFromBundle's CONTRACT GATE the moment a
  // valid Verification Contract was required to start this loom. Sticky for
  // the loom's lifetime so a contract that later goes missing/corrupt/
  // invalid (a steering edit, a bad write, anything) is a hard verification
  // FAILURE, never a silent downgrade to the legacy no-panel skip path —
  // see runVerification in executor.ts.
  contractRequired?: boolean;
};

// docs/loom-model.md §5 — a loom is "listable" (shown in the top-level Looms
// list) once it's no longer a draft awaiting commit and isn't a child loom
// (children render nested under their parent/epic). Pure so the web list
// route and any other consumer share one definition instead of inlining it.
export const isListableLoom = (l: Loom): boolean => !l.draft && !l.parentLoomId;

// Idempotent, non-destructive legacy migration from ~/.telar/runs/ to
// ~/.telar/looms/ (and run.json -> loom.json within each loom dir). Runs once
// per process, guarded so it never throws.
let migrated = false;
function ensureMigrated() {
  if (migrated) return;
  migrated = true;
  try {
    const looms = loomsDir();
    const legacy = path.join(telarDir(), "runs");
    let legacyStat: fs.Stats | null = null;
    try {
      legacyStat = fs.lstatSync(legacy);
    } catch {}
    if (!fs.existsSync(looms) && legacyStat && legacyStat.isDirectory() && !legacyStat.isSymbolicLink()) {
      fs.renameSync(legacy, looms);
      try {
        fs.symlinkSync(looms, legacy, "dir"); // back-compat shim
      } catch {}
    }
    let ids: string[] = [];
    try {
      ids = fs.readdirSync(looms);
    } catch {}
    for (const id of ids) {
      const d = path.join(looms, id);
      const oldF = path.join(d, "run.json");
      const newF = path.join(d, "loom.json");
      try {
        if (fs.existsSync(oldF) && !fs.existsSync(newF)) fs.renameSync(oldF, newF);
      } catch {}
    }
  } catch {}
}

export function createLoom(init: {
  project: string;
  kind: LoomKind;
  title: string;
  prompt: string;
  account: string;
  role?: "leaf" | "epic" | "thread";
  parentLoomId?: string;
  subGoalId?: string;
  charter?: Charter;
  draft?: boolean;
}): Loom {
  ensureMigrated();
  const now = Date.now();
  const id = `loom_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const loom: Loom = {
    id,
    ...init,
    state: "queued",
    createdAt: now,
    updatedAt: now,
    attempts: [],
    error: null,
  };
  fs.mkdirSync(loomDir(id), { recursive: true });
  saveLoom(loom);
  return loom;
}

export function saveLoom(loom: Loom): void {
  ensureMigrated();
  loom.updatedAt = Date.now();
  const dir = loomDir(loom.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "loom.json");
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(loom, null, 2));
  fs.renameSync(tmp, file);
}

export function getLoom(id: string): Loom | null {
  ensureMigrated();
  let dir: string;
  try {
    dir = loomDir(id);
  } catch {
    return null; // malformed/traversal id: treat like "not found", not a 500
  }
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "loom.json"), "utf8")) as Loom;
  } catch {
    // fallback to legacy run.json if loom.json is absent
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8")) as Loom;
    } catch {
      return null;
    }
  }
}

export function listLooms(): Loom[] {
  ensureMigrated();
  let ids: string[];
  try {
    ids = fs.readdirSync(loomsDir());
  } catch {
    return [];
  }
  return ids
    .map((id) => getLoom(id))
    .filter((l): l is Loom => l !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// Child Looms of an epic — each its own loom.json (docs/loom-orchestrator.md
// §4); no embedded lane state on the parent.
export function listChildLooms(parentId: string): Loom[] {
  return listLooms().filter((l) => l.parentLoomId === parentId);
}

export function appendEvent(id: string, ev: { type: string } & Record<string, unknown>): void {
  ensureMigrated();
  const dir = loomDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "events.ndjson"), JSON.stringify({ ...ev, ts: Date.now() }) + "\n");
}

// §A / §M.2 (docs/loom-model.md): the ONLY path "ready" -> "done". A NORMAL
// accept requires the loom to already be "ready" (verification green). An
// OVERRIDE accept (opts.override) promotes a non-ready loom (e.g. a red/
// needs-review loom) but requires opts.cosignedBy — the human co-sign §M.2
// mandates for accepting anything less than a clean green — never the
// default accept button.
export function acceptLoom(id: string, by: string, opts?: { override?: boolean; cosignedBy?: string }): Loom {
  // §A: "done" is reachable solely through a human (or an authenticated
  // human delegate) — a blank/missing `by` must never slip through, exactly
  // as assertProvenance rejects a blank approvedBy for the provenance gate.
  if (!by?.trim()) throw new Error("acceptLoom requires a non-blank `by`");
  const loom = getLoom(id);
  if (!loom) throw new Error(`loom not found: ${id}`);
  if (loom.state === "done") throw new Error("loom already accepted");

  if (loom.state === "ready") {
    loom.state = "done";
    appendEvent(id, { type: "accepted", by });
    saveLoom(loom);
    return loom;
  }

  if (!opts?.override || !opts.cosignedBy?.trim()) {
    throw new Error("accepting a non-ready loom requires an override co-sign");
  }
  loom.state = "done";
  appendEvent(id, { type: "accepted", by, override: true, cosignedBy: opts.cosignedBy });
  saveLoom(loom);
  return loom;
}

// afterLine = complete lines already consumed; pass back nextLine to tail incrementally.
export function readEvents(id: string, afterLine = 0): { events: LoomEvent[]; nextLine: number } {
  ensureMigrated();
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(loomDir(id), "events.ndjson"), "utf8");
  } catch {
    return { events: [], nextLine: afterLine };
  }
  const lines = raw.split("\n");
  lines.pop(); // "" after a final \n, or a partial line mid-append — either way not a complete event
  const events: LoomEvent[] = [];
  for (const line of lines.slice(afterLine)) {
    try {
      events.push(JSON.parse(line) as LoomEvent);
    } catch {
      // corrupt line: skip but still count it as consumed
    }
  }
  return { events, nextLine: lines.length };
}
