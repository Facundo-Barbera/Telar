// The completion wake's DURABLE half (story 4.1 / AC1, AC2, AC7; FR-UW-1).
//
// ── THE ONE SENTENCE THIS FILE EXISTS TO MAKE TRUE ────────────────────────────
// A run that reached a terminal state gets its outcome to the session's agent
// EXACTLY ONCE, and losing the bus event delays that, never cancels it.
//
// It is tempting — and wrong — to describe the design as "the wake is published
// and the subscriber records it." That sentence is true of the happy path and
// false of the two paths that matter. So, stated the correct way round:
//
//   THE GUARANTEE is `pendingUltraWakes`, a PROJECTION: a run is pending when
//   its own manifest is terminal, names this session, and its own wake record
//   does not already say it was delivered FOR THAT TERMINAL. Nothing about that
//   depends on an event ever having been published.
//   THE FAST PATH is the bus. `ultra:run-completed` is published by
//   storage.ts at the terminal write and stamps `recordedAt` here, so a live
//   process learns immediately instead of at the session's next read.
//
// AD-15's reconcile-on-read doctrine is exactly this shape, and it is why the
// three failure modes below all land on "delivered late":
//
//   Publish threw            → no record, so terminal-with-no-deliveredAt → pending.
//   Process died pre-terminal → getUltraManifest self-heals `running` → `stopped`
//                               ON READ, which does NOT go through settle() and
//                               fires no publish at all → still pending, because
//                               pending is derived from the manifest and not from
//                               the record's existence. (This is also, precisely,
//                               a run killed by a server restart — the exact class
//                               of failure the story exists to end. Key off the
//                               manifest, never off "a wake record exists".)
//   Two turns start at once  → both may read the same pending wake; the ack is
//                               idempotent (stamping an already-stamped record
//                               keeps the FIRST timestamp). At worst the outcome
//                               is stated twice; it can never be lost.
//   A run is RESUMED after    → the resume reaches a NEW terminal with a new
//   its wake was delivered      `updatedAt`, and the delivery stamp is scoped to
//                               the terminal it delivered — so the new outcome is
//                               pending again rather than swallowed by the old
//                               stamp. See `deliveredTerminalAt`.
//
// ── THE ONE PLACE THIS GUARANTEE STOPS, stated rather than glossed ────────────
// It rests on THE TERMINAL MANIFEST BEING WRITTEN. `storage.ts`'s
// `run.finished.then` calls `saveManifest` before the publish, and that call is
// NOT wrapped — a throw there (JSON.stringify on a script that returned a BigInt
// or a circular value; ENOSPC/EROFS) lands in the trailing `.catch(() => {})`,
// which predates this story and swallows it. The run then keeps a `running`
// manifest AND a live registry entry, so `getUltraManifest`'s self-heal cannot
// fire either, and the wake is unreachable until the process restarts. This is a
// PRE-EXISTING defect in the terminal write path rather than one this module
// introduces, and it is recorded in
// _bmad-output/implementation-artifacts/deferred-work.md with a named owner
// instead of being fixed here — changing saveManifest's error contract is
// outside story 4.1's write set. Do not read the guarantee above as covering it.
//
// ── WHERE THE RECORD LIVES, AND THE TWO PLACES IT DELIBERATELY DOES NOT ───────
// `TELAR_HOME/ultra/<runId>/wake.json`, composed off `runDir(runId)` — ultra's
// OWN subtree (AD-5, one owner per subtree), a machine single-doc so it is JSON
// written atomically via `.tmp` → `renameSync` (AD-6), with its zod schema owned
// here in @telar/core. Two alternatives were considered and rejected:
//
//   · A FIELD ON `UltraManifest`. Rejected: `saveManifest(buildManifest(...))`
//     rebuilds the manifest FROM SCRATCH out of launch()'s closure on every
//     save, so a field written by any other code path is clobbered by the next
//     save. A resume makes that reachable, not hypothetical.
//   · A SESSION-SCOPED MAILBOX under `sessions/<sessionId>/`. Rejected: that
//     subtree is the SESSION module's (AD-5), it already has a recorded
//     co-tenancy problem (sessions.ts and apps/web/lib/session-log.ts both write
//     there; AD5_OWNERS' "CO-TENANCY 1" note says a THIRD writer fails INV-3),
//     and ultra writing there would be exactly that breach.
//
// This is NOT bus durability, which is architecture-deferred
// (ARCHITECTURE-SPINE.md § Deferred). The bus still persists nothing. This is
// one module's own record under its own subtree, which is a different thing and
// must not be built as if it were the other.
//
// ── AD-3 ──────────────────────────────────────────────────────────────────────
// Server-only, like everything else in packages/core: `fs`, and a state root.
// A client reaches this through `GET /api/ultra/wakes`, never by import.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { runDir } from "./journal";
import {
  ultraEvents,
  ultraRunLabel,
  type UltraEventPort,
  type UltraRunCompletedPayload,
  type UltraRunCompletedState,
} from "./events";
import { getUltraManifest, listUltraRuns, type UltraManifest } from "./storage";

