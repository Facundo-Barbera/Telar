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
import { ledgerReadUnavailable, ledgerSpendUsd, logUsage } from "../usage-ledger";
import { runDir, ultraDir } from "./journal";
import { ultraEvents, ultraRunLabel } from "./events";
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

// A script's return value is ARBITRARY — a BigInt, a circular object, anything
// JSON.stringify refuses — and it is written verbatim onto the manifest. So the
// serialization class of terminal-write failure is removed AT SOURCE here rather
// than recovered from below: round-trip it once, and on a throw substitute a
// TOMBSTONE STRING.
//
// A tombstone rather than dropping `result`: a `done` manifest with no result
// makes the wake appendix say "the run completed and returned nothing", which is
// a LIE about a run that returned a BigInt. The tombstone is true, survives to
// the appendix verbatim, and needs no second write. Mirrors ultra-wake.ts's own
// safeJson posture, one layer down.
function safeManifestResult(v: unknown): unknown {
  if (v === undefined) return v;
  try {
    JSON.stringify(v);
    return v;
  } catch (err) {
    return `(the script returned a value that could not be serialized: ${err instanceof Error ? err.message : String(err)})`;
  }
}

// The spend figure ALREADY ON DISK for this run, read with no side effect —
// deliberately NOT via getUltraManifest, whose self-healing `running` →
// `stopped` rewrite would fire from inside a live run's own manifest write. It
// exists for one caller: the fallback below, when the ledger cannot be read at
// all in a fresh process and there is no in-run figure yet. A fallback that
// mutates the thing it is a fallback for is not a fallback.
//
// Null for "no usable figure": no manifest yet, unreadable, unparseable, or a
// `spend` that is not a finite number. Null is NOT zero — the caller must be
// able to tell "nothing to fall back on" from "the fallback is $0".
function persistedSpend(runId: string): number | null {
  try {
    const m = JSON.parse(fs.readFileSync(manifestFile(runId), "utf8")) as { spend?: unknown };
    return typeof m.spend === "number" && Number.isFinite(m.spend) ? m.spend : null;
  } catch {
    return null;
  }
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
    // THE RETURN IS THE CONTRACT; THE WRITE IS AN OPTIMISATION. Heal in memory
    // first, then TRY to persist — a heal that could not be persisted is
    // recomputed identically on the next read, because the condition it keys on
    // (`running` with no live registry entry) is still true.
    //
    // The write was unwrapped until this story, and it is a WRITE ON A READ
    // PATH: `listUltraRuns()` calls this for EVERY run directory and
    // `pendingUltraWakes` calls that on every chat POST for every session — so
    // ONE bad manifest anywhere 500'd every chat turn in the app, including
    // sessions that had never touched Ultra. Both reproduced escapes are real: a
    // `running` manifest with no `runId` key throws `invalid ultra runId:
    // undefined` out of runDir inside saveManifest, and a well-formed stale
    // manifest whose root refuses the write throws that write's errno.
    //
    // NOTHING IS LOGGED HERE, deliberately. The obvious "best-effort append to
    // the run's own events.ndjson" would fire on every chat turn of every
    // session for as long as the path stays unwritable, and events.ndjson is
    // read WHOLE by ultra_status, by the per-run SSE route and by the rail —
    // so the log would grow without bound and make every reader of that run
    // slower, forever, as the price of a failure that is already observable
    // (the on-disk manifest still says `running`).
    // THE HEALED TIMESTAMP MUST BE IDEMPOTENT, and `Date.now()` here was not
    // (the wake-marker loop, 2026-08-08): wake.ts dedupes delivery by
    // `deliveredTerminalAt === m.updatedAt`, so a heal whose persist FAILED
    // and which then re-minted a fresh timestamp on every read was a terminal
    // no ack could ever match — the wake stayed pending forever, the client's
    // freshness latch saw a "new" terminal every poll, and the session fired
    // hidden wake turns in a loop, each announcing the same "ultra stopped"
    // marker. The heal keeps the manifest's own `updatedAt` in memory: the
    // recomputed heal is now IDENTICAL on every read, exactly as the comment
    // above has always claimed. The one successful persist below is the only
    // thing that moves the timestamp — once, durably, so every later read
    // (and the ack's second read) agrees on it.
    const healed = { ...m, state: "stopped" as const, updatedAt: Date.now() };
    try {
      saveManifest(healed);
      // Persisted: the disk is terminal now, this branch never fires again
      // for this run, and every later reader sees exactly this timestamp.
      m = healed;
    } catch {
      // Unpersisted: heal for this reader but KEEP the manifest's own
      // `updatedAt`, so the next read recomputes the identical heal —
      // timestamp included.
      m = { ...m, state: "stopped" };
    }
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

// A `log` line into the run's OWN durable stream, contained: the caller is
// always already handling a failure, so the reporter must never become a second
// one. A `log` event rather than a new UltraEvent variant on purpose — that
// union is executor.ts's, and a variant no reader knows about would record the
// failure exactly as invisibly as swallowing it.
//
// NOT for the read path (getUltraManifest's self-heal deliberately logs
// nothing) — see the comment there. This is for the WRITE path, where the
// caller is one run doing one thing once.
function appendUltraLog(runId: string, msg: string): void {
  try {
    appendUltraEvent(runId, { type: "log", msg });
  } catch {
    // the run's own event log is unwritable too — nothing left to report to,
    // and still not a reason to fail a run.
  }
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

// WHICH ORDINALS HAVE BEGUN (story 4.2) — the "is anything running right now"
// reader the session rail's live agent rows have no other source for.
//
// IT ANSWERS A DIFFERENT QUESTION FROM `readUltraEvents`, and that difference is
// the whole point. An `agent` UltraEvent means an ordinal SETTLED; a file under
// `agents/` means an ordinal has STREAMED AT LEAST ONE ENGINE EVENT, which
// happens while it is still working. Before this, a running agent was invisible
// to every reader outside the executor's own process.
//
// A directory listing and not a scan of events.ndjson on purpose: it is O(agents)
// rather than O(stream), it needs no parsing, and it is correct for a run
// resumed in a different process (the files are on disk; the in-process registry
// is not).
//
// Tolerant of `agents/` not existing — a run that has not spawned anything yet,
// or a run whose directory was never created, is EMPTY and never an error. Only
// `<n>.ndjson` names count: `agentFile` is the sole writer of that directory and
// this is the exact inverse of its name construction, so a stray file cannot
// mint a phantom ordinal.
const AGENT_FILE_RE = /^(\d+)\.ndjson$/;

export function listUltraAgentOrdinals(runId: string): number[] {
  let names: string[];
  try {
    names = fs.readdirSync(agentsDir(runId));
  } catch {
    return [];
  }
  const out: number[] = [];
  for (const name of names) {
    const m = AGENT_FILE_RE.exec(name);
    if (m) out.push(Number(m[1]));
  }
  return out.sort((a, b) => a - b);
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
  // The project's own guardrails, forwarded to every child agent's PreToolUse
  // hook (ultra/child-guard.ts). The CALLER resolves them — this package does
  // not read a project manifest — so the launch API route hands them in from the
  // same `getProject()` lookup it already does for `root`.
  guardrails?: StartUltraOpts["guardrails"];
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
// full CACHE HIT settles with NO internal `await` at all (the journal map's
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
  const compiled = compileScript(script);
  const meta: ScriptMeta = compiled.ok ? compiled.meta : {};

  // AD-18 — the manifest's `spend` READ leg, with the same rule weave.ts's
  // `spentUsd` applies on the sibling leg: A PROJECTION THAT COULD NOT BE READ
  // MUST NOT BE PERSISTED AS $0.
  //
  // ledgerSpendUsd answers 0 for two different events — "no line was ever
  // written for this run" (true, and worth 0) and "the ledger could not be read
  // right now" (meaningless) — and a bare read cannot tell them apart.
  // ledgerReadUnavailable() is the port's own predicate for the second, and it
  // is TRUE only when the last fold-producing read failed transiently with no
  // fold of that file to serve. Why it matters here specifically: manifest.json
  // is rewritten on every agent settle AND once more on the terminal, so a
  // transient EACCES/EMFILE on the FIRST ledger touch of a fresh, resumed
  // process writes `spend: 0` over a run that has really spent $7.50 — and if
  // that lands on the terminal write, the wrong figure is the permanent record.
  //
  // Ultra's spend is a READOUT, not a cap, so failing closed here means keeping
  // the best figure available rather than throwing (weave.ts throws because its
  // number GATES spending; nothing gates on this one, and failing a settled run
  // over bookkeeping would be the worse trade). In order: the last figure this
  // run read successfully, then the figure an earlier process already persisted
  // in manifest.json, then 0 — and the fallback is announced in the run's own
  // events.ndjson, one-shot, so a stale readout is never silent.
  let lastKnownSpend: number | null = null;
  let spendFallbackReported = false;
  const projectedSpend = (): number => {
    const spent = ledgerSpendUsd({ ownerKind: "ultra", ownerId: runId });
    if (!ledgerReadUnavailable()) {
      lastKnownSpend = spent;
      return spent;
    }
    // Read the persisted figure only on THIS path, and only until it yields
    // one: a fallback for a failure has no business in the hot manifest write.
    // (If the manifest is absent or unusable this re-reads on the next failed
    // projection — an ENOENT per settle while the ledger is unreadable, which
    // is cheaper than caching a `null` that would outlive the condition.)
    // ASSIGNMENT ONLY, never `+=`: `lastKnownSpend` holds a whole projection,
    // so repeated failures cannot make it drift.
    if (lastKnownSpend === null) lastKnownSpend = persistedSpend(runId);
    if (!spendFallbackReported) {
      spendFallbackReported = true;
      try {
        appendUltraEvent(runId, {
          type: "log",
          msg:
            `spend-read-unavailable: the usage ledger could not be read; manifest spend holds at ` +
            `${lastKnownSpend === null ? "0 (no earlier figure to hold — this run has read no ledger yet)" : String(lastKnownSpend)}` +
            ` rather than being rewritten to 0`,
        });
      } catch {
        // the run's own event log is unwritable too — still not a reason to
        // fail a run over accounting.
      }
    }
    return lastKnownSpend ?? 0;
  };

  const buildManifest = (state: UltraState, error?: string, result?: unknown): UltraManifest => ({
    runId,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.messageId ? { messageId: opts.messageId } : {}),
    ...(opts.account?.name ? { account: opts.account.name } : {}),
    ...(opts.project ? { project: opts.project } : {}),
    meta,
    ...(opts.args !== undefined ? { args: opts.args } : {}),
    state,
    // AD-18 — a PROJECTION over the one usage ledger, folded fresh on every
    // manifest write, never a counter this closure accumulates. A line
    // appended for this run by anything else is visible here too, and a
    // resumed run picks up its own persisted prefix instead of restarting
    // from zero. `lastKnownSpend` is NOT an accumulator: it is only ever
    // ASSIGNED a whole projection, and only ever read when the projection could
    // not be — see projectedSpend above.
    spend: projectedSpend(),
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
        // ONE keyed ledger row per LIVE SETTLE of an ordinal, written on EVERY
        // presentation of that settle — live or cache-replayed. Identity, not a
        // guard, is what stops the double-count now: usage-ledger.ts folds a
        // non-empty `entryKey` at most once, over the FILE, so a row that
        // already landed cannot be billed twice no matter how many times this
        // callback re-presents it.
        //
        // WHY the old `!e.cached` guard is GONE, and why removing it is the
        // repair rather than a regression: appendJournal runs strictly BEFORE
        // opts.onEvent (executor.ts's live-settle path), so a LIVE settle whose
        // logUsage throws leaves the ordinal journaled WITH its cost and with
        // no ledger row at all. Every later resume re-emits that same settle as
        // `cached: true`, replaying the journaled costUsd verbatim under the
        // SAME settleId — the id is ON the journal record, so the replay reads
        // it back rather than deriving it — and the old guard skipped exactly
        // those, so the gap was unrecoverable FOREVER and the run
        // under-reported real money in silence. Attempting the write on the
        // cached replay REPAIRS the gap; the fold's entryKey dedupe is what
        // makes the repair safe.
        if (typeof e.costUsd === "number") {
          // ONE reporter for every way this settle's money can fail to reach the
          // ledger — a value the ledger cannot accept, a rejection it reports by
          // RETURNING false, and a throw. All three are the same event to a
          // human: real money that is not on the ledger.
          //
          // Never swallowed: events.ndjson is this run's own durable log, so the
          // miss is visible to anyone tailing the run (and to ultra-mcp's
          // journal summary) rather than only to the ledger's absence. A `log`
          // event and not a new UltraEvent variant on purpose — that union is
          // executor.ts's and is deliberately not touched here, and a variant no
          // reader knows about would record the failure exactly as invisibly as
          // swallowing it.
          const reportSpendMiss = (msg: string) => {
            try {
              appendUltraEvent(runId, { type: "log", msg });
            } catch {
              // the run's own event log is unwritable too — nothing left to
              // report to, and still not a reason to fail the run.
            }
          };
          if (!Number.isFinite(e.costUsd)) {
            // `typeof NaN === "number"`, so the check above is a TYPE check and
            // not a VALUE check. Handed to logUsage, a NaN or Infinity cost
            // fails the UsageEntry schema (z.number() rejects NaN), logUsage
            // returns false WITHOUT throwing, the catch below therefore never
            // fires, and the only trace of a real, already-paid-for agent settle
            // would be a console line. weave.ts's recordSpend guards this exact
            // provider anomaly with its own `spend-record-skipped` event; this
            // is the sibling leg's copy of that guard, and the asymmetry between
            // the two legs was the finding.
            reportSpendMiss(
              `spend-record-skipped ordinal=${e.ordinal}: non-finite cost ${String(e.costUsd)} — nothing was written to the ledger, and a resume replaying this ordinal from the journal will present the same unusable value`,
            );
          } else {
            // ACCOUNTING IS BEST-EFFORT; THE RUN IS NOT. This callback is invoked
            // from inside the script's own `await agent()`, so a throw escaping
            // here fails a run that was already billed AND skips the
            // saveManifest below — freezing the manifest's state/spend readout
            // for the rest of the run. logUsage can genuinely throw
            // (ENOSPC/EACCES/EROFS on mkdirSync/appendFileSync, or its
            // NODE_ENV=test-without-TELAR_HOME guard), so it is contained here.
            try {
              const logged = logUsage({
                ts: Date.now(),
                account: opts.account?.name ?? "unknown",
                model: e.model,
                sessionId: opts.sessionId ?? "",
                ownerKind: "ultra",
                ownerId: runId,
                // Story 4.1 / FR-UW-5 — the OWNING CHAT TURN. `ownerId` is
                // already spoken for as the runId, so per-turn attribution
                // needed its own field (schemas.ts's UsageEntry.messageId). This
                // is the launching turn's `runId`, threaded in by
                // apps/web/app/api/chat/route.ts's `getMessageId: () => runId`.
                // Additive and defaulted: a run launched with no messageId
                // writes no such key at all, exactly as before.
                //
                // NO NEW CALL SITE. INV-5b pins logUsage's three production
                // callers to one per UsageOwnerKind, and this is a field on the
                // ultra caller that already existed.
                messageId: opts.messageId ?? "",
                costUsd: e.costUsd,
                // THE LEDGER HAS ALWAYS HAD THESE FIELDS; this caller passed
                // none, so every ultra row banked its dollars and defaulted its
                // token counts to 0. Nothing downstream could then state an
                // Ultra's token usage — not the agent rows, not any per-run
                // rollup — while the identical session-owned rows carried it.
                // Absent usage stays 0 here because `UsageEntry` defaults it so;
                // the "not reported" distinction is kept where it can be
                // expressed, on the settle event and the journal record.
                ...(e.tokens
                  ? {
                      inputTokens: e.tokens.input,
                      outputTokens: e.tokens.output,
                      cacheReadTokens: e.tokens.cacheRead,
                      cacheCreateTokens: e.tokens.cacheCreate,
                    }
                  : {}),
                // A KEY NAMES A BILLABLE EVENT, NOT A SLOT. (runId, ordinal)
                // names a slot: `ordinal` is issued from a per-run counter that
                // RESTARTS AT 0 on every re-run, so that name covers every call
                // that has ever occupied the position — and a resume genuinely
                // re-runs, and the provider genuinely re-bills, both the call a
                // human rewrote and (executor.ts's `cacheValid` being a one-way
                // latch) every later ordinal after the first miss. Keyed on the
                // slot, the fold consumed the FIRST of those billings and
                // dropped every later one. The write path suppresses nothing, so
                // those rows do land — but a row repeating a key is precisely
                // what an honest re-presentation of one settle looks like, so no
                // projection counts it, no `spend-record-failed` event fires and
                // no log line is written: real money, missing from every
                // readout.
                //
                // `settleId` (executor.ts) is the per-CALL identity: a unique id
                // MINTED WHEN THE MONEY WAS SPENT and written onto that settle's
                // journal record. A cache replay reads it back out of the record
                // it is serving, so a re-record folds to nothing here while a
                // genuine re-run — which minted its own — gets its own row.
                //
                // It is minted rather than COUNTED for the reason the ordinal
                // itself failed, one level down: a tally of journal records
                // regresses when a corrupt line is skipped and collides when two
                // processes resume one runId, and either way a live settle
                // re-mints a key already on the ledger and its cost is dropped
                // in the same silence. `runId`/`ordinal` stay in the key as
                // human-readable provenance; the id alone is what makes it
                // unique.
                entryKey: `ultra:${runId}:${e.ordinal}:${e.settleId}`,
              });
              if (!logged) {
                // THE RETURNED BOOLEAN IS READ, not discarded. logUsage's
                // documented failure signal is `false`, not a throw — it refuses
                // to throw so that an accounting defect can never fail an
                // in-flight run — so the catch below cannot see a schema
                // rejection. Discarding the boolean is what made the "Never
                // swallowed" claim beside this call false for that path: the row
                // was missing from usage.ndjson, from the manifest and from
                // events.ndjson at once, with a console line as the only trace.
                reportSpendMiss(
                  `spend-record-failed ordinal=${e.ordinal}: logUsage rejected the entry — it is NOT on the ledger (usage-ledger.ts prints the failing fields); re-attempted only if a later resume REPLAYS this ordinal from the journal`,
                );
              }
            } catch (err) {
              // The message states the CONDITIONAL repair, not a promise. The
              // re-attempt happens only where the repair actually lives: a later
              // resume that REPLAYS this ordinal from the journal re-presents
              // this settle's `settleId` and rewrites its row. A resume that
              // re-runs the ordinal LIVE instead (the human edited that call, or
              // `cacheValid` latched false at an earlier ordinal) mints a NEW id
              // for the new billing and never re-presents this one — so this
              // spend stays off the ledger for good, and the log line has to say
              // so or the human stops looking.
              reportSpendMiss(
                `spend-record-failed ordinal=${e.ordinal}: ${err instanceof Error ? err.message : String(err)} — re-attempted only if a later resume REPLAYS this ordinal from the journal; a resume that re-runs it live never re-presents this settle and this spend stays off the ledger`,
              );
            }
          }
        }
        // ACCOUNTING IS BEST-EFFORT, THE RUN IS NOT — the sentence twelve lines
        // above, finally applied to the line it did not cover. This callback is
        // invoked from inside the script's own `await agent()`, so a throw
        // escaping here fails a run that was ALREADY BILLED; the argument that
        // contained logUsage applies unchanged to the write that follows it.
        // buildManifest is inside the try too: it calls projectedSpend() →
        // ledgerSpendUsd(), which can throw.
        try {
          saveManifest(buildManifest("running"));
        } catch (err) {
          appendUltraLog(
            runId,
            `settle-manifest-write-failed ordinal=${e.ordinal}: ${err instanceof Error ? err.message : String(err)} — this settle's spend/state did not reach manifest.json; the run continues and the next successful write (a later settle, or the terminal one) carries the whole projection anyway`,
          );
        }
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
  // DELIBERATELY UNWRAPPED, unlike the settle and terminal writes below. If the
  // manifest cannot be written at launch the CALLER must learn about it: a run
  // live in the registry with no manifest is invisible to getUltraManifest,
  // listUltraRuns, the wake projection and every route — there is nothing to
  // degrade to.
  saveManifest(buildManifest("running"));

  // Fire-and-forget (doc §4 "non-blocking"): NOT awaited by the caller. The
  // run keeps working in this process after launch() returns; this .then()
  // just persists the terminal outcome whenever it lands.
  run.finished
    .then((result) => {
      // THE TERMINAL WRITE, WRAPPED — recorded three times (deferred-work.md,
      // story 4.1's completion note 17, story 4.2's scope-fence table) with the
      // standing owner "whichever story next opens ultra's terminal write path
      // deliberately". This is that story, so this closes it rather than
      // re-deferring it.
      //
      // buildManifest is INSIDE the try: it calls projectedSpend() →
      // ledgerSpendUsd(), which can throw, and it is where the result is
      // serialized. `safeManifestResult` has already removed the serialization
      // class (a BigInt/circular return value) at source, so what remains here
      // is the fs class — ENOSPC, EROFS, EACCES, a blocked temp path.
      let manifest: UltraManifest;
      try {
        manifest = buildManifest(result.state, result.error, safeManifestResult(result.result));
        saveManifest(manifest);
      } catch (err) {
        // THE RECOVERY IS `registry().delete`, and it is why this catch is more
        // than a log. getUltraManifest's self-heal is gated on
        // `!registry().has(runId)`, and nothing in this file ever deleted from
        // the registry — so a run whose terminal write failed kept BOTH a
        // `running` manifest AND a live handle, which is precisely why its heal
        // "cannot fire until the process restarts" and its completion wake was
        // unreachable. Releasing the handle turns "stranded forever" into
        // "reconciles to `stopped` on the next read", and because
        // pendingUltraWakes derives pending from the manifest, that IS "the wake
        // becomes reachable".
        //
        // THE HONEST CEILING, stated because a reader will otherwise assume
        // more: the wake becomes REACHABLE, not ACCURATE. A run that genuinely
        // finished `done` with a real result is reported as `stopped` with no
        // result, and the appendix will say "stopped before finishing". A
        // recovery that cannot write to disk cannot preserve an outcome; what it
        // can do is stop the run lying about being alive.
        //
        // ONLY IN THIS CATCH, never on the happy path: a successful terminal
        // write leaves a terminal manifest, so the self-heal can never fire for
        // it anyway, and deleting unconditionally would change what
        // stopUltraRun() and getLiveUltraRun() answer for a completed run.
        appendUltraLog(
          runId,
          `terminal-manifest-write-failed: ${err instanceof Error ? err.message : String(err)}` +
            ` — this run's terminal state is NOT on disk; its live handle has been released so the` +
            ` next read reconciles it to "stopped" and its completion wake becomes reachable (the` +
            ` real outcome is lost — a wake that cannot be written cannot be preserved)`,
        );
        registry().delete(runId);
        // The publish is SKIPPED: announcing `run-completed` for a terminal the
        // durable projection contradicts would put the fast path ahead of the
        // guarantee. It only ever stamps `recordedAt`, which pending-ness does
        // not depend on, so skipping it costs nothing.
        return;
      }
      // Story 4.1 / AC4 — announce the terminal state on the one event bus, as
      // an `agent-facing` event (AD-14). THE ORDER IS LOAD-BEARING: the durable
      // write happens first, so if only one of the two survives it is the one
      // the wake's correctness actually rests on.
      //
      // WHY HERE AND NOT IN executor.ts's settle(). settle() is the more
      // "central" terminal point and that is exactly why it is wrong: it lives
      // inside the executor, which knows a runId and nothing else — no
      // sessionId, no messageId, no account, no persisted spend. This closure
      // has all of them, runs in whichever process is actually driving the run,
      // and already performs the terminal saveManifest. It also keeps
      // executor.ts out of this story's write set, which the SPEC's
      // finish-work-only non-goal is asking for.
      //
      // BEST-EFFORT, exactly like the logUsage call two functions above:
      // NOTIFICATION IS BEST-EFFORT, THE RUN IS NOT. A throw escaping here is
      // an unhandled rejection on a run that has already finished and already
      // persisted, so it is contained and reported into the run's own event log
      // — one-shot, the same posture weave.ts's recordSpend takes.
      //
      // AND IT IS THE FAST PATH, NEVER THE GUARANTEE. If this publish is lost —
      // it threw, no subscriber was installed in this process, or the process
      // died before reaching it — the run is STILL pending, because
      // `pendingUltraWakes` derives pending from the MANIFEST (terminal, and no
      // `deliveredAt` stamp), not from anything this line does. Losing the
      // event degrades delivery to "late", never to "never". Do not rewrite
      // this comment to say the subscriber is what makes the wake work.
      try {
        ultraEvents().publish("run-completed", {
          runId,
          sessionId: manifest.sessionId ?? "",
          messageId: manifest.messageId ?? "",
          state: result.state,
          name: ultraRunLabel(manifest.meta, runId),
          // Guarded the same way wake.ts's `toPendingWake` guards it, and for
          // the same reason: `UltraRunCompletedPayload.spendUsd` is z.number(),
          // which REJECTS NaN — so an unguarded non-finite spend would make
          // publish throw and the catch below would report a delivery failure
          // that was really a bookkeeping anomaly. The two readers now agree.
          spendUsd: Number.isFinite(manifest.spend) ? manifest.spend : 0,
          terminalAt: manifest.updatedAt,
          ...(manifest.result !== undefined ? { result: manifest.result } : {}),
          ...(manifest.error ? { error: manifest.error } : {}),
        });
      } catch (err) {
        try {
          appendUltraEvent(runId, {
            type: "log",
            msg:
              `run-completed-publish-failed: ${err instanceof Error ? err.message : String(err)}` +
              ` — the terminal manifest IS written, so this run stays pending for the session's ` +
              `next turn (pendingUltraWakes reconciles from the manifest); only the immediate ` +
              `wake was lost`,
          });
        } catch {
          // the run's own event log is unwritable too — still not a reason to
          // fail a run that has already finished.
        }
      }
    })
    .catch(() => {
      // startUltra's own finished promise never rejects (every path settles
      // via settle()) — this catch is defense-in-depth only, never expected.
      // The `.then` body above is now fully wrapped (the terminal write and the
      // publish each have their own catch), so this is genuinely unreachable
      // rather than the silent backstop that swallowed the terminal write until
      // this story.
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
    (startOpts) =>
      startUltra(opts.script, {
        ...startOpts,
        agent: opts.agent,
        project: opts.project,
        guardrails: opts.guardrails,
      }),
    opts,
  );
}

export type ResumeUltraOpts = {
  script?: string; // omitted -> the persisted script.js from the original launch
  agent?: StartUltraOpts["agent"];
  project?: string;
  // Resolved by the CALLER, exactly as on a fresh launch. Unlike `project` and
  // `account` this is NOT recoverable from the manifest — guardrails are the
  // project's CURRENT configuration, not a property of the run, so a resume must
  // enforce today's rules rather than the ones in force when it first started.
  guardrails?: StartUltraOpts["guardrails"];
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
    // A RESUME IS GUARDED LIKE A LAUNCH. Forgetting this would make the guard
    // opt-out by re-entry: stop a run, resume it, and its children would run
    // unguarded — the journal replays the prefix, but every live call after the
    // cache miss is a fresh child.
    (startOpts) =>
      resumeUltra(runId, script, {
        ...startOpts,
        agent: opts.agent,
        project,
        guardrails: opts.guardrails,
      }),
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
