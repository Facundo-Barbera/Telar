"use client";

/**
 * A RUN, DRAWN IN THE TERMINAL STRIP (#890) — one chip's pane.
 *
 * THIS IS `components/run/run-terminal.tsx` MOVED, not rewritten, and the move
 * is the point: a run was a Run tab with its own emulator beside a Terminal tab
 * with another, and a person looking for "the thing that is running" had two
 * places to look. The emulator, the byte pipeline, the theme, the keys and the
 * scrollback are the ones that file had; what changed is where it is mounted
 * and where its bytes come from.
 *
 * TWO FEEDS, AND WHICH ONE IS DECIDED BY THE SAME RULE AS A SHELL'S.
 *
 *   - WITH A TERMINAL BRIDGE (this Mac, desktop shell): the redacted bytes
 *     arrive over IPC as the engine produces them, and NOTHING is polled. That
 *     is the whole of #890's transport half: a Run tab asked `/run/bytes` twice
 *     a second for as long as it was open, which on an idle project is four
 *     requests a second against Next for a screen nobody is watching.
 *   - WITHOUT ONE (a session whose Mac is not this one, a plain browser tab):
 *     the poll this replaced, at the cadence it had. An iPad has no IPC and the
 *     issue puts making it stream out of scope — but a remote run must still be
 *     readable, and it is, over the ordinary host hop.
 *
 * THE FRAMES IT READS ARE REDACTED, and that is not this file's promise to
 * keep. The desktop fans RAW node-pty bytes to a shell's reader; a RUN's raw
 * bytes stop at the engine, which mirrors its redactor's output back for the
 * renderer (apps/desktop/main.js, `POST /mirror`). So what arrives here is
 * byte-for-byte what `/run/bytes` holds — which is what makes the two feeds
 * interchangeable rather than merely similar.
 *
 * THE KEYBOARD ALWAYS GOES THROUGH THE ENGINE, in both feeds. A renderer may
 * READ an engine terminal and may not address one: `write`, `resize` and `kill`
 * refuse it over IPC by design, and typing into a project's one deployment
 * belongs on the route where the singleton and the journal are.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { claimChords } from "@/lib/commands";
import { EngineApiError } from "@/lib/engine/client";
import type { RunApi } from "@/lib/run/api";
import { byteDroppedNotice, byteFeed } from "@/lib/run/terminal-feed";
import { terminalBridge } from "@/lib/terminal-bridge";
import { TERMINAL_CHORD_CLAIMS } from "@/lib/terminal-keys";
import { ptyByteWriter, terminalKeyHandler } from "@/lib/terminal-session";
import { cssColorReader, cssVariableReader, loadTerminalFonts, terminalFont, terminalTheme } from "@/lib/terminal-theme";
import { cn } from "@/lib/utils";

/** Deep enough to hold a build's output and the failure above it; a run is not
 *  a place anyone reads twenty thousand lines back. xterm's default is 1000 and
 *  a person's shell keeps 5000 for a session's whole history. */
const SCROLLBACK = 3000;

/**
 * How often the bytes are asked for WHEN THERE IS NO BRIDGE TO STREAM THEM.
 *
 * Unchanged from the Run tab, deliberately: this is the remote-host fallback
 * and the issue scopes making that stream out. Faster while something is live,
 * because a terminal that answers a keystroke a second later does not feel like
 * a terminal; slow once nothing can change.
 */
export function bytePollInterval(live: boolean): number {
  return live ? 500 : 4000;
}

/**
 * Which feed this pane can use.
 *
 * A BRIDGE IS NOT ENOUGH ON ITS OWN. It also needs `adopt` — a cockpit running
 * against an older desktop shell has the bridge and not the verb — and a
 * terminal id, which a run has only while the engine still holds its handle. A
 * run that is `starting`, or one that has ended, therefore reads over the hop
 * until (or for ever after) the id exists, which is the same answer as a remote
 * host's and needs no second code path.
 */
export function runFeedKind(terminalId: string | undefined, bridge: { adopt?: unknown } | undefined): "stream" | "poll" {
  return terminalId && bridge?.adopt ? "stream" : "poll";
}

type Props = {
  /** Pinned to one Mac by the surface — see the note in run-panel's successor,
   *  `terminal-surface.tsx`: session ids are per-host and can collide. */
  api: RunApi;
  sessionId: string;
  runId: string;
  /** The host's name for this run's PTY, while it has one. The stream feed's
   *  address; absent means the hop. */
  terminalId?: string;
  /** Whether the run can still say anything. Sets the poll cadence and nothing
   *  else: a finished run's last screen is most of the value of keeping it. */
  live: boolean;
  /** The chip the strip is showing. Only this one fits and takes the keyboard,
   *  and only this one polls — a hidden pane asking twice a second is cost with
   *  no reader. The STREAM keeps running either way: it is push, and a chip you
   *  come back to should have the screen it would have had. */
  active: boolean;
  /** The panel is on screen. It keeps a closing surface mounted at zero width
   *  through its animation, which is not a box worth measuring. */
  visible: boolean;
};

