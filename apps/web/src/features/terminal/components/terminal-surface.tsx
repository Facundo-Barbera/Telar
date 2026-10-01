"use client";

import { isOpenTerminal } from "../run/presentation";
import { setShellTerminal, setShellTitle } from "../workspace";
import { useShellStrip } from "../hooks/use-shell-strip";
import { RunPane } from "./run-pane";
import { TerminalPane } from "./terminal-pane";
import { TerminalStrip } from "./terminal-strip";

/** One outer tab holding a strip of shells and runs. `params`/`onParams` are its whole persistence, so a remount re-adopts every shell. */
export function TerminalSurface({
  sessionId,
  projectId,
  hostId,
  params = {},
  onParams,
  onCloseSelf,
  visible = true,
}: {
  sessionId?: string;
  projectId?: string;
  /** Which Mac the session lives on; absent means this cockpit's own. */
  hostId?: string;
  params?: Readonly<Record<string, string>>;
  /** Replaces the tab's params. */
  onParams?: (params: Record<string, string>) => void;
  /** Closes the outer tab; closing the last shell means this. */
  onCloseSelf?: () => void;
  visible?: boolean;
}) {
  const strip = useShellStrip({ sessionId, hostId, params, onParams, onCloseSelf });
  const { workspace, setWorkspace, run } = strip;
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onKeyDownCapture={strip.onKeys}
      // focusin/focusout: the `contains` check keeps a move between two children from reading as a release.
      onFocus={() => strip.setHasKeys(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) strip.setHasKeys(false);
      }}
    >
      <TerminalStrip strip={strip} sessionId={sessionId} />
      {/* Shell panes stay mounted: unmounting drops scrollback the host does not record. A run pane draws only while shown. */}
      <div className="relative min-h-0 flex-1">
        {workspace.shells.map((shell) =>
          shell.run && sessionId ? (
            // Keyed by the run: reusing an emulator across runs would show one process's bytes under another's.
            <RunPane
              key={`${shell.id}:${shell.run.runId}`}
              api={run.runApi}
              sessionId={sessionId}
              runId={shell.run.runId}
              {...(shell.terminalId ? { terminalId: shell.terminalId } : {})}
              live={isOpenTerminal(run.runsById.get(shell.run.runId))}
              active={shell.id === workspace.active}
              visible={visible}
            />
          ) : (
            <TerminalPane
              key={shell.id}
              {...(sessionId ? { sessionId } : {})}
              {...(projectId ? { projectId } : {})}
              {...(shell.terminalId ? { terminalId: shell.terminalId } : {})}
              onTerminalId={(id) => setWorkspace((current) => setShellTerminal(current, shell.id, id))}
              onTitle={(title) => setWorkspace((current) => setShellTitle(current, shell.id, title))}
              active={shell.id === workspace.active}
              visible={visible}
            />
          ),
        )}
      </div>
    </div>
  );
}
