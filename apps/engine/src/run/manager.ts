/**
 * ONE local deployment per project, and the enforcement is here rather than in
 * the UI.
 *
 * THE SINGLETON IS THE FEATURE. A project has one dev server, and two of them is
 * not a mild redundancy — it is a port collision, two watchers writing the same
 * `.next`, and a human staring at a page served by the process they thought they
 * stopped. Guidance in a skill or a disabled play button cannot deliver that,
 * because the second launch arrives from a different session, or from an agent,
 * or from both at once. So the slot is reserved by `reserve()` in ONE
 * SYNCHRONOUS BLOCK before any `await`: two `start()` calls in the same tick
 * cannot both win, because the second one reaches the check after the first has
 * already written the map. Everything expensive — the readiness baseline, the
 * spawn — happens after the slot is already ours to lose.
 *
 * A RUN WE CANNOT VOUCH FOR KEEPS THE SLOT. `unknown` is not a soft `exited`. If
 * we lost the handle on a process, something may still be holding port 3000, and
 * quietly freeing the slot would let the next launch collide with it. So an
 * unknown run BLOCKS, its message says why, and clearing it is `release()` — an
 * explicit human act that signals nothing and admits, in the text, that Telar is
 * no longer the one who can stop that process.
 *
 * WE SIGNAL PROCESS GROUPS WE CREATED, AND ONLY WHILE SOMETHING STILL HOLDS
 * THEM. On POSIX every launch is a group leader, so one signal reaches the
 * `bun`/`node`/`vite` descendants a bare `kill(pid)` would strand. This file
 * used to be able to say "the pid is only ever used while our own
 * `ChildProcess` has not yet fired `exit`" — and since #198 the process may be
 * held by the DESKTOP SHELL instead, on a pseudo-terminal, so that sentence had
 * to be rebuilt rather than restated.
 *
 * IT IS REBUILT AS A HANDLE. `launcher.ts` hands back a `RunHandle` that knows
 * how to stop what it started; nothing here ever receives a pid it could aim at
 * by itself. Over the wire the handle is a terminal id, which the host honours
 * only while it still holds what the id names — a pid is reused by the kernel
 * and an id is not. What the pid IS still used for is one question, asked with
 * signal 0, which delivers nothing: see `groupVerdict`.
 *
 * AND A CHANNEL THAT DIES IS `unknown`, NEVER `exited`. That is the failure the
 * two-process arrangement adds and the one this whole design is aimed at: a
 * host that goes quietly while something downstream frees a slot for a dev
 * server that is still listening. A lost, silent or refused channel settles the
 * run `unknown` with the slot still held, exactly where a daemon death lands.
 *
 * WHICH OF THOSE MOVES EXIST IS A PROPERTY OF THE OPERATING SYSTEM, NOT OF THIS
 * FILE. `platform.ts` owns both — whether a child is spawned as a group leader,
 * how a whole tree is stopped, and whether "is the group gone?" can be asked at
 * all — and is injected here, so the Windows branch is exercised from a Mac
 * rather than written and hoped for.
 *
 * THE SHELL DYING IS NOT THE GROUP DYING. `bun run dev &` returns immediately:
 * the shell exits 0 with a server still running in the group behind it, and a
 * `trap`ping child can outlive a SIGTERM its parent obeyed. Treating the parent's
 * exit as the end of the run would free the slot while the port is still taken —
 * the precise thing the singleton exists to prevent. So every exit is followed by
 * asking whether the GROUP is gone, and a group with survivors makes the run
 * `unknown` rather than `exited`. Survivors are not signalled: we are past the
 * point where our handle vouches for that pid. A platform that CANNOT BE ASKED
 * lands in the same place as one that answered "survivors", and for the same
 * reason — see `GroupLiveness`.
 *
 * NO DURABLE SUPERVISOR, BUT ONE DURABLE FACT. Runs live in this process's
 * memory and `shutdown()` stops what it started. What it cannot do is survive
 * being killed, so a record is written to the journal before each spawn and
 * removed when the run ends — and anything left over is recovered as `unknown`,
 * blocking the slot and naming what to look for. Nothing is adopted, polled or
 * signalled across a restart; that needs a verification story this milestone
 * does not have.
 */
