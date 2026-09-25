/**
 * THE ENGINE'S RECORD OF THE TERMINALS IT OPENED — "Run = a new terminal".
 *
 * THIS FILE USED TO ENFORCE ONE LOCAL DEPLOYMENT PER PROJECT, AND DOES NOT ANY
 * MORE. A `reserve()` held a project-wide slot before every spawn; a second
 * launch was a `conflict`; `replace` was the deliberate takeover; and a run
 * Telar could not vouch for went `unknown`, kept the slot, refused `stop`, and
 * could only be cleared by a person pressing "release" — which signalled
 * nothing. In practice every path ended there: a quit, a restart, a missed
 * heartbeat, a kill nobody saw land. The dev server kept running, nothing in
 * Telar could reach it, and the next Run was blocked until somebody released
 * a ghost.
 *
 * NOW A RUN IS A TERMINAL, AND THE TERMINAL IS THE SESSION'S. Each start opens
 * a new one in the session's panel — "web dev", then "web dev #2" — and none
 * of them blocks another. A busy port only warns (`warning`), because a second
 * instance is often what somebody asked for and whether it collides is theirs
 * to see. There is no slot, so there is no replace, no transition and nothing
 * to release.
 *
 * NO LIVENESS TRACKING. Telar does not poll a pid or ask the kernel about a
 * process group. The terminal owns its process; the engine records what the
 * host tells it — output bytes, an exit with its code, a close — and nothing
 * else. Closing a terminal is the host's `/close`, which ends the whole tree
 * (hangup, SIGTERM, SIGKILL a second later), and WHO closed it is recorded so
 * a later turn can tell an agent "the person closed it" instead of letting it
 * reopen what somebody deliberately ended.
 *
 * A RESTARTED ENGINE INVENTS NOTHING. The desktop host keeps its terminals
 * across an engine restart, so `recover()` asks it once which it still holds
 * and re-lists the ones this engine opened (`journal.ts` remembers which, and
 * which configuration redacts them). Anything the host no longer holds has
 * ended and is forgotten: no orphan, no `unknown`, nothing held.
 *
 * WE SIGNAL ONLY THROUGH A HANDLE. `launcher.ts` hands back a `RunHandle` that
 * knows how to close what it started; nothing here ever receives a pid it
 * could aim at by itself. Over the wire the handle is a terminal id, which the
 * host honours only while it still holds what the id names.
 */
import fs from "node:fs";
import path from "node:path";
import { nullRunJournal, type RunJournal, type RunRecord } from "./journal";
import { pipeLauncher, type RunHandle, type RunLaunchEvents, type RunLauncher } from "./launcher";
import { processGroupFor, type RunKill, type RunProcessGroup } from "./platform";
import { createPtyRedactor, safeCutBack } from "./pty-stream";
import { resolveShell } from "./shell";
import { createOutputSplitter } from "./stream";
import type { TerminalFacts } from "./terminal-client";
import {
  isTerminal,
  type RunClosedBy,
  type RunConfiguration,
  RunError,
  type RunOrigin,
  type RunOutputLine,
  type RunProbe,
  type RunReadiness,
  type RunStatus,
  type RunView,
  redactText,
  secretValues,
  unhideableSecrets,
} from "./types";

const MAX_LINES = 2000;
const MAX_LINE_CHARS = 4000;
/**
 * THE REDACTED BYTE RING, WHICH IS WHAT A TERMINAL READS (#198).
 *
 * `lines` is a DEGRADED VIEW of a PTY's output: a terminal's output is not a
 * list of lines, and a surface that draws it properly needs the bytes, escape
 * sequences included. So a terminal keeps both — `/run/output` is what an
 * agent reads, `/run/bytes` what an emulator draws.
 *
 * KEPT AS CHUNKS RATHER THAN ONE STRING, and the reason is escape integrity.
 * Every chunk here comes out of `createPtyRedactor`, whose contract is that it
 * never emits a partial sequence, so dropping whole chunks cannot desync a
 * reader. BOUNDED TWICE, because either bound alone has a writer that defeats
 * it.
 */
const MAX_BYTE_CHUNKS = 4000;
const MAX_BYTE_CHARS = 256_000;
/**
 * How long a closed terminal's exit gets to be reported after the close itself
 * finished. The host (or the pipe launcher) has already run its whole
 * SIGTERM-then-SIGKILL escalation by then, so an exit that still has not
 * arrived is a report in flight, not a process that might live — and past this
 * the terminal is recorded `closed` anyway rather than waiting for a frame.
 */
const CLOSE_SETTLE_MS = 2000;
const READY_POLL_MS = 500;
/** Finished terminals kept per session — output after exit is most of the value. */
const KEEP_FINISHED = 10;
/**
 * How often `wait` re-reads state THIS PROCESS ALREADY HOLDS. Engine-local:
 * nothing about this tick crosses a wire.
 */
const WAIT_TICK_MS = 50;

/**
 * How much of a terminal's output a reader wants, and which of it.
 *
 * NONE OF THESE MOVE THE CURSOR. `after` is the cursor; these narrow what comes
 * back within the window it opened.
 */
export type RunOutputFilter = {
  /** Only the last N lines of the window, after the filters below. */
  tail?: number;
  /** A regular expression; only matching lines come back. */
  grep?: string;
  /** Only one of the two streams. A PTY terminal has only `stdout`. */
  stream?: "stdout" | "stderr";
};

/** What `run_wait` answers: WHICH condition fired, a cursor to resume from, and
 *  the lines that arrived while waiting — not the whole scrollback. */
export type RunWaitOutcome = { fired: "pattern" | "ready" | "exit" | "timeout"; cursor: number; lines: RunOutputLine[] };

