"use client";

/**
 * THE TERMINAL TAB — xterm.js in the cockpit's own DOM, on real PTYs (#198).
 *
 * ONE OUTER TAB, A STRIP OF SHELLS INSIDE IT. A shell used to be its own outer
 * panel tab, which wrote "Terminal", "Terminal", "Terminal" across the strip
 * and pushed Diff and Issues off the edge — so opening a second shell cost you
 * the surfaces you were working with. The Browser and the Editor already
 * answered this: the surface is ONE, its contents are many. This is the same
 * shape, the same idioms (`+`, a close per chip, ⌘T / ⌘W / ⌘1–9, middle-click
 * closes) and the same persistence approach, so there is no second dialect of
 * "tab" to learn one level down.
 *
 * NOT SHAPED LIKE THE BROWSER SURFACE INSIDE, and the issue's instruction to
 * mirror it is the one thing to ignore here. `browser-manager.js` is 4,545
 * lines because a page renders in ANOTHER PROCESS and a `WebContentsView` has
 * to be positioned, zoomed, clipped and profile-bound over our window. An
 * emulator renders in this document: there is no native view to host, nothing
 * to keep in register with a scroll position, and no second process to
 * authenticate. What that surface has that this one needs is one call —
 * `claimChords` — and the strip's markup, which is copied so the two read as
 * the same control.
 *
 * WHAT THIS OWNS and nothing else:
 *   - the strip of shells, over `lib/terminal-workspace.ts`'s pure model;
 *   - one emulator per shell, its addons and its size;
 *   - the bytes, in both directions, between each one and W1's host;
 *   - the three keys a focused shell must not lose (lib/terminal-keys.ts).
 *
 * Everything past that is the user's dotfiles' business. Telar is a terminal
 * emulator, not a shell configurator — docs/terminal-host.md §1.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { PlusIcon, RotateCwIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon, type IImageAddonOptions } from "@xterm/addon-image";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui/button";
import { claimChords } from "@/lib/commands";
import { createEngineApi } from "@/lib/engine/client";
import { hostFetcher, LOCAL_HOST_ID } from "@/lib/hosts/client";
import { createRunApi } from "@/lib/run/api";
import { RunGlyph } from "@/lib/run/icons";
import { isOpenTerminal, statusDetail, statusLabel, statusTone, type RunTone } from "@/lib/run/presentation";
import { useRunStatusFeed } from "@/lib/run/status-stream";
import type { RunConfigurationView, RunView } from "@/lib/run/types";
import { describeTerminalEnding, isUnenterableCwd, terminalBridge, type TerminalEnding } from "@/lib/terminal-bridge";
import { endTerminal, mayClose } from "@/lib/terminal-close";
import { runAsChip } from "@/lib/terminal-reveal";
export { TERMINAL_ID_PARAM } from "@/lib/terminal-bridge";
import { TERMINAL_CHORD_CLAIMS } from "@/lib/terminal-keys";
import { attachTerminal, gridMeasurer, terminalKeyHandler } from "@/lib/terminal-session";
import {
  activateShell,
  addShell,
  closeShell,
  emptyWorkspace,
  readWorkspace,
  runShells,
  setShellTerminal,
  setShellTitle,
  shellLabel,
  upsertRunShell,
  workspaceParams,
  type TerminalWorkspace,
} from "@/lib/terminal-workspace";
import { RunPane } from "./run-pane";
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

/**
 * THE CHORDS THE STRIP TAKES BACK, AND ONLY WHILE IT HAS FOCUS.
 *
 * ⌘T and ⌘1..⌘9 carry a `menu` in the shared keymap table, so macOS matches
 * them against the application menu before the page is ever asked — without a
 * claim, the handler below would not be losing a race, it would never run.
 *
 * KEYED TO FOCUS, NOT TO MOUNT, which is `browser-live.tsx`'s rule and for its
 * reason: this surface is mounted for as long as the panel shows a Terminal, so
 * claiming on mount would suppress the rail's own ⌘1..⌘9 that entire time — a
 * worse bug than the one it fixes. ⌘W needs no entry here: a mounted terminal
 * already claims `CommandOrControl+W` for the shell (lib/terminal-keys.ts), so
 * the press reaches this document either way.
 */
