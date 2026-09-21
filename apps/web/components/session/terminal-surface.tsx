"use client";

/**
 * THE TERMINAL TAB — xterm.js in the cockpit's own DOM, on a real PTY (#198).
 *
 * NOT SHAPED LIKE THE BROWSER SURFACE, and the issue's instruction to mirror it
 * is the one thing to ignore here. `browser-manager.js` is 4,545 lines because a
 * page renders in ANOTHER PROCESS and a `WebContentsView` has to be positioned,
 * zoomed, clipped and profile-bound over our window. An emulator renders in this
 * document: there is no native view to host, nothing to keep in register with a
 * scroll position, and no second process to authenticate. What that surface has
 * that this one needs is one call — `claimChords` — and it is four lines.
 *
 * THREE THINGS THIS OWNS and nothing else:
 *   - the emulator, its addons and its size;
 *   - the bytes, in both directions, between it and W1's host;
 *   - the three keys a focused shell must not lose (lib/terminal-keys.ts).
 *
 * Everything past that is the user's dotfiles' business. Telar is a terminal
 * emulator, not a shell configurator — docs/terminal-host.md §1.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon, type IImageAddonOptions } from "@xterm/addon-image";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui/button";
import { claimChords } from "@/lib/commands";
import { createEngineApi } from "@/lib/engine/client";
import { describeTerminalEnding, isUnenterableCwd, terminalBridge, type TerminalBridge, type TerminalEnding } from "@/lib/terminal-bridge";
export { TERMINAL_ID_PARAM } from "@/lib/terminal-bridge";
import { TERMINAL_CHORD_CLAIMS } from "@/lib/terminal-keys";
import { attachTerminal, terminalKeyHandler } from "@/lib/terminal-session";
import { cssColorReader, cssVariableReader, loadTerminalFonts, terminalFont, terminalTheme } from "@/lib/terminal-theme";
import { cn } from "@/lib/utils";

const api = createEngineApi();

/**
 * WHICH IMAGE PROTOCOLS, AND THE HONEST NAME FOR EACH ONE'S MATURITY.
 *
 * SIXEL and iTerm2's IIP, both on. IIP is the one that matters: the owner's
 * `~/.zshrc` runs `fastfetch --logo-type iterm` when it detects an iTerm-ish
 * terminal, so his logo arrives as IIP on every new tab.
 *
 * KITTY IS NOT TURNED OFF HERE BECAUSE THERE IS NOTHING TO TURN OFF.
 * `@xterm/addon-image@0.9.0` implements SIXEL and IIP and nothing else — its
 * options carry no kitty key and its source contains no kitty handler. Saying
 * "kitty: disabled" would describe a switch that does not exist.
 *
 * WHAT IS ALPHA IS IIP, not kitty. The addon's own README §Status: "Sixel
 * support and image handling in xterm.js is considered beta quality. IIP
 * support is in alpha stage." So the protocol we depend on for fastfetch is the
 * least mature one here, and that is stated rather than smoothed — it is the
 * first thing to suspect when a logo draws wrongly.
 */
export const TERMINAL_IMAGE_OPTIONS: IImageAddonOptions = {
  sixelSupport: true,
  iipSupport: true,
  /**
   * The CSI 14/16/18 t reports. On, because a program that cannot ask the cell
   * size in pixels cannot scale an image to the grid — which is exactly what
   * fastfetch's logo does.
   */
  enableSizeReports: true,
};

/** Deep enough to hold a `fastfetch` and the session above it; shallow enough
 *  that twenty tabs are not a memory problem. xterm's default is 1000. */
const SCROLLBACK = 5000;

type Phase =
  | { kind: "starting" }
  | { kind: "live"; id: string; pid?: number }
  | { kind: "ended"; ending: TerminalEnding }
  /**
   * THE ONE ENDING WITH A WAY FORWARD (#851's follow-up). The host refused
   * because the session's checkout is gone, not because anything about the
   * shell itself is wrong — so unlike `ended`, this phase never had a PTY to
   * show, and offers the one retry that is honest: the shell's own default
   * directory, which is what an absent `cwd` already means to the host.
   */
  | { kind: "cwd-refused"; ending: TerminalEnding }
  | { kind: "unavailable"; why: string };

/**
 * Where a new shell starts.
 *
 * `workspacePath` is the session's checkout — the field's own comment in
 * `protocol/entities.ts` says it is named in full "because the next thing a
 * reader does is `cd`", which is this call site exactly. A session that has not
 * cut a worktree yet answers the project's root, which is the same directory.
 *
 * FAILING TO ANSWER IS NOT AN ERROR. The host treats an absent `cwd` as "the
 * shell's own default", which is a worse place to land but still a terminal —
 * better than refusing to open one because the engine was slow.
 */
