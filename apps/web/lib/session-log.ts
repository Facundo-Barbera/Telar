// Per-session live-turn event log (docs/runtime-architecture.md §A, Phase 1b).
//
// Mirrors the loom event log (packages/core/src/looms.ts) but scoped to a chat
// session's CURRENT in-flight turn. The POST /api/chat run writes its SSE event
// stream here as it goes; a client that reconnects while the turn is still
// running tails this file (via GET /api/chat/[sessionId]/events) to watch the
// turn live, instead of seeing the stale pre-turn state until it finishes.
//
// The file is TRUNCATED at the start of every turn: it only ever holds the
// current turn's events. A completed turn already lives in chats.json (the page
// seeds from it on mount), so the log is purely the live-tail surface.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = () => process.env.TELAR_HOME ?? path.join(os.homedir(), ".telar");
const sessionDir = (sessionId: string) => path.join(home(), "sessions", sessionId);
const logFile = (sessionId: string) => path.join(sessionDir(sessionId), "live.ndjson");

export type SessionLogEvent = { event: string; data: unknown };

// Open a fresh log for a new turn: truncate the file, then write a synthetic
// `user` header event so a reconnecting client can render the user bubble. The
// POST path never emits a "user" SSE event (the client adds it optimistically),
// so the reconnect log must carry it as its first line.
export function startSessionLog(sessionId: string, userText: string): void {
  // A brand-new turn: drop any stale current-block deltas a crashed prior turn
  // may have left in the ring (endSessionDeltas normally clears them at
  // teardown, but a crash before the finally can skip that).
  endSessionDeltas(sessionId);
  try {
    const dir = sessionDir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      logFile(sessionId),
      JSON.stringify({ event: "user", data: { text: userText } }) + "\n",
    );
  } catch {
    // logging is best-effort — never let it break the turn
  }
}

// Append one SSE event to the session's live log. Best-effort: never throws.
export function appendSessionEvent(sessionId: string, event: string, data: unknown): void {
  try {
    fs.appendFileSync(logFile(sessionId), JSON.stringify({ event, data }) + "\n");
  } catch {
    // best-effort
  }
}

// Tail the log from `afterLine` (complete lines already consumed); pass back
// nextLine to drain incrementally. Missing file → nothing yet.
export function readSessionEvents(
  sessionId: string,
  afterLine: number,
): { events: SessionLogEvent[]; nextLine: number } {
  let raw: string;
  try {
    raw = fs.readFileSync(logFile(sessionId), "utf8");
  } catch {
    return { events: [], nextLine: 0 };
  }
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const events: SessionLogEvent[] = [];
  for (const line of lines.slice(afterLine)) {
    try {
      events.push(JSON.parse(line) as SessionLogEvent);
    } catch {
      // corrupt/partial line: skip but still count it as consumed
    }
  }
  return { events, nextLine: lines.length };
}

// ── Live delta ring (contract §2) ──────────────────────────────────────────
// The token-level firehose (delta / thinking_delta) is deliberately kept OUT of
// the ndjson file above — it's high-volume and only ever needed live. Instead
// each session mirrors the CURRENT streaming block's deltas into a bounded
// in-memory ring, so a client that reconnects mid-turn (GET .../events) replays
// the in-flight tokens and keeps streaming, instead of watching the block pop
// in whole the instant it finalizes.
//
// SINGLE-PROCESS ASSUMPTION (Telar is local-first — one `next start`): the ring
// lives in this process's memory, next to the in-flight run itself (a detached
// in-process turn, not cross-process). A second Node process would see an empty
// ring and fall back to the file's finalized events — degraded, never wrong.
// globalThis-backed so it survives Next dev HMR module reloads, the same way
// lib/chat-runs.ts keeps its run registry.
//
// The ring holds ONLY the current, not-yet-finalized text/thinking block's
// deltas: the chat route's send() clears it the instant a "text" (finalize) or
// "thinking" (new block) event is written to the file. That disjointness keeps
// replay correct — finalized blocks live in the file, the in-flight block lives
// in the ring, the two never overlap, so a reconnect replays file-then-ring
// with no double-render. `gen` bumps on each clear so a live subscriber detects
// the block boundary and re-bases its cursor instead of losing or re-sending
// deltas across the reset; `base` tracks front-drops so the cursor stays exact
// even after the hard cap sheds the oldest tokens of an enormous single block.
const DELTA_CAP = 4000; // hard cap on buffered current-block deltas

type DeltaRing = { gen: number; base: number; items: SessionLogEvent[] };
export type DeltaCursor = { gen: number; index: number };

const dg = globalThis as unknown as { __telarSessionDeltas?: Map<string, DeltaRing> };
const deltaRings = (dg.__telarSessionDeltas ??= new Map<string, DeltaRing>());

// Mirror one delta / thinking_delta of the current in-flight block. Bounded:
// past DELTA_CAP the oldest token is shed (base++ keeps absolute indexing sound).
export function pushSessionDelta(sessionId: string, event: string, data: unknown): void {
  const ring = deltaRings.get(sessionId) ?? { gen: 0, base: 0, items: [] };
  ring.items.push({ event, data });
  if (ring.items.length > DELTA_CAP) {
    ring.items.shift();
    ring.base += 1;
  }
  deltaRings.set(sessionId, ring);
}

// A finalizing/opening text-like event superseded the current block's deltas —
// drop them and bump gen so live subscribers re-base onto the next block.
export function clearSessionDeltas(sessionId: string): void {
  const ring = deltaRings.get(sessionId);
  if (!ring) return;
  ring.gen += 1;
  ring.base = 0;
  ring.items = [];
}

// Turn fully over — drop the ring entirely.
export function endSessionDeltas(sessionId: string): void {
  deltaRings.delete(sessionId);
}

// Incremental read for a live subscriber. `after` is the cursor last consumed
// (pass gen:-1 for a first read → the whole current block). A gen mismatch
// means the block finalized+cleared since last read, so the current items are a
// fresh block returned from the start.
export function readSessionDeltas(
  sessionId: string,
  after: DeltaCursor,
): { events: SessionLogEvent[]; next: DeltaCursor } {
  const ring = deltaRings.get(sessionId);
  if (!ring) return { events: [], next: after };
  const end = ring.base + ring.items.length;
  if (ring.gen !== after.gen) {
    return { events: ring.items.slice(), next: { gen: ring.gen, index: end } };
  }
  const start = Math.max(0, after.index - ring.base);
  return { events: ring.items.slice(start), next: { gen: ring.gen, index: end } };
}