/** A caller's regular expression, refused in words rather than thrown raw. */
function compile(source: string, field: string): RegExp {
  try {
    return new RegExp(source);
  } catch (error) {
    throw new RunError("invalid_request", `${field} is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export type StartRunInput = {
  projectId: string;
  /** The session whose panel the terminal opens in. It owns the terminal. */
  sessionId: string;
  config: RunConfiguration;
  /** Absolute path of the tree this launch uses. Captured, never inferred. */
  worktreePath: string;
  worktreeBranch?: string;
  /** `run` for a saved configuration (the default), `agent` for a command an
   *  agent opened so the person can watch it. */
  origin?: RunOrigin;
  /** Who asked for it. An agent's terminal is one whose close by the person
   *  the agent is told about. Default: the person. */
  openedBy?: "person" | "agent";
  /**
   * READY WHEN A LINE MATCHES, for a terminal with no URL to ask — an agent's
   * `terminal_open({ready: "Listening on"})`. Checked against every captured
   * line; the first match makes it `ready`.
   */
  readyPattern?: string;
};

type LiveRun = {
  /** Empty until the launcher names the terminal; see `start`. */
  terminalId: string;
  projectId: string;
  sessionId: string;
  origin: RunOrigin;
  /** The name before any `#n`; instances are numbered per session. */
  baseTitle: string;
  instance: number;
  config: RunConfiguration;
  configName: string;
  command: string;
  worktreePath: string;
  worktreeBranch?: string;
  cwd: string;
  status: RunStatus;
  readiness: RunReadiness;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  signal?: string;
  error?: string;
  warning?: string;
  closedBy?: RunClosedBy;
  /** Who asked for the close in flight, applied when the exit arrives. */
  closing?: RunClosedBy;
  /**
   * THE AGENT HAS A STAKE IN THIS TERMINAL: it opened it, or it waited on it.
   * The person closing one of these is the one close an agent is told about
   * on its next turn — see `RunManagerOptions.personClosed`.
   */
  agentWatching: boolean;
  readyPattern?: RegExp;
  closeTask?: Promise<void>;
  /** Whatever is holding this terminal's process. NEVER A BARE PID. */
  handle?: RunHandle;
  /**
   * RE-LISTED AFTER A RESTART WITHOUT ITS CONFIGURATION, so without its
   * secrets. Its output is not captured: printing it unredacted into the
   * cockpit would break the one promise `secret` makes.
   */
  blind: boolean;
  lines: RunOutputLine[];
  dropped: number;
  bytes: string[];
  byteChars: number;
  bytesDropped: number;
  secrets: string[];
  readyTimer?: ReturnType<typeof setInterval>;
  waiters: Array<() => void>;
};

export type RunManagerOptions = {
  now?: () => number;
  /** Injected so tests can decide what a URL answers without binding a port. */
  probe?: RunProbe;
  /** Injected so a test can make a signal fail. POSIX only. */
  kill?: RunKill;
  /** Which operating system's rules the pipe fallback follows. */
  platform?: NodeJS.Platform;
  /** The whole group strategy, when a test wants one neither platform ships. */
  processGroup?: RunProcessGroup;
  /**
   * HOW A RUN GETS A TERMINAL. Defaults to the pipe fallback — what the engine
   * has under `bun run src/main.ts`, where there is no Electron. The desktop
   * daemon hands in `terminalLauncher` instead — see `launcher.ts`.
   */
  launcher?: RunLauncher;
  /** Which terminals to re-list after a restart. Omit for a manager that forgets. */
  journal?: RunJournal;
  /** The pipe fallback's SIGTERM-to-SIGKILL grace. */
  stopGraceMs?: number;
  /** How long a finished close waits for its exit report. */
  closeSettleMs?: number;
  readyPollMs?: number;
  /**
   * Told when the PERSON closes a terminal the agent opened or waited on, once.
   * The daemon turns it into a note on the session's next turn.
   */
  personClosed?: (run: RunView) => void;
};

const defaultProbe: RunProbe = async (url) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500), redirect: "manual" });
    // ANSWERED and SERVING are different questions. A 500 proves the port is
    // taken — enough to warn about — but it is the state a person is waiting
    // to get out of, so it must not turn a terminal green.
    return { answered: true, serving: response.status < 500 };
  } catch {
    return { answered: false, serving: false };
  }
};

/**
 * The port a readiness URL names, for a sentence a person reads. An explicit
 * port when there is one, the scheme's default otherwise.
 */
function portOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  } catch {
    return url;
  }
}

/**
 * ONE FRAME OF "A TERMINAL CHANGED", AND THE FULL VIEW IS ON IT DELIBERATELY.
 *
 * A terminal's state lives in this process's memory and the only read of it is
 * `/run/status`, which is the poll this event exists to delete. So the frame IS
 * the answer — the same `RunView` `/run/status` lists — and a reader that
 * missed one is corrected by the next rather than having to reconcile.
 *
 * THERE IS NO `active` ON IT ANY MORE. It said which run held the project's
 * deployment slot, and there is no slot.
 */
export type RunStatusEvent = {
  type: "run.status";
  projectId: string;
  sessionId: string;
  run: RunView;
};

export class RunManager {
  /** terminalId → record. Registered once the launcher names the terminal. */
  private readonly runs = new Map<string, LiveRun>();
  /** Starts whose terminal has not been named yet; they count for numbering. */
  private readonly opening = new Set<LiveRun>();
  private readonly watchers = new Set<(event: RunStatusEvent) => void>();
  /** Launches in flight. `shutdown` drains these before it claims to be done. */
  private readonly pending = new Set<Promise<unknown>>();
  /** Set by `shutdown`: nothing new may be opened from here on. */
  private shuttingDown = false;
  private readonly now: () => number;
  private readonly probe: RunProbe;
  private readonly platform: NodeJS.Platform;
  private readonly launcher: RunLauncher;
  private readonly journal: RunJournal;
  private readonly closeSettleMs: number;
  private readonly readyPollMs: number;
  private readonly personClosed: ((run: RunView) => void) | undefined;

  constructor(options: RunManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.probe = options.probe ?? defaultProbe;
    const kill: RunKill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
    this.platform = options.platform ?? process.platform;
    const group = options.processGroup ?? processGroupFor(this.platform, kill);
    this.launcher = options.launcher ?? pipeLauncher(group, { ...(options.stopGraceMs === undefined ? {} : { graceMs: options.stopGraceMs }) });
    this.journal = options.journal ?? nullRunJournal;
    this.closeSettleMs = options.closeSettleMs ?? CLOSE_SETTLE_MS;
    this.readyPollMs = options.readyPollMs ?? READY_POLL_MS;
    this.personClosed = options.personClosed;
  }