export function RunPane({ api, sessionId, runId, terminalId, live, active, visible }: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  /** The same byte pipeline a shell uses (`ptyByteWriter`): a run's output is
   *  PTY bytes too, and the corrections it needs are the emulator's, not the
   *  surface's. Held across frames because a sequence can end in one. */
  const writeRef = useRef<((data: string) => void) | null>(null);
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
   *  carries the size the emulator is actually drawing. Over the engine in both
   *  feeds: a renderer may not resize a terminal it does not own. */
  const measure = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    try {
      fitRef.current?.fit();
    } catch {
      // A zero-sized box (a hidden chip, the panel mid-animation) has no grid.
      return;
    }
    const { api: current, sessionId: session, runId: run } = latest.current;
    void current.resize(session, { runId: run, cols: term.cols, rows: term.rows }).catch(() => {
      // A run that ended between the fit and the request is the ordinary race.
      // The size is the emulator's either way.
    });
  }, []);

  useEffect(() => {
    const element = host.current;
    if (!element) return;

    let disposed = false;
    const read = cssColorReader(element, document.createElement("canvas"));
    const { fontFamily, fontSize } = terminalFont(cssVariableReader(element));
    /** Started before the terminal exists and awaited before the first fit —
     *  see `loadTerminalFonts`. A grid measured mid-download is a grid sized
     *  against the fallback face. */
    const fontsReady = loadTerminalFonts(fontFamily, fontSize);
    const term = new Terminal({
      allowProposedApi: true,
      theme: terminalTheme(read),
      fontFamily,
      fontSize,
      scrollback: SCROLLBACK,
      // NO BLINKING CURSOR. A run usually has no prompt — the bytes are a dev
      // server's log — and a cursor blinking under a wall of output reads as a
      // shell waiting for input that nothing is waiting for.
      cursorBlink: false,
      macOptionIsMeta: false,
    });
    termRef.current = term;
    writeRef.current = ptyByteWriter(term);
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
    void fontsReady.then(() => {
      if (!disposed) measure();
    });

    return () => {
      disposed = true;
      observer.disconnect();
      offKeys.dispose();
      /* THE RUN IS NOT STOPPED HERE. This unmounts on every tab switch, and a
         deployment is a project singleton that outlives whoever is looking at
         it. Stopping belongs to the chip's stop action and to run_stop. */
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // Keyed by `runId` at the call site, so a different run is a different
    // mount and this never has to re-run for one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const feed = runFeedKind(terminalId, terminalBridge());

  /**
   * THE STREAM: adopt the run's terminal and draw what the engine sends.
   *
   * THE JOIN IS THE WHOLE DIFFICULTY, and it is what the frame's cursor is for.
   * A chip opened onto a run that has been going for ten minutes needs the
   * scrollback the engine kept AND the frames arriving while it reads it. So:
   * subscribe first (buffering, drawing nothing), read `/run/bytes` from the
   * top, draw that, then draw only the buffered frames the read did not already
   * contain. Reading first would lose whatever landed in between; drawing the
   * buffer first would put it above the history it belongs after.
   *
   * ONE READ, NOT A POLL. Nothing on this path is on a timer.
   */
  useEffect(() => {
    if (feed !== "stream" || terminalId === undefined) return;
    const bridge = terminalBridge();
    if (!bridge?.adopt) return;

    let stopped = false;
    /** The ring position of the last chunk drawn. Frames at or before it were
     *  already in the scrollback read and would be a repeat. */
    let seen = -1;
    /** Frames that arrived before the scrollback read finished. `null` once the
     *  join is done and frames go straight to the screen. */
    let holding: Array<{ data: string; cursor?: number }> | null = [];

    const paint = (chunk: { data: string; cursor?: number }) => {
      const term = termRef.current;
      if (!term || stopped) return;
      if (chunk.cursor !== undefined) {
        if (chunk.cursor <= seen) return;
        seen = chunk.cursor;
      }
      (writeRef.current ?? ptyByteWriter(term))(chunk.data);
    };

    // SUBSCRIBED BEFORE ADOPTING, so nothing produced between the two is lost.
    const offData = bridge.onData((chunk) => {
      if (chunk.id !== terminalId) return;
      if (holding) holding.push({ data: chunk.data, ...(chunk.cursor === undefined ? {} : { cursor: chunk.cursor }) });
      else paint({ data: chunk.data, ...(chunk.cursor === undefined ? {} : { cursor: chunk.cursor }) });
    });

    void (async () => {
      try {
        const adopted = await bridge.adopt!(terminalId);
        if (stopped) return;
        if (!adopted.ok) {
          // The host no longer holds that terminal — the run ended while this
          // was in flight. The status feed is already on its way with the same
          // news; the screen below is whatever the last read drew.
          return;
        }
        const answer = await latest.current.api.bytes(latest.current.sessionId, { runId: latest.current.runId, after: 0 });
        if (stopped) return;
        const term = termRef.current;
        if (term) {
          // FROM THE TOP, ONTO A CLEARED SCREEN. This runs when a chip attaches
          // — including when a `starting` run finally names its PTY and this
          // pane leaves the poll — so anything already drawn is a prefix of
          // what is about to be, and redrawing over it would double it.
          term.reset();
          writeRef.current = ptyByteWriter(term);
          writeRef.current(answer.chunks.join(""));
        }
        setDropped(answer.dropped);
        cursor.current = answer.cursor;
        seen = answer.cursor;
        const held = holding ?? [];
        holding = null;
        for (const chunk of held) paint(chunk);
      } catch {
        // The engine is away. The frames keep arriving over IPC — they are the
        // desktop's, not Next's — so the screen stays live; what was missed is
        // the scrollback, which the next attach reads again.
        holding = null;
      }
    })();

    return () => {
      stopped = true;
      offData?.();
      // PUT THE FRAMES DOWN, DO NOT STOP THE RUN. Closing a chip or switching
      // tabs unmounts this; the deployment is the project's.
      void Promise.resolve(bridge.abandon?.(terminalId)).catch(() => {});
    };
  }, [feed, terminalId, runId, sessionId]);

  /**
   * THE FALLBACK: one timer, rescheduled from its own result.
   *
   * ONLY WHERE THERE IS NO BRIDGE, and only while this chip is the one on
   * screen. A finished run is read ONCE and then never again — its screen
   * cannot change, and the Run tab's habit of asking every four seconds for
   * ever is the cost this milestone is deleting.
   */
  useEffect(() => {
    if (feed !== "poll" || !visible || !active) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const { api: current, sessionId: session, runId: run, live: running } = latest.current;
      try {
        const answer = await current.bytes(session, { runId: run, after: cursor.current });
        if (!alive) return;
        const next = byteFeed(cursor.current, answer);
        cursor.current = next.cursor;
        setDropped(answer.dropped);
        const term = termRef.current;
        if (term) {
          if (next.reset) {
            term.reset();
            writeRef.current = ptyByteWriter(term);
          }
          if (next.text) (writeRef.current ?? ptyByteWriter(term))(next.text);
        }
      } catch {
        // A refusal here is the strip's to report — the status feed is already
        // following the same run and will say what happened. Retrying slowly
        // beats a tight loop against an engine that is away.
      }
      // A SETTLED RUN STOPS ASKING. Its bytes are final.
      if (alive && running) timer = setTimeout(() => void tick(), bytePollInterval(running));
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [feed, visible, active, runId, sessionId, live]);

  /** The strip keeps a hidden chip mounted; coming back needs a fit the
   *  ResizeObserver may already have fired for an unusable box. */
  useEffect(() => {
    if (!active || !visible) return;
    measure();
    termRef.current?.focus();
  }, [active, visible, measure]);

  /**
   * THE CHORDS, CLAIMED ONLY WHILE THIS CHIP IS ON SCREEN.
   *
   * A run's pane is open for hours while nobody is typing into it, so Escape
   * and `^W`/`^R` belong to the cockpit again the moment you are looking at
   * another chip — which `active` changes on, rather than on focus.
   */
  useEffect(() => {
    if (!active || !visible) return;
    return claimChords(TERMINAL_CHORD_CLAIMS);
  }, [active, visible]);

  const dropNotice = byteDroppedNotice(dropped);

  return (
    <div
      data-testid="run-pane"
      data-active={active ? "true" : "false"}
      // MOUNTED BUT HIDDEN when it is not the chip on screen — the same rule
      // every pane in this strip follows, for the same reason: unmounting drops
      // the emulator's buffer, and a chip you came back to would arrive blank
      // over a live process.
      className={cn("absolute inset-0 flex flex-col", !active && "hidden")}
    >
      {notice ? (
        <p role="status" className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {dropNotice ? <p className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">{dropNotice}</p> : null}
      {/* `min-h-0` because this is `flex-1` inside a flex column, and without it
          a grown terminal pushes its own scroller past the bottom. `bg-card`
          unconditionally: xterm's own `theme.background` only paints once the
          terminal has drawn a cell. */}
      <div ref={host} data-testid="run-terminal-host" className="min-h-0 flex-1 overflow-hidden bg-card px-1 py-1" />
    </div>
  );
}
