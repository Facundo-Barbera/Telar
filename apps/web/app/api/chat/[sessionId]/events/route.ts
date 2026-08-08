import { isSessionRunLive } from "@/lib/chat-runs";
import { isSessionWindowLive } from "@/lib/server/session-runtime";
import {
  type DeltaCursor,
  type FeedCursor,
  readFeedEvents,
  readSessionDeltas,
  readSessionEvents,
  sessionFeedCursor,
} from "@/lib/session-log";

export const dynamic = "force-dynamic";

const POLL_MS = 300;

// SSE tail of a session's CURRENT activity window (docs/runtime-architecture.md
// §A, Phase 1b; #28 turn-as-event). Two forms:
//
// - No cursor: replay the window from its start — the reconnect case (a client
//   returning to a session mid-window rebuilds the whole in-flight turn from
//   the live log) and the dock's per-reconnect rebuild.
// - ?win=N&seq=M: tail the FEED strictly after that cursor — the background
//   case (a client whose own POST just ended at `result` attaches here to keep
//   rendering what its background agents produce, without replaying the turn
//   it already rendered).
//
// LIVENESS is the window, not the run: a session whose POST ended but whose
// background agents are still working is live to a subscriber — that is what
// makes the work visibly background instead of silently vanishing. A session
// with neither a run nor a window emits nothing and finishes on the first
// tick (the anti-double-render gate: a completed window already lives in
// chats.json, which the page seeds from on mount).
export async function GET(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const url = new URL(req.url);
  const winParam = url.searchParams.get("win");
  const seqParam = url.searchParams.get("seq");
  // ?tail=1 — feed mode from the CURRENT cursor, resolved server-side: the
  // subscriber of a mount that already rendered the window (a turn that
  // ended without a done handoff — Stop, error) must attach strictly after
  // now, never replay what it just showed (the duplicate-bubble regression).
  const tailFromNow = url.searchParams.get("tail") === "1";
  const afterCursor: FeedCursor | null =
    winParam !== null && seqParam !== null
      ? { win: Number(winParam), seq: Number(seqParam) }
      : tailFromNow
        ? sessionFeedCursor(sessionId)
        : null;
  const encoder = new TextEncoder();

  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let finish = () => {};

  const windowOrRunLive = () => isSessionRunLive(sessionId) || isSessionWindowLive(sessionId);

  const stream = new ReadableStream({
    start(controller) {
      let line = 0;
      let feedCursor: FeedCursor | null = afterCursor;
      // Live delta ring cursor (§2). gen:-1 forces the first read to replay the
      // whole current in-flight block; thereafter it advances incrementally and
      // re-bases on block boundaries (see readSessionDeltas).
      let deltaCursor: DeltaCursor = { gen: -1, index: 0 };
      let firstTick = true;

      const onAbort = () => finish();

      finish = () => {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        req.signal.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // client vanished — tear down (the run itself is untouched)
          finish();
        }
      };

      const tick = () => {
        if (closed) return;

        // Anti-double-render gate: on the FIRST tick, a session with neither a
        // live run nor an open window is a completed (or never-started) turn
        // the page already rendered from chats.json — finish silently.
        if (firstTick) {
          firstTick = false;
          if (!windowOrRunLive()) return finish();
        }

        const live = windowOrRunLive();
        let sawClosed = false;
        let structuralCount = 0;
        // BOTH MODES ARE FEED READS NOW, and that is what ended the duplicate
        // divider. Replay used to be a line-counted read of live.ndjson that
        // never told the client where it stood: a cursor-less subscriber
        // stayed cursor-less forever, so every reconnect replayed the whole
        // open window into client state that had already applied it — and the
        // compaction fold, whose rule is "a repeated event opens a NEW
        // compaction" (correct for genuinely-new events, blind to
        // redelivery), minted a second divider for the same compaction.
        // Reading the feed instead gives replay the one thing the line count
        // could not: the exact (win, seq) resume point IN THE SAME READ as
        // the events it covers — no straddle window where an event lands
        // after the read but before the cursor capture. A null cursor is
        // readFeedEvents' own "replay the window from its start", so the
        // first drain replays and every later one tails, in one code path.
        {
          const wasReplay = feedCursor === null;
          const { events, next } = readFeedEvents(sessionId, feedCursor);
          if (wasReplay && events.length === 0 && !afterCursor) {
            // Degraded fallback: the feed is best-effort (a write failure is
            // reported, not thrown), so a window whose feed never made it to
            // disk still replays from live.ndjson exactly as before — with
            // the old no-cursor semantics, since there is nothing to resume
            // from. The duplicate-on-reconnect exposure survives only here.
            const { events: lines, nextLine } = readSessionEvents(sessionId, line);
            line = nextLine;
            for (const { event, data } of lines) {
              structuralCount++;
              send(event, data);
              if (event === "closed") sawClosed = true;
            }
          } else {
            feedCursor = next;
            for (const { event, data } of events) {
              structuralCount++;
              send(event, data);
              if (event === "closed") sawClosed = true;
            }
            // Advance the client's resume point: a transport drop reconnects
            // with the LAST cursor it saw — for a replay subscriber, the
            // first cursor it has ever had — so nothing already applied
            // replays.
            if (structuralCount > 0 && !sawClosed) send("cursor", feedCursor);
          }
        }
        if (sawClosed) return finish();
        // Then the in-flight block's tokens from the bounded delta ring (§2).
        // Disjoint from the structural surface — deltas never touch either
        // file — so no event is ever double-sent between the two.
        const { events: deltas, next } = readSessionDeltas(sessionId, deltaCursor);
        deltaCursor = next;
        for (const { event, data } of deltas) send(event, data);
        // Safety: the window went dead and both surfaces are fully drained (no
        // "closed" seen, e.g. a crash) — nothing more will arrive.
        if (!live && structuralCount === 0 && deltas.length === 0) finish();
      };

      if (req.signal.aborted) return finish();
      req.signal.addEventListener("abort", onAbort);

      tick();
      if (!closed) timer = setInterval(tick, POLL_MS);
    },
    cancel() {
      finish();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
