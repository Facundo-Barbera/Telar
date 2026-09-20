/**
 * THE PTY, FROM THE RENDERER'S SIDE (#198).
 *
 * W1 put the pseudo-terminals in the Electron main process and `preload.js`
 * carries the bytes; this is the typed view of that, and the `typeof window`
 * probe that answers "is there one here at all".
 *
 * GATED ON THE LOCAL HOST, exactly as `desktopBrowserBridge` is, and for a
 * sharper reason than the browser's: a session on a REMOTE Mac would otherwise
 * open a shell on THIS one and present it as that machine's. A terminal that
 * lies about which computer it is on is worse than no terminal.
 */
import { hostFromPathname, LOCAL_HOST_ID } from "@/lib/hosts/client";

/**
 * WHY A TERMINAL ENDED — and `unknown` is not a rounding of `exited`.
 *
 * `exited` is the only one node-pty observed, and it carries a code. `failed`
 * means `pty.fork` itself threw, so no process was ever created. `unknown`
 * means Telar stopped being able to vouch for the process — the app is
 * quitting, a kill could not be delivered, a kill was never observed to land,
 * or the pty's fd raised. See docs/terminal-host.md §3; the engine's
 * `RunStatus` splits three ways for the same reason.
 *
 * A UI MUST NOT DRAW `unknown` AS "FINISHED". There is very likely still a
 * process on the other end of that handle.
 */
export type TerminalFate = "exited" | "failed" | "unknown";

/** The `telar:terminal:exit` payload. `pid` is absent only on `failed`. */
export type TerminalEnding = {
  id: string;
  pid?: number;
  fate: TerminalFate;
  /**
   * The child's exit status — present on `exited` only.
   *
   * IT IS THE ONLY PLACE "THE COMMAND WAS WRONG" IS WRITTEN DOWN. A missing
   * binary and an unusable cwd both fork successfully and fail inside the
   * child, so each arrives as a nonzero `exited` with a real pid (126 and 1,
   * measured by W1) rather than as `failed`.
   */
  exitCode?: number;
  signal?: string;
  /** Why we stopped vouching — set on `unknown`, and it always names the pid. */
  reason?: string;
  /** What `pty.fork` threw — set on `failed`. */
  error?: string;
  at?: number;
};

export type TerminalChunk = { id: string; data: string };

/** What is live in the host right now. Facts only; no handles cross the IPC. */
export type LiveTerminal = {
  id: string;
  pid?: number;
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  startedAt?: number;
};

export type TerminalOpenRequest = {
  /** Absent means the host resolves `$SHELL` — a terminal emulator runs what
   *  the person's login shell is, not a shell we picked for them. */
  shell?: string;
  args?: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
};

/** `open` answers the id it minted — plus `ending` in the one case where there
 *  is no process to answer about, so a caller never has to wait for an event to
 *  learn the spawn threw. */
export type TerminalOpened = { id: string; pid?: number; ending?: TerminalEnding };

export type TerminalBridge = {
  open: (options: TerminalOpenRequest) => Promise<TerminalOpened>;
  write: (id: string, data: string) => Promise<{ ok: boolean }>;
  resize: (id: string, cols: number, rows: number) => Promise<{ ok: boolean }>;
  kill: (id: string, signal?: string) => Promise<{ ok: boolean }>;
  list: () => Promise<{ terminals: LiveTerminal[] }>;
  onData: (listener: (chunk: TerminalChunk) => void) => (() => void) | undefined;
  onExit: (listener: (ending: TerminalEnding) => void) => (() => void) | undefined;
};

/** The shell's terminal host, or undefined in a browser tab or on a session
 *  whose Mac is not this one. */
export function terminalBridge(): TerminalBridge | undefined {
  if (typeof window === "undefined" || hostFromPathname(window.location.pathname) !== LOCAL_HOST_ID) return undefined;
  return (window as unknown as { telarDesktop?: { terminal?: TerminalBridge } }).telarDesktop?.terminal;
}

/**
 * CLOSING A TERMINAL TAB ENDS ITS SHELL.
 *
 * WHY HERE AND NOT IN THE SURFACE: the surface unmounts every time another tab
 * is looked at, so "the component went away" is not "the person is done with
 * this shell" — killing on unmount would end a half-typed command because
 * somebody glanced at the Diff. The COCKPIT owns the strip, so it is the only
 * place that can tell a tab switch from a tab closing.
 *
 * Without this, every closed tab leaves a shell running until the app quits,
 * where W1's host reports it as `unknown`.
 *
 * `bridge` is injected so this is testable without a shell; the default is the
 * real one, so the call site stays one line.
 */
export function endTerminalForTab(params: Readonly<Record<string, string>>, bridge = terminalBridge()): string | undefined {
  const id = params[TERMINAL_ID_PARAM];
  if (!id || !bridge) return undefined;
  void Promise.resolve(bridge.kill(id, "SIGTERM")).catch(() => {
    // A terminal that already ended is not an error — the renderer learns of an
    // exit asynchronously, so a close racing one is the normal case.
  });
  return id;
}

/** The params key a terminal tab carries its PTY's id in. Declared beside the
 *  bridge rather than in the surface, so the reaper above does not have to
 *  import the emulator to know what to look for. */
export const TERMINAL_ID_PARAM = "terminal";

/**
 * WHAT A PERSON SHOULD READ WHEN A TERMINAL ENDS.
 *
 * Kept next to the type rather than in the surface, because the one rule that
 * matters here is a rule about the MODEL: `unknown` never says "finished". The
 * sentences below differ in kind, not in tone — one reports an observation, one
 * reports a refusal to start, and one reports that we have lost track of a
 * process that is probably still running.
 */
export function describeTerminalEnding(ending: TerminalEnding): string {
  if (ending.fate === "failed") return `This shell never started${ending.error ? `: ${ending.error}` : "."}`;
  if (ending.fate === "unknown") {
    return ending.reason
      ? `Telar lost track of this shell — ${ending.reason}`
      : "Telar lost track of this shell; its process may still be running.";
  }
  if (ending.signal) return `Shell ended on ${ending.signal}.`;
  if (ending.exitCode === undefined) return "Shell ended.";
  return ending.exitCode === 0 ? "Shell exited." : `Shell exited with status ${ending.exitCode}.`;
}