  /**
   * RE-LIST THE TERMINALS A PREVIOUS ENGINE OPENED, IF THE HOST STILL HAS THEM.
   *
   * One question to the host (`GET /state`), answered against the journal: a
   * terminal in both is picked back up — running, its output followed from
   * here on, redacted with its configuration's CURRENT secrets — and anything
   * in the journal the host does not hold is dropped without a word. It ended;
   * the host is the only one who could have ended it.
   *
   * NOTHING HERE CAN BLOCK A LAUNCH. A host that cannot be reached leaves the
   * journal alone for the next engine and re-lists nothing; the pipe fallback
   * has no host and re-lists nothing either, because a previous engine's child
   * is nobody's to pick up.
   *
   * `configFor` resolves a record's configuration from the store. A record
   * whose configuration has since been deleted is re-listed BLIND — no output
   * captured — rather than mirrored without the secrets it may carry.
   */
  async recover(options: { configFor?: (projectId: string, configId: string) => RunConfiguration | undefined } = {}): Promise<RunView[]> {
    const records = this.journal.list();
    if (records.length === 0) return [];
    if (!this.launcher.held || !this.launcher.adopt) {
      this.forgetJournal([]);
      return [];
    }
    let held: TerminalFacts[];
    try {
      held = await this.launcher.held();
    } catch {
      return [];
    }
    const recovered: RunView[] = [];
    const kept: RunRecord[] = [];
    for (const record of records) {
      const facts = held.find((terminal) => terminal.id === record.terminalId);
      if (!facts || this.runs.has(record.terminalId)) continue;
      const stored = record.configId ? options.configFor?.(record.projectId, record.configId) : undefined;
      const run = this.relisted(record, stored);
      try {
        run.handle = await this.launcher.adopt(facts, this.events(run));
      } catch {
        continue;
      }
      this.register(run);
      if (run.blind) {
        this.log(
          run,
          "stderr",
          "Telar restarted, and the run configuration this terminal came from has since been deleted, so its output is not shown here: it could contain values that configuration marked secret. The terminal itself is still running and can be closed.",
        );
      }
      if (run.readiness.kind === "pending") this.pollReadiness(run);
      kept.push(record);
      recovered.push(this.view(run));
    }
    this.forgetJournal(kept);
    return recovered;
  }

  private relisted(record: RunRecord, stored: RunConfiguration | undefined): LiveRun {
    // THE RECORD'S COMMAND AND CWD, NOT THE RECIPE'S. The recipe may have been
    // edited since; what is running is what the record says was launched.
    const config: RunConfiguration = stored ?? {
      id: record.configId ?? "",
      projectId: record.projectId,
      name: record.configName,
      command: record.command,
      ...(record.readinessUrl ? { readinessUrl: record.readinessUrl } : {}),
      createdAt: record.startedAt,
      updatedAt: record.startedAt,
    };
    const { base, instance } = splitTitle(record.title);
    return {
      ...this.blank(),
      terminalId: record.terminalId,
      projectId: record.projectId,
      sessionId: record.sessionId,
      origin: record.origin,
      baseTitle: base,
      instance,
      config,
      configName: record.configName,
      command: record.command,
      worktreePath: record.worktreePath,
      ...(record.worktreeBranch ? { worktreeBranch: record.worktreeBranch } : {}),
      cwd: record.cwd,
      startedAt: record.startedAt,
      // A readiness baseline taken by a previous engine is not ours to trust:
      // "silent before the launch" is a claim about a moment this process
      // never saw, so a re-listed terminal starts over as merely pending.
      readiness: config.readinessUrl ? { kind: "pending" } : { kind: "none" },
      blind: record.configId !== undefined && stored === undefined,
      secrets: stored ? secretValues(stored) : [],
    };
  }

  // ── watching ─────────────────────────────────────────────────────────────

  /**
   * Be told when any terminal's state changes. Answers the unsubscribe.
   *
   * NOT FILTERED HERE. A watcher is a transport — the daemon's SSE route — and
   * which sessions one connection may see is that route's knowledge.
   *
   * A LISTENER THAT THROWS DOES NOT STOP THE OTHERS, and does not take down the
   * transition that emitted the frame: `announce` is called from exit handlers
   * reached through `void`, where a rejection ends the daemon.
   */
  watch(listener: (event: RunStatusEvent) => void): () => void {
    this.watchers.add(listener);
    return () => {
      this.watchers.delete(listener);
    };
  }

  private announce(run: LiveRun): void {
    if (this.watchers.size === 0 || !this.runs.has(run.terminalId)) return;
    const event: RunStatusEvent = { type: "run.status", projectId: run.projectId, sessionId: run.sessionId, run: this.view(run) };
    for (const watcher of this.watchers) {
      try {
        watcher(event);
      } catch {
        // A broken reader is that reader's problem, not this terminal's.
      }
    }
  }

  // ── reading ──────────────────────────────────────────────────────────────

  /** One session's terminals, newest first — open ones and recently ended. */
  terminals(sessionId: string): RunView[] {
    return [...this.runs.values()]
      .filter((run) => run.sessionId === sessionId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((run) => this.view(run));
  }

  run(terminalId: string): RunView {
    return this.view(this.require(terminalId));
  }

  /**
   * Captured output from `after`, with a cursor to resume from. The ring drops
   * from the front under load, and `dropped` is reported rather than hidden.
   */
  output(terminalId: string, after = 0, filter: RunOutputFilter = {}): { lines: RunOutputLine[]; cursor: number; dropped: number } {
    const run = this.require(terminalId);
    const start = Math.max(0, after - run.dropped);
    let lines = run.lines.slice(start);
    if (filter.stream) lines = lines.filter((line) => line.stream === filter.stream);
    if (filter.grep !== undefined) {
      const pattern = compile(filter.grep, "grep");
      lines = lines.filter((line) => pattern.test(line.text));
    }
    // TAIL LAST, AND THE CURSOR IS NOT TAKEN FROM IT. `tail` narrows what is
    // SHOWN; the cursor still advances over everything in the window.
    if (filter.tail !== undefined && lines.length > filter.tail) lines = lines.slice(lines.length - filter.tail);
    return { lines, cursor: run.dropped + run.lines.length, dropped: run.dropped };
  }

  /**
   * BLOCK UNTIL SOMETHING HAPPENS — the tool that replaces `sleep 2 && curl`.
   *
   * FOUR CONDITIONS, AND THE ANSWER SAYS WHICH ONE FIRED, because "it came
   * back" is not the same fact as "the server is up". CHECKED BEFORE THE FIRST
   * SLEEP, so a terminal already ready or already ended answers at once.
   * `ready` ON A RECIPE WITH NO READINESS URL IS REFUSED rather than waited
   * out, since nothing could ever make it fire.
   */
  async wait(terminalId: string, options: { pattern?: string; ready?: boolean; exit?: boolean; timeoutMs: number }): Promise<RunWaitOutcome> {
    const run = this.require(terminalId);
    const pattern = options.pattern === undefined ? undefined : compile(options.pattern, "pattern");
    run.agentWatching = true;
    if (options.ready && !run.config.readinessUrl && !run.readyPattern) {
      throw new RunError(
        "invalid_request",
        `"${redactText(run.configName, run.secrets)}" has no readiness URL, so waiting for it to be ready could only ever time out. Wait for a pattern in its output instead, or give the configuration a readinessUrl.`,
      );
    }
    const from = run.dropped + run.lines.length;
    const since = () => this.output(terminalId, from).lines;
    const answer = (fired: RunWaitOutcome["fired"], lines: RunOutputLine[]): RunWaitOutcome => ({ fired, cursor: from + lines.length, lines });
    // WALL CLOCK, NOT THE INJECTED ONE: `this.now` stamps lines and a test is
    // entitled to freeze it; a frozen deadline against a real timer never ends.
    const deadline = Date.now() + options.timeoutMs;

    for (;;) {
      const seen = since();
      if (options.ready && run.readiness.kind === "ready") return answer("ready", seen);
      if (options.exit && isTerminal(run.status)) return answer("exit", seen);
      if (pattern && seen.some((line) => pattern.test(line.text))) return answer("pattern", seen);
      // AN ENDED TERMINAL PRINTS NOTHING MORE AND NEVER BECOMES READY, so a
      // wait for either is over. Said as `exit`, which is the fact — most of
      // all when the person closed it while the agent was waiting.
      if (isTerminal(run.status)) return answer("exit", seen);
      const left = deadline - Date.now();
      if (left <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(WAIT_TICK_MS, left)));
    }
    return answer("timeout", since());
  }

