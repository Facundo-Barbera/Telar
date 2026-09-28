"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { claimChords } from "@/features/commands";
import { endTerminal, mayClose } from "../close";
import { TERMINAL_CHORD_CLAIMS } from "../keys";
import { isOpenTerminal } from "../run/presentation";
import { activateShell, addShell, closeShell, emptyWorkspace, readWorkspace, shellLabel, workspaceParams, type TerminalWorkspace } from "../workspace";
import { useRunStrip } from "./use-run-strip";

// macOS matches these against the app menu first, so they need a claim; only while focus is inside, or the rail loses ⌘1–9.
const STRIP_CHORD_CLAIMS: readonly string[] = ["CommandOrControl+T", ...Array.from({ length: 9 }, (_, index) => `CommandOrControl+${index + 1}`)];

/** The strip of shells, persisted in the tab's params, plus its runs and keys. */
export function useShellStrip({
  sessionId,
  hostId,
  params,
  onParams,
  onCloseSelf,
}: {
  sessionId: string | undefined;
  hostId: string | undefined;
  params: Readonly<Record<string, string>>;
  onParams: ((params: Record<string, string>) => void) | undefined;
  onCloseSelf: (() => void) | undefined;
}) {
  // Seeded once from the tab; a remount is what re-reads. An empty restore opens a shell now, not in an effect.
  const [workspace, setWorkspace] = useState<TerminalWorkspace>(() => {
    const restored = readWorkspace(params);
    return restored.shells.length > 0 ? restored : addShell(emptyWorkspace());
  });
  const write = useRef(onParams);
  const dismiss = useRef(onCloseSelf);
  const latest = useRef(workspace);
  useEffect(() => {
    write.current = onParams;
    dismiss.current = onCloseSelf;
    latest.current = workspace;
  });
  useEffect(() => {
    write.current?.(workspaceParams(workspace));
  }, [workspace]);

  const run = useRunStrip(sessionId, hostId, setWorkspace);
  useEffect(() => claimChords(TERMINAL_CHORD_CLAIMS), []);
  const [hasKeys, setHasKeys] = useState(false);
  useEffect(() => {
    if (!hasKeys) return undefined;
    return claimChords(STRIP_CHORD_CLAIMS);
  }, [hasKeys]);

  // Closing a chip ends its terminal, asking first only if something runs in it. One close at a time per chip.
  const closing = useRef(new Set<string>());
  const closeOne = async (id: string) => {
    const shell = workspace.shells.find((entry) => entry.id === id);
    if (!shell || closing.current.has(id)) return;
    closing.current.add(id);
    try {
      const view = shell.run ? run.runsById.get(shell.run.runId) : undefined;
      const terminalId = shell.run ? (isOpenTerminal(view) ? shell.run.runId : undefined) : shell.terminalId;
      if (terminalId) {
        const target = { id: view?.terminalId ?? terminalId, label: shellLabel(workspace, id), ...(view?.command ? { command: view.command } : {}) };
        if (!(await mayClose([target]))) return;
        await endTerminal({ terminalId, run: Boolean(shell.run) }, { stopRun: (runId) => run.runApi.stop(sessionId!, runId) });
        if (shell.run) run.runs.refresh();
      }
      // From the latest strip: it may have moved while the question was open.
      const next = closeShell(latest.current, id);
      latest.current = next;
      setWorkspace(next);
      if (next.shells.length === 0) dismiss.current?.();
    } finally {
      closing.current.delete(id);
    }
  };

  // Capture phase and the native stopImmediatePropagation: xterm's textarea and the window dispatcher would answer too.
  const onKeys = (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    const shells = workspace.shells;
    const take = () => {
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
    };
    // By `code`: with Shift held, `key` for these differs by layout.
    if (event.shiftKey && (event.code === "BracketLeft" || event.code === "BracketRight")) {
      if (shells.length < 2) return;
      take();
      const at = shells.findIndex((shell) => shell.id === workspace.active);
      const step = event.code === "BracketRight" ? 1 : shells.length - 1;
      setWorkspace(activateShell(workspace, shells[(Math.max(at, 0) + step) % shells.length]!.id));
      return;
    }
    const letter = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (letter === "t") {
      take();
      setWorkspace(addShell(workspace));
    } else if (letter === "w") {
      take();
      if (workspace.active) void closeOne(workspace.active);
    } else if (/^[1-9]$/.test(letter)) {
      const target = shells[Number(letter) - 1];
      if (!target) return;
      take();
      setWorkspace(activateShell(workspace, target.id));
    }
  };

  return { workspace, setWorkspace, run, closeOne, onKeys, setHasKeys };
}

export type ShellStrip = ReturnType<typeof useShellStrip>;
