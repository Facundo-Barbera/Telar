import { getUltraManifest, readUltraEvents } from "@telar/core";

export const dynamic = "force-dynamic";

// Terminal states: once here (and all events drained) the stream sends `end` and closes.
const TERMINAL = new Set(["done", "failed", "stopped"]);
const POLL_MS = 400;

// SSE tail of an Ultra run (doc §5's `/api/ultra/[id]/events GET (SSE)`),
// byte-for-byte the same shape as /api/looms/[id]/events: full manifest
// snapshot + every event from line 0 as `run`/`ev`, then poll for new
// events/state, `end` once terminal + drained. The run dir may not exist yet
// on connect (a launch's manifest write can lag a fast client's SSE open by a
// tick) — we keep polling until it appears.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const encoder = new TextEncoder();

  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stop = () => {};

  const stream = new ReadableStream({
    start(controller) {
      let nextLine = 0;
      let lastUpdatedAt = -1;
      let sentInitialRun = false;

      const onAbort = () => stop();

      stop = () => {
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
          // client vanished — tear down the poll loop
          stop();
        }
      };

      const tick = () => {
        if (closed) return;
        const run = getUltraManifest(id);
        if (!run) return; // dir not there yet — keep polling until it appears

        // First sighting: emit the full run snapshot before any events.
        if (!sentInitialRun) {
          sentInitialRun = true;
          send("run", run);
          lastUpdatedAt = run.updatedAt;
        }

        // Drain newly-appended events (phase/log/agent/state — doc §5).
        const { events, nextLine: nl } = readUltraEvents(id, nextLine);
        for (const ev of events) send("ev", ev);
        nextLine = nl;

        // Then a fresh manifest snapshot if it moved since we last sent one.
        if (run.updatedAt !== lastUpdatedAt) {
          lastUpdatedAt = run.updatedAt;
          send("run", run);
        }

        if (TERMINAL.has(run.state)) {
          send("end", run);
          stop();
        }
      };

      if (req.signal.aborted) return stop();
      req.signal.addEventListener("abort", onAbort);

      tick();
      if (!closed) timer = setInterval(tick, POLL_MS);
    },
    cancel() {
      stop();
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