  /**
   * The same window, in the shape a terminal can draw: redacted BYTES. Same
   * cursor contract as `output` — a cursor that goes BACKWARDS means a
   * different terminal, not lost output.
   */
  bytes(terminalId: string, after = 0): { chunks: string[]; cursor: number; dropped: number } {
    const run = this.require(terminalId);
    const start = Math.max(0, after - run.bytesDropped);
    return { chunks: run.bytes.slice(start), cursor: run.bytesDropped + run.bytes.length, dropped: run.bytesDropped };
  }

  // ── opening ──────────────────────────────────────────────────────────────

  /**
   * OPEN A NEW TERMINAL FROM A CONFIGURATION. Never a conflict with another
   * terminal: two presses are two terminals, numbered in the session.
   *
   * THE TITLE IS TAKEN BEFORE THE FIRST `await`, so two starts in the same tick
   * cannot both be "web dev" — the second sees the first in `opening`.
   */
  async start(input: StartRunInput): Promise<RunView> {
    if (this.shuttingDown) {
      throw new RunError("conflict", "Telar is shutting down and will not open a new terminal");
    }
    // A value the person was told is hidden must never reach a log. The store
    // refuses these at save time; a configuration that arrived another way is
    // refused here rather than launched with a promise we cannot keep.
    const exposed = unhideableSecrets(input.config);
    if (exposed.length) {
      throw new RunError(
        "invalid_request",
        `${exposed.join(", ")} ${exposed.length === 1 ? "is" : "are"} marked secret but too short or spread over lines to be removed from captured output; change the value or unmark it rather than have Telar print it`,
      );
    }
    const cwd = this.resolveCwd(input);
    const run: LiveRun = {
      ...this.blank(),
      projectId: input.projectId,
      sessionId: input.sessionId,
      origin: input.origin ?? "run",
      baseTitle: input.config.name,
      instance: 0,
      config: input.config,
      configName: input.config.name,
      command: input.config.command,
      worktreePath: input.worktreePath,
      ...(input.worktreeBranch ? { worktreeBranch: input.worktreeBranch } : {}),
      cwd,
      startedAt: this.now(),
      secrets: secretValues(input.config),
      agentWatching: input.openedBy === "agent",
      ...(input.readyPattern === undefined ? {} : { readyPattern: compile(input.readyPattern, "ready") }),
    };
    run.instance = this.nextInstance(run.sessionId, run.baseTitle);
    this.opening.add(run);
    // Registered BEFORE it is awaited, so a shutdown that arrives mid-baseline
    // has something to wait for rather than racing past it.
    const work = this.open(run);
    this.pending.add(work);
    try {
      await work;
    } finally {
      this.pending.delete(work);
      this.opening.delete(run);
    }
    return this.view(run);
  }

  /**
   * CLOSE, THEN OPEN THE SAME RECIPE ON THE SAME TREE — a NEW terminal with a
   * new id, since there is no slot to hold across the gap and nothing else to
   * keep out of it.
   */
  async restart(terminalId: string, by: RunClosedBy = "person"): Promise<RunView> {
    const run = this.require(terminalId);
    if (!isTerminal(run.status)) await this.close(terminalId, by);
    return await this.start({
      projectId: run.projectId,
      sessionId: run.sessionId,
      config: run.config,
      worktreePath: run.worktreePath,
      ...(run.worktreeBranch ? { worktreeBranch: run.worktreeBranch } : {}),
      origin: run.origin,
      ...(run.agentWatching ? { openedBy: "agent" as const } : {}),
      ...(run.readyPattern ? { readyPattern: run.readyPattern.source } : {}),
    });
  }

