"use client";

/**
 * THE RUN FEED, READ ONCE AND THEN FOLLOWED - issue #890.
 *
 * WHAT THIS REPLACES is a poll loop in the masthead: `run-header-control` asked
 * `/run/status` every 4 s while a run was live and every 12 s while it was not,
 * for ever, in every window with the cockpit open. The BYTES were polled too,
 * every 500 ms, and those are the terminal bridge's job now; the STATUS is this
 * file's.
 *
 * ONE READ, THEN EVENTS. `/run/status` is asked exactly once per mount, because
 * the feed is live-only and a reader that connected after a launch would
 * otherwise know nothing. After that every transition arrives as a frame
 * carrying the WHOLE `RunView` - so there is no delta to apply wrong, and a
 * reader that missed a frame is corrected by the next rather than drifting.
 *
 * `fetch` RATHER THAN `EventSource`, for the reasons `lib/agent/thread.ts`
 * writes out: `EventSource` cannot be aborted exactly on unmount (the browser
 * reconnects on its own schedule) and cannot carry a header, which the remote
 * host hop needs. Reading the body with a reader gives an exact abort.
 *
 * RECONNECT IS THE NORMAL CASE. A stream ends when a proxy times it out, when
 * the engine restarts, when a laptop sleeps. Each reopen re-reads status FIRST,
 * because the feed has no replay: whatever happened while the socket was down
 * is only recoverable from the state read. The backoff is for the engine that
 * is DOWN - without one a refused port is a tight spin.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { hostFetcher, LOCAL_HOST_ID, rewriteApiPath } from "@/lib/hosts/client";
import { createRunApi, runPath, type RunApi } from "./api";
import type { RunStatusAnswer, RunStatusEvent } from "./types";

/**
 * Fold one frame into the answer a `/run/status` read produced.
 *
 * PURE, AND EXPORTED BECAUSE THIS IS THE RULE WORTH TESTING. The hook below is
 * its only caller.
 *
 * `active` COMES FROM THE FRAME, never inferred from the run's status. A
 * released run stays `unknown` for ever with the project's slot free - that is
 * what `unknown` means - so a reader that read "not terminal, therefore
 * deployed" would show a ghost as the live deployment.
 *
 * HISTORY IS NEWEST-FIRST BY `startedAt`, matching `/run/status`, so a reader
 * cannot tell a folded answer from a freshly read one.
 */
export function applyRunStatusEvent(answer: RunStatusAnswer | undefined, event: RunStatusEvent): RunStatusAnswer {
  const base: RunStatusAnswer = answer ?? { history: [] };
  const history = [event.run, ...base.history.filter((run) => run.runId !== event.run.runId)].sort((a, b) => b.startedAt - a.startedAt);
  // A frame about a run that is NOT the holder must not clear an active run it
  // has nothing to do with: an older run announcing its own exit says nothing
  // about the one that replaced it.
  const active = event.active ? event.run : base.active?.runId === event.run.runId ? undefined : base.active;
  const rest: Omit<RunStatusAnswer, "active" | "history"> = base.sessionWorktreePath ? { sessionWorktreePath: base.sessionWorktreePath } : {};
  return { ...rest, ...(active ? { active } : {}), history };
}

export type RunStatusFeed = {
  status: RunStatusAnswer | undefined;
  error: string | undefined;
  /**
   * Re-read the state now, and re-open the feed.
   *
   * FOR A MUTATION THIS SCREEN ITSELF PERFORMED. The frame is already on its
   * way, and in the ordinary case this read and that frame agree; what it buys
   * is that a pressed button does not look unpressed while the round trip
   * finishes. It is NOT a poll: nothing calls it on a timer.
   */
  refresh: () => void;
};

export function useRunStatusFeed({
  sessionId,
  hostId,
  api: injected,
}: {
  sessionId: string;
  hostId?: string;
  /** Injected by tests and the fixture; production builds a pinned client. */
  api?: RunApi;
}): RunStatusFeed {
  const [status, setStatus] = useState<RunStatusAnswer>();
  const [error, setError] = useState<string>();
  /** Bumped by `refresh`; the effect below re-reads and re-follows on it. */
  const [generation, setGeneration] = useState(0);
  const apiRef = useRef<RunApi | undefined>(undefined);
  apiRef.current = injected ?? createRunApi(hostFetcher(hostId ?? LOCAL_HOST_ID));

  const refresh = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    let delay = 1_000;

    const follow = async (): Promise<void> => {
      while (!stopped) {
        try {
          // THE STATE READ COMES FIRST, EVERY TIME ROUND. The feed is live-only
          // - see the engine route - so a reconnect that skipped this would
          // silently miss whatever happened while the socket was down.
          const answer = await apiRef.current!.status(sessionId);
          if (stopped) return;
          setStatus(answer);
          setError(undefined);

          const path = rewriteApiPath(runPath(sessionId, "/stream"), hostId ?? LOCAL_HOST_ID);
          const response = await fetch(path, { signal: controller.signal, headers: { accept: "text/event-stream" } });
          if (!response.ok || !response.body) throw new Error(`run stream ${response.status}`);
          delay = 1_000;
          await read(response.body, () => stopped, setStatus);
        } catch (cause) {
          if (stopped || controller.signal.aborted) return;
          setError(cause instanceof Error ? cause.message : "The run feed is not answering.");
        }
        if (stopped) return;
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 30_000);
      }
    };

    void follow();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [sessionId, hostId, generation]);

  return { status, error, refresh };
}

const FRAME_END = "\n\n";

/**
 * Read one connection to exhaustion, folding every frame in.
 *
 * FRAMES SPLIT ON THE BLANK LINE, which is SSE own boundary. A partial frame
 * waits for the rest: a chunk boundary falls wherever the network puts it, and
 * parsing half a JSON body would drop it.
 */
async function read(
  body: NonNullable<Response["body"]>,
  stopped: () => boolean,
  apply: (update: (current: RunStatusAnswer | undefined) => RunStatusAnswer) => void,
): Promise<void> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done || stopped()) return;
    buffer += value;
    let boundary = buffer.indexOf(FRAME_END);
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + FRAME_END.length);
      boundary = buffer.indexOf(FRAME_END);
      // `: open` and `: beat` are the engine keep-alives. Not events.
      if (!frame.startsWith("data:")) continue;
      let event: RunStatusEvent;
      try {
        event = JSON.parse(frame.slice("data:".length).trim()) as RunStatusEvent;
      } catch {
        continue;
      }
      if (event.type !== "run.status") continue;
      apply((current) => applyRunStatusEvent(current, event));
    }
  }
}
