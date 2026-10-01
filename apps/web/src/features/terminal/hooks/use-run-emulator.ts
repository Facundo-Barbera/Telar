"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { EngineApiError } from "@/platform/engine";
import type { RunApi } from "../run/api";
import { gridMeasurer, ptyByteWriter, terminalKeyHandler } from "../session";
import { cssColorReader, cssVariableReader, loadTerminalFonts, terminalFont, terminalTheme } from "../theme";

const SCROLLBACK = 3000;

export type RunTarget = { api: RunApi; sessionId: string; runId: string; live: boolean };

/** A run's emulator, built each time its chip comes on screen. Keys and resizes always go through the engine, never the IPC bridge. */
export function useRunEmulator(target: RunTarget) {
  const host = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Held across frames because an escape sequence can end in the next one.
  const writeRef = useRef<((data: string) => void) | null>(null);
  const [notice, setNotice] = useState<string>();
  const latest = useRef(target);
  useEffect(() => {
    latest.current = target;
  });

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    const read = cssColorReader(element, document.createElement("canvas"));
    const { fontFamily, fontSize } = terminalFont(cssVariableReader(element));
    const fontsReady = loadTerminalFonts(fontFamily, fontSize);
    // No blinking cursor: a run is usually a log, and a blinking cursor reads as a prompt waiting for input.
    const term = new Terminal({ allowProposedApi: true, theme: terminalTheme(read), fontFamily, fontSize, scrollback: SCROLLBACK, cursorBlink: false, macOptionIsMeta: false });
    termRef.current = term;
    writeRef.current = ptyByteWriter(term);
    const fit = new FitAddon();
    term.loadAddon(fit);
    fitRef.current = fit;
    term.open(element);

    const measurement = gridMeasurer(
      () => (termRef.current && fitRef.current ? { term: termRef.current, fit: fitRef.current } : undefined),
      (grid) => {
        const { api, sessionId, runId } = latest.current;
        void api.resize(sessionId, { runId, cols: grid.cols, rows: grid.rows }).catch(() => undefined);
      },
    );

    // Typed input is not redacted: redaction covers what the process writes.
    const send = (data: string) => {
      const { api, sessionId, runId } = latest.current;
      void api
        .write(sessionId, { runId, data })
        .then((answer) => {
          if (!disposed) setNotice(answer.delivered ? undefined : "This run's terminal is no longer accepting input.");
        })
        .catch((error: unknown) => {
          if (!disposed) setNotice(error instanceof EngineApiError ? error.message : "Telar could not deliver that keystroke.");
        });
    };
    const offKeys = term.onData(send);
    term.attachCustomKeyEventHandler(terminalKeyHandler(send));

    const observer = new ResizeObserver(() => measurement.measure());
    observer.observe(element);
    measurement.measure();
    term.focus();
    void fontsReady.then(() => {
      if (!disposed) measurement.measure();
    });

    return () => {
      disposed = true;
      observer.disconnect();
      measurement.cancel();
      offKeys.dispose();
      // The run is not stopped here: this unmounts on every tab switch.
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  return { host, termRef, writeRef, notice, latest };
}

export type RunEmulator = Pick<ReturnType<typeof useRunEmulator>, "termRef" | "writeRef" | "latest">;
