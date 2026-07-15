// Cut U4-B: the REST of a run's on-disk state under TELAR_HOME/ultra/<runId>/
// (doc §5). journal.ts (U2) already owns journal.jsonl/runDir/ultraDir; this
// module owns manifest.json (run state/spend), events.ndjson (the
// phase/log/agent/state progress stream), agents/<ordinal>.ndjson (per-agent
// transcripts), script.js (the persisted script text so a bare resume can
// round-trip without the caller re-supplying `code` — executor.ts's own
// resumeUltra doc comment names this as U4's job), and the LAUNCH wiring that
// turns startUltra/resumeUltra's callbacks into these durable, tailable
// files. Mirrors looms.ts's loom.json/events.ndjson split; the
// apps/web/app/api/ultra/* routes read/write ONLY through this module, same
// convention as the loom routes going through @telar/core.
//
// Detached runs (doc §3/§4 "non-blocking"): launchUltra/resumeUltraRun start
// the run and return as soon as the manifest is seeded — the caller (the
// launch API route) responds with {runId} immediately and never awaits the
// run's completion; `run.finished` is handled with a fire-and-forget
// `.then()`. The run keeps going in this process's event loop; this file's
// onEvent/onAgentEvent taps are what make that progress durable across an
// SSE reconnect or a page navigation. A `globalThis`-backed registry (doc §3:
// "so it survives Next dev HMR and page navigation") holds the live UltraRun
// handle so stop()/state() stay reachable across a hot-reloaded route module
// — a plain module-scope Map does NOT survive Next dev's route-module
// reload, globalThis does.
import fs from "node:fs";
import path from "node:path";
import type { AccountProfile } from "../schemas";
import { getAccount } from "../accounts";
import { runDir, ultraDir } from "./journal";
import {
  startUltra,
  resumeUltra,
  newUltraRunId,
  type StartUltraOpts,
  type UltraEvent,
  type UltraRun,
  type UltraState,
} from "./executor";
import type { EngineEvent } from "../engine";
import { compileScript, type ScriptMeta } from "./sandbox";

export type UltraManifest = {
  runId: string;
  sessionId?: string;
  messageId?: string;
  account?: string; // AccountProfile.name — resume auto-resolves it back via getAccount
  // The project root every child agent() call ran in (doc §3: "confined to
  // the project root"). Not in the doc's literal manifest field list (§5),
  // but necessary in practice: without it a resume long after this process
  // exited (doc §3's "on server restart the task dies") would have no way to
  // know where to run — a caller COULD always override it, but the common
  // "just resume" case must not silently fall back to the web server's own
  // cwd.
  project?: string;
  meta: ScriptMeta;
  args?: unknown;
  state: UltraState;
  // Live running total in USD (Claude) — doc §3 "cost visibility": a
  // readout, never a cap. Codex/tokens lights up with the driver seam
  // (doc §3/§7 prove-run plan pt 2); no Ultra code branches on provider
  // today because there is no second provider path yet to branch on.
  spend: number;
  // The script's default-export RETURN VALUE, set once on a `done` terminal
  // (doc §5's "/api/ultra/[id] GET — manifest + state + terminal result").
  // Never present on `running`/`stopped`/`failed` — a stop/failure has no
  // resolved value, only `error` below.
  result?: unknown;
  error?: string;
  startedAt: number;
  updatedAt: number;
};

const manifestFile = (runId: string) => path.join(runDir(runId), "manifest.json");
const eventsFile = (runId: string) => path.join(runDir(runId), "events.ndjson");
const scriptFile = (runId: string) => path.join(runDir(runId), "script.js");
const agentsDir = (runId: string) => path.join(runDir(runId), "agents");
const agentFile = (runId: string, ordinal: number) => path.join(agentsDir(runId), `${ordinal}.ndjson`);

// ── manifest.json (atomic rewrite — temp+rename, looms.ts's saveLoom idiom) ─
function saveManifest(m: UltraManifest): void {
  const dir = runDir(m.runId);
  fs.mkdirSync(dir, { recursive: true });
  const file = manifestFile(m.runId);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
  fs.renameSync(tmp, file);
}

