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
