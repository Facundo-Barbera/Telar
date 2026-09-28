"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { isUnenterableCwd, terminalBridge, type TerminalBridge, type TerminalEnding } from "../bridge";
import { createEmulator, startingDirectory } from "../emulator";
import { attachTerminal, gridMeasurer } from "../session";
import { cssColorReader, cssVariableReader, loadTerminalFonts, terminalFont } from "../theme";

export type Phase =
  | { kind: "starting" }
  | { kind: "live"; id: string; pid?: number }
  | { kind: "ended"; ending: TerminalEnding }
  /** The host refused the checkout; there was never a PTY, and the retry is the shell's default directory. */
  | { kind: "cwd-refused"; ending: TerminalEnding }
  | { kind: "unavailable"; why: string };

const NO_BRIDGE =
  "A terminal needs Telar's desktop shell — and one on this Mac. A session on another host would otherwise get a shell on this computer while claiming to be that one.";

type Mount = {
  element: HTMLElement;
  bridge: TerminalBridge;
  sessionId: string | undefined;
  projectId: string | undefined;
  adopt: string | undefined;
  termRef: MutableRefObject<Terminal | null>;
  fitRef: MutableRefObject<FitAddon | null>;
  measurer: MutableRefObject<ReturnType<typeof gridMeasurer> | null>;
  retryInHome: MutableRefObject<(() => void) | null>;
  setPhase: (phase: Phase) => void;
  latest: MutableRefObject<{ onTerminalId: (id: string) => void; onTitle: (title: string) => void; active: boolean }>;
};

/** Runs once per pane: builds the emulator, re-adopts or opens a PTY, and follows the box's size. Returns the teardown. */
function mountShell(m: Mount): () => void {
  const { element, bridge } = m;
  let disposed = false;
  let live: string | undefined;
  const cleanups: Array<() => void> = [];
  const measurement = gridMeasurer(
    () => (m.termRef.current && m.fitRef.current ? { term: m.termRef.current, fit: m.fitRef.current } : undefined),
    (grid) => {
      if (live !== undefined) void bridge.resize(live, grid.cols, grid.rows);
    },
  );
  m.measurer.current = measurement;
  const measure = () => measurement.measure();
  const read = cssColorReader(element, document.createElement("canvas"));
  const { fontFamily, fontSize } = terminalFont(cssVariableReader(element));
  // Awaited before the first fit: a grid measured against a fallback face is a fraction off once the real one lands.
  const fontsReady = loadTerminalFonts(fontFamily, fontSize);

  const newTerm = () => {
    const made = createEmulator(element, bridge, { read, fontFamily, fontSize }, {
      onTitle: (title) => m.latest.current.onTitle(title),
      write: (bytes) => {
        if (live !== undefined) void bridge.write(live, bytes);
      },
    });
    cleanups.push(...made.cleanups);
    m.termRef.current = made.term;
    m.fitRef.current = made.fit;
    return made.term;
  };
  let term = newTerm();

  const attach = (id: string, pid?: number) => {
    live = id;
    m.setPhase({ kind: "live", id, ...(pid === undefined ? {} : { pid }) });
    m.latest.current.onTerminalId(id);
    cleanups.push(
      attachTerminal(term, bridge, id, (ending) => {
        live = undefined;
        m.setPhase({ kind: "ended", ending });
      }),
    );
    void fontsReady.then(() => {
      if (!disposed) measure();
    });
    // Only the shell on screen takes the keyboard.
    if (m.latest.current.active) term.focus();
  };

  const openShell = async (cwd: string | undefined) => {
    if (disposed) return;
    try {
      const opened = await bridge.open({ ...(cwd === undefined ? {} : { cwd }), ...(m.sessionId ? { sessionId: m.sessionId } : {}), cols: term.cols, rows: term.rows });
      if (disposed) {
        // Closed while the spawn was in flight: nobody will read it.
        if (opened.pid !== undefined) void bridge.kill(opened.id, "SIGTERM");
        return;
      }
      if (opened.ending && isUnenterableCwd(opened.ending)) {
        term.dispose();
        m.termRef.current = null;
        m.fitRef.current = null;
        m.setPhase({ kind: "cwd-refused", ending: opened.ending });
      } else if (opened.ending) m.setPhase({ kind: "ended", ending: opened.ending });
      else attach(opened.id, opened.pid);
    } catch (error) {
      if (!disposed) m.setPhase({ kind: "unavailable", why: error instanceof Error ? error.message : String(error) });
    }
  };

  m.retryInHome.current = () => {
    if (disposed) return;
    term = newTerm();
    void openShell(undefined);
  };

  // Re-adopt before opening: the panel unmounts this on every tab switch. Scrollback does not come back.
  void (async () => {
    if (m.adopt) {
      try {
        const found = (await bridge.list()).terminals.find((entry) => entry.id === m.adopt);
        if (disposed) return;
        if (found) return attach(found.id, found.pid);
      } catch {
        // Open a new one below.
      }
    }
    const cwd = await startingDirectory(m.sessionId, m.projectId);
    if (!disposed) await openShell(cwd);
  })();

  const onResize = () => {
    if (live !== undefined) measure();
  };
  const observer = new ResizeObserver(onResize);
  observer.observe(element);
  // The panel's drag announces itself, so the grid follows within the same frame.
  window.addEventListener("telar:panel-resized", onResize);

  return () => {
    disposed = true;
    observer.disconnect();
    window.removeEventListener("telar:panel-resized", onResize);
    measurement.cancel();
    m.measurer.current = null;
    for (const off of cleanups.splice(0)) off();
    m.retryInHome.current = null;
    // The shell is not killed: this unmounts on every outer tab switch. Closing the chip ends it.
    if (m.termRef.current === term) {
      term.dispose();
      m.termRef.current = null;
      m.fitRef.current = null;
    }
  };
}

/** One emulator on one PTY. `terminalId` re-adopts the PTY on remount instead of opening a second. */
export function useShellEmulator(props: {
  sessionId?: string;
  projectId?: string;
  terminalId?: string;
  onTerminalId: (id: string) => void;
  onTitle: (title: string) => void;
  active: boolean;
  visible: boolean;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const measurer = useRef<ReturnType<typeof gridMeasurer> | null>(null);
  const retryInHome = useRef<(() => void) | null>(null);
  // Decided on the first render, so a missing bridge never flashes an empty box.
  const [phase, setPhase] = useState<Phase>(() => (terminalBridge() ? { kind: "starting" } : { kind: "unavailable", why: NO_BRIDGE }));
  const latest = useRef({ onTerminalId: props.onTerminalId, onTitle: props.onTitle, active: props.active });
  useEffect(() => {
    latest.current = { onTerminalId: props.onTerminalId, onTitle: props.onTitle, active: props.active };
  });
  const adopt = useRef(props.terminalId);

  useEffect(() => {
    const element = host.current;
    const bridge = terminalBridge();
    if (!element || !bridge) return;
    return mountShell({ element, bridge, sessionId: props.sessionId, projectId: props.projectId, adopt: adopt.current, termRef, fitRef, measurer, retryInHome, setPhase, latest });
    // Keyed by shell id one level up; re-running for a changed session would tear a live shell down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Coming back into view is a fit and a focus: a hidden or animating pane was never a grid.
  const { active, visible } = props;
  useEffect(() => {
    if (!active || !visible || phase.kind !== "live") return;
    measurer.current?.measure();
    termRef.current?.focus();
  }, [active, visible, phase]);

  return { host, phase, retryInHome };
}