  private async open(run: LiveRun): Promise<void> {
    /**
     * A BUSY PORT WARNS AND NEVER BLOCKS. The baseline is still taken BEFORE
     * the launch, because it is the only moment "something already answers"
     * can be told apart from "this terminal is answering" — so a terminal whose
     * URL was already answering can never claim `ready` (`unattributable`),
     * and says why on `warning`. It is still opened: a second instance of a
     * dev server is often exactly what somebody pressed Run for.
     */
    if (run.config.readinessUrl) {
      const baseline = await this.probe(run.config.readinessUrl);
      if (baseline.answered) {
        const port = portOf(run.config.readinessUrl);
        run.warning = redactText(
          `port ${port} already answers, so something else may be serving ${run.config.readinessUrl}; this terminal was opened anyway`,
          run.secrets,
        );
        run.readiness = {
          kind: "unattributable",
          reason: redactText(`${run.config.readinessUrl} was already answering before this terminal opened, so a response from it cannot be attributed to this process`, run.secrets),
        };
      } else {
        run.readiness = { kind: "pending" };
      }
    } else if (run.readyPattern) {
      run.readiness = { kind: "pending" };
    }
    // The baseline is a network round trip, and the daemon may have been told
    // to go down during it. Opening now would leave a process nobody is left
    // to follow.
    if (this.shuttingDown) throw new RunError("conflict", "Telar is shutting down, so it did not open this terminal");

    // `NodeJS.ProcessEnv`, not a plain record: a project that augments
    // ProcessEnv with required keys (Next does) rejects the narrowed type.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const entry of run.config.env ?? []) env[entry.key] = entry.value;
    /**
     * `shell: false`, AND THE SHELL IS SPELLED OUT INSTEAD. A saved recipe
     * still means what it reads like — `bun run dev`, `a && b` — because a
     * shell still evaluates it; which shell, and where the command sits in its
     * argv, is a value this process computed (`resolveShell`).
     */
    const launch = resolveShell(run.config, this.platform, process.env);
    let handle: RunHandle;
    try {
      handle = await this.launcher.launch(
        {
          file: launch.file,
          args: launch.args,
          cwd: run.cwd,
          env,
          windowsVerbatimArguments: launch.windowsVerbatimArguments,
          sessionId: run.sessionId,
          origin: run.origin,
          title: this.title(run),
        },
        this.events(run),
      );
    } catch (error) {
      // The host could not be asked at all. Nothing was opened, so there is no
      // terminal to record — only a refusal to hand back.
      throw new RunError("conflict", redactText(`Telar could not open a terminal for "${run.configName}": ${error instanceof Error ? error.message : String(error)}`, run.secrets));
    }
    run.handle = handle;
    this.register(run);
    this.prune(run.sessionId);
    // A launcher may already have settled the terminal inside `launch` — a
    // spawn the host refused arrives in the same answer. That verdict stands.
    if (isTerminal(run.status)) {
      this.announce(run);
      return;
    }
    // A pipe spawn that could not even get a pid has no process to follow; its
    // `error` event is on the way, but the record is failed now either way.
    if (handle.pid === undefined && this.launcher.kind === "pipes") {
      this.finish(run, "failed", { error: "the process could not be started (no pid)" });
      return;
    }
    this.announce(run);
    if (run.readiness.kind === "pending" && run.config.readinessUrl) this.pollReadiness(run);
    // THE NAME TAG, for a future engine re-listing this terminal. It is not
    // load-bearing — a failure costs the re-listing, not the terminal — and it
    // is only written where a host exists to keep the terminal across a
    // restart.
    if (this.launcher.held) {
      try {
        this.journal.open(this.record(run));
      } catch {
        /* see above: the terminal is fine without it */
      }
    }
  }

  /**
   * WHAT A LAUNCHER'S REPORTS MEAN FOR THE RECORD — the same for a fresh
   * launch and a re-listed terminal.
   */
  private events(run: LiveRun): RunLaunchEvents {
    return {
      output: this.capture(run),
      failed: (reason) => {
        if (isTerminal(run.status)) return;
        this.finish(run, "failed", { error: reason });
      },
      exited: (detail) => {
        if (isTerminal(run.status)) return;
        /**
         * CLOSED, OR ENDED BY ITSELF — and the difference is who asked. A close
         * this engine started carries its caller; a close the host started on
         * its own (Telar quitting, a whole session closed) is Telar's. A
         * process that simply ended — `exit` at the prompt, a crash, a build
         * that finished — keeps `exited`/`failed` and its code.
         */
        // A single close the engine did not ask for came from the cockpit's own
        // tab or chip, which is the person; a session or quit close is Telar's.
        const by = run.closing ?? (detail.closed === "close" ? "person" : detail.closed ? "telar" : undefined);
        const code = { ...(detail.exitCode === undefined ? {} : { exitCode: detail.exitCode }), ...(detail.signal ? { signal: detail.signal } : {}) };
        if (by) this.finish(run, "closed", { ...code, closedBy: by });
        else this.finish(run, detail.exitCode === 0 || detail.exitCode === undefined ? "exited" : "failed", code);
      },
      gone: (reason) => {
        if (isTerminal(run.status)) return;
        this.finish(run, "closed", { closedBy: run.closing ?? "telar", error: reason });
      },
    };
  }

  /**
   * The lowest instance number no OPEN terminal of this name in this session is
   * using: "web dev", then "web dev #2"; close the first and the next press is
   * "web dev" again. Ended terminals do not hold a number.
   */
  private nextInstance(sessionId: string, baseTitle: string): number {
    const used = new Set<number>();
    for (const run of [...this.runs.values(), ...this.opening]) {
      if (run.sessionId === sessionId && run.baseTitle === baseTitle && !isTerminal(run.status) && run.instance > 0) used.add(run.instance);
    }
    let instance = 1;
    while (used.has(instance)) instance += 1;
    return instance;
  }

  private title(run: LiveRun): string {
    return run.instance > 1 ? `${run.baseTitle} #${run.instance}` : run.baseTitle;
  }

  /** The terminal has a name now, so it can be addressed and announced. */
  private register(run: LiveRun): void {
    run.terminalId = run.handle?.terminalId ?? run.terminalId;
    this.runs.set(run.terminalId, run);
  }

  private resolveCwd(input: StartRunInput): string {
    if (!path.isAbsolute(input.worktreePath)) {
      throw new RunError("invalid_request", "a run needs the absolute path of the worktree it launches from");
    }
    const root = path.resolve(input.worktreePath);
    const cwd = path.resolve(root, input.config.cwd ?? ".");
    if (cwd !== root && !cwd.startsWith(`${root}${path.sep}`)) {
      throw new RunError("invalid_request", `the working directory "${input.config.cwd}" resolves outside the worktree`);
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(cwd);
    } catch {
      throw new RunError("invalid_request", `there is no directory "${input.config.cwd ?? "."}" in ${root}`);
    }
    if (!stat.isDirectory()) throw new RunError("invalid_request", `"${input.config.cwd}" is not a directory`);

    // LEXICAL CONTAINMENT IS NOT CONTAINMENT. `apps/web` passes the check above
    // while being a symlink to somewhere else entirely. Ask the filesystem.
    let realRoot: string;
    let realCwd: string;
    try {
      realRoot = fs.realpathSync(root);
      realCwd = fs.realpathSync(cwd);
    } catch {
      throw new RunError("invalid_request", `the working directory "${input.config.cwd ?? "."}" could not be resolved inside ${root}`);
    }
    if (realCwd !== realRoot && !realCwd.startsWith(`${realRoot}${path.sep}`)) {
      throw new RunError("invalid_request", `the working directory "${input.config.cwd}" is a link out of the worktree: it really points at ${realCwd}`);
    }
    // The lexical path is what gets spawned in — it is what the person wrote.
    return cwd;
  }