// ── the record ──────────────────────────────────────────────────────────────

// The DELIVERY STATE of one run's wake, and nothing else. The outcome itself is
// not duplicated here: `pendingUltraWakes` reads it off the manifest, which is
// the source of truth for a run's state and spend, so a copy here could only go
// stale (a resumed run's spend keeps moving; its manifest keeps up, a snapshot
// would not).
//
// TOLERANT (AD-7): every field but `runId` defaults, so a record written by an
// older or newer shape still parses, and zod strips unknown keys rather than
// rejecting them. `0` means "never" for both stamps — an absent timestamp and a
// zero one are the same fact, and collapsing them removes a branch every reader
// would otherwise have to get right.
export const UltraWakeRecord = z.object({
  runId: z.string(),
  // When the MOST RECENT terminal publish for this run was observed by the
  // recorder below. 0 means the fast path never ran — which says nothing about
  // whether the wake is pending, and that independence is the whole design.
  recordedAt: z.number().default(0),
  // When a turn CONSUMED this wake. Durable rather than an in-memory flag,
  // precisely so a restart cannot resurrect an already-delivered outcome.
  deliveredAt: z.number().default(0),
  // WHICH TERMINAL THAT DELIVERY WAS FOR — the manifest's `updatedAt` at the
  // moment it was consumed.
  //
  // WHY IT IS NOT ENOUGH TO STAMP `deliveredAt` ALONE, and this was a real bug
  // found by adversarial review rather than a hypothetical. On its own,
  // `deliveredAt` says "this RUN was delivered", which is the wrong claim for
  // the first-class Stop → edit → RESUME flow (`resumeUltraRun`): a run
  // delivered as `stopped`, then resumed and finished `done` with a real result,
  // would be excluded from `pendingUltraWakes` FOREVER — nothing on the resume
  // path touches this file, so the stamp never clears. The session's agent would
  // have heard the stale outcome and never the real one, permanently, surviving
  // a restart. That is precisely the "delivered never" this module exists to
  // make impossible.
  //
  // Scoping the stamp to the terminal it delivered fixes it by construction: a
  // resume writes a NEW `updatedAt`, so the run becomes pending again on its
  // own, and a genuinely delivered wake stays delivered because a TERMINAL
  // manifest's `updatedAt` does not move (getUltraManifest only rewrites a
  // `running` one).
  //
  // A record written before this field existed reads 0, which matches no real
  // manifest, so such a run is re-stated ONCE. That is the deliberate failure
  // direction: this module tolerates "stated twice" and never "lost".
  deliveredTerminalAt: z.number().default(0),
});
export type UltraWakeRecord = z.infer<typeof UltraWakeRecord>;

// What a caller gets back: the outcome, denormalized enough to render with no
// second lookup (AD-8). Every id on it is a WEAK reference — a `sessionId` or
// `messageId` whose target is gone is a tombstone, never a throw.
export type PendingUltraWake = {
  runId: string;
  sessionId: string;
  messageId?: string;
  state: UltraRunCompletedState;
  name: string;
  spendUsd: number;
  terminalAt: number;
  result?: unknown;
  error?: string;
};

const wakeFile = (runId: string) => path.join(runDir(runId), "wake.json");

const TERMINAL: readonly UltraManifest["state"][] = ["done", "failed", "stopped"];
const isTerminal = (state: UltraManifest["state"]): state is UltraRunCompletedState =>
  TERMINAL.includes(state);

