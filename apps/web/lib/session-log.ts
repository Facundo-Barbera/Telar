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

// Trim+resolve guard, matching core's manifest.ts telarDir() (full reasoning
// there): `??` falls back on null/undefined but NOT on "", and an
// exported-but-empty `TELAR_HOME=` is routine in shell scripts and CI. Another
// silent-failure case, measured rather than assumed — with root "" sessionDir()
// is the non-empty RELATIVE path "sessions/<id>", so mkdirSync succeeds and
// every live turn's log is written to <cwd>/sessions/<id>/live.ndjson while the
// reconnect tail reads whatever the reader's own cwd resolves to. Lazy for the
// usual reason: a test or a reconfigured process must be able to re-point it.
//
// DESIGN CALL on a RELATIVE root: path.resolve makes it absolute but still
// lands it under the cwd, and it pins NOTHING — this resolver is lazy, so
// path.resolve re-runs against the CURRENT cwd on every call and a process that
// chdir's mid-run reads and writes a different root afterwards (measured: with
// TELAR_HOME="rel-root", two calls straddling a process.chdir() returned two
// different absolute paths). Refusing a relative root outright is stronger, but
// it is a behavior change beyond this fix, so we resolve and document.
const home = () => {
  const v = process.env.TELAR_HOME?.trim();
  return v ? path.resolve(v) : path.join(os.homedir(), ".telar");
};
const sessionDir = (sessionId: string) => path.join(home(), "sessions", sessionId);
const logFile = (sessionId: string) => path.join(sessionDir(sessionId), "live.ndjson");

export type SessionLogEvent = { event: string; data: unknown };