import fs from "node:fs";
import path from "node:path";
import { nullRunJournal, RunJournalUnreadable, type RunJournal, type RunRecord } from "./journal";
import { pipeLauncher, type RunHandle, type RunLauncher } from "./launcher";
import { type GroupLiveness, processGroupFor, type RunKill, type RunProcessGroup } from "./platform";
import { createPtyRedactor, safeCutBack } from "./pty-stream";
import { resolveShell } from "./shell";
import { createOutputSplitter } from "./stream";
import {
  isTerminal,
  newRunId,
  type RunConfiguration,
  RunError,
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
 * `lines` is a DEGRADED VIEW of a PTY's output and `capture()` says so: a
 * terminal's output is not a list of lines, and a surface that draws it
 * properly needs the bytes, escape sequences included. So a run keeps both, and
 * neither replaces the other — `/run/output` is still what an agent reads
 * (`run_output` wants lines, not `CSI H`) and still the only shape a caller who
 * never wanted an emulator has to handle.
 *
 * KEPT AS CHUNKS RATHER THAN ONE STRING, and the reason is escape integrity.
 * Dropping the front of a flat buffer can cut inside a `CSI 1;31 m`, and half a
 * sequence is not a shorter sequence — it is a parser desync that eats whatever
 * text follows it. Every chunk here comes out of `createPtyRedactor`, whose
 * contract is that it never emits a partial sequence, so a CHUNK boundary is
 * always a safe boundary and dropping whole chunks cannot desync a reader.
 *
 * BOUNDED TWICE, because either bound alone has a process that defeats it: a
 * chunk count alone gives a one-byte-at-a-time writer a scrollback of nothing
 * and a megabyte-at-a-time writer an unbounded one.
 */
const MAX_BYTE_CHUNKS = 4000;
const MAX_BYTE_CHARS = 256_000;
/** How long a polite SIGTERM gets before the group is killed outright. */
const STOP_GRACE_MS = 5000;
const READY_POLL_MS = 500;
/**
 * How long the group gets to finish dying after the shell exits. Descendants
 * killed alongside their parent are usually gone within a tick; this window is
 * for telling them apart from the ones that are not going anywhere.
 */
const GROUP_DRAIN_MS = 1000;
const GROUP_POLL_MS = 25;
/** Finished runs stay readable — output after exit is most of the value. */
const KEEP_TERMINAL = 10;

export type StartRunInput = {
  projectId: string;
  config: RunConfiguration;
  /** Absolute path of the tree this launch uses. Captured, never inferred. */
  worktreePath: string;
  worktreeBranch?: string;
  /** Who pressed play. Provenance for the UI; it confers no ownership. */
  sessionId?: string;
};

type LiveRun = {
  runId: string;
  projectId: string;
  config: RunConfiguration;
  configName: string;
  command: string;
  worktreePath: string;
  worktreeBranch?: string;
  cwd: string;
  sessionId?: string;
  status: RunStatus;
  readiness: RunReadiness;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  signal?: string;
  error?: string;
  /**
   * Whatever is holding this run's process — a local child, or a terminal the
   * desktop shell holds for us. NEVER A BARE PID: see `launcher.ts`.
   */
  handle?: RunHandle;
  /** True once an end was reported. The gate on every signal we send. */
  handleClosed: boolean;
  /**
   * True once the run has reached its final answer. Distinct from
   * `handleClosed`: between the shell's exit and the verdict on its group there
   * is a window where the handle is gone and the outcome is not yet known, and
   * anyone waiting on a stop must wait for the verdict, not the handle.
   */
  settled: boolean;
  /** Set by `release()`: the slot is free, the process is not ours any more. */
  released: boolean;
  lines: RunOutputLine[];
  dropped: number;
  /** Redacted bytes, in the slices the redactor emitted them. See the ring's
   *  note above for why the slicing is load-bearing and not an artefact. */
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
  /**
   * Injected so a test can make a signal fail the way a stale pid would. Signal
   * `0` is the existence check and delivers nothing. POSIX only: it is what the
   * default POSIX process group is built from, and the Windows one stops trees
   * with a command instead.
   */
  kill?: RunKill;
  /**
   * Which operating system's rules apply. Injected — as `volumes.ts`,
   * `host-path.ts` and `git.ts` already do it — so the win32 branch can be
   * asserted from a Mac rather than assumed.
   */
  platform?: NodeJS.Platform;
  /** The whole group strategy, when a test wants one neither platform ships. */
  processGroup?: RunProcessGroup;
  /**
   * HOW A RUN GETS A PROCESS. Defaults to a detached child with pipes, which is
   * what the engine has under `bun run src/main.ts` where there is no Electron
   * and therefore no pseudo-terminal to reach. The desktop daemon hands in
   * `terminalLauncher` instead — see `launcher.ts`.
   */
  launcher?: RunLauncher;
  /** Durable record of runs believed live. Omit for a manager that forgets. */
  journal?: RunJournal;
  stopGraceMs?: number;
  readyPollMs?: number;
  groupDrainMs?: number;
};

const defaultProbe: RunProbe = async (url) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500), redirect: "manual" });
    // ANSWERED and SERVING are different questions. A 500 proves the port is
    // taken — enough to spoil a baseline — but it is the state a human is
    // waiting to get out of, so it must not turn a run green.
    return { answered: true, serving: response.status < 500 };
  } catch {
    return { answered: false, serving: false };
  }
};

/**
 * ONE FRAME OF "A RUN CHANGED", AND THE FULL VIEW IS ON IT DELIBERATELY.
 *
 * Every other feed in this engine is thin — an id and a kind, re-derivable from
 * a cursor'd read — because the thing it names is a JOURNAL ENTRY that a reader
 * can page back to. A run's status is not journalled anywhere a client can page:
 * it lives in this process's memory, and the only read of it is `/run/status`,
 * which is precisely the poll this event exists to delete. A thin frame here
 * would buy a request per transition instead of one every four seconds, which is
 * not the trade #890 asked for.
 *
 * SO THE FRAME IS THE ANSWER, and it is the SAME `RunView` `/run/status` hands
 * back — same redaction, same rule about when `pid` and `terminalId` appear.
 * A reader that connects late reads `/run/status` ONCE and then never again; a
 * reader that missed a frame gets the next one, which carries the whole state
 * rather than a delta, so there is nothing to reconcile.
 */
export type RunStatusEvent = {
  type: "run.status";
  projectId: string;
  run: RunView;
  /**
   * WHETHER THIS RUN HOLDS THE PROJECT'S DEPLOYMENT SLOT, right now.
   *
   * ON THE EVENT RATHER THAN ON THE VIEW, because it is not a property of the
   * run: it is the answer to "which of this project's runs is the live one",
   * and `holder()` is the only thing entitled to give it. A client cannot
   * re-derive it from the status either — `release()` frees the slot while the
   * run stays `unknown` for ever, which is the whole point of `unknown` — so a
   * reader left to guess would show a released ghost as deployed.
   */
  active: boolean;
};

export class RunManager {
  private readonly runs = new Map<string, LiveRun>();
  /** Everyone listening for `run.status`. See `RunStatusEvent`. */
  private readonly watchers = new Set<(event: RunStatusEvent) => void>();
  /** projectId → runId holding the one deployment slot. */
  private readonly active = new Map<string, string>();
  /** Projects mid stop-then-start. A transition holds the slot across the gap. */
  private readonly transitions = new Set<string>();
  /** Launches in flight. `shutdown` drains these before it claims to be done. */
  private readonly pending = new Set<Promise<unknown>>();
  /** Set by `shutdown`: no new process may be spawned from here on. */
  private closing = false;
  /**
   * Why the durable record cannot be trusted right now, if it cannot.
   *
   * A journal we cannot read may be describing a live dev server, so starting
   * anything would be gambling with the singleton the journal exists to protect.
   * Reads stay open — history and output are still worth having — and only the
   * verbs that would spawn refuse.
   */
  private journalFault?: string;
  private readonly now: () => number;
  private readonly probe: RunProbe;
  private readonly platform: NodeJS.Platform;
  private readonly group: RunProcessGroup;
  private readonly launcher: RunLauncher;
  private readonly journal: RunJournal;
  private readonly stopGraceMs: number;
  private readonly readyPollMs: number;
  private readonly groupDrainMs: number;

  constructor(options: RunManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.probe = options.probe ?? defaultProbe;
    const kill: RunKill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
    this.platform = options.platform ?? process.platform;
    this.group = options.processGroup ?? processGroupFor(this.platform, kill);
    this.launcher = options.launcher ?? pipeLauncher(this.group);
    this.journal = options.journal ?? nullRunJournal;
    this.stopGraceMs = options.stopGraceMs ?? STOP_GRACE_MS;
    this.readyPollMs = options.readyPollMs ?? READY_POLL_MS;
    this.groupDrainMs = options.groupDrainMs ?? GROUP_DRAIN_MS;
  }