  /**
   * The name tag — WRITTEN ALREADY REDACTED. A re-listed terminal whose
   * configuration is gone has no secret list to scrub with, so anything stored
   * raw here would be handed back verbatim after a restart.
   */
  private record(run: LiveRun): RunRecord {
    const hide = (text: string) => redactText(text, run.secrets);
    return {
      terminalId: run.terminalId,
      projectId: run.projectId,
      sessionId: run.sessionId,
      origin: run.origin,
      title: hide(this.title(run)),
      ...(run.config.id ? { configId: run.config.id } : {}),
      configName: hide(run.configName),
      command: hide(run.command),
      worktreePath: hide(run.worktreePath),
      ...(run.worktreeBranch ? { worktreeBranch: hide(run.worktreeBranch) } : {}),
      cwd: hide(run.cwd),
      ...(run.config.readinessUrl ? { readinessUrl: hide(run.config.readinessUrl) } : {}),
      startedAt: run.startedAt,
    };
  }

  /** Forget a name tag. NEVER THROWS: called from exit handlers reached through
   *  `void`, where a rejection would take the daemon down. */
  private closeRecord(run: LiveRun): void {
    try {
      this.journal.close(run.terminalId);
    } catch {
      /* a stale tag is dropped by the next re-listing */
    }
  }

  private forgetJournal(kept: RunRecord[]): void {
    try {
      this.journal.replace(kept);
    } catch {
      /* the next re-listing drops what this could not */
    }
  }

  /**
   * Capture what the launcher gives us, WITHOUT trusting the process to send
   * newlines — and with a different redactor per shape.
   *
   * PIPES keep the line discipline and the line redactor (`stream.ts`); its
   * correctness rests on `types.ts` refusing a secret with a line break in it.
   *
   * A PTY has neither a reliable newline nor escape-free bytes, so
   * `pty-stream.ts` redacts them instead — never cutting inside a sequence, and
   * replacing a secret with mask cells of the same width so cursor-positioned
   * output keeps its columns. The lines kept here are a DEGRADED VIEW of that
   * stream; the surface that shows it properly reads the bytes.
   *
   * EITHER WAY THE CARRY IS KEPT RAW and only released once no later byte could
   * change how it is scrubbed. AND A PTY MERGES THE TWO STREAMS, so every line
   * from one is recorded as `stdout`.
   */
  private capture(run: LiveRun): (stream: "stdout" | "stderr", chunk: string) => void {
    if (this.launcher.kind === "pipes") {
      const splitters = new Map<string, ReturnType<typeof createOutputSplitter>>();
      return (stream, chunk) => {
        let splitter = splitters.get(stream);
        if (!splitter) {
          splitter = createOutputSplitter(run.secrets, MAX_LINE_CHARS, (text) => {
            // With no Electron there is no PTY, so what a terminal gets is the
            // redacted lines put back together — `\r\n` because an emulator
            // needs the carriage return to get its column back.
            this.keep(run, `${this.log(run, stream, text)}\r\n`);
          });
          splitters.set(stream, splitter);
        }
        splitter.push(chunk);
      };
    }
    // The PTY path: redact the bytes first, then cut the already-safe text into
    // lines. Nothing is redacted twice and the line cut is escape-aware.
    let carry = "";
    const emitLine = (text: string) => this.log(run, "stdout", text);
    const redactor = createPtyRedactor(run.secrets, (text) => {
      // THE BYTES AS THE REDACTOR EMITTED THEM — fed from its OUTPUT, never its
      // input: this is the one place a terminal's secrets could reach a
      // surface unmasked, and #819 is what stops that.
      const cursor = this.keep(run, text);
      // AND STRAIGHT BACK TO THE HOST, so the cockpit's strip draws this slice
      // rather than the raw one the desktop fans (#890).
      run.handle?.mirror?.(text, cursor);
      carry += text;
      for (let at = carry.indexOf("\n"); at !== -1; at = carry.indexOf("\n")) {
        emitLine(carry.slice(0, at));
        carry = carry.slice(at + 1);
      }
      while (carry.length > MAX_LINE_CHARS) {
        const cut = safeCutBack(carry, [], MAX_LINE_CHARS);
        if (cut <= 0) break;
        emitLine(carry.slice(0, cut));
        carry = carry.slice(cut);
      }
    });
    return (_stream, chunk) => {
      // A BLIND terminal keeps nothing: see `LiveRun.blind`.
      if (!run.blind) redactor.push(chunk);
    };
  }

  /** Answers the redacted line it kept, so the byte ring can hold the same
   *  text rather than a second scrub of the same input. */
  private log(run: LiveRun, stream: "stdout" | "stderr", text: string): string {
    const clean = redactText(text.replace(/\r$/, ""), run.secrets).slice(0, MAX_LINE_CHARS);
    run.lines.push({ at: this.now(), stream, text: clean });
    if (run.readyPattern && run.readiness.kind === "pending" && !isTerminal(run.status) && run.readyPattern.test(clean)) {
      run.readiness = { kind: "ready", at: this.now() };
      if (run.status === "running") run.status = "ready";
      this.announce(run);
    }
    if (run.lines.length > MAX_LINES) {
      run.dropped += run.lines.length - MAX_LINES;
      run.lines.splice(0, run.lines.length - MAX_LINES);
    }
    return clean;
  }

  /**
   * One already-redacted slice into the byte ring, dropping WHOLE chunks from
   * the front so a cut can never land inside an escape sequence. Answers the
   * cursor a reader holds once it has this chunk — the same number `bytes()`
   * would hand back.
   */
  private keep(run: LiveRun, text: string): number {
    if (!text) return run.bytesDropped + run.bytes.length;
    run.bytes.push(text);
    run.byteChars += text.length;
    // `length > 1` on the character bound: one chunk larger than the whole cap
    // would otherwise empty the ring.
    while (run.bytes.length > MAX_BYTE_CHUNKS || (run.bytes.length > 1 && run.byteChars > MAX_BYTE_CHARS)) {
      const gone = run.bytes.shift();
      if (gone === undefined) break;
      run.byteChars -= gone.length;
      run.bytesDropped += 1;
    }
    return run.bytesDropped + run.bytes.length;
  }

