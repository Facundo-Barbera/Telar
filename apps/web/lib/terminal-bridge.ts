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
 * WHY A TERMINAL ENDED.
 *
 * `exited` is the only one node-pty observed, and it carries a code. `failed`
 * means no process was ever created: `pty.fork` threw, or the host refused a
 * request that could not have run. See docs/terminal-host.md §3.
 *
 * THERE IS NO `unknown` ANY MORE. It meant "Telar stopped vouching for this
 * process" and existed to hold the one-deployment slot; with the terminal
 * owning its process (a close is SIGTERM then SIGKILL, and an ignored signal
 * leaves the terminal open and closable), the host never produces it.
 */
export type TerminalFate = "exited" | "failed";

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
  /** Set when the HOST ended it: one terminal closed, a whole session closed,
   *  or Telar quitting. Absent when the process ended by itself. */
  closed?: "close" | "session" | "quit";
  /** What `pty.fork` threw — set on `failed`. */
  error?: string;
  at?: number;
};

export type TerminalChunk = {
  id: string;
  data: string;
  /**
   * WHERE THIS CHUNK SITS IN THE ENGINE'S BYTE RING — on a RUN's frames only
   * (#890), because only a run has a ring to index into.
   *
   * A person's shell has no scrollback anywhere but in the emulator drawing it:
   * the host forwards bytes and records none, so there is no position to carry
   * and no join to make. A run's output IS recorded — `/run/bytes` hands back a
   * window and a cursor — so a chip that attaches to a run already in flight
   * reads that window and then follows these frames, and this is what tells it
   * which of them it has already drawn. Without it the join would either repeat
   * a screen or leave a hole in one.
   */
  cursor?: number;
};

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
  /** The session whose panel this shell lives in, so settling that session can
   *  close it. */
  sessionId?: string;
};

/**
 * `terminal.active`'s answer for one terminal: is anything running in it that
 * a close would end. One process-table read in the host, taken only when asked.
 * `processes` counts what runs under the shell, not the shell itself; `command`
 * is the foreground one, as the process table spells it.
 */
export type TerminalActivity = { id: string; active: boolean; processes: number; command?: string };

/** `open` answers the id it minted — plus `ending` in the one case where there
 *  is no process to answer about, so a caller never has to wait for an event to
 *  learn the spawn threw. */
export type TerminalOpened = { id: string; pid?: number; ending?: TerminalEnding };

export type TerminalBridge = {
  open: (options: TerminalOpenRequest) => Promise<TerminalOpened>;
  write: (id: string, data: string) => Promise<{ ok: boolean }>;
  resize: (id: string, cols: number, rows: number) => Promise<{ ok: boolean }>;
  kill: (id: string, signal?: string) => Promise<{ ok: boolean }>;
  /**
   * CLOSE = KILL: SIGTERM to every process group in the terminal, SIGKILL a
   * second later to whatever stayed; resolves once that is over. Whether to ask
   * first is `lib/terminal-close.ts`'s call, made with `active` below.
   * Optional because a shell whose preload predates it has only `kill`.
   */
  close?: (id: string) => Promise<{ ok: boolean }>;
  /**
   * IS ANYTHING RUNNING IN THESE TERMINALS — asked once, before a close. Named
   * ids may include a run's (its chip needs the same question); with none, this
   * window's own shells.
   */
  active?: (ids?: string[]) => Promise<{ terminals: TerminalActivity[] }>;
  list: () => Promise<{ terminals: LiveTerminal[] }>;
  /**
   * BECOME THE READER OF A RUN'S TERMINAL (#890) — an id this renderer did not
   * open, and the only kind it may ask for: the host refuses anything that is
   * not one of the engine's. `ok: false` means that terminal is not (or is no
   * longer) there, which is the ordinary answer for a run that just ended.
   *
   * OPTIONAL BECAUSE THE SHELL MAY PREDATE IT. A cockpit running against an
   * older preload has no `adopt`, and the run chip falls back to the same poll
   * a remote host uses rather than drawing nothing.
   */
  adopt?: (id: string) => Promise<{ ok: boolean }>;
  /** Stop reading it. Does NOT stop the run: the engine owns the process. */
  abandon?: (id: string) => Promise<{ ok: boolean }>;
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
 * The params key a terminal tab carries its PTY's id in.
 *
 * RE-EXPORTED, NOT DECLARED HERE ANY MORE. It moved to `terminal-workspace.ts`
 * when a Terminal grew a strip of shells, because the tab's reaper
 * (`lib/terminal-close.ts`) reads the whole list from that module and the
 * dependency has to point one way.
 * Every existing importer keeps the name it had.
 */
export { TERMINAL_ID_PARAM } from "@/lib/terminal-workspace";

/**
 * WHETHER A `failed` ENDING IS THE HOST REFUSING AN UNENTERABLE CWD (#851),
 * rather than some other reason `pty.fork` itself threw (a missing shell
 * binary, a rejected env, ...).
 *
 * DETECTED FROM THE SENTENCE'S OWN SHAPE, because there is no dedicated field
 * for it: the host's `unusableCwd` (apps/desktop/terminal-host.js) writes one
 * of two fixed openings for every way a cwd can be unusable, and a fork
 * failure's own message never starts that way — it comes from node-pty, not
 * from this sentence.
 */
export function isUnenterableCwd(ending: TerminalEnding): boolean {
  if (ending.fate !== "failed" || !ending.error) return false;
  return ending.error.startsWith("Telar cannot start a terminal in") || ending.error.startsWith("Telar was asked to start a terminal in");
}

/** WHAT A PERSON READS WHEN A TERMINAL ENDS: an observed exit with its status,
 *  or a shell that never started and why. */
export function describeTerminalEnding(ending: TerminalEnding): string {
  if (ending.fate === "failed") return `This shell never started${ending.error ? `: ${ending.error}` : "."}`;
  // Closed by the host on purpose — the SIGTERM that did it is not news.
  if (ending.closed) return "Shell closed.";
  if (ending.signal) return `Shell ended on ${ending.signal}.`;
  if (ending.exitCode === undefined) return "Shell ended.";
  return ending.exitCode === 0 ? "Shell exited." : `Shell exited with status ${ending.exitCode}.`;
}