// Atomic single-doc write — `.tmp` → `renameSync`, manifest.ts's atomicWrite
// idiom. NOT the append-only-stream exception: that class is usage.ndjson,
// events.ndjson and the session logs, and this is not one of them. Do not
// "consistently" make it an NDJSON stream.
function saveWakeRecord(rec: UltraWakeRecord): void {
  const dir = runDir(rec.runId);
  fs.mkdirSync(dir, { recursive: true });
  const file = wakeFile(rec.runId);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  fs.renameSync(tmp, file);
}

// Null for "no record" — absent, unreadable, unparseable, or a malformed id.
// Never a throw: this sits on a per-turn read path, and a torn file must degrade
// to "not yet delivered" (which re-delivers) rather than to a 500.
export function readUltraWakeRecord(runId: string): UltraWakeRecord | null {
  try {
    const parsed = UltraWakeRecord.safeParse(
      JSON.parse(fs.readFileSync(wakeFile(runId), "utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ── the recorder + the channel ──────────────────────────────────────────────

// The bus handler. Best-effort by construction: `publish` wraps every handler
// and reports a throw as `failed`, and a lost stamp costs nothing a reader
// depends on.
function recordUltraWake(payload: UltraRunCompletedPayload): void {
  const existing = readUltraWakeRecord(payload.runId);
  // The DELIVERY stamps are carried forward, never clobbered — a publish must
  // not be able to un-deliver an outcome a turn already stated. `recordedAt` IS
  // refreshed, deliberately: it means "when the most recent terminal publish was
  // seen", and a resume genuinely reaching a new terminal state is a new publish
  // worth recording. Pending-ness does not depend on it either way (see
  // pendingUltraWakes), so this stamp cannot change what is delivered.
  saveWakeRecord({
    runId: payload.runId,
    recordedAt: Date.now(),
    deliveredAt: existing?.deliveredAt ?? 0,
    deliveredTerminalAt: existing?.deliveredTerminalAt ?? 0,
  });
}

// The port instance the recorder is currently attached to. NOT a boolean: the
// registry is the authority (see events.ts), and `resetBus()` clears
// declarations and subscriptions TOGETHER — so `ultraEvents()` handing back a
// different port object is exactly the signal that the old subscription is gone
// with it. Comparing identities is self-healing where a flag would lie.
let subscribedTo: UltraEventPort | null = null;

// THE ONE ACCESSOR: it gets you the declaration AND the recorder, and neither
// can be registered twice. Everything in this file that touches wakes calls it,
// so any process that has ever asked a wake question has the fast path live.
//
// WHAT IT MEANS IF NOBODY CALLED IT BEFORE A PUBLISH: the publish reaches zero
// wake subscribers, `recordedAt` stays 0, and the run is still pending — see
// this file's header. That is the designed degradation, not a gap. In practice
// the route asks `pendingUltraWakes` on every chat turn and `GET
// /api/ultra/wakes` asks it on every poll, so a process that can launch a run
// from a chat has already installed the recorder.
export function ultraWakeChannel(): UltraEventPort {
  const port = ultraEvents();
  if (subscribedTo !== port) {
    port.subscribeAgentFacing("run-completed", recordUltraWake);
    subscribedTo = port;
  }
  return port;
}

// ── the projection ──────────────────────────────────────────────────────────

function toPendingWake(m: UltraManifest): PendingUltraWake | null {
  if (!isTerminal(m.state)) return null;
  return {
    runId: m.runId,
    sessionId: m.sessionId ?? "",
    ...(m.messageId ? { messageId: m.messageId } : {}),
    state: m.state,
    name: ultraRunLabel(m.meta, m.runId),
    spendUsd: typeof m.spend === "number" && Number.isFinite(m.spend) ? m.spend : 0,
    terminalAt: m.updatedAt,
    ...(m.result !== undefined ? { result: m.result } : {}),
    ...(m.error ? { error: m.error } : {}),
  };
}

// PENDING IS A PROJECTION; DELIVERED IS A STAMP.
//
// Folds every run down to: this manifest names this session, its state is
// terminal, and its wake record has no `deliveredAt`. Newest first, so a caller
// that renders a bounded list shows the freshest outcomes.
//
// ── WHAT THIS COSTS, STATED SO THE NEXT READER MEETS IT AS A KNOWN BOUND ──────
// `listUltraRuns()` does `fs.readdirSync(ultraDir())` over EVERY ultra run
// directory ever created — not scoped by session, not scoped by project — and
// calls `getUltraManifest(id)` on each, which is a `JSON.parse` and, for a stale
// `running` manifest, a `saveManifest` WRITE. Nothing reaps that directory
// today. Because the system-prompt appendix composes on every chat POST for
// every session, a naive call makes every turn in the app a full historical scan
// of `TELAR_HOME/ultra/`, with incidental self-healing writes to unrelated runs.
//
// That is ACCEPTED for story 4.1 rather than discovered: at a developer's run
// volumes the scan is small, and the self-heal write is the reconciliation AD-15
// wants anyway. The mitigation that IS here is the short-circuit below — a
// session that cannot possibly have a wake never scans. A `sessionId → runIds`
// index is recorded in deferred-work.md with story 4.2 as the candidate owner,
// because 4.2's dock signal needs the same session-scoped question answered from
// every page and is the first story with a reason to pay for it.
export function pendingUltraWakes(sessionId: string): PendingUltraWake[] {
  // The short-circuit: no session, no wake, no scan. A wake exists only for a
  // run whose manifest names a session, so an empty id can match nothing.
  if (!sessionId) return [];
  ultraWakeChannel();
  const out: PendingUltraWake[] = [];
  for (const m of listUltraRuns()) {
    if (m.sessionId !== sessionId) continue;
    const wake = toPendingWake(m);
    if (!wake) continue;
    // DELIVERED IS SCOPED TO A TERMINAL, not to a run — see
    // UltraWakeRecord.deliveredTerminalAt. A run that was delivered and has
    // since been RESUMED to a new terminal state has a fresh `updatedAt`, so it
    // is pending again; a run delivered for the terminal it still holds is not.
    const rec = readUltraWakeRecord(m.runId);
    if (rec?.deliveredAt && rec.deliveredTerminalAt === m.updatedAt) continue;
    out.push(wake);
  }
  return out.sort((a, b) => b.terminalAt - a.terminalAt);
}

// Stamps `deliveredAt` on each named run's record — the exactly-once half of
// AC7. Returns how many records this call actually stamped.
//
// IDEMPOTENT: an already-stamped record keeps its FIRST timestamp and is not
// rewritten, so two turns racing the same wake cannot make the second one look
// like the delivery. `sessionId` is checked rather than trusted — an ack is a
// write, and a caller passing a runId from another session must not be able to
// consume that session's wake.
export function ackUltraWakes(sessionId: string, runIds: readonly string[]): number {
  if (!sessionId || runIds.length === 0) return 0;
  ultraWakeChannel();
  const now = Date.now();
  let stamped = 0;
  for (const runId of new Set(runIds)) {
    let m: UltraManifest | null;
    try {
      m = getUltraManifest(runId);
    } catch {
      continue; // malformed id — nothing to ack, never a throw on a turn path
    }
    if (!m || m.sessionId !== sessionId || !isTerminal(m.state)) continue;
    const existing = readUltraWakeRecord(runId);
    // Idempotent FOR THIS TERMINAL. A second ack of the same outcome keeps the
    // first timestamp; an ack of a run that has since been resumed to a new
    // terminal stamps that new one, because it is a different outcome.
    if (existing?.deliveredAt && existing.deliveredTerminalAt === m.updatedAt) continue;
    try {
      saveWakeRecord({
        runId,
        recordedAt: existing?.recordedAt ?? 0,
        deliveredAt: now,
        deliveredTerminalAt: m.updatedAt,
      });
      stamped++;
    } catch {
      // Unwritable state root. The wake simply stays pending and is re-stated on
      // the next turn — the correct failure direction, and the one D4's ack
      // semantics already tolerate.
    }
  }
  return stamped;
}

// How many of this session's runs are still NON-terminal. The client hook polls
// on this: something is running, so keep asking; nothing is, so stop. Same scan
// as above, so a caller wanting both should expect one directory walk each — the
// route asks for them together and pays for it once per poll, not per turn.
export function liveUltraRunCount(sessionId: string): number {
  if (!sessionId) return 0;
  let n = 0;
  for (const m of listUltraRuns()) {
    if (m.sessionId === sessionId && !isTerminal(m.state)) n++;
  }
  return n;
}