  private pollReadiness(run: LiveRun): void {
    const timer = setInterval(() => {
      if (run.readiness.kind !== "pending" || isTerminal(run.status)) {
        clearInterval(timer);
        return;
      }
      void this.probe(run.config.readinessUrl!).then((result) => {
        // `serving`, not `answered`: a 5xx is something listening and failing.
        if (!result.serving || run.readiness.kind !== "pending" || isTerminal(run.status)) return;
        run.readiness = { kind: "ready", at: this.now() };
        if (run.status === "running") run.status = "ready";
        clearInterval(timer);
        this.announce(run);
      });
    }, this.readyPollMs);
    timer.unref?.();
    run.readyTimer = timer;
  }

  // ── typing into it ───────────────────────────────────────────────────────

  /**
   * KEYSTROKES REACH THE PROGRAM THE RECIPE NAMED. `resolveShell` spawns
   * `/bin/sh -c "<command>"`, so bytes arriving here go to `psql`, to an
   * installer asking `Proceed (Y/n)`, to a dev server waiting on `r`.
   *
   * WHAT THIS IS NOT ABLE TO PROMISE, stated at the door: what a person types
   * is NOT redacted, in any launcher shape. docs/run-terminal.md §5.
   */
  async write(terminalId: string, data: string): Promise<boolean> {
    const run = this.requireLiveKeyboard(terminalId, "type into");
    return await run.handle!.write!(data);
  }

  /** The geometry the surface drawing it is using — SIGWINCH is the PTY's job. */
  async resize(terminalId: string, cols: number, rows: number): Promise<boolean> {
    const run = this.requireLiveKeyboard(terminalId, "resize");
    return await run.handle!.resize!(cols, rows);
  }

  /**
   * THE PIPE FALLBACK HAS NO KEYBOARD: `pipeLauncher` spawns with `stdio:
   * ["ignore", …]`, so there is genuinely nothing to type into. Saying so is
   * better than a `write` that answers `true` and goes nowhere.
   */
  private requireLiveKeyboard(terminalId: string, verb: string): LiveRun {
    const run = this.require(terminalId);
    if (isTerminal(run.status) || !run.handle) {
      throw new RunError("conflict", `"${redactText(this.title(run), run.secrets)}" is not running, so there is nothing to ${verb}`);
    }
    if (!run.handle.write || !run.handle.resize) {
      throw new RunError(
        "conflict",
        `"${redactText(this.title(run), run.secrets)}" was started without a terminal — Telar's desktop shell is what provides one — so there is no keyboard to ${verb} with`,
      );
    }
    return run;
  }

  // ── closing ──────────────────────────────────────────────────────────────

  /**
   * CLOSE A TERMINAL, WHICH ENDS WHAT RUNS IN IT — and remember who asked.
   *
   * On the desktop this is the host's `/close`: a hangup to the shell, SIGTERM
   * to every process group on the terminal, SIGKILL a second later. The pipe
   * fallback does the same to its child's group. Idempotent: closing an ended
   * terminal answers its record, and a second close while one is in flight
   * joins it.
   *
   * `signal` IS A POLITE FIRST WORD, NOT A REPLACEMENT. A dev server that
   * traps SIGTERM to drain connections stops the way Ctrl-C stops it, so a
   * caller may ask for SIGINT first; if that does not end it within the grace,
   * the ordinary close follows.
   *
   * AN ENDED CLOSE IS A CLOSE. Once the escalation is over, the exit report
   * gets `closeSettleMs` to arrive; past that the terminal is recorded `closed`
   * anyway. The host has already sent SIGKILL — waiting for a frame would be
   * liveness tracking by another name.
   */
  async close(terminalId: string, by: RunClosedBy, signal?: NodeJS.Signals): Promise<RunView> {
    const run = this.require(terminalId);
    if (isTerminal(run.status)) return this.view(run);
    if (!run.closeTask) {
      run.closing = by;
      run.closeTask = this.closeRun(run, signal).finally(() => {
        run.closeTask = undefined;
      });
    }
    await run.closeTask;
    return this.view(run);
  }

  private async closeRun(run: LiveRun, signal?: NodeJS.Signals): Promise<void> {
    const handle = run.handle;
    if (!handle) return;
    if (signal && signal !== "SIGTERM") {
      try {
        await handle.signal(signal);
      } catch {
        /* the close below is the answer either way */
      }
      if (await this.ended(run, this.closeSettleMs)) return;
    }
    try {
      await handle.close();
    } catch (error) {
      // Nothing was closed: the host could not even be asked. The terminal is
      // exactly as it was, and says so rather than pretending.
      run.closing = undefined;
      throw new RunError(
        "conflict",
        redactText(`Telar could not close "${this.title(run)}": ${error instanceof Error ? error.message : String(error)}`, run.secrets),
      );
    }
    if (await this.ended(run, this.closeSettleMs)) return;
    if (!isTerminal(run.status)) this.finish(run, "closed", { closedBy: run.closing ?? "person" });
  }

  /** How many of this session's terminals are open right now. */
  openCount(sessionId: string): number {
    let count = 0;
    for (const run of this.runs.values()) if (run.sessionId === sessionId && !isTerminal(run.status)) count += 1;
    return count;
  }

  /** Every session with at least one open terminal. */
  openSessions(): string[] {
    return [...new Set([...this.runs.values()].filter((run) => !isTerminal(run.status)).map((run) => run.sessionId))];
  }

  /**
   * CLOSE EVERYTHING A SESSION HAS OPEN, AS TELAR — settling it (#883).
   *
   * On the desktop this is ONE call to the host's `/close-session`, because the
   * session's terminals include the shells the person opened in its panel, and
   * only the host knows those. The engine's own records are stamped `telar`
   * first, so the endings the host reports are recorded as Telar's rather than
   * the person's — which is also why the agent gets no "closed by the person"
   * note for them. The pipe fallback has no host; its children are all there is.
   *
   * Answers how many terminals were closed, the person's shells included.
   */
  async closeSession(sessionId: string): Promise<number> {
    const open = [...this.runs.values()].filter((run) => run.sessionId === sessionId && !isTerminal(run.status));
    if (!this.launcher.closeSession) {
      await Promise.allSettled(open.map((run) => this.close(run.terminalId, "telar")));
      return open.length;
    }
    const stamped = open.filter((run) => !run.closeTask);
    for (const run of stamped) run.closing = "telar";
    let closed: number;
    try {
      closed = await this.launcher.closeSession(sessionId);
    } catch (error) {
      for (const run of stamped) run.closing = undefined;
      throw error;
    }
    // Same rule as a single close: once the host's escalation is over, an exit
    // report that has not arrived is not waited on for ever.
    await Promise.all(open.map((run) => this.ended(run, this.closeSettleMs)));
    for (const run of open) if (!isTerminal(run.status)) this.finish(run, "closed", { closedBy: run.closing ?? "telar" });
    return Math.max(closed, open.length);
  }