// Open a fresh log for a new turn: truncate the file, then write a synthetic
// `user` header event so a reconnecting client can render the user bubble. The
// POST path never emits a "user" SSE event (the client adds it optimistically),
// so the reconnect log must carry it as its first line.
//
// `hidden` mirrors store.ts's `hideUserMessage` (route.ts's isKickoff): the
// escalation kickoff's local POST path never adds a user bubble optimistically
// (session-view.tsx's send(), `opts.hidden`), so a reconnect tailing this log
// mid-turn must not manufacture one either — skip the synthetic "user" line
// entirely so applyServerEvent's "user" branch never fires for this turn.
export function startSessionLog(sessionId: string, userText: string, hidden = false): void {
  // A brand-new turn: drop any stale current-block deltas a crashed prior turn
  // may have left in the ring (endSessionDeltas normally clears them at
  // teardown, but a crash before the finally can skip that).
  endSessionDeltas(sessionId);
  try {
    const dir = sessionDir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      logFile(sessionId),
      hidden ? "" : JSON.stringify({ event: "user", data: { text: userText } }) + "\n",
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

// ── Session feed (server-layer contract §B) ────────────────────────────────
// The successor to live.ndjson's line-counted tail, cursor-addressed so a
// subscriber can attach anywhere: every non-delta event in an ACTIVITY WINDOW
// (a turn plus whatever background work outlives it) gets a monotonic `seq`
// under a per-window `win`. The cursor pair mirrors the delta ring's
// {gen,index} re-base contract below — a reader whose `win` is stale gets the
// current window replayed from its start, which is exactly the semantics the
// dock's reconnect tail already assumes ("EACH RECONNECT REPLAYS FROM THE
// TURN'S START"). The file TRUNCATES at window start, same lifecycle as
// live.ndjson: completed windows live in chats.json, the feed is the live
// surface only — which is what keeps it bounded without a rotation policy.
//
// Same owner as everything else here (AD-5: session-log.ts co-owns the
// sessions/<id>/ subtree with core's sessions.ts), same best-effort
// discipline: feed writes never throw into a turn.
//
// SHADOW MODE (this commit): the chat route mirrors its events here in
// parallel with live.ndjson; nothing reads the feed yet except tests and the
// events route's opt-in `?after=` form. The turn-end flip makes it primary.

export type FeedCursor = { win: number; seq: number };
export type FeedEvent = { win: number; seq: number; event: string; data: unknown };

const feedFile = (sessionId: string) => path.join(sessionDir(sessionId), "feed.ndjson");

type FeedState = { win: number; seq: number };
const fg = globalThis as unknown as { __telarSessionFeeds?: Map<string, FeedState> };
const feedStates = (fg.__telarSessionFeeds ??= new Map<string, FeedState>());

// Recover the allocator from the file's last line — a dev-server reload (or a
// second process, degraded-but-correct as with the delta ring) must continue
// the window rather than fork a second seq space.
function feedStateFor(sessionId: string): FeedState {
  const cached = feedStates.get(sessionId);
  if (cached) return cached;
  let recovered: FeedState = { win: 0, seq: 0 };
  try {
    const raw = fs.readFileSync(feedFile(sessionId), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const last = lines[lines.length - 1];
    if (last) {
      const parsed = JSON.parse(last) as FeedEvent;
      if (typeof parsed.win === "number" && typeof parsed.seq === "number") {
        recovered = { win: parsed.win, seq: parsed.seq };
      }
    }
  } catch {
    // no feed yet — a fresh window starts at win 1 below
  }
  feedStates.set(sessionId, recovered);
  return recovered;
}

/** Open a fresh window: truncate the file, bump `win`, write the window
 *  header (seq 0, carrying the turn's runId) and — unless the turn is hidden
 *  machinery, same rule as startSessionLog — a synthetic `user` event so a
 *  subscriber attaching mid-window can render the user bubble. */
export function startSessionFeedWindow(
  sessionId: string,
  runId: string,
  userText: string,
  hidden = false,
): void {
  try {
    const prior = feedStateFor(sessionId);
    const state: FeedState = { win: prior.win + 1, seq: 0 };
    feedStates.set(sessionId, state);
    fs.mkdirSync(sessionDir(sessionId), { recursive: true });
    const lines = [
      JSON.stringify({ win: state.win, seq: 0, event: "window", data: { runId } }),
    ];
    if (!hidden) {
      state.seq = 1;
      lines.push(
        JSON.stringify({ win: state.win, seq: 1, event: "user", data: { text: userText } }),
      );
    }
    fs.writeFileSync(feedFile(sessionId), lines.join("\n") + "\n");
  } catch {
    // best-effort — never let the feed break the turn
  }
}

/** Append one event to the current window. Callers keep the token firehose
 *  (delta/thinking_delta) OUT of the feed — those stay on the bounded ring
 *  below, exactly as they stay out of live.ndjson. Returns the cursor the
 *  event landed at, or null if the write failed. */
export function appendFeedEvent(
  sessionId: string,
  event: string,
  data: unknown,
): FeedCursor | null {
  try {
    const state = feedStateFor(sessionId);
    state.seq += 1;
    fs.appendFileSync(
      feedFile(sessionId),
      JSON.stringify({ win: state.win, seq: state.seq, event, data }) + "\n",
    );
    return { win: state.win, seq: state.seq };
  } catch {
    return null;
  }
}

/** Where the current window stands — what a turn's terminal event reports so
 *  the client knows the cursor to attach its background tail at. */
export function sessionFeedCursor(sessionId: string): FeedCursor {
  const state = feedStateFor(sessionId);
  return { win: state.win, seq: state.seq };
}

/** Read the current window from `after` (exclusive). A null/stale-window
 *  cursor replays the window from its start — the header (seq 0) included, so
 *  the reader can re-base on the new `win`. Missing file → nothing yet. */
export function readFeedEvents(
  sessionId: string,
  after: FeedCursor | null,
): { events: FeedEvent[]; next: FeedCursor } {
  let raw: string;
  try {
    raw = fs.readFileSync(feedFile(sessionId), "utf8");
  } catch {
    return { events: [], next: after ?? { win: 0, seq: 0 } };
  }
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const events: FeedEvent[] = [];
  let win = after?.win ?? 0;
  let seq = after?.seq ?? 0;
  for (const line of lines) {
    let parsed: FeedEvent;
    try {
      parsed = JSON.parse(line) as FeedEvent;
    } catch {
      continue; // corrupt/partial line — skip, same tolerance as the tail above
    }
    if (typeof parsed.win !== "number" || typeof parsed.seq !== "number") continue;
    const stale = after === null || after.win !== parsed.win;
    if (!stale && parsed.seq <= after.seq) continue;
    events.push(parsed);
    win = parsed.win;
    seq = parsed.seq;
  }
  return { events, next: { win, seq } };
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
