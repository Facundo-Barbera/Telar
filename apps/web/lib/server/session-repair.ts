import { isSessionRunLive } from "@/lib/chat-runs";
import { appendFeedEvent, appendSessionEvent, readFeedEvents } from "@/lib/session-log";
import { isSessionWindowLive } from "@/lib/server/session-runtime";
import { markLastTurnInterrupted, settleSpawnStatuses } from "@/lib/store";

// THE CRASH TRUTH-TELLER (creative-run defect). Every liveness signal the
// runtime owns — the run registry, the runtime map, the window sink — is
// globalThis-only and dies with the process. After a restart, a session whose
// turn was mid-flight has both checks false, so the events route's first-tick
// gate finishes silently and the half-turn in chats.json reads exactly like a
// completed one. The queue lane already tells this truth (recoverSessionQueue
// marks a running item ambiguous, "the server restarted while this was
// running"); this is the same honesty for the direct-POST lane.
//
// DETECTION IS THE FEED WINDOW: feed.ndjson truncates per window, so the file
// IS the current window — a non-`closed` last event with no live runtime is a
// window nothing will ever finish. Every graceful teardown writes `closed`
// (route.ts's two terminal paths), so this cannot fire for a turn that ended
// normally, and the liveness check above excludes one that is still running.
//
// REPAIR IS DURABLE AND IDEMPOTENT, in three writes: the attention marker
// into the transcript (skipped if already the trailing part), the spawn sweep
// (a crashed window's launch-acked agents would shimmer "running" forever —
// store.ts documents this exact repair use), and a terminal `closed` onto
// both log surfaces — which ends any late subscriber's replay AND makes the
// next call find a closed window and do nothing.
//
// Called from the session detail GET: the moment a user opens a session is
// the moment its transcript must not lie to them.
export function repairInterruptedSession(sessionId: string): boolean {
  if (isSessionRunLive(sessionId) || isSessionWindowLive(sessionId)) return false;
  const { events } = readFeedEvents(sessionId, null);
  if (events.length === 0) return false;
  if (events[events.length - 1]?.event === "closed") return false;

  const marked = markLastTurnInterrupted(sessionId, "interrupted — the server restarted");
  settleSpawnStatuses(sessionId);
  appendSessionEvent(sessionId, "closed", {});
  appendFeedEvent(sessionId, "closed", {});
  return marked;
}
