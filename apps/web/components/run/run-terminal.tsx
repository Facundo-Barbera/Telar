"use client";

/**
 * A RUN'S TERMINAL, DRAWN IN THE STRIP AND WRITABLE (#198).
 *
 * WHY THIS IS NOT `TerminalSurface` WITH A DIFFERENT PROP. That surface talks
 * to `telarDesktop.terminal` — the IPC bridge — and this one must not, for two
 * independent reasons that happen to have the same answer:
 *
 *   - THE BRIDGE FANS RAW node-pty BYTES. Redaction is engine-side, with one
 *     call site in `manager.ts`. An emulator attached to the bridge would draw
 *     a run's secrets unredacted and silently undo #819.
 *   - THE BRIDGE IS LOCAL-HOST ONLY, deliberately: "a terminal that lies about
 *     which computer it is on is worse than no terminal". A run on a PAIRED MAC
 *     has no bridge at all, and this panel has always been able to show one.
 *
 * So the bytes come from the engine over the ordinary host hop — `/run/bytes`
 * out, `/run/write` and `/run/resize` back — and this component never imports
 * `terminal-bridge`.
 *
 * WHAT IT SHARES WITH THE TERMINAL TAB is what is genuinely the same question:
 * the theme (`terminal-theme.ts`), the three keys a focused shell must not lose
 * (`terminal-keys.ts`), and the handler that writes their bytes rather than
 * letting xterm encode them twice (`terminal-session.ts`).
 *
 * AND WHAT IT IS NOT. A Run tab is not a shell. `resolveShell` spawns
 * `/bin/sh -c "<command>"` — non-login, non-interactive, no dotfiles, no
 * prompt, no history — so it looks the same for every user whatever their
 * configuration, and `docs/terminal-surface.md`'s caveats about Nerd Fonts,
 * `fastfetch` and grey autosuggestions are about the other surface. No image
 * addon here for the same reason: nothing a recipe runs draws a logo, and IIP
 * is the least mature protocol in that addon.
 *
 * A POLL AND NOT A STREAM, for this pass. The cursor shape already crosses the
 * host hop with no new plumbing, and SSE can replace it behind the same api
 * function later. The cadence follows the run rather than a fixed interval.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { claimChords } from "@/lib/commands";
import { EngineApiError } from "@/lib/engine/client";
import type { RunApi } from "@/lib/run/api";
import { byteDroppedNotice, byteFeed } from "@/lib/run/terminal-feed";
import { TERMINAL_CHORD_CLAIMS } from "@/lib/terminal-keys";
import { terminalKeyHandler } from "@/lib/terminal-session";
import { cssColorReader, cssVariableReader, terminalFont, terminalTheme } from "@/lib/terminal-theme";

/** Deep enough to hold a build's output and the failure above it; a run panel
 *  is not a place anyone reads twenty thousand lines back. xterm's default is
 *  1000 and the Terminal tab keeps 5000 for a session's whole history. */
const SCROLLBACK = 3000;

/** How often the bytes are asked for. Faster than the panel's status poll while
 *  something is live, because a terminal that answers a keystroke a second
 *  later does not feel like a terminal; slow once nothing can change. */
export function bytePollInterval(live: boolean): number {
  return live ? 500 : 4000;
}

type Props = {
  /** Pinned to one Mac by the panel — see the note at the top of run-panel.tsx. */
  api: RunApi;
  sessionId: string;
  runId: string;
  /** Whether the run can still say anything. Sets the cadence, nothing else:
   *  a finished run's last screen is most of the value of keeping it. */
  live: boolean;
  /** The panel stays mounted at zero width through its close animation, so
   *  polling and the chord claims stop on a flag rather than on unmount. */
  visible?: boolean;
};