async function startingDirectory(sessionId?: string, projectId?: string): Promise<string | undefined> {
  try {
    if (sessionId) return (await api.sessionFiles(sessionId)).listing.workspacePath;
    if (projectId) return (await api.projectFiles(projectId)).listing.workspacePath;
  } catch {
    // The engine is away or the checkout is unavailable — see above.
  }
  return undefined;
}

export function TerminalSurface({
  sessionId,
  projectId,
  terminalId,
  onTerminalId,
  visible = true,
}: {
  sessionId?: string;
  projectId?: string;
  /** The PTY this tab was last attached to, out of the tab's own params. */
  terminalId?: string;
  /** Remember the PTY on the tab, so the next mount re-adopts rather than
   *  opening a second shell and leaving the first one running with nobody
   *  reading it. */
  onTerminalId?: (id: string) => void;
  visible?: boolean;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  /**
   * DECIDED ON THE FIRST RENDER, not in an effect, and there are two reasons.
   * A synchronous `setState` inside an effect body cascades a render, which
   * `react-hooks/set-state-in-effect` refuses; and "there is no shell here" is
   * knowable before anything mounts, so reporting it one render late would
   * flash an empty black box first.
   *
   * NO HYDRATION MISMATCH TO WORRY ABOUT: which panel tab is open comes out of
   * localStorage, so the server renders no surface at all — see the `dynamic`
   * block at the top of components/right-panel.tsx.
   */
  const [phase, setPhase] = useState<Phase>(() =>
    terminalBridge()
      ? { kind: "starting" }
      : {
          kind: "unavailable",
          why: "A terminal needs Telar's desktop shell — and one on this Mac. A session on another host would otherwise get a shell on this computer while claiming to be that one.",
        },
  );
  /** Read through a ref: re-running the mount effect because the callback
   *  identity changed would tear the emulator down and open a second shell. */
  const remember = useRef(onTerminalId);
  useEffect(() => {
    remember.current = onTerminalId;
  });
  const adopt = useRef(terminalId);
  /** Set by the mount effect once a bridge exists, so the "open a shell in
   *  your home folder instead" button — rendered outside that effect — can
   *  retry without reaching into its closure. */
  const retryInHome = useRef<(() => void) | null>(null);

  /** The rAF that will run the next fit, so a burst of resize signals in one
   *  frame becomes one fit. */
  const measureFrame = useRef<number | null>(null);
  /** The last grid the PTY was told about, so a pixel change that moves no
   *  cell sends no SIGWINCH. */
  const lastGrid = useRef<{ cols: number; rows: number } | null>(null);

  /** One place that resizes, because two would disagree about the order: fit
   *  first so xterm knows its own grid, then tell the PTY, so SIGWINCH carries
   *  the size the emulator is actually drawing.
   *
   *  COALESCED TO A FRAME, and only forwarded when the grid moved. A panel drag
   *  fires the ResizeObserver and the drag's own event several times per frame;
   *  each used to fit and signal the PTY synchronously, and a shell mid-redraw
   *  (nvim) got a SIGWINCH storm it could not keep up with — which read as the
   *  resize "not responding". One fit per painted frame, and a SIGWINCH only
   *  when cols or rows changed, is what every other emulator does. */
  const measure = useCallback((bridge: TerminalBridge, id: string) => {
    if (measureFrame.current !== null) window.cancelAnimationFrame(measureFrame.current);
    measureFrame.current = window.requestAnimationFrame(() => {
      measureFrame.current = null;
      const term = termRef.current;
      if (!term) return;
      try {
        fitRef.current?.fit();
      } catch {
        // A zero-sized box (the panel mid-animation) has no grid to fit to.
        return;
      }
      const grid = { cols: term.cols, rows: term.rows };
      if (lastGrid.current && lastGrid.current.cols === grid.cols && lastGrid.current.rows === grid.rows) return;
      lastGrid.current = grid;
      void bridge.resize(id, grid.cols, grid.rows);
    });
  }, []);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const bridge = terminalBridge();
    // The sentence is already on screen from the first render above; there is
    // nothing to emulate without a PTY behind it.
    if (!bridge) return;

    let disposed = false;
    /** Set as soon as the PTY answers, so teardown can detach even if the
     *  component unmounted while `open` was still in flight. */
    let live: string | undefined;
    const cleanups: Array<() => void> = [];

    const read = cssColorReader(element, document.createElement("canvas"));
    const { fontFamily, fontSize } = terminalFont(cssVariableReader(element));
    /**
     * STARTED BEFORE THE TERMINAL EXISTS, AWAITED BEFORE THE FIRST FIT.
     *
     * xterm derives cols and rows by measuring one cell, so a grid measured
     * while a face is still downloading is a grid sized against the fallback —
     * and when the real face lands every cell is a fraction off, which reads as
     * a prompt wrapping a column early. Kicking the load off here means the
     * bundled symbols face is registered before `open()`; awaiting it before
     * the first `measure()` means the measurement is of what is drawn.
     */
    const fontsReady = loadTerminalFonts(fontFamily, fontSize);

    /**
     * ONE PER ATTEMPT, NOT ONE PER MOUNT. A cwd the host refuses is disposed
     * of before it is ever shown (see `openShell` below), and the retry needs
     * a fresh instance to open into the same `element` — xterm does not
     * support re-opening a disposed terminal.
     */
    const createTerminal = (): Terminal => {
      const term = new Terminal({
        allowProposedApi: true,
        theme: terminalTheme(read),
        fontFamily,
        fontSize,
        scrollback: SCROLLBACK,
        cursorBlink: true,
        // macOS's own convention, and the one the owner's muscle memory has: a
        // word ends at a path separator too, so ⌥← walks a path segment.
        macOptionIsMeta: false,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new ImageAddon(TERMINAL_IMAGE_OPTIONS));
      term.open(element);
      /**
       * WEBGL IS AN OPTIMISATION, NOT A REQUIREMENT. A machine with no GL
       * context — or one whose context is lost when the panel is hidden —
       * must still have a terminal, so this both tries and gives back:
       * `onContextLoss` disposes the addon and xterm falls through to its DOM
       * renderer on the next frame.
       */
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        // No GL here. The DOM renderer draws the same cells, more slowly.
      }
      // The three keys a focused shell must not lose — see
      // lib/terminal-session.ts for why this writes the byte itself instead
      // of letting xterm encode it.
      term.attachCustomKeyEventHandler(
        terminalKeyHandler((bytes) => {
          if (live !== undefined) void bridge.write(live, bytes);
        }),
      );
      termRef.current = term;
      fitRef.current = fit;
      return term;
    };

    let term = createTerminal();
    // The other half of the two keys above, for the presses macOS matches
    // against the application menu before the page is ever asked. See
    // lib/terminal-keys.ts. Claimed once — it is a window-level claim, not
    // something a re-mounted terminal needs a second copy of.
    cleanups.push(claimChords(TERMINAL_CHORD_CLAIMS));

    const attach = (id: string, pid?: number) => {
      live = id;
      setPhase({ kind: "live", id, ...(pid === undefined ? {} : { pid }) });
      remember.current?.(id);
      cleanups.push(
        attachTerminal(term, bridge, id, (ending) => {
          live = undefined;
          setPhase({ kind: "ended", ending });
        }),
      );
      void fontsReady.then(() => {
        if (!disposed) measure(bridge, id);
      });
      term.focus();
    };

    /** Shared by the first attempt and the "open a shell in your home folder
     *  instead" retry — the only difference between them is whether `cwd` is
     *  passed at all. */
    const openShell = async (cwd: string | undefined) => {
      if (disposed) return;
      try {
        const opened = await bridge.open({
          ...(cwd === undefined ? {} : { cwd }),
          cols: term.cols,
          rows: term.rows,
        });
        if (disposed) {
          // The tab was closed while the spawn was in flight. Nobody will ever
          // read this shell, so it does not get to outlive the request for it.
          if (opened.pid !== undefined) void bridge.kill(opened.id, "SIGTERM");
          return;
        }
        if (opened.ending) {
          if (isUnenterableCwd(opened.ending)) {
            /**
             * NO XTERM UNDER THE REFUSAL. There was never a process behind
             * this instance, so it is disposed rather than left as an empty
             * canvas — see the render below, which hides the host div for
             * this phase and draws the retry in its place instead.
             */
            term.dispose();
            termRef.current = null;
            fitRef.current = null;
            setPhase({ kind: "cwd-refused", ending: opened.ending });
            return;
          }
          setPhase({ kind: "ended", ending: opened.ending });
          return;
        }
        attach(opened.id, opened.pid);
      } catch (error) {
        if (disposed) return;
        setPhase({ kind: "unavailable", why: error instanceof Error ? error.message : String(error) });
      }
    };

    retryInHome.current = () => {
      if (disposed) return;
      term = createTerminal();
      void openShell(undefined);
    };

    void (async () => {
      /**
       * RE-ADOPT BEFORE OPENING. The panel unmounts this surface every time
       * another tab is looked at, and a fresh `open()` on every remount would
       * leave a shell per glance running with nobody reading it. `list()` is
       * exactly the question W1 shipped for this.
       *
       * THE SCROLLBACK DOES NOT COME BACK — the host forwards bytes, it does
       * not record them — so an adopted terminal arrives with an empty screen
       * and a live shell. Nothing is written into the buffer to explain that:
       * the emulator's buffer belongs to the program on the other end.
       */
      const wanted = adopt.current;
      if (wanted) {
        try {
          const { terminals } = await bridge.list();
          const found = terminals.find((entry) => entry.id === wanted);
          if (disposed) return;
          if (found) {
            attach(found.id, found.pid);
            return;
          }
        } catch {
          // Ask for a new one below rather than leaving an empty surface.
        }
      }

      const cwd = await startingDirectory(sessionId, projectId);
      if (disposed) return;
      await openShell(cwd);
    })();

    const observer = new ResizeObserver(() => {
      if (live !== undefined) measure(bridge, live);
    });
    observer.observe(element);
    // The right panel's drag announces itself (right-panel.tsx `paint`), so the
    // grid follows the handle within the same frame rather than a frame after
    // the ResizeObserver notices the box changed.
    const onPanelResized = () => {
      if (live !== undefined) measure(bridge, live);
    };
    window.addEventListener("telar:panel-resized", onPanelResized);

    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener("telar:panel-resized", onPanelResized);
      if (measureFrame.current !== null) {
        window.cancelAnimationFrame(measureFrame.current);
        measureFrame.current = null;
      }
      for (const off of cleanups.splice(0)) off();
      retryInHome.current = null;
      /* THE SHELL IS NOT KILLED HERE, deliberately. This unmounts on every tab
         switch, and a `cd` and a half-typed command are not something to throw
         away because somebody looked at the Diff. Closing the TAB is what ends
         it — see `endTerminalForTab`, called from the cockpit that owns tabs. */
      // Already disposed (and refs cleared) by `openShell` when the host
      // refused the cwd — disposing it twice is not something xterm promises
      // to tolerate.
      if (termRef.current === term) {
        term.dispose();
        termRef.current = null;
        fitRef.current = null;
      }
    };
    // The instance is keyed by its tab id one level up, so a different terminal
    // is a different mount. Re-running this for a changed session id would tear
    // a live shell down mid-command.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The panel keeps a closing surface mounted at zero width through its
   *  animation; coming back needs a fit the ResizeObserver may already have
   *  fired for an unusable box. */
  useEffect(() => {
    if (!visible || phase.kind !== "live") return;
    const bridge = terminalBridge();
    if (bridge) measure(bridge, phase.id);
  }, [visible, phase, measure]);

  return (
    <div className="flex h-full flex-col">
      {phase.kind === "ended" && (
        /**
         * `unknown` IS NOT "FINISHED" and this line must never read as if it
         * were — `describeTerminalEnding` is where that distinction is written
         * down. A shell Telar lost track of very likely still has a process on
         * the other end of it.
         */
        <p
          className={cn(
            "shrink-0 border-b px-3 py-1.5 text-xs",
            // `--warning` on the state vocabulary, not a raw ramp: a shell
            // Telar cannot vouch for is the same KIND of fact as a blocked
            // session, and the palette's note says not to add a sixth colour
            // (app/globals.css). `tint-warning` is the sanctioned wash.
            phase.ending.fate === "unknown" ? "tint-warning text-warning" : "text-muted-foreground",
          )}
          role="status"
        >
          {describeTerminalEnding(phase.ending)}
        </p>
      )}
      {phase.kind === "unavailable" && <p className="shrink-0 border-b px-3 py-1.5 text-xs text-muted-foreground">{phase.why}</p>}
      {phase.kind === "cwd-refused" && (
        /**
         * THE TAB'S WHOLE CONTENT, not a banner over an empty canvas — there
         * is no xterm behind this (see `openShell`'s disposal above), so
         * nothing would be under it but white. Same muted/centred shape the
         * rail's own empty states use (`SidebarEmpty` in app-sidebar.tsx),
         * with the one action that is actually true: the host's documented
         * fallback for an absent `cwd` is the shell's own default directory.
         */
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-xs text-muted-foreground">{describeTerminalEnding(phase.ending)}</p>
          <Button size="sm" variant="outline" onClick={() => retryInHome.current?.()}>
            Open a shell in your home folder instead
          </Button>
        </div>
      )}
      {/* `min-h-0` because the box above is `flex-1` inside a flex column, and
          without it a grown terminal pushes its own scroller past the bottom.
          `bg-card` UNCONDITIONALLY: xterm's own `theme.background` only paints
          once the terminal has drawn a cell, so before that (and while this
          div is hidden for `cwd-refused`, briefly, mid-attempt) the box under
          it is the page's white, not the panel's. Hidden rather than unmounted
          for `cwd-refused` so `host` stays a stable ref across phases. */}
      <div
        ref={host}
        data-testid="terminal-host"
        className={cn("min-h-0 flex-1 overflow-hidden bg-card px-1 py-1", phase.kind === "cwd-refused" && "hidden")}
      />
    </div>
  );
}