  /** Resolves true once the terminal has ended, false after `ms`. */
  private ended(run: LiveRun, ms: number): Promise<boolean> {
    if (isTerminal(run.status)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        run.waiters = run.waiters.filter((waiter) => waiter !== onEnd);
        resolve(isTerminal(run.status));
      }, ms);
      timer.unref?.();
      const onEnd = () => {
        clearTimeout(timer);
        resolve(true);
      };
      run.waiters.push(onEnd);
    });
  }

  /**
   * THE ENGINE IS GOING DOWN — which is not Telar quitting.
   *
   * A TERMINAL ON THE DESKTOP HOST IS LEFT RUNNING. It is the person's: the
   * host keeps it, the next engine re-lists it, and quitting Telar is what
   * closes it (the host does that itself). So this stops listening and closes
   * nothing there.
   *
   * THE PIPE FALLBACK'S CHILDREN ARE CLOSED, because nobody else holds them:
   * a pipe child left behind is exactly the orphan nothing could reach.
   */
  async shutdown(): Promise<void> {
    // ORDER IS THE WHOLE FIX: refuse new opens, then drain the ones in flight,
    // so every spawn this manager will ever do has happened before closing.
    this.shuttingDown = true;
    await Promise.allSettled([...this.pending]);
    if (this.launcher.kind === "pipes") {
      await Promise.allSettled(
        [...this.runs.values()].filter((run) => !isTerminal(run.status)).map((run) => this.close(run.terminalId, "telar")),
      );
    }
    for (const run of this.runs.values()) if (run.readyTimer) clearInterval(run.readyTimer);
    this.launcher.detach?.();
  }

  // ── internals ────────────────────────────────────────────────────────────

  private require(terminalId: string): LiveRun {
    const run = this.runs.get(terminalId);
    if (!run) throw new RunError("not_found", `no terminal ${terminalId}`);
    return run;
  }

  /** The parts every record starts from. */
  private blank(): Pick<
    LiveRun,
    "terminalId" | "status" | "readiness" | "blind" | "lines" | "dropped" | "bytes" | "byteChars" | "bytesDropped" | "secrets" | "waiters" | "agentWatching"
  > {
    return {
      terminalId: "",
      status: "running",
      readiness: { kind: "none" },
      blind: false,
      lines: [],
      dropped: 0,
      bytes: [],
      byteChars: 0,
      bytesDropped: 0,
      secrets: [],
      waiters: [],
      agentWatching: false,
    };
  }

  private finish(
    run: LiveRun,
    status: "exited" | "failed" | "closed",
    detail: { exitCode?: number; signal?: string; error?: string; closedBy?: RunClosedBy },
  ): void {
    run.status = status;
    run.endedAt = this.now();
    if (detail.exitCode !== undefined) run.exitCode = detail.exitCode;
    if (detail.signal) run.signal = detail.signal;
    if (detail.error) run.error = redactText(detail.error, run.secrets);
    if (detail.closedBy) run.closedBy = detail.closedBy;
    if (run.readyTimer) clearInterval(run.readyTimer);
    if (run.readiness.kind === "pending") run.readiness = { kind: "none" };
    this.closeRecord(run);
    this.wake(run);
    this.announce(run);
    if (status === "closed" && run.closedBy === "person" && run.agentWatching && this.runs.has(run.terminalId)) {
      try {
        this.personClosed?.(this.view(run));
      } catch {
        /* a note that could not be kept is not this terminal's failure */
      }
    }
  }

  private wake(run: LiveRun): void {
    const waiters = run.waiters;
    run.waiters = [];
    for (const waiter of waiters) waiter();
  }

  /** Keep a session's recent ended terminals for their output; forget the rest. */
  private prune(sessionId: string): void {
    const finished = [...this.runs.values()]
      .filter((run) => run.sessionId === sessionId && isTerminal(run.status))
      .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
    for (const run of finished.slice(KEEP_FINISHED)) this.runs.delete(run.terminalId);
  }

  private view(run: LiveRun): RunView {
    // Every text field goes through the scrubber, not just the env list: a
    // person who marks TOKEN secret and pastes it into the command has put it
    // in a field this would otherwise hand back verbatim.
    const hide = (text: string) => redactText(text, run.secrets);
    return {
      terminalId: run.terminalId,
      runId: run.terminalId,
      projectId: run.projectId,
      sessionId: run.sessionId,
      origin: run.origin,
      title: hide(this.title(run)),
      ...(run.config.id ? { configId: run.config.id } : {}),
      configName: hide(run.configName),
      command: hide(run.command),
      worktreePath: hide(run.worktreePath),
      ...(run.worktreeBranch ? { worktreeBranch: hide(run.worktreeBranch) } : {}),
      cwd: hide(run.cwd),
      status: run.status,
      readiness: run.readiness,
      ...(run.config.readinessUrl ? { readinessUrl: hide(run.config.readinessUrl) } : {}),
      ...(run.handle?.pid !== undefined && !isTerminal(run.status) ? { pid: run.handle.pid } : {}),
      startedAt: run.startedAt,
      ...(run.endedAt ? { endedAt: run.endedAt } : {}),
      ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
      ...(run.signal ? { signal: run.signal } : {}),
      ...(run.closedBy ? { closedBy: run.closedBy } : {}),
      ...(run.warning ? { warning: run.warning } : {}),
      ...(run.error ? { error: run.error } : {}),
      env: (run.config.env ?? []).map((entry) => (entry.secret ? { key: entry.key, secret: true } : { key: entry.key, value: hide(entry.value) })),
    };
  }
}

/** "web dev #2" → { base: "web dev", instance: 2 }; anything else is instance 1. */
function splitTitle(title: string): { base: string; instance: number } {
  const match = /^(.*) #(\d+)$/.exec(title);
  if (match && Number(match[2]) > 1) return { base: match[1]!, instance: Number(match[2]) };
  return { base: title, instance: 1 };
}