// Self-healing read (doc §3's startup reconciliation, folded into every
// read rather than a separate one-shot scan — see the module header): a
// manifest still claiming `running` with no LIVE task in this process's
// registry is stale — either a server restart (doc §3: "on server restart
// the task dies... marks them stopped") or a hot-reloaded module that lost
// its in-memory handle. Both land in the SAME `stopped` state, Resume
// offered, exactly like a human Stop (doc §3's stated equivalence).
export function getUltraManifest(runId: string): UltraManifest | null {
  let dir: string;
  try {
    dir = runDir(runId);
  } catch {
    return null; // malformed/traversal id — treat as not-found, never a 500 (looms.ts idiom)
  }
  let m: UltraManifest;
  try {
    m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as UltraManifest;
  } catch {
    return null;
  }
  if (m.state === "running" && !registry().has(m.runId)) {
    m = { ...m, state: "stopped", updatedAt: Date.now() };
    saveManifest(m);
  }
  return m;
}

// Listed newest-first (looms' listLooms() convention, updatedAt desc there;
// startedAt here — Ultra manifests don't otherwise change after their last
// state transition).
export function listUltraRuns(): UltraManifest[] {
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(ultraDir());
  } catch {
    return []; // no runs yet
  }
  const out: UltraManifest[] = [];
  for (const id of ids) {
    const m = getUltraManifest(id);
    if (m) out.push(m);
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

// ── events.ndjson (append-only, looms.ts's appendEvent/readEvents idiom) ────
export type UltraStoredEvent = UltraEvent & { ts: number };

function appendUltraEvent(runId: string, ev: UltraEvent): void {
  const dir = runDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(eventsFile(runId), JSON.stringify({ ...ev, ts: Date.now() }) + "\n");
}

// Line-by-line, tolerant of a torn trailing line — same idiom as
// journal.ts's readJournal / looms.ts's readEvents (a corrupt/partial line is
// dropped, never thrown, and still counted as consumed so `nextLine` stays a
// simple line count).
export function readUltraEvents(runId: string, afterLine = 0): { events: UltraStoredEvent[]; nextLine: number } {
  let raw: string;
  try {
    raw = fs.readFileSync(eventsFile(runId), "utf8");
  } catch {
    return { events: [], nextLine: afterLine };
  }
  const lines = raw.split("\n");
  lines.pop(); // "" after a final \n, or a torn partial line either way
  const events: UltraStoredEvent[] = [];
  for (const line of lines.slice(afterLine)) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line) as UltraStoredEvent);
    } catch {
      // corrupt line: skip, still consumed
    }
  }
  return { events, nextLine: lines.length };
}

// ── agents/<ordinal>.ndjson (per-agent transcript: EngineEvent + attempt) ───
export type UltraAgentEventRecord = EngineEvent & { attempt: number; ts: number };

function appendAgentEvent(runId: string, ordinal: number, e: EngineEvent, attempt: number): void {
  const dir = agentsDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(agentFile(runId, ordinal), JSON.stringify({ ...e, attempt, ts: Date.now() }) + "\n");
}

export function readUltraAgentTranscript(runId: string, ordinal: number): UltraAgentEventRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(agentFile(runId, ordinal), "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n");
  lines.pop();
  const out: UltraAgentEventRecord[] = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as UltraAgentEventRecord);
    } catch {
      // corrupt line: skip
    }
  }
  return out;
}

// ── script.js (the persisted source, so a bare resume round-trips) ─────────
function persistScript(runId: string, script: string): void {
  const dir = runDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(scriptFile(runId), script);
}

export function readUltraScript(runId: string): string | null {
  try {
    return fs.readFileSync(scriptFile(runId), "utf8");
  } catch {
    return null;
  }
}

// ── run registry (in-process, globalThis-backed — doc §3) ──────────────────
// A live UltraRun handle keyed by runId. globalThis (not a plain module-scope
// Map) so it survives Next dev's route-module hot-reload — the SAME reason
// looms' `active` map (dispatcher.ts) is process-lifetime already, except
// Ultra additionally needs to survive a route FILE edit mid-run, which
// re-evaluates a plain module top-level. Never the source of truth — a
// terminal run's manifest.json is — this is purely a stop()/state() shortcut
// for a run that's still actually live in this process.
const REGISTRY_KEY = "__telarUltraRunRegistry__";
type Registry = Map<string, UltraRun>;
function registry(): Registry {
  const g = globalThis as unknown as Record<string, Registry | undefined>;
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = new Map();
  return g[REGISTRY_KEY]!;
}

// Exposed for the rail's Script tab / a resume UI that wants to show what's
// currently live without waiting on a manifest read.
export function getLiveUltraRun(runId: string): UltraRun | undefined {
  return registry().get(runId);
}

