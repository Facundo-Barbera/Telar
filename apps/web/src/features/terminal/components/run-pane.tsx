"use client";

import { useEffect } from "react";
import "@xterm/xterm/css/xterm.css";
import { claimChords } from "@/features/commands";
import { cn } from "@/ui/utils";
import type { RunApi } from "../run/api";
import { byteDroppedNotice } from "../run/terminal-feed";
import { TERMINAL_CHORD_CLAIMS } from "../keys";
import { useRunEmulator } from "../hooks/use-run-emulator";
import { useRunFeed } from "../hooks/use-run-feed";

/** One run chip's pane: the engine's redacted bytes, streamed over IPC on this Mac or polled from elsewhere. */
export function RunPane({
  api,
  sessionId,
  runId,
  terminalId,
  live,
  active,
  visible,
}: {
  /** Pinned to one Mac by the surface: session ids are per host. */
  api: RunApi;
  sessionId: string;
  runId: string;
  /** The host's name for this run's PTY while it has one; absent means poll. */
  terminalId?: string;
  /** Whether the run can still say anything; sets the poll cadence only. */
  live: boolean;
  /** The chip on screen: only it fits, takes the keyboard and polls. The stream runs regardless. */
  active: boolean;
  visible: boolean;
}) {
  const { host, notice, ...emulator } = useRunEmulator({ api, sessionId, runId, live }, { active, visible });
  const dropped = useRunFeed(emulator, { sessionId, runId, terminalId, live, active, visible });

  // Claimed only while this chip is on screen: a run pane sits open for hours with nobody typing.
  useEffect(() => {
    if (!active || !visible) return;
    return claimChords(TERMINAL_CHORD_CLAIMS);
  }, [active, visible]);

  const dropNotice = byteDroppedNotice(dropped);
  return (
    <div data-testid="run-pane" data-active={active ? "true" : "false"} className={cn("absolute inset-0 flex flex-col", !active && "hidden")}>
      {notice ? (
        <p role="status" className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {dropNotice ? <p className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">{dropNotice}</p> : null}
      <div ref={host} data-testid="run-terminal-host" className="min-h-0 flex-1 overflow-hidden bg-card px-1 py-1" />
    </div>
  );
}
