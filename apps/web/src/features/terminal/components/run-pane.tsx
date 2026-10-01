"use client";

import { useEffect } from "react";
import "@xterm/xterm/css/xterm.css";
import { claimChords } from "@/features/commands";
import type { RunApi } from "../run/api";
import { byteDroppedNotice } from "../run/terminal-feed";
import { TERMINAL_CHORD_CLAIMS } from "../keys";
import { useRunEmulator } from "../hooks/use-run-emulator";
import { useRunFeed } from "../hooks/use-run-feed";

type RunPaneProps = {
  /** Pinned to one Mac by the surface: session ids are per host. */
  api: RunApi;
  sessionId: string;
  runId: string;
  /** The host's name for this run's PTY while it has one; absent means poll. */
  terminalId?: string;
  /** Whether the run can still say anything; sets the poll cadence only. */
  live: boolean;
  /** The chip on screen. */
  active: boolean;
  visible: boolean;
};

/** One run chip's pane. Only the chip on screen has an emulator: the engine keeps the run's bytes, so a hidden one re-reads them when shown. */
export function RunPane(props: RunPaneProps) {
  return props.active && props.visible ? <LiveRunPane {...props} /> : null;
}

function LiveRunPane({ api, sessionId, runId, terminalId, live }: RunPaneProps) {
  const { host, notice, ...emulator } = useRunEmulator({ api, sessionId, runId, live });
  const dropped = useRunFeed(emulator, { sessionId, runId, terminalId, live });

  useEffect(() => claimChords(TERMINAL_CHORD_CLAIMS), []);

  const dropNotice = byteDroppedNotice(dropped);
  return (
    <div data-testid="run-pane" className="absolute inset-0 flex flex-col">
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
