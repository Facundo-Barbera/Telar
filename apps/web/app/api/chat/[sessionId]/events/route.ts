import { isSessionRunLive } from "@/lib/chat-runs";
import { type DeltaCursor, readSessionDeltas, readSessionEvents } from "@/lib/session-log";

export const dynamic = "force-dynamic";

const POLL_MS = 300;

// SSE tail of a session's CURRENT in-flight turn (docs/runtime-architecture.md
// §A, Phase 1b). A client that returns to a session while its turn is still
// running subscribes here and replays the live event log written by the POST
// /api/chat run, so it watches the turn to completion instead of seeing the
// pre-turn state until it finishes.
//
// CRITICAL: only a LIVE run is tailed. A completed turn already lives in
// chats.json (the page seeds from it on mount); replaying its log would
// double-render. The first tick gates on isSessionRunLive and finishes silently
// if the run isn't live.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const encoder = new TextEncoder();

  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let finish = () => {};

  const stream = new ReadableStream({
    start(controller) {
      let line = 0;
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

        // Anti-double-render gate: on the FIRST tick, a run that isn't live is
        // a completed (or never-started) turn the page already rendered from
        // chats.json — finish silently, emit nothing.
        if (firstTick) {
          firstTick = false;
          if (!isSessionRunLive(sessionId)) return finish();
        }

        const live = isSessionRunLive(sessionId);
        // Finalized/structural events first (the skeleton) — so the current
        // block's deltas below apply on top in the right order.
        const { events, nextLine } = readSessionEvents(sessionId, line);
        line = nextLine;
        for (const { event, data } of events) {
          send(event, data);
          if (event === "closed") return finish();
        }
        // Then the in-flight block's tokens from the bounded delta ring (§2).
        // Disjoint from the file above — deltas never touch the file — so no
        // event is ever double-sent between the two surfaces.
        const { events: deltas, next } = readSessionDeltas(sessionId, deltaCursor);
        deltaCursor = next;
        for (const { event, data } of deltas) send(event, data);
        // Safety: the run went not-live and both surfaces are fully drained (no
        // "closed" seen, e.g. a crash) — nothing more will arrive.
        if (!live && events.length === 0 && deltas.length === 0) finish();
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