const STRIP_CHORD_CLAIMS: readonly string[] = ["CommandOrControl+T", ...Array.from({ length: 9 }, (_, index) => `CommandOrControl+${index + 1}`)];

/**
 * A RUN CHIP'S STATE DOT, on the same five-tone vocabulary the masthead's pill
 * uses (`lib/run/presentation.ts`). Copied from `run-header-control.tsx` rather
 * than invented: two controls describing one deployment must not disagree about
 * what green means, and the palette's own note refuses a sixth colour.
 */
const RUN_TONE_DOT: Record<RunTone, string> = {
  idle: "bg-muted-foreground/40",
  working: "bg-warning",
  good: "bg-success",
  bad: "bg-destructive",
};

/** Can this run still say anything? Only while its terminal is open. */
function isLiveRun(run: RunView | undefined): boolean {
  return isOpenTerminal(run);
}

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

/**
 * THE SURFACE: the strip, and one pane per shell.
 *
 * `params` and `onParams` ARE THE WHOLE OF ITS PERSISTENCE. The workspace is
 * JSON under one key on this tab's own params — the same round trip the Diff's
 * filter and the Editor's open file make — which is what lets a remounted
 * panel re-adopt every running shell instead of stranding them and opening a
 * fresh set.
 */
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
  /** Which Mac this session lives on. Absent means this cockpit's own. The run
   *  door is host-scoped and session ids are per-host, so a chip built against
   *  the wrong one would describe a stranger's deployment rather than fail. */
  hostId?: string;
  /** This tab's params, carrying the shells it had when it was last written. */
  params?: Readonly<Record<string, string>>;
  /** Rewrite them. A REPLACE, like every other surface's — see
   *  `setPanelTabParams`. */
  onParams?: (params: Record<string, string>) => void;
  /** Close the OUTER tab. Closing the last shell is the gesture that means it,
   *  exactly as closing a browser's last tab closes its window. */
  onCloseSelf?: () => void;
  visible?: boolean;
}) {
  /**
   * SEEDED ONCE, FROM THE TAB, AND NEVER RESEEDED. The params come back
   * through this component on every write, and re-reading them would fight the
   * state that produced them. A remount is what re-reads — which is exactly
   * when re-adoption should happen.
   *
   * A TERMINAL WITH NO SHELLS IS NOT A TERMINAL, so an empty restore opens one
   * here rather than in an effect: a synchronous `setState` in an effect body
   * cascades a render, and the strip would flash empty first.
   */
  const [workspace, setWorkspace] = useState<TerminalWorkspace>(() => {
    const restored = readWorkspace(params);
    return restored.shells.length > 0 ? restored : addShell(emptyWorkspace());
  });

  /** Read through refs: re-running the effects below because a parent
   *  re-rendered with a new callback identity would be noise. */
  const write = useRef(onParams);
  const dismiss = useRef(onCloseSelf);
  /** The strip as last rendered — read by a close that resumes after an
   *  asynchronous question, when the render it started in may be stale. */
  const latest = useRef(workspace);
  useEffect(() => {
    write.current = onParams;
    dismiss.current = onCloseSelf;
    latest.current = workspace;
  });
  useEffect(() => {
    write.current?.(workspaceParams(workspace));
  }, [workspace]);

  /**
   * THE PROJECT'S DEPLOYMENT, IN THIS STRIP (#890).
   *
   * ONE READ AND THEN EVENTS — never a poll. `useRunStatusFeed` asks
   * `/run/status` once per mount (which is also how a live run with no chip
   * gets one back) and then follows the engine's `run.status` frames, each
   * carrying the whole view. The old Run tab asked every four seconds in every
   * window, for ever, and its emulator asked for bytes twice a second on top.
   *
   * PINNED TO ONE MAC. The default run client resolves the host from the
   * address bar per call, and session ids are per-host and can collide — so a
   * two-leg read could come back describing another machine's deployment
   * rather than failing.
   */
  const runApi = useMemo(() => createRunApi(hostFetcher(hostId ?? LOCAL_HOST_ID)), [hostId]);
  const runs = useRunStatusFeed({ sessionId: sessionId ?? "", ...(hostId ? { hostId } : {}), api: runApi });
  const [configs, setConfigs] = useState<RunConfigurationView[]>();

  /** The recipes, for a chip's glyph. Read once: a configuration's icon is not
   *  a thing that changes while you watch, and the chip's LABEL comes off the
   *  run itself (which copied the name at launch) rather than from this. */
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    void runApi
      .configurations(sessionId)
      .then((answer) => {
        if (alive) setConfigs(answer.configurations);
      })
      .catch(() => {
        // A recipe deleted mid-run simply has no glyph; the chip still draws.
      });
    return () => {
      alive = false;
    };
  }, [runApi, sessionId]);

  /**
   * FOLD THE RUN STATE ONTO THE STRIP.
   *
   * TWO RULES, AND THEY ARE NOT THE SAME RULE TWICE. Every OPEN terminal of
   * this session has a chip — a session may have several ("web dev", "web dev
   * #2") — which is what puts one there for a run an agent started. Every chip
   * already in the strip is kept CURRENT from the list, open or not, because a
   * run that just ended has to stop naming a live terminal and show its exit
   * rather than sit for ever on the last state anyone saw.
   *
   * A CHIP IS NEVER REMOVED FROM HERE. Closing one is a person's gesture and an
   * exited run's last screen is most of the value of keeping it.
   *
   * `upsertRunShell` IS IDENTITY-STABLE, so a frame that changed nothing does
   * not rewrite the tab's params or re-render the strip.
   *
   * WHILE THIS SURFACE IS NOT MOUNTED the cockpit does the first rule's work
   * instead, into this tab's params (`lib/terminal-reveal.ts`), and it uses the
   * same `runAsChip` and the same run id — so when both are running they
   * arrive at one chip, not two.
   */
  useEffect(() => {
    const status = runs.status;
    if (!status) return;
    // DEFERRED TO A TASK rather than called in the effect body: a synchronous
    // `setState` there is a cascading render, and this is the rule the cockpit's
    // own panel restore follows (`session-cockpit.tsx`) for the same reason.
    // A PAIRED MAC MAY RUN AN OLDER ENGINE, whose answer has no `terminals`
    // list; it reads as "none" rather than taking the strip down.
    const terminals = status.terminals ?? [];
    const task = window.setTimeout(() => {
      setWorkspace((current) => {
        let next = current;
        for (const shell of runShells(next)) {
          const view = terminals.find((run) => run.runId === shell.run!.runId);
          if (view) next = upsertRunShell(next, runAsChip(view));
        }
        // Oldest first, so the strip's order matches the order they opened in.
        for (const run of [...terminals].reverse()) if (isOpenTerminal(run)) next = upsertRunShell(next, runAsChip(run));
        return next;
      });
    }, 0);
    return () => window.clearTimeout(task);
  }, [runs.status]);

  /**
   * A CHIP'S STOP OR RESTART, AND THE ONE READ THAT FOLLOWS IT.
   *
   * `refresh` re-reads status and re-opens the feed. The frame for this change
   * is already on its way and in the ordinary case the two agree; what it buys
   * is that a pressed button does not look unpressed while the round trip
   * finishes. IT IS NOT A POLL — nothing calls it on a timer.
   *
   * A REFUSAL IS THE FEED'S TO REPORT. `runs.error` is already on screen for
   * the case where the engine is away, and a chip is not a place to grow a
   * second error surface.
   */
  const actOnRun = (work: () => Promise<unknown>) => {
    void work()
      .catch(() => {
        // The status the feed re-reads below is the truth either way: a stop
        // that was refused leaves the run exactly as the next frame describes.
      })
      .finally(() => runs.refresh());
  };

  /** Every run this strip knows about, by id — the chips' status dots. */
  const runsById = useMemo(() => {
    const map = new Map<string, RunView>();
    for (const run of runs.status?.terminals ?? []) map.set(run.runId, run);
    return map;
  }, [runs.status]);

  /**
   * THE WINDOW-LEVEL CLAIM, ONCE FOR THE WHOLE STRIP. Every pane used to take
   * its own copy of this, which is a claim per shell for a fact about the
   * window. See lib/terminal-keys.ts for what it buys.
   */
  useEffect(() => claimChords(TERMINAL_CHORD_CLAIMS), []);

  /** ⌘T and ⌘1..⌘9, only while focus is inside this surface — see
   *  `STRIP_CHORD_CLAIMS`. */
  const [hasKeys, setHasKeys] = useState(false);
  useEffect(() => {
    if (!hasKeys) return undefined;
    return claimChords(STRIP_CHORD_CLAIMS);
  }, [hasKeys]);

  /**
   * CLOSING A CHIP ENDS ITS TERMINAL — a shell or a run alike, since the
   * terminal owns its process ("Run = a new terminal"). Outside any reducer on
   * purpose: a reducer runs twice under StrictMode, and killing a process is
   * not something to do twice.
   *
   * ASK FIRST ONLY IF SOMETHING IS RUNNING. `mayClose` puts one question to the
   * host — is anything running in this terminal — and confirms in plain words
   * ("End “bun run dev” (4 processes)?") when there is. An idle shell at its
   * prompt, or a run that already ended, closes without a word.
   *
   * THE OLD EXCEPTION IS GONE. A run's chip used to close without stopping
   * anything, because a run belonged to the project and outlived the chip. It
   * belongs to the session now, and the chip is where it lives: closing it and
   * leaving the process behind with nothing on screen is the orphan this model
   * exists to remove.
   *
   * ONE CLOSE AT A TIME PER CHIP. The question is asynchronous, and a second
   * ⌘W or click while it is pending must not ask twice or kill twice.
   */
  const closing = useRef(new Set<string>());
  const closeOne = async (id: string) => {
    const shell = workspace.shells.find((entry) => entry.id === id);
    if (!shell || closing.current.has(id)) return;
    closing.current.add(id);
    try {
      const run = shell.run ? runsById.get(shell.run.runId) : undefined;
      // What there is to end: a run while its terminal is open, a shell once
      // its PTY has answered.
      const terminalId = shell.run ? (isOpenTerminal(run) ? shell.run.runId : undefined) : shell.terminalId;
      if (terminalId) {
        const target = { id: run?.terminalId ?? terminalId, label: shellLabel(workspace, id), ...(run?.command ? { command: run.command } : {}) };
        if (!(await mayClose([target]))) return;
        await endTerminal({ terminalId, run: Boolean(shell.run) }, { stopRun: (runId) => runApi.stop(sessionId!, runId) });
        if (shell.run) runs.refresh();
      }
      // From the LATEST strip, because it may have moved while the person read
      // the question — a status frame, another chip opening.
      const next = closeShell(latest.current, id);
      latest.current = next;
      setWorkspace(next);
      // AN EMPTY TERMINAL CLOSES. Its outer tab is the thing that was holding
      // shells, and one holding none is a blank pane with a `+` in it.
      if (next.shells.length === 0) dismiss.current?.();
    } finally {
      closing.current.delete(id);
    }
  };

  /**
   * THE STRIP'S KEYS, CONSUMED BEFORE ANYTHING ELSE SEES THEM.
   *
   * ON THE CAPTURE PHASE, and `stopImmediatePropagation` on the NATIVE event,
   * because there are two other listeners that would otherwise answer first or
   * as well: xterm attaches its own handler to the textarea (the target, below
   * this box), and the cockpit's dispatcher listens on `window` at the end of
   * the bubble chain and does not consult `defaultPrevented` —
   * `terminalKeyHandler` stops that same listener the same way.
   */
  const onKeys = (event: React.KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    const shells = workspace.shells;
    const take = () => {
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
    };
    // ⌘⇧[ / ⌘⇧] — by `code`, because with Shift held the `key` of those two is
    // "{" and "}" on a US layout and something else again on others.
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
      return;
    }
    if (letter === "w") {
      take();
      // Closing the LAST shell closes the outer tab — `closeOne` says so.
      if (workspace.active) void closeOne(workspace.active);
      return;
    }
    if (/^[1-9]$/.test(letter)) {
      const target = shells[Number(letter) - 1];
      if (!target) return;
      take();
      setWorkspace(activateShell(workspace, target.id));
    }
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onKeyDownCapture={onKeys}
      // React's onFocus/onBlur are focusin/focusout, so they fire for anything
      // inside — the strip, a chip, the emulator. The `contains` check is what
      // keeps a move BETWEEN two of them from reading as a release.
      onFocus={() => setHasKeys(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHasKeys(false);
      }}
    >
      {/* ── the strip ──────────────────────────────────────────────────────
          THE BROWSER'S MARKUP AND CLASSES, deliberately identical: same
          rounded chips, same close-on-the-right, same `+` at the end, so the
          two strips are one control a person learns once. */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1" role="tablist" aria-label="Terminal tabs">
        {workspace.shells.map((shell) => {
          const on = shell.id === workspace.active;
          const label = shellLabel(workspace, shell.id);
          const run = shell.run ? runsById.get(shell.run.runId) : undefined;
          const icon = shell.run ? configs?.find((config) => config.id === shell.run!.configId)?.icon : undefined;
          return (
            <div
              key={shell.id}
              data-testid={shell.run ? "run-tab" : "terminal-tab"}
              className={cn(
                "flex min-w-0 max-w-44 shrink-0 items-center gap-1 rounded-md px-2 py-1",
                on ? "bg-muted" : "hover:bg-muted/50",
              )}
              // Middle-click closes, the way every strip in this app does — and
              // on a run, as on a shell, closing ends what runs in it.
              onAuxClick={(event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                void closeOne(shell.id);
              }}
            >
              {shell.run && (
                /**
                 * THE RECIPE'S GLYPH AND A STATE DOT — what tells a run apart
                 * from a shell at a glance, and the two facts that are actually
                 * different about it. `statusTone` is the palette's own
                 * vocabulary (the masthead's pill uses the same one), so the
                 * chip and the pill cannot disagree about what green means.
                 */
                <>
                  <span
                    aria-hidden
                    className={cn("size-1.5 shrink-0 rounded-full", RUN_TONE_DOT[run ? statusTone(run.status) : "idle"])}
                  />
                  <RunGlyph icon={icon} className="size-3 shrink-0 opacity-80" />
                </>
              )}
              <button
                type="button"
                role="tab"
                aria-selected={on}
                className="min-w-0 flex-1 truncate text-left text-xs"
                // The status is in the TITLE rather than in the chip, which has
                // room for a name or for a state and not for both.
                title={run ? `${label} — ${statusLabel(run)}${run.command ? ` · ${run.command}` : ""}` : label}
                onClick={() => setWorkspace(activateShell(workspace, shell.id))}
              >
                {label}
              </button>
              {run?.warning && isOpenTerminal(run) && (
                /**
                 * A BUSY PORT WARNS, IT NEVER BLOCKS. The engine opened this
                 * terminal anyway and says why its readiness check proves
                 * nothing; the sign is here so a person looking at a chip that
                 * never turns green is not left guessing, and the engine's
                 * sentence is its own explanation, on hover and to a reader.
                 */
                <span role="img" aria-label={statusDetail(run)} title={statusDetail(run)} className="shrink-0 text-warning">
                  <TriangleAlertIcon className="size-3" />
                </span>
              )}
              {shell.run && run && (
                /**
                 * RESTART, ON THE CHIP. It ends this terminal and opens a fresh
                 * one from the same configuration — what a person watching a
                 * server's output reaches for, without going back up to the
                 * masthead. There is no separate Stop any more: the close
                 * beside it IS the stop.
                 */
                <button
                  type="button"
                  aria-label={`Restart ${label}`}
                  title="Restart — end this and start the same command again"
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={(event) => {
                    event.stopPropagation();
                    actOnRun(() => runApi.restart(sessionId!, shell.run!.runId));
                  }}
                >
                  <RotateCwIcon className="size-3" />
                </button>
              )}
              <button
                type="button"
                // NAMED FOR WHAT IT DOES: a close ends what runs in the
                // terminal, a run's server as much as a shell's editor.
                aria-label={`Close ${label}`}
                title="Close — ends what is running in it"
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={(event) => {
                  event.stopPropagation();
                  void closeOne(shell.id);
                }}
              >
                <XIcon className="size-3" />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          aria-label="New shell"
          title="New shell"
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => setWorkspace(addShell(workspace))}
        >
          <PlusIcon className="size-3.5" />
        </button>
      </div>

      {/**
       * EVERY PANE STAYS MOUNTED, hidden when it is not the one you are
       * looking at — the browser's rule, for a harder reason. Unmounting is
       * what drops SCROLLBACK: the host forwards bytes, it does not record
       * them, so a pane that came back would arrive with an empty screen over
       * a live shell. `hidden` rather than zero-width because a hidden pane
       * must not be measured either; only the active one fits and focuses.
       */}
      <div className="relative min-h-0 flex-1">
        {workspace.shells.map((shell) =>
          shell.run && sessionId ? (
            /**
             * KEYED BY THE RUN, not by the chip. A different run is a different
             * terminal: reusing the emulator across them would append one
             * process's bytes to another's screen, which does not look wrong —
             * it looks like the first process printed something it never did.
             * `restart` is exactly that case, and it is one click away here.
             */
            <RunPane
              key={`${shell.id}:${shell.run.runId}`}
              api={runApi}
              sessionId={sessionId}
              runId={shell.run.runId}
              {...(shell.terminalId ? { terminalId: shell.terminalId } : {})}
              live={isLiveRun(runsById.get(shell.run.runId))}
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

/**
 * ONE SHELL: one emulator, one PTY, and the size of the box between them.
 *
 * `terminalId` / `onTerminalId` remember the PTY on the shell so a remount
 * re-adopts instead of opening a second one and leaving the first running with
 * nobody reading it.
 */
function TerminalPane({
  sessionId,
  projectId,
  terminalId,
  onTerminalId,
  onTitle,
  active,
  visible,
}: {
  sessionId?: string;
  projectId?: string;
  /** The PTY this shell was last attached to, out of the tab's own params. */
  terminalId?: string;
  onTerminalId: (id: string) => void;
  /** What the shell called itself through OSC 0/2 — the chip's label. */
  onTitle: (title: string) => void;
  /** The shell the strip is showing. Only this one fits, and only this one
   *  takes the keyboard. */
  active: boolean;
  /** The panel is on screen. It keeps a closing surface mounted at zero width
   *  through its animation, which is not a box worth measuring. */
  visible: boolean;
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
  /** Read through refs: re-running the mount effect because a callback
   *  identity changed would tear the emulator down and open a second shell. */
  const remember = useRef(onTerminalId);
  const rename = useRef(onTitle);
  const focused = useRef(active);
  useEffect(() => {
    remember.current = onTerminalId;
    rename.current = onTitle;
    focused.current = active;
  });
  const adopt = useRef(terminalId);
  /** Set by the mount effect once a bridge exists, so the "open a shell in
   *  your home folder instead" button — rendered outside that effect — can
   *  retry without reaching into its closure. */
  const retryInHome = useRef<(() => void) | null>(null);

  /**
   * One place that resizes, because two would disagree about the order: fit
   * first so xterm knows its own grid, then tell the PTY, so SIGWINCH carries
   * the size the emulator is actually drawing.
   *
   * COALESCED TO A FRAME, and only forwarded when the grid moved — the rule
   * lives in `gridMeasurer` now (#909). It was written here for #825 and
   * `RunPane` was then built without it, so a run's chip fitted and SIGWINCHed
   * synchronously per notification; one copy is what stops that happening a
   * third time.
   *
   * BUILT BY THE MOUNT EFFECT, which is the scope that has the bridge and the
   * PTY's id. Held here so the reveal below can ask for a measurement without
   * reaching into that closure.
   */
  const measurer = useRef<ReturnType<typeof gridMeasurer> | null>(null);

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

    /** The refs are read fresh on every frame rather than closed over here:
     *  `createTerminal` can replace the emulator (the cwd retry), and a frame
     *  queued before this effect's cleanup runs after it. */
    const measurement = gridMeasurer(
      () => {
        const current = termRef.current;
        const addon = fitRef.current;
        return current && addon ? { term: current, fit: addon } : undefined;
      },
      (grid) => {
        // A shell that ended between the notification and the frame has no
        // process to signal — the same guard its callers make.
        if (live !== undefined) void bridge.resize(live, grid.cols, grid.rows);
      },
    );
    measurer.current = measurement;
    const measure = () => measurement.measure();

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
      // OSC 0/2 — what the shell calls itself, which is what the chip says.
      cleanups.push(term.onTitleChange((title) => rename.current(title)).dispose);
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

    const attach = (id: string, pid?: number) => {
      live = id;
      setPhase({ kind: "live", id, ...(pid === undefined ? {} : { pid }) });
      remember.current(id);
      cleanups.push(
        attachTerminal(term, bridge, id, (ending) => {
          live = undefined;
          setPhase({ kind: "ended", ending });
        }),
      );
      void fontsReady.then(() => {
        if (!disposed) measure();
      });
      // ONLY THE SHELL YOU ARE LOOKING AT takes the keyboard. A background
      // pane opening one — which is what `+` on a busy strip would do — would
      // pull focus out from under whatever you were typing into.
      if (focused.current) term.focus();
    };

    /** Shared by the first attempt and the "open a shell in your home folder
     *  instead" retry — the only difference between them is whether `cwd` is
     *  passed at all. */
    const openShell = async (cwd: string | undefined) => {
      if (disposed) return;
      try {
        const opened = await bridge.open({
          ...(cwd === undefined ? {} : { cwd }),
          // The session this shell belongs to, so settling it can close it.
          ...(sessionId ? { sessionId } : {}),
          cols: term.cols,
          rows: term.rows,
        });
        if (disposed) {
          // The shell was closed while the spawn was in flight. Nobody will
          // ever read it, so it does not get to outlive the request for it.
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
      if (live !== undefined) measure();
    });
    observer.observe(element);
    // The right panel's drag announces itself (right-panel.tsx `paint`), so the
    // grid follows the handle within the same frame rather than a frame after
    // the ResizeObserver notices the box changed.
    const onPanelResized = () => {
      if (live !== undefined) measure();
    };
    window.addEventListener("telar:panel-resized", onPanelResized);

    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener("telar:panel-resized", onPanelResized);
      measurement.cancel();
      measurer.current = null;
      for (const off of cleanups.splice(0)) off();
      retryInHome.current = null;
      /* THE SHELL IS NOT KILLED HERE, deliberately. This unmounts on every
         outer tab switch, and a `cd` and a half-typed command are not something
         to throw away because somebody looked at the Diff. Closing the CHIP is
         what ends one shell (`closeOne` above); closing the outer tab ends them
         all — see `closeTerminalTab`, called from the cockpit that owns tabs. */
      // Already disposed (and refs cleared) by `openShell` when the host
      // refused the cwd — disposing it twice is not something xterm promises
      // to tolerate.
      if (termRef.current === term) {
        term.dispose();
        termRef.current = null;
        fitRef.current = null;
      }
    };
    // The instance is keyed by its shell id one level up, so a different shell
    // is a different mount. Re-running this for a changed session id would tear
    // a live shell down mid-command.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * COMING BACK INTO VIEW IS A FIT AND A FOCUS. A hidden pane is a zero-sized
   * box the ResizeObserver may already have fired for, and the panel keeps a
   * closing surface mounted at zero width through its animation — neither is a
   * grid, so the measurement has to be retaken when it becomes one.
   */
  useEffect(() => {
    if (!active || !visible || phase.kind !== "live") return;
    measurer.current?.measure();
    termRef.current?.focus();
  }, [active, visible, phase]);

  return (
    <div
      data-testid="terminal-pane"
      data-active={active ? "true" : "false"}
      // MOUNTED BUT HIDDEN when it is not the shell on screen — see the strip's
      // comment above for why unmounting is not an option.
      // `hidden` is `display: none`, which is also what takes this pane's
      // emulator out of the tab order and out of the accessibility tree —
      // nine live textareas reachable by Tab would make the strip's own keys
      // the slow way round. No `inert` beside it: that would be the same
      // statement twice, and the two could drift.
      className={cn("absolute inset-0 flex flex-col", !active && "hidden")}
    >
      {phase.kind === "ended" && (
        <p className="shrink-0 border-b px-3 py-1.5 text-xs text-muted-foreground" role="status">
          {describeTerminalEnding(phase.ending)}
        </p>
      )}
      {phase.kind === "unavailable" && <p className="shrink-0 border-b px-3 py-1.5 text-xs text-muted-foreground">{phase.why}</p>}
      {phase.kind === "cwd-refused" && (
        /**
         * THE PANE'S WHOLE CONTENT, not a banner over an empty canvas — there
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