export function RunTerminal({ api, sessionId, runId, live, visible = true }: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const cursor = useRef(0);
  const [dropped, setDropped] = useState(0);
  const [notice, setNotice] = useState<string>();

  /** Read from callbacks that must not be re-created when these change: the
   *  emulator is built once per run and tearing it down mid-stream would lose
   *  the screen. */
  const latest = useRef({ api, sessionId, runId, live });
  useEffect(() => {
    latest.current = { api, sessionId, runId, live };
  });

  /** Fit first so xterm knows its own grid, then tell the PTY — so SIGWINCH
   *  carries the size the emulator is actually drawing. */
  const measure = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    try {
      fitRef.current?.fit();
    } catch {
      // A zero-sized box (the panel mid-animation) has no grid to fit to.
      return;
    }
    const { api: current, sessionId: session, runId: run } = latest.current;
    void current.resize(session, { runId: run, cols: term.cols, rows: term.rows }).catch(() => {
      // A run that ended between the fit and the request is the ordinary race.
      // The size is the emulator's either way; nothing on screen depends on
      // the engine having agreed with it.
    });
  }, []);

  useEffect(() => {
    const element = host.current;
    if (!element) return;

    let disposed = false;
    const read = cssColorReader(element, document.createElement("canvas"));
    const { fontFamily, fontSize } = terminalFont(cssVariableReader(element));
    const term = new Terminal({
      allowProposedApi: true,
      theme: terminalTheme(read),
      fontFamily,
      fontSize,
      scrollback: SCROLLBACK,
      // NO BLINKING CURSOR. A Run tab usually has no prompt — the bytes are a
      // dev server's log — and a cursor blinking under a wall of output reads
      // as a shell waiting for input that nothing is waiting for.
      cursorBlink: false,
      macOptionIsMeta: false,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    fitRef.current = fit;
    term.open(element);

    /**
     * THE KEYBOARD. `onData` is every ordinary key, a paste included; the
     * custom handler is the three a focused shell must not lose, and it writes
     * their bytes itself so xterm does not encode them a second time.
     *
     * NOTHING HERE IS REDACTED, and that is stated rather than discovered:
     * redaction covers what the PROCESS writes. A passphrase typed into a
     * migration's prompt is bytes Telar was never told were a secret —
     * docs/run-terminal.md §5, unchanged by this surface existing.
     */
    const send = (data: string) => {
      const { api: current, sessionId: session, runId: run } = latest.current;
      void current
        .write(session, { runId: run, data })
        .then((answer) => {
          if (disposed) return;
          // `delivered: false` is the host declining to reach a process — the
          // terminal ended a moment ago. Said once, plainly, rather than per
          // keystroke into a void.
          setNotice(answer.delivered ? undefined : "This run's terminal is no longer accepting input.");
        })
        .catch((error: unknown) => {
          if (disposed) return;
          setNotice(error instanceof EngineApiError ? error.message : "Telar could not deliver that keystroke.");
        });
    };
    const offKeys = term.onData(send);
    term.attachCustomKeyEventHandler(terminalKeyHandler(send));

    const observer = new ResizeObserver(() => measure());
    observer.observe(element);
    measure();

    return () => {
      disposed = true;
      observer.disconnect();
      offKeys.dispose();
      /* THE RUN IS NOT STOPPED HERE. This unmounts on every tab switch and on
         every new run, and a deployment is a project singleton that outlives
         whoever is looking at it. Stopping belongs to the Stop button. */
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // Keyed by `runId` at the call site, so a different run is a different
    // mount and this never has to re-run for one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * ONE TIMER, RESCHEDULED FROM ITS OWN RESULT, so the cadence follows the run
   * rather than firing forever after everything stopped. Nothing is polled
   * while the panel is off screen: it stays mounted at zero width through the
   * close animation, and a hidden emulator asking twice a second is cost with
   * no reader.
   */
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const { api: current, sessionId: session, runId: run, live: running } = latest.current;
      try {
        const answer = await current.bytes(session, { runId: run, after: cursor.current });
        if (!alive) return;
        const feed = byteFeed(cursor.current, answer);
        cursor.current = feed.cursor;
        setDropped(answer.dropped);
        const term = termRef.current;
        if (term) {
          if (feed.reset) term.reset();
          if (feed.text) term.write(feed.text);
        }
      } catch {
        // A refusal here is the panel's to report — it is already asking for
        // the same run's status on its own timer and will say what happened.
        // Retrying slowly beats a tight loop against an engine that is away.
      }
      if (alive) timer = setTimeout(() => void tick(), bytePollInterval(running));
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [visible, runId, sessionId]);

  /** The panel keeps a closing surface mounted at zero width; coming back needs
   *  a fit the ResizeObserver may already have fired for an unusable box. */
  useEffect(() => {
    if (visible) measure();
  }, [visible, measure]);

  /**
   * THE CHORDS, CLAIMED ONLY WHILE ON SCREEN.
   *
   * The Terminal tab claims these while MOUNTED, because a claim released on
   * blur would race the application menu's rebuild. This one can do better
   * without that race: `visible` changes on a tab switch rather than on focus,
   * so Escape and `^W`/`^R` belong to the cockpit again the moment the Run tab
   * is not the one on screen — which matters more here, since a Run tab is open
   * for hours while nobody is typing into it.
   */
  useEffect(() => {
    if (!visible) return;
    return claimChords(TERMINAL_CHORD_CLAIMS);
  }, [visible]);

  const dropNotice = byteDroppedNotice(dropped);

  return (
    /**
     * `bg-muted/30` IS NOT DECORATION HERE. The box clips its children to its
     * own corners, so it is a card by construction and has to paint rather than
     * borrow an ancestor's ground (app/globals.test.ts). It is also the fill the
     * `<pre>` this replaces used, so the panel's shape is unchanged — and xterm
     * draws its own cells over it from `terminalTheme`, which reads the Look's
     * variables, so the two agree by construction rather than by a matching
     * pair of hard-coded colours.
     */
    <section className="flex h-72 min-h-0 flex-col overflow-hidden rounded-md border border-border bg-muted/30" aria-label="Output">
      {notice ? (
        <p role="status" className="shrink-0 border-b border-border px-2 py-1 text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {dropNotice ? <p className="shrink-0 border-b border-border px-2 py-1 text-xs text-muted-foreground">{dropNotice}</p> : null}
      {/* `min-h-0` because this is `flex-1` inside a flex column, and without it
          a grown terminal pushes its own scroller past the bottom. */}
      <div ref={host} data-testid="run-terminal-host" className="min-h-0 flex-1 overflow-hidden px-1 py-1" />
    </section>
  );
}