  /**
   * Read the journal back after a restart. Every record still open describes a
   * run the last daemon did not see end — so it becomes an `unknown` run that
   * HOLDS ITS PROJECT'S SLOT and is signalled by nobody. Call this once, before
   * serving requests; calling it twice is harmless but pointless.
   *
   * The pid in the record is from a previous boot and is treated as prose, not
   * as a handle: it appears in the message so a human can go and look, and
   * nowhere else.
   *
   * A JOURNAL THAT CANNOT BE READ IS NOT AN EMPTY ONE. It is the case where a
   * process is most likely to be running unseen, so it does not throw here —
   * that would take the daemon down over one bad file — and it does not shrug
   * either. It latches, and every verb that would spawn refuses until a human
   * deals with the file.
   */
  recover(): RunView[] {
    const recovered: RunView[] = [];
    let records: RunRecord[];
    try {
      records = this.journal.list();
    } catch (error) {
      this.journalFault = error instanceof RunJournalUnreadable ? error.message : String(error);
      return recovered;
    }
    for (const record of records) {
      if (this.runs.has(record.runId)) continue;
      const run: LiveRun = {
        runId: record.runId,
        projectId: record.projectId,
        // The recipe may have been edited or deleted since; what this run used
        // is what the record says it used.
        config: {
          id: record.configId,
          projectId: record.projectId,
          name: record.configName,
          command: record.command,
          createdAt: record.startedAt,
          updatedAt: record.startedAt,
        },
        configName: record.configName,
        command: record.command,
        worktreePath: record.worktreePath,
        ...(record.worktreeBranch ? { worktreeBranch: record.worktreeBranch } : {}),
        cwd: record.cwd,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        status: "unknown",
        readiness: { kind: "none" },
        startedAt: record.startedAt,
        error: `Telar was restarted while "${record.configName}" was running${
          record.pid ? ` (process group ${record.pid} at the time)` : ""
        }, so it can no longer see or stop that process. Check whether it is still running — it may still be holding the port — then release this run.`,
        handleClosed: true,
        settled: true,
        released: false,
        lines: [],
        dropped: 0,
        bytes: [],
        byteChars: 0,
        bytesDropped: 0,
        secrets: [],
        waiters: [],
      };
      this.runs.set(run.runId, run);
      // Only the newest survivor per project can hold the slot; the rest stay
      // readable but do not each block the project a second time.
      if (!this.active.has(run.projectId)) this.active.set(run.projectId, run.runId);
      recovered.push(this.view(run));
    }
    return recovered;
  }

  // ── watching ─────────────────────────────────────────────────────────────

  /**
   * Be told when any run's state changes. Answers the unsubscribe.
   *
   * NOT FILTERED BY PROJECT HERE. A watcher is a transport — the daemon's SSE
   * route — and which projects one connection may see is that route's knowledge,
   * not this file's. Filtering here would mean this map had to be told about
   * sessions.
   *
   * A LISTENER THAT THROWS DOES NOT STOP THE OTHERS, and does not take down the
   * status transition that emitted the frame: `announce` is called from `exit`
   * handlers reached through `void`, where a rejection ends the daemon.
   */
  watch(listener: (event: RunStatusEvent) => void): () => void {
    this.watchers.add(listener);
    return () => {
      this.watchers.delete(listener);
    };
  }

  private announce(run: LiveRun): void {
    if (this.watchers.size === 0) return;
    const event: RunStatusEvent = {
      type: "run.status",
      projectId: run.projectId,
      run: this.view(run),
      active: this.holder(run.projectId)?.runId === run.runId,
    };
    for (const watcher of this.watchers) {
      try {
        watcher(event);
      } catch {
        // A broken reader is that reader's problem, not this run's.
      }
    }
  }

  // ── reading ──────────────────────────────────────────────────────────────

  activeRun(projectId: string): RunView | undefined {
    const run = this.holder(projectId);
    return run ? this.view(run) : undefined;
  }

  run(runId: string): RunView {
    return this.view(this.require(runId));
  }