export type LaunchUltraOpts = {
  runId?: string; // forced id — tests only; a real launch always mints one
  script: string;
  args?: unknown;
  sessionId?: string;
  messageId?: string;
  project?: string;
  account?: AccountProfile; // resolved profile — drives the runner's accountEnv (doc §2)
  // DI seam for tests — same shape as StartUltraOpts.agent (no live SDK).
  agent?: StartUltraOpts["agent"];
};

export type LaunchUltraResult =
  | { ok: true; runId: string; meta: ScriptMeta }
  | { ok: false; error: string };

// Shared by launchUltra (fresh run) and resumeUltraRun (same runId, journal
// prefix already on disk) — both wire the SAME persistence taps onto
// startUltra/resumeUltra's callbacks, so a resumed run's events/manifest
// accrue identically to a first run's. `starter` is a thunk that closes over
// either startUltra(script,...) or resumeUltra(runId, script,...).
//
// `script` is read up front ONLY to precompute `meta` (compileScript is a
// cheap regex/vm literal read, already duplicated by startUltra/resumeUltra
// internally). This is NOT a redundant nicety: a resumed ordinal that's a
// full CACHE HIT settles with NO internal `await` at all (readJournalMap's
// lookup is synchronous, doc §3), so its "agent" onEvent can fire
// SYNCHRONOUSLY *during* the `starter(startOpts)` call below — i.e. before
// `run = starter(...)` has even assigned `run`. `buildManifest` must never
// dereference the not-yet-assigned `run` handle in that window; sourcing
// `meta` from the precompiled script instead of `run.meta` sidesteps the
// hazard entirely (a fresh, all-live run has no such hazard — the FIRST live
// agent() call always crosses a real `await ctl.sem.acquire()` — but a
// resume's cached prefix does, and manifest writes must be race-free either
// way).
async function launch(
  runId: string,
  script: string,
  starter: (startOpts: StartUltraOpts) => UltraRun,
  opts: {
    args?: unknown;
    sessionId?: string;
    messageId?: string;
    account?: AccountProfile;
    project?: string;
  },
): Promise<LaunchUltraResult> {
  const startedAt = Date.now();
  let spend = 0;
  const compiled = compileScript(script);
  const meta: ScriptMeta = compiled.ok ? compiled.meta : {};

  const buildManifest = (state: UltraState, error?: string, result?: unknown): UltraManifest => ({
    runId,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.messageId ? { messageId: opts.messageId } : {}),
    ...(opts.account?.name ? { account: opts.account.name } : {}),
    ...(opts.project ? { project: opts.project } : {}),
    meta,
    ...(opts.args !== undefined ? { args: opts.args } : {}),
    state,
    spend,
    // `result` is only ever set on a `done` terminal (executor.ts's settle()
    // only attaches `result` alongside state "done") — undefined elsewhere,
    // so the spread simply omits the key rather than writing `result: undefined`.
    ...(state === "done" && result !== undefined ? { result } : {}),
    ...(error ? { error } : {}),
    startedAt,
    updatedAt: Date.now(),
  });

  const startOpts: StartUltraOpts = {
    runId,
    args: opts.args,
    account: opts.account,
    onEvent: (e: UltraEvent) => {
      appendUltraEvent(runId, e);
      if (e.type === "agent") {
        if (typeof e.costUsd === "number") spend += e.costUsd;
        saveManifest(buildManifest("running"));
      }
    },
    onAgentEvent: (ordinal, e, attempt) => appendAgentEvent(runId, ordinal, e, attempt),
  };

  const run = starter(startOpts);

  // A synchronous compile reject (doc §4: "validates synchronously") settles
  // `finished` on the very next microtask — nothing was ever persisted
  // (runDir was never touched), and the error goes back to the caller, not
  // the user (doc §4). No manifest, no runId handed back.
  if (run.state() === "failed") {
    const result = await run.finished;
    return { ok: false, error: result.error ?? "Ultra script failed validation." };
  }

  registry().set(runId, run);
  saveManifest(buildManifest("running"));

  // Fire-and-forget (doc §4 "non-blocking"): NOT awaited by the caller. The
  // run keeps working in this process after launch() returns; this .then()
  // just persists the terminal outcome whenever it lands.
  run.finished
    .then((result) => {
      saveManifest(buildManifest(result.state, result.error, result.result));
    })
    .catch(() => {
      // startUltra's own finished promise never rejects (every path settles
      // via settle()) — this catch is defense-in-depth only, never expected.
    });

  return { ok: true, runId, meta: run.meta };
}

