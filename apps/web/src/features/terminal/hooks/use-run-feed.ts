"use client";

import { useEffect, useRef, useState } from "react";
import { usePoll } from "@/ui/hooks/use-poll";
import { terminalBridge } from "../bridge";
import { frameWriter } from "../frames";
import { byteFeed, type RunByteFeed } from "../run/terminal-feed";
import { ptyByteWriter } from "../session";
import type { RunEmulator } from "./use-run-emulator";

/** Stream over IPC when the desktop can adopt the run's PTY; otherwise poll the engine. */
function runFeedKind(terminalId: string | undefined, bridge: { adopt?: unknown } | undefined): "stream" | "poll" {
  return terminalId && bridge?.adopt ? "stream" : "poll";
}

function redraw(emulator: RunEmulator, feed: Pick<RunByteFeed, "chunks" | "reset">) {
  const term = emulator.termRef.current;
  if (!term) return;
  if (feed.reset) {
    term.reset();
    emulator.writeRef.current = ptyByteWriter(term);
  }
  const write = emulator.writeRef.current ?? ptyByteWriter(term);
  for (const chunk of feed.chunks) write(chunk);
}

type OnRead = (answer: { dropped: number; cursor: number }, skipped: number) => void;

/** Subscribe first and buffer, read the scrollback from the top, then draw only buffered frames past its cursor. */
function useRunStream(emulator: RunEmulator, run: { sessionId: string; runId: string; terminalId: string | undefined }, enabled: boolean, onRead: OnRead) {
  const { runId, sessionId, terminalId } = run;
  useEffect(() => {
    const bridge = terminalBridge();
    if (!enabled || terminalId === undefined || !bridge?.adopt) return;
    let stopped = false;
    let seen = -1;
    let holding: Array<{ data: string; cursor?: number }> | null = [];
    const frames = frameWriter((data) => {
      const term = emulator.termRef.current;
      if (term && !stopped) (emulator.writeRef.current ?? ptyByteWriter(term))(data);
    });
    const paint = (chunk: { data: string; cursor?: number }) => {
      if (stopped) return;
      if (chunk.cursor !== undefined) {
        if (chunk.cursor <= seen) return;
        seen = chunk.cursor;
      }
      frames.push(chunk.data);
    };
    const offData = bridge.onData((chunk) => {
      if (chunk.id !== terminalId) return;
      const frame = { data: chunk.data, ...(chunk.cursor === undefined ? {} : { cursor: chunk.cursor }) };
      if (holding) holding.push(frame);
      else paint(frame);
    });
    void (async () => {
      try {
        const adopted = await bridge.adopt!(terminalId);
        // Not held any more: the run ended in flight, and the status feed says so.
        if (stopped || !adopted.ok) return;
        const { api, sessionId: session, runId: run } = emulator.latest.current;
        const answer = await api.bytes(session, { runId: run, after: 0 });
        if (stopped) return;
        const feed = byteFeed(0, answer);
        redraw(emulator, { chunks: feed.chunks, reset: true });
        onRead(answer, feed.skipped);
        seen = answer.cursor;
        const held = holding ?? [];
        holding = null;
        for (const chunk of held) paint(chunk);
      } catch {
        // The engine is away; frames keep arriving over IPC, and the next attach re-reads the scrollback.
        holding = null;
      }
    })();
    return () => {
      stopped = true;
      frames.cancel();
      offData?.();
      // Put the frames down; never stop the run.
      void Promise.resolve(bridge.abandon?.(terminalId)).catch(() => {});
    };
    // `emulator` and `onRead` are stable for the pane's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, terminalId, runId, sessionId]);
}

/** The run's bytes, drawn into its emulator. Returns how many chunks are not on screen. */
export function useRunFeed(emulator: RunEmulator, { sessionId, runId, terminalId, live }: { sessionId: string; runId: string; terminalId: string | undefined; live: boolean }) {
  const [dropped, setDropped] = useState(0);
  const cursor = useRef(0);
  const skipped = useRef(0);
  const feed = runFeedKind(terminalId, terminalBridge());
  useRunStream(emulator, { sessionId, runId, terminalId }, feed === "stream", (answer, trimmed) => {
    skipped.current = trimmed;
    setDropped(answer.dropped + trimmed);
    cursor.current = answer.cursor;
  });

  // A settled run is read once more and then left alone.
  const settledRead = useRef(false);
  usePoll(
    async () => {
      const { api, sessionId: session, runId: run, live: running } = emulator.latest.current;
      if (!running && settledRead.current) return;
      try {
        const answer = await api.bytes(session, { runId: run, after: cursor.current });
        const next = byteFeed(cursor.current, answer);
        cursor.current = next.cursor;
        if (next.reset || next.skipped > 0) skipped.current = next.skipped;
        setDropped(answer.dropped + skipped.current);
        redraw(emulator, next);
        if (!running) settledRead.current = true;
      } catch {
        // The status feed reports refusals; retrying slowly beats a tight loop.
      }
    },
    feed === "poll" ? (live ? 500 : 4000) : null,
    { key: `${sessionId}:${runId}:${live}` },
  );
  return dropped;
}