  /** Newest first, live one included. History is what makes an exit readable. */
  history(projectId: string): RunView[] {
    return [...this.runs.values()]
      .filter((run) => run.projectId === projectId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((run) => this.view(run));
  }

  /**
   * Captured output from `after`, with a cursor to resume from. The ring drops
   * from the front under load, and `dropped` is reported rather than hidden so a
   * client can say "earlier output was discarded" instead of showing a gap.
   */
  output(runId: string, after = 0): { lines: RunOutputLine[]; cursor: number; dropped: number } {
    const run = this.require(runId);
    const start = Math.max(0, after - run.dropped);
    return {
      lines: run.lines.slice(start),
      cursor: run.dropped + run.lines.length,
      dropped: run.dropped,
    };
  }

  /**
   * The same window, in the shape a terminal can draw: redacted BYTES.
   *
   * SAME CURSOR CONTRACT AS `output`, deliberately — one poll shape for both,
   * so the cockpit's existing host hop carries this with no new plumbing and a
   * cursor that goes BACKWARDS still means "a different run", not "lost
   * output". What differs is the unit: a chunk rather than a line, because a
   * line is not a thing a terminal has.
   */
  bytes(runId: string, after = 0): { chunks: string[]; cursor: number; dropped: number } {
    const run = this.require(runId);
    const start = Math.max(0, after - run.bytesDropped);
    return {
      chunks: run.bytes.slice(start),
      cursor: run.bytesDropped + run.bytes.length,
      dropped: run.bytesDropped,
    };
  }

  // ── starting ─────────────────────────────────────────────────────────────

  async start(input: StartRunInput): Promise<RunView> {
    return await this.startReserved(input, false);
  }

  /**
   * Stop what is running for this project and start this instead — the explicit
   * act behind "Run this worktree" when the session is sitting somewhere other
   * than the live deployment. It is a separate verb from `start` ON PURPOSE: an
   * agent that meant to launch must never silently take over a deployment
   * somebody else is watching, so taking over has to be asked for by name.
   */
  async replace(input: StartRunInput): Promise<RunView> {
    const holder = this.holder(input.projectId);
    if (!holder) return await this.start(input);
    if (holder.status === "unknown") throw this.unknownConflict(holder);
    this.beginTransition(input.projectId);
    try {
      if (!isTerminal(holder.status)) await this.stopRun(holder);
      return await this.startReserved(input, true);
    } finally {
      this.transitions.delete(input.projectId);
    }
  }

  /** Same recipe, same tree, same slot — held across the whole gap. */
  async restart(runId: string): Promise<RunView> {
    const run = this.require(runId);
    if (run.status === "unknown") throw this.unknownConflict(run);
    this.beginTransition(run.projectId);
    try {
      if (!isTerminal(run.status)) await this.stopRun(run);
      return await this.startReserved(
        {
          projectId: run.projectId,
          config: run.config,
          worktreePath: run.worktreePath,
          ...(run.worktreeBranch ? { worktreeBranch: run.worktreeBranch } : {}),
          ...(run.sessionId ? { sessionId: run.sessionId } : {}),
        },
        true,
      );
    } finally {
      this.transitions.delete(run.projectId);
    }
  }

  private async startReserved(input: StartRunInput, insideTransition: boolean): Promise<RunView> {
    // SYNCHRONOUS UP TO HERE. Nothing awaits between the conflict check inside
    // reserve() and the map write, so a second caller in the same tick loses.
    const run = this.reserve(input, insideTransition);
    // The launch is registered BEFORE it is awaited, so a shutdown that arrives
    // mid-baseline has something to wait for rather than racing past it.
    const work = this.bringUp(run, input);
    this.pending.add(work);
    try {
      await work;
    } finally {
      this.pending.delete(work);
    }
    return this.view(run);
  }

  private async bringUp(run: LiveRun, input: StartRunInput): Promise<void> {
    try {
      if (input.config.readinessUrl) {
        const baseline = await this.probe(input.config.readinessUrl);
        run.readiness = baseline.answered
          ? {
              kind: "unattributable",
              reason: redactText(
                `${input.config.readinessUrl} was already answering before this run started, so a response from it cannot be attributed to this process`,
                run.secrets,
              ),
            }
          : { kind: "pending" };
      }
      // The baseline is a network round trip, and the daemon may have been told
      // to go down during it. Spawning here would leave a process behind that
      // nothing is left to stop — the orphan `shutdown` exists to prevent.
      if (this.closing) {
        throw new RunError("conflict", "Telar is shutting down, so it did not start this run");
      }
      await this.launch(run);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A LIVE CHILD IS NEVER DISOWNED BY A FAILED BOOKKEEPING STEP. `finish`
      // frees the project's slot, which is the right answer for a launch that
      // never got a process and exactly the wrong one for a launch that did:
      // the next start would collide with a server this one is still running.
      if (run.handle?.pid !== undefined && !run.handleClosed) {
        this.markUnknown(
          run,
          `"${run.configName}" was started but Telar hit an error while recording it (${message}), so it can no longer vouch for the process. Check whether it is running, then stop or release this run.`,
        );
      } else {
        this.finish(run, "failed", { error: message });
      }
      throw error instanceof RunError ? error : new RunError("invalid_request", redactText(String(error), run.secrets));
    }
  }

  private reserve(input: StartRunInput, insideTransition: boolean): LiveRun {
    if (this.closing) {
      throw new RunError("conflict", "Telar is shutting down and will not start anything new");
    }
    if (this.journalFault) {
      throw new RunError(
        "conflict",
        `Telar will not start a run while it cannot read its record of what is already running: ${this.journalFault}. Check whether a process from a previous session is still alive, then move or delete that file to start again.`,
      );
    }
    // A value the human was told is hidden must never reach a log. The store
    // refuses these at save time; a configuration that arrived another way is
    // refused here rather than launched with a promise we cannot keep.
    const exposed = unhideableSecrets(input.config);
    if (exposed.length) {
      throw new RunError(
        "invalid_request",
        `${exposed.join(", ")} ${exposed.length === 1 ? "is" : "are"} marked secret but too short or spread over lines to be removed from captured output; change the value or unmark it rather than have Telar print it`,
      );
    }
    if (!insideTransition && this.transitions.has(input.projectId)) {
      throw new RunError("conflict", "this project's deployment is being replaced right now; try again once that settles");
    }
    const holder = this.holder(input.projectId);
    if (holder) {
      if (holder.status === "unknown") throw this.unknownConflict(holder);
      throw new RunError(
        "conflict",
        `"${holder.configName}" is already running for this project (from ${holder.worktreePath}). A project has one local deployment: stop it, or replace it deliberately, rather than starting a second.`,
        { runId: holder.runId, configId: holder.config.id, status: holder.status, worktreePath: holder.worktreePath },
      );
    }

    const cwd = this.resolveCwd(input);
    const run: LiveRun = {
      runId: newRunId(),
      projectId: input.projectId,
      config: input.config,
      configName: input.config.name,
      command: input.config.command,
      worktreePath: input.worktreePath,
      ...(input.worktreeBranch ? { worktreeBranch: input.worktreeBranch } : {}),
      cwd,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      status: "starting",
      readiness: { kind: "none" },
      startedAt: this.now(),
      handleClosed: false,
      settled: false,
      released: false,
      lines: [],
      dropped: 0,
      bytes: [],
      byteChars: 0,
      bytesDropped: 0,
      secrets: secretValues(input.config),
      waiters: [],
    };
    this.runs.set(run.runId, run);
    this.active.set(input.projectId, run.runId);
    this.prune(input.projectId);
    // `starting` IS A STATE WORTH ANNOUNCING. The slot is already held, so a
    // cockpit that waited for `running` would show nothing for the length of a
    // readiness baseline and a spawn — which is exactly the window a person
    // presses the button twice in.
    this.announce(run);
    return run;
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
    // while being a symlink to somewhere else entirely, and the contract this
    // module publishes — a run works inside its worktree — would then be false
    // in exactly the case somebody arranged on purpose. Ask the filesystem.
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
    // The lexical path is what gets spawned in — it is what the human wrote and
    // what they will see in the panel; the kernel resolves the links either way.
    return cwd;
  }

  private async launch(run: LiveRun): Promise<void> {
    // `NodeJS.ProcessEnv`, not a plain record: a project that augments
    // ProcessEnv with required keys (Next does) rejects the narrowed type.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const entry of run.config.env ?? []) env[entry.key] = entry.value;

    // BEFORE THE SPAWN, NOT AFTER. If the daemon is killed between these two
    // statements the record exists and the run recovers as `unknown`; the other
    // order loses a live process to a crash that is milliseconds wide.
    this.journal.open(this.record(run));

    /**
     * `shell: false`, AND THE SHELL IS SPELLED OUT INSTEAD. A saved recipe
     * still means what it reads like — `bun run dev`, `a && b` — because a
     * shell still evaluates it; what changed is that WHICH shell, and where the
     * command sits in its argv, is now a value this process computed and can
     * show you (`resolveShell`) rather than something `shell: true` decides
     * privately and differently per platform. Nobody downstream splits a string.
     *
     * WHICH LAUNCHER RUNS IT IS NOT THIS FILE'S BUSINESS — a detached child
     * with pipes, or a pseudo-terminal the desktop shell holds. What this file
     * owns is what each of the four outcomes MEANS for the project's slot, and
     * that is the same policy either way.
     */
    const launch = resolveShell(run.config, this.platform, process.env);
    // The capture is registered BEFORE the launch, because the first bytes of a
    // PTY can arrive inside the call that starts it.
    const capture = this.capture(run);
    // Declared before the launch because a launcher may report an end from
    // inside it — a spawn that threw arrives that way — and the callbacks below
    // must not reach a binding that does not exist yet.
    let handle: RunHandle | undefined;
    handle = await this.launcher.launch(
      {
        file: launch.file,
        args: launch.args,
        cwd: run.cwd,
        env,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
      },
      {
        output: capture,
        failed: (reason) => {
          if (isTerminal(run.status)) return;
          this.finish(run, "failed", { error: redactText(reason, run.secrets) });
        },
        /**
         * WE STOPPED BEING ABLE TO VOUCH, AND THIS NEVER BECOMES `exited`.
         *
         * The group is deliberately NOT asked here, unlike on an observed exit.
         * A channel that died tells us nothing about the process behind it, and
         * a `gone` answer from a pid we are no longer entitled to reason about
         * would free the slot on the strength of a coincidence. The run holds
         * the project until a human releases it, which is what `unknown` has
         * always meant.
         */
        lost: (reason) => {
          run.handleClosed = true;
          if (isTerminal(run.status) || run.settled) return;
          this.markUnknown(run, reason);
          run.settled = true;
          this.wake(run);
        },
        exited: (detail) => {
          run.handleClosed = true;
          // Nothing awaits this, so a rejection here would be an unhandled one —
          // i.e. a process exiting would be able to take the daemon down.
          // Whatever went wrong, the honest answer is a run we cannot vouch for.
          this.settle(run, handle?.pid, detail).catch((error: unknown) => {
            if (isTerminal(run.status) || run.status === "unknown") return;
            this.markUnknown(run, `Telar could not determine how "${run.configName}" ended: ${error instanceof Error ? error.message : String(error)}`);
            run.settled = true;
            this.wake(run);
          });
        },
      },
    );
    run.handle = handle;

    if (handle.pid === undefined) {
      // No pid means no group to signal. Refuse to hold a slot on a process we
      // never had, rather than inventing an `unknown` out of a failed spawn.
      if (!isTerminal(run.status) && run.status !== "unknown") {
        this.finish(run, "failed", { error: "the process could not be started (no pid)" });
      }
      return;
    }
    // A launcher that already settled the run inside `launch` must not have its
    // verdict overwritten with `running`.
    if (isTerminal(run.status) || run.status === "unknown") return;

    run.status = "running";
    // Announced here rather than after the journal write below, because that
    // write is allowed to fail and a live run must not go unannounced over it.
    this.announce(run);
    // EVERYTHING THAT CANNOT FAIL, FIRST. Readiness is pure registration; the
    // second journal write is disk I/O and can throw, and a throw between the
    // spawn and this would leave a live process with no readiness poll.
    if (run.readiness.kind === "pending") this.pollReadiness(run);

    // Now there is a pid worth recording — the only thing a human gets to look
    // for if this daemon dies before the run does. IT IS NOT LOAD-BEARING: the
    // pre-spawn record already holds the slot across a crash, so a failure here
    // costs the pid in that sentence, not the run.
    try {
      this.journal.open(this.record(run));
    } catch (error) {
      this.log(
        run,
        "stderr",
        `Telar: this run's process id could not be written to the run journal (${error instanceof Error ? error.message : String(error)}). The run itself is fine; if Telar is killed before it ends, the warning you get back will not be able to name the process group.`,
      );
    }
  }

  /**
   * The verdict on an exit. THE SHELL BEING DEAD IS NOT THE ANSWER: `cmd &`
   * leaves a server in our group behind an exit code of 0, and a child that
   * trapped SIGTERM outlives the parent that obeyed it. Both cases mean the port
   * is still taken, so the run keeps the project's slot as `unknown` instead of
   * reporting a clean exit.
   *
   * Survivors are NOT signalled. Our handle is gone, which is precisely when the
   * pid stops being ours to aim at — the group probe is a question, not a shot.
   */
  private async settle(run: LiveRun, pid: number | undefined, detail: { exitCode?: number; signal?: string }): Promise<void> {
    if (run.settled) return;
    // THE GROUP IS ASKED FIRST, EVEN FOR A RUN ALREADY GIVEN UP ON. A stop whose
    // signal failed marks the run `unknown`; if the shell then exits while a
    // descendant it spawned keeps the port, taking the exit as "accounted for"
    // would hand the slot back over a process still holding it. The exit of our
    // handle is evidence about the shell, never about the group.
    const verdict = pid === undefined ? "gone" : await this.groupVerdict(pid, this.groupDrainMs);
    if (verdict !== "gone") {
      run.endedAt ??= this.now();
      this.markUnknown(
        run,
        verdict === "alive"
          ? `"${run.configName}" exited but processes it started are still alive in its process group (${pid}). Telar will not free this project's deployment while something may still be holding its port, and will not signal a group its handle no longer covers — check what is left, then release this run.`
          : `"${run.configName}" exited, and on this system Telar cannot ask whether the processes it started went with it — there is no process group to query. It will not free this project's deployment on a guess: check whether anything is still holding the port, then release this run.`,
      );
      run.settled = true;
      this.wake(run);
      return;
    }
    if (run.status === "unknown") {
      // It came back after we gave up on it AND its group is empty: that is safe
      // completion, so stop blocking the project on a ghost.
      run.released = true;
      run.settled = true;
      this.closeRecord(run);
      this.wake(run);
      this.announce(run);
      return;
    }
    const code = detail.exitCode;
    this.finish(run, code === 0 || code === undefined ? "exited" : "failed", {
      ...(code === undefined ? {} : { exitCode: code }),
      ...(detail.signal ? { signal: detail.signal } : {}),
    });
  }

  /**
   * What is left of this run's process tree. SIGNALS NOTHING — it is a
   * question, and by the time it is asked our handle no longer vouches for the
   * pid, which is exactly when a shot would be aimed at a stranger.
   *
   * On an ordinary stop the descendants are dying alongside their parent and
   * this returns almost at once; the window is only long enough to tell that
   * apart from a group that is staying. A platform that cannot be asked returns
   * `unanswerable` on the first try and is not polled — repeating a question
   * nobody can answer would only spend the drain window.
   */
  private async groupVerdict(pid: number, ms: number): Promise<GroupLiveness> {
    const first = this.group.liveness(pid);
    if (first !== "alive") return first;
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_MS));
      const again = this.group.liveness(pid);
      if (again !== "alive") return again;
    }
    return this.group.liveness(pid);
  }

  /**
   * The durable record — WRITTEN ALREADY REDACTED.
   *
   * A recovered run has no configuration behind it and therefore no secret list
   * to scrub with, so anything stored raw here would be handed back verbatim
   * after a restart: a token pasted into a command, or into a configuration's
   * name, would survive in the file and reappear in the warning. Since these
   * fields exist only to describe the run to a human — a recovered run cannot be
   * restarted from them — the redacted text is the whole truth they need.
   */
  private record(run: LiveRun): RunRecord {
    const hide = (text: string) => redactText(text, run.secrets);
    return {
      runId: run.runId,
      projectId: run.projectId,
      configId: run.config.id,
      configName: hide(run.configName),
      command: hide(run.command),
      worktreePath: hide(run.worktreePath),
      ...(run.worktreeBranch ? { worktreeBranch: hide(run.worktreeBranch) } : {}),
      cwd: hide(run.cwd),
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      startedAt: run.startedAt,
      ...(run.handle?.pid !== undefined ? { pid: run.handle.pid } : {}),
    };
  }

  /**
   * Forget the durable record. NEVER THROWS: this is called from `exit`
   * handlers reached through `void`, where a rejection is an unhandled one that
   * takes the daemon down, and the failure mode of not closing is benign —
   * a stale record recovers as `unknown` and a human releases it.
   */
  private closeRecord(run: LiveRun): void {
    try {
      this.journal.close(run.runId);
    } catch {
      // Left open on purpose: the next daemon will ask about it, which is the
      // safe direction to be wrong in.
    }
  }

  /**
   * Capture what the launcher gives us, WITHOUT trusting the process to send
   * newlines — and with a different redactor per shape, because the two shapes
   * are not the same stream wearing different clothes.
   *
   * PIPES keep the line discipline and the line redactor (`stream.ts`). Its
   * correctness rests on `types.ts` refusing a secret with a line break in it,
   * so a complete line can never be changed by a later byte. A binary blob or a
   * webpack build dumping a megabyte before its first `\n` is handled by
   * flushing the carry in fixed-size slices, each cut where no secret straddles
   * it.
   *
   * A PTY has neither of those. There is no reliable newline and the bytes
   * carry escape sequences, so `pty-stream.ts` redacts them instead — never
   * cutting inside a sequence, and replacing a secret with mask cells of the
   * same width so that cursor-positioned output keeps its columns. The lines
   * kept here are then a DEGRADED VIEW of that stream, which is honest: a
   * terminal's output is not a list of lines and the surface that shows it
   * properly reads the bytes.
   *
   * EITHER WAY THE CARRY IS KEPT RAW and only released once no later byte could
   * change how it is scrubbed. Scrubbing eagerly is what leaked `EFGH` when
   * `ABCD` and `ABCDEFGH` were both secret and arrived in that order.
   *
   * AND A PTY MERGES THE TWO STREAMS. A pseudo-terminal is one device; stdout
   * and stderr went into the same file descriptor and nothing downstream can
   * un-merge them, so every line from one is recorded as `stdout`.
   */
  private capture(run: LiveRun): (stream: "stdout" | "stderr", chunk: string) => void {
    if (this.launcher.kind === "pipes") {
      const splitters = new Map<string, ReturnType<typeof createOutputSplitter>>();
      return (stream, chunk) => {
        let splitter = splitters.get(stream);
        if (!splitter) {
          splitter = createOutputSplitter(run.secrets, MAX_LINE_CHARS, (text) => {
            // THE BYTE VIEW EXISTS HERE TOO, RATHER THAN THE SURFACE DRAWING A
            // BLACK BOX. With no Electron there is no PTY, so what a terminal
            // gets is the redacted lines put back together — interleaved,
            // because a terminal is one device, and `\r\n` because an emulator
            // needs the carriage return to get its column back. It is a poorer
            // terminal than a real PTY gives, and it is a working one.
            this.keep(run, `${this.log(run, stream, text)}\r\n`);
          });
          splitters.set(stream, splitter);
        }
        splitter.push(chunk);
      };
    }
    // The PTY path: redact the bytes first, then cut the already-safe text into
    // lines. Nothing is redacted twice and the line cut is escape-aware, so a
    // wrapped line cannot desync a reader either.
    let carry = "";
    const emitLine = (text: string) => this.log(run, "stdout", text);
    const redactor = createPtyRedactor(run.secrets, (text) => {
      // THE BYTES AS THE REDACTOR EMITTED THEM, before the line cut — the line
      // view below is the degraded one. Fed from the redactor's OUTPUT and
      // never its input: this is the one place a run's secrets could reach a
      // surface unmasked, and #819 is what stops that.
      this.keep(run, text);
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
    return (_stream, chunk) => redactor.push(chunk);
  }

  /** Answers the redacted line it kept, so the byte ring can hold the same
   *  text rather than a second scrub of the same input. */
  private log(run: LiveRun, stream: "stdout" | "stderr", text: string): string {
    const clean = redactText(text.replace(/\r$/, ""), run.secrets).slice(0, MAX_LINE_CHARS);
    run.lines.push({ at: this.now(), stream, text: clean });
    if (run.lines.length > MAX_LINES) {
      run.dropped += run.lines.length - MAX_LINES;
      run.lines.splice(0, run.lines.length - MAX_LINES);
    }
    return clean;
  }

  /** One already-redacted slice into the byte ring, dropping WHOLE chunks from
   *  the front so a cut can never land inside an escape sequence. */
  private keep(run: LiveRun, text: string): void {
    if (!text) return;
    run.bytes.push(text);
    run.byteChars += text.length;
    // `length > 1` on the character bound: one chunk larger than the whole cap
    // would otherwise empty the ring, leaving a reader with nothing at all
    // rather than with the most recent thing the process said. The redactor
    // holds at most `MAX_HOLD_CHARS` before flushing, so the overshoot that
    // buys is bounded by one of those.
    while (run.bytes.length > MAX_BYTE_CHUNKS || (run.bytes.length > 1 && run.byteChars > MAX_BYTE_CHARS)) {
      const gone = run.bytes.shift();
      if (gone === undefined) break;
      run.byteChars -= gone.length;
      run.bytesDropped += 1;
    }
  }

  private pollReadiness(run: LiveRun): void {
    const timer = setInterval(() => {
      if (run.readiness.kind !== "pending" || run.handleClosed || isTerminal(run.status)) {
        clearInterval(timer);
        return;
      }
      void this.probe(run.config.readinessUrl!).then((result) => {
        // `serving`, not `answered`: a 5xx is something listening and failing,
        // which is the state the human is waiting to LEAVE.
        if (!result.serving || run.readiness.kind !== "pending" || run.handleClosed) return;
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
   * KEYSTROKES REACH THE PROGRAM THE RECIPE NAMED, and that is the whole of
   * what this is.
   *
   * IT IS NOT A SHELL PROMPT. `resolveShell` spawns `/bin/sh -c "<command>"` —
   * non-login, non-interactive, no dotfiles, no history — so bytes arriving
   * here go to `psql`, to `node`, to an installer asking `Proceed (Y/n)`, to a
   * dev server waiting on `r`. A recipe that PINS its shell (`config.shell`) is
   * the one case where they go to a real login shell, and that is a legitimate
   * thing to save rather than a hole to close.
   *
   * WHAT THIS IS NOT ABLE TO PROMISE, stated at the door rather than found in a
   * log: what a person types is NOT redacted, in any launcher shape. Redaction
   * covers what a process WRITES. docs/run-terminal.md §5 is where that limit
   * lives and this does not narrow it — read-only would not have narrowed it
   * either, it would only have changed who could reach the keyboard.
   *
   * AND A RUN IS A PROJECT SINGLETON, so two sessions with this panel open are
   * two keyboards on one process. The panel already says the run belongs to the
   * project; nothing here pretends the second keyboard is not there.
   */
  async write(runId: string, data: string): Promise<boolean> {
    const run = this.requireLiveKeyboard(runId, "type into");
    return await run.handle!.write!(data);
  }

  /** The geometry the surface drawing it is using — SIGWINCH is the PTY's job,
   *  and a program that draws a full screen needs to be told. */
  async resize(runId: string, cols: number, rows: number): Promise<boolean> {
    const run = this.requireLiveKeyboard(runId, "resize");
    return await run.handle!.resize!(cols, rows);
  }

  /**
   * The run whose keyboard `verb` is about, or a refusal naming which of the
   * three reasons it is not one.
   *
   * THE THIRD REASON IS THE ONE WORTH SPELLING OUT. With no Electron there is
   * no pseudo-terminal: `pipeLauncher` spawns with `stdio: ["ignore", …]`, so
   * the process's stdin is /dev/null and there is genuinely nothing to type
   * into. Saying so is better than a `write` that answers `true` and goes
   * nowhere, and better than opening stdin — a program that reads it would then
   * block waiting instead of seeing EOF, which is a behaviour change for every
   * headless run in exchange for a keyboard nobody is sitting at.
   */
  private requireLiveKeyboard(runId: string, verb: string): LiveRun {
    const run = this.require(runId);
    if (run.status === "unknown") throw this.unknownConflict(run);
    if (isTerminal(run.status) || run.handleClosed || !run.handle) {
      throw new RunError("conflict", `"${run.configName}" is not running, so there is nothing to ${verb}`);
    }
    if (!run.handle.write || !run.handle.resize) {
      throw new RunError(
        "conflict",
        `"${run.configName}" was started without a terminal — Telar's desktop shell is what provides one — so there is no keyboard to ${verb} with`,
      );
    }
    return run;
  }

  // ── stopping ─────────────────────────────────────────────────────────────

  async stop(runId: string): Promise<RunView> {
    return this.view(await this.stopRun(this.require(runId)));
  }

  private async stopRun(run: LiveRun): Promise<LiveRun> {
    if (isTerminal(run.status)) return run;
    if (run.status === "unknown") throw this.unknownConflict(run);
    if (run.status === "starting" || !run.handle) {
      throw new RunError("conflict", "this run is still starting; wait for it to come up before stopping it");
    }
    const pid = run.handle.pid;
    if (pid === undefined || run.handleClosed) {
      // The handle is gone but no exit was recorded: we cannot tell a finished
      // process from a reused pid, so we say so and signal nothing.
      this.markUnknown(run, "Telar no longer holds this run's process handle, so it will not signal a pid that may have been reused");
      throw this.unknownConflict(run);
    }

    if (!this.stopGroup(run, false)) throw this.unknownConflict(run);
    if (await this.waitForExit(run, this.stopGraceMs)) return this.settled(run);

    if (!run.handleClosed && !this.stopGroup(run, true)) throw this.unknownConflict(run);
    if (await this.waitForExit(run, this.stopGraceMs)) return this.settled(run);

    this.markUnknown(run, "the process did not exit after being killed outright; Telar has stopped tracking it rather than guess");
    throw this.unknownConflict(run);
  }

  /**
   * The exit arrived — but `settle` may have read the group and found survivors,
   * in which case the stop did not finish, whatever the shell's exit code said.
   */
  private settled(run: LiveRun): LiveRun {
    if (run.status === "unknown") throw this.unknownConflict(run);
    return run;
  }

  /**
   * Stop the whole tree, and only while our handle says it is still ours.
   * `force` is the second, impolite attempt — a signal on POSIX, `taskkill /F`
   * on Windows, an id the desktop host resolves to a pid it still holds when
   * the run is on a terminal. Which one applies is the HANDLE's business, and
   * that is the point: this file never gets to aim at a number by itself.
   */
  private stopGroup(run: LiveRun, force: boolean): boolean {
    if (run.handleClosed) return true;
    if (!run.handle) return true;
    try {
      run.handle.stop(force);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // ESRCH: the group is already gone. The `exit` event is what confirms it,
      // and it is already on its way — nothing to report.
      if (code === "ESRCH") return true;
      this.markUnknown(run, `could not signal this run's process group: ${redactText(String((error as Error).message ?? error), run.secrets)}`);
      return false;
    }
  }

  /**
   * Wait for the VERDICT, not the handle. The shell closing is where `settle`
   * starts asking about the group; resolving here on `handleClosed` would let a
   * stop report success while that question was still open.
   */
  private waitForExit(run: LiveRun, ms: number): Promise<boolean> {
    if (run.settled) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        run.waiters = run.waiters.filter((waiter) => waiter !== onExit);
        resolve(run.settled);
      }, ms);
      timer.unref?.();
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      run.waiters.push(onExit);
    });
  }

  /**
   * Give up the slot for a run we cannot verify. KILLS NOTHING — that is the
   * whole point: whatever is still holding the port is now the human's to deal
   * with, and Telar says so instead of firing a signal into the dark.
   */
  release(runId: string): RunView {
    const run = this.require(runId);
    if (run.status !== "unknown") {
      throw new RunError("conflict", "only a run Telar has lost contact with can be released; stop this one instead");
    }
    run.released = true;
    // The human has said "I checked". The durable record exists to make them
    // check; once they have, it would only haunt the next daemon start.
    this.closeRecord(run);
    this.announce(run);
    return this.view(run);
  }

  /**
   * Daemon going down. We stop what we started rather than leave processes no
   * future daemon can see, let alone verify — adoption across restarts needs a
   * durable record this milestone does not have.
   */
  async shutdown(): Promise<void> {
    // ORDER IS THE WHOLE FIX. A start that is mid-baseline-probe has not spawned
    // yet, and used to spawn AFTER shutdown returned — a process nobody was left
    // to stop. Refusing new starts and then draining the ones in flight means
    // every spawn this manager will ever do has already happened by the time we
    // start stopping.
    this.closing = true;
    await Promise.allSettled([...this.pending]);
    await Promise.all(
      [...this.runs.values()]
        .filter((run) => !isTerminal(run.status) && run.status !== "unknown")
        .map(async (run) => {
          try {
            await this.stopRun(run);
          } catch {
            // Already reported on the run itself as `unknown`.
          }
        }),
    );
  }

  // ── internals ────────────────────────────────────────────────────────────

  private holder(projectId: string): LiveRun | undefined {
    const runId = this.active.get(projectId);
    const run = runId ? this.runs.get(runId) : undefined;
    if (!run) return undefined;
    if (run.released || isTerminal(run.status)) return undefined;
    return run;
  }

  private require(runId: string): LiveRun {
    const run = this.runs.get(runId);
    if (!run) throw new RunError("not_found", `no run ${runId}`);
    return run;
  }

  private beginTransition(projectId: string): void {
    if (this.transitions.has(projectId)) {
      throw new RunError("conflict", "this project's deployment is already being replaced");
    }
    this.transitions.add(projectId);
  }

  /** Scrubbed like every other read: the name and the tree are text a human
   *  chose, and a human who pasted a token into one is owed the same promise. */
  private unknownConflict(run: LiveRun): RunError {
    return new RunError(
      "conflict",
      redactText(
        `Telar has lost contact with "${run.configName}" (run ${run.runId}) and will not act on a process it cannot verify. ${run.error ?? ""} Check whether it is still running, then release the run to free this project.`.trim(),
        run.secrets,
      ),
      { runId: run.runId, status: "unknown", worktreePath: redactText(run.worktreePath, run.secrets) },
    );
  }

  private markUnknown(run: LiveRun, why: string): void {
    const reason = redactText(why, run.secrets);
    run.status = "unknown";
    run.error = reason;
    if (run.readyTimer) clearInterval(run.readyTimer);
    // The same sentence, and it must arrive scrubbed here too — `readiness` is
    // handed to clients whole.
    if (run.readiness.kind === "pending") run.readiness = { kind: "unattributable", reason };
    this.announce(run);
  }

  private finish(run: LiveRun, status: "exited" | "failed", detail: { exitCode?: number; signal?: string; error?: string }): void {
    run.status = status;
    run.endedAt = this.now();
    if (detail.exitCode !== undefined) run.exitCode = detail.exitCode;
    if (detail.signal) run.signal = detail.signal;
    if (detail.error) run.error = redactText(detail.error, run.secrets);
    if (run.readyTimer) clearInterval(run.readyTimer);
    if (run.readiness.kind === "pending") run.readiness = { kind: "none" };
    run.settled = true;
    // Accounted for: nothing is left for a future daemon to warn about.
    this.closeRecord(run);
    this.wake(run);
    this.announce(run);
  }

  private wake(run: LiveRun): void {
    const waiters = run.waiters;
    run.waiters = [];
    for (const waiter of waiters) waiter();
  }

  /** Keep the recent dead around for their output; forget the rest. */
  private prune(projectId: string): void {
    const finished = [...this.runs.values()]
      .filter((run) => run.projectId === projectId && isTerminal(run.status))
      .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
    for (const run of finished.slice(KEEP_TERMINAL)) this.runs.delete(run.runId);
  }

  private view(run: LiveRun): RunView {
    return {
      runId: run.runId,
      projectId: run.projectId,
      configId: run.config.id,
      // Every text field goes through the scrubber, not just the env list: a
      // human who marks TOKEN secret and pastes it into the command has put it
      // in a field this used to hand back verbatim.
      configName: redactText(run.configName, run.secrets),
      command: redactText(run.command, run.secrets),
      worktreePath: redactText(run.worktreePath, run.secrets),
      ...(run.worktreeBranch ? { worktreeBranch: redactText(run.worktreeBranch, run.secrets) } : {}),
      cwd: redactText(run.cwd, run.secrets),
      ...(run.sessionId ? { startedBySessionId: run.sessionId } : {}),
      status: run.status,
      readiness: run.readiness,
      ...(run.config.readinessUrl ? { readinessUrl: redactText(run.config.readinessUrl, run.secrets) } : {}),
      ...(run.handle?.pid !== undefined && !run.handleClosed ? { pid: run.handle.pid } : {}),
      ...(run.handle?.terminalId !== undefined && !run.handleClosed ? { terminalId: run.handle.terminalId } : {}),
      startedAt: run.startedAt,
      ...(run.endedAt ? { endedAt: run.endedAt } : {}),
      ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
      ...(run.signal ? { signal: run.signal } : {}),
      ...(run.error ? { error: run.error } : {}),
      env: (run.config.env ?? []).map((entry) => (entry.secret ? { key: entry.key, secret: true } : { key: entry.key, value: redactText(entry.value, run.secrets) })),
    };
  }
}