// Fresh run — mints a runId (or honors a forced one, tests only), persists
// the script text so a later bare resume can round-trip it, and starts.
export async function launchUltra(opts: LaunchUltraOpts): Promise<LaunchUltraResult> {
  const runId = opts.runId ?? newUltraRunId();
  // Compile-check BEFORE any fs write (doc §6.5's reject-then-reauthor beat
  // is a normal, expected flow, not a rare edge case): persistScript() below
  // mkdirSync's the run directory, and a reject never gets far enough to
  // write manifest.json (launch() -> startUltra() settles `failed` with
  // nothing persisted, executor.ts's terminalRun) — so writing script.js
  // first would leak an orphaned, un-manifested directory that
  // listUltraRuns()/getUltraManifest() can never reach (both key off
  // manifest.json) and nothing ever reaps.
  const compiled = compileScript(opts.script);
  if (!compiled.ok) return { ok: false, error: compiled.error };
  persistScript(runId, opts.script);
  return launch(
    runId,
    opts.script,
    (startOpts) => startUltra(opts.script, { ...startOpts, agent: opts.agent, project: opts.project }),
    opts,
  );
}

export type ResumeUltraOpts = {
  script?: string; // omitted -> the persisted script.js from the original launch
  agent?: StartUltraOpts["agent"];
  project?: string;
  account?: AccountProfile;
};

export type ResumeUltraResult =
  | { ok: true; runId: string; meta: ScriptMeta }
  | { ok: false; error: string };

// Same shape guard journal.ts's runDir enforces (a bare, separator-free
// segment) — checked up front here so a malformed/traversal id fails clean
// with {ok:false} before any fs call, rather than an uncaught throw from deep
// inside persistScript (the one write below not already behind a
// null-returning try/catch, since getUltraManifest/readUltraScript both treat
// a bad id as "not found" rather than propagating).
const RUN_ID_RE = /^[A-Za-z0-9_-]+$/;

// Re-run a (possibly edited) script under an EXISTING runId, serving the
// journal prefix by ordinal (doc §3/§5) — the standard Stop → edit → resume
// surgery. Refuses if this process already has a live task for the id (two
// concurrent tasks against one journal.jsonl would race its appends).
export async function resumeUltraRun(runId: string, opts: ResumeUltraOpts = {}): Promise<ResumeUltraResult> {
  if (!RUN_ID_RE.test(runId)) {
    return { ok: false, error: `invalid ultra runId: ${JSON.stringify(runId)}` };
  }
  const live = registry().get(runId);
  if (live && live.state() === "running") {
    return { ok: false, error: `Ultra run "${runId}" is already running.` };
  }
  const manifest = getUltraManifest(runId);
  const script = opts.script ?? readUltraScript(runId);
  if (!script) {
    return {
      ok: false,
      error: manifest
        ? `Ultra run "${runId}" has no persisted script — pass one explicitly to resume.`
        : `Ultra run "${runId}" not found.`,
    };
  }
  if (opts.script && opts.script !== readUltraScript(runId)) persistScript(runId, opts.script);

  // A resume inherits the ORIGINAL project/account when the caller doesn't
  // override — the common "just resume" case must not silently fall back to
  // the web server's own cwd or an unauthenticated base login (see
  // UltraManifest.project's comment). `account` is stored as just a NAME on
  // the manifest, so it's re-resolved back to a profile here.
  const project = opts.project ?? manifest?.project;
  const account = opts.account ?? (manifest?.account ? getAccount(manifest.account) : undefined);

  return launch(
    runId,
    script,
    (startOpts) => resumeUltra(runId, script, { ...startOpts, agent: opts.agent, project }),
    {
      args: manifest?.args,
      sessionId: manifest?.sessionId,
      messageId: manifest?.messageId,
      account,
      project,
    },
  );
}

// Aborts a live run — mirrors dispatcher.ts's cancelLoom. Only works while
// the run's task is alive in THIS process (doc §3's single-process reality);
// a run with no live registry entry (server restarted, or already terminal)
// simply returns false — getUltraManifest's own self-healing read is what
// reconciles a truly-dead `running` manifest to `stopped`, not this.
export function stopUltraRun(runId: string): boolean {
  const run = registry().get(runId);
  if (!run || run.state() !== "running") return false;
  run.stop();
  return true;
}
