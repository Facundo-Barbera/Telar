/**
 * THE SENTINEL LOOP — and the single property the whole design rests on:
 * **idle must be free.**
 *
 * `orchestrator.md` §3.6 names the failure mode this file exists to prevent: a
 * loop that wakes, invokes an agent, concludes "nothing to do," and reschedules
 * — forever. That is not a slow system, it is an expensive clock, and it is the
 * same cost trap the long-lived orchestrator had, wearing a timer instead of a
 * transcript. So the rule is absolute and it is enforced here rather than
 * promised in a prompt:
 *
 *   **THE SENTINEL MUST BE ABLE TO SAY "NOTHING CHANGED" WITHOUT INVOKING AN
 *   AGENT.** If it cannot, the design leaks.
 *
 * A pass costs exactly one `probe` command. `probe`'s contract (§1) is one line
 * of stdout, cheap, LLM-free; that line is the fingerprint. Same line as last
 * time and nothing in flight ⇒ back off and return. No prompt is assembled, no
 * model is loaded, no token is spent.
 *
 * ── A FAILING PROBE IS `unknown`, NOT `no` AND NOT `yes` ────────────────────
 * `gh` rate-limited, network down, credentials expired: exit non-zero. The
 * tempting readings are both wrong. Treating it as "changed" wakes an agent
 * every interval for as long as the outage lasts — the cost trap again, now
 * triggered by someone else's outage. Treating it as "unchanged" lets the
 * backoff climb to an hour on evidence that was never gathered, so the moment
 * the network returns the system is asleep. So: record the error, do not wake,
 * and **do not touch the backoff**. The interval stays exactly where the last
 * real observation left it.
 *
 * ── ONE TIMER, INJECTED, UNREF'D ────────────────────────────────────────────
 * `daemon.ts:343` is the repo's one recurring-timer precedent and this follows
 * it exactly: injectable, `.unref()`ed when real, cleared in `close()`. Not
 * style — a test that cannot stop this timer hangs the suite, and a real timer
 * that is not unref'd keeps the process alive after `close()`.
 *
 * ONE INTERVAL FOR ALL PROJECTS, ticking fast and cheap, with each project's own
 * cadence expressed as `nextProbeAt`. N projects would otherwise mean N timers
 * to leak, and a per-project backoff would need its timer rescheduled on every
 * pass anyway.
 */
import type { LoomProgram, LoomWatch } from "@telar/engine-client";
import { fingerprintFrom, hasChanged, nextInterval } from "./sentinel";
import { isActive } from "./machine";
import { listLooms, listProjectIds, readWatch, readSentinel, writeSentinel, writeWatch, type LoomPaths } from "./store";
import { DEFAULT_TIMEOUT_MS, type LoomExec } from "./exec";

/** A probe is contractually cheap. If it has not answered in 30s it is not the
 *  thing §3.6 described, and waiting the full command timeout would stall every
 *  other project's pass behind it. */
export const PROBE_TIMEOUT_MS = 30_000;

/** How often the single timer looks for a project that is due. Granularity, not
 *  cadence: the cadence is each watch's `intervalSec`. */
export const POLL_MS = 1_000;

export type LoomTimer = { clear(): void };

/**
 * A LOOK AT THE WORLD, PASS OR UNKNOWN — §3's gate vocabulary, reused rather
 * than paralleled, because it is the same judgement about the same kind of
 * evidence. There is deliberately no `fail`: a command that RAN and reported
 * "no work" is a pass with an empty answer, which is an ordinary quiet night.
 * The only other thing a read can be is one that did not happen.
 */
export type WorldRead = { outcome: "pass" } | { outcome: "unknown"; error: string };

export type LoomSupervisorDeps = {
  paths: LoomPaths;
  exec: LoomExec;
  now: () => Date;
  projectRoot: (projectId: string) => string | null;
  readProgram: (projectId: string) => LoomProgram | null;
  /** Fires a tick. The reason is passed through to the ledger. */
  onWake: (projectId: string, reason: string) => void;
  /**
   * Fires a reconcile — §6's first branch, "advance it (no agent needed)".
   * SEPARATE FROM `onWake` because the distinction is the file's whole point:
   * a loom in flight needs its state machine walked, which costs a few git
   * commands, and calling `onWake` for it would spend an agent on a question
   * machinery already answers. Absent ⇒ falls back to `onWake`, which is
   * correct but not free.
   */
  onAdvance?: (projectId: string) => void;
  /** `daemon.ts:343`'s shape. Injected so a test can fire passes by hand. */
  interval?: (fn: () => void, ms: number) => LoomTimer;
  pollMs?: number;
};

export type LoomSupervisor = {
  watch(projectId: string): LoomWatch;
  /**
   * Arm the timer if — and only if — some watch on disk is already `running`.
   *
   * FOR A DAEMON RESTART, and deliberately NOT called by the factory. A watch
   * is persisted, so a machine that rebooted overnight still has one marked
   * running; without this the supervisor would sit inert until a human clicked
   * something. Left as a separate verb because construction must be inert (a
   * first-run engine has no project, no Program, and no business probing).
   */
  resume(): void;
  setWatch(projectId: string, running: boolean): LoomWatch;
  list(): LoomWatch[];
  /** A human acted, or a worker exited. Immediate, and it resets the backoff —
   *  the whole reason the backoff exists is that nothing was happening, and
   *  something just did. */
  wake(projectId: string, reason: string): void;
  /**
   * WHAT THE TICK SAW WHEN IT TRIED TO READ THE WORLD — the same tri-state this
   * file already applies to `probe`, arriving from one layer up.
   *
   * The probe is not the only look this system takes at a project: the tick's
   * `list` is the other, and it can fail for exactly the reasons the probe can
   * (expired credential, rate limit, a typo in the Program). Both are world
   * reads and both must obey the header's rule — `unknown` is neither `yes` nor
   * `no`. Without this the supervisor would keep its own counsel: the probe
   * would keep succeeding (a `git` one-liner needs no credentials), every pass
   * would score as quiet, the backoff would climb to an hour, and a project
   * that has been unable to read its backlog since midnight would look exactly
   * like one with nothing to do.
   *
   * `unknown` therefore does two things and no more: it pins the reason to the
   * watch record where the deck already renders it, and it stops the project
   * being counted quiet. It never wakes anything — waking on a failure is the
   * cost trap in the other direction.
   */
  observe(projectId: string, read: WorldRead): LoomWatch;
  /** Exposed for tests and for the wiring's own "probe now". Never throws. */
  pass(projectId: string): Promise<LoomWatch>;
  close(): void;
};

function defaultInterval(fn: () => void, ms: number): LoomTimer {
  const timer = setInterval(fn, ms);
  // See the header: without this a closed daemon still holds the event loop.
  timer.unref?.();
  return { clear: () => clearInterval(timer) };
}

export function createLoomSupervisor(deps: LoomSupervisorDeps): LoomSupervisor {
  const makeInterval = deps.interval ?? defaultInterval;
  /** One pass per project at a time. A `probe` slower than the poll cadence
   *  would otherwise stack passes on top of each other, each fingerprinting a
   *  world the previous one is still measuring. */
  const inPass = new Set<string>();
  /**
   * PROJECTS WHOSE LAST WORLD-READ DID NOT HAPPEN, and the reason.
   *
   * Held here rather than derived from `lastError`, which cannot answer the
   * question: `lastError` is one string used by several writers, so a probe
   * that succeeds would clear a `list` failure that is still true and the deck
   * would go quiet again while the project stayed broken. This says WHICH kind
   * of failure is outstanding, which is what the quiet accounting below needs.
   *
   * IN MEMORY, AND THAT IS AN ACCEPTED LIMIT rather than an oversight. It is
   * the same posture `run.ts` takes: a marker on disk claiming a project is
   * unreadable would outlive the outage and could only be cleared by a tick
   * that a backed-off supervisor was no longer scheduling. After a restart the
   * project simply re-earns the mark on its next tick, and the `lastError`
   * written below — which IS persisted — is what a human reads in the meantime.
   */
  const unreadable = new Map<string, string>();
  let closed = false;
  /**
   * NOTHING IS ARMED AT CONSTRUCTION.
   *
   * A daemon boots with no project configured and no Program on disk; a timer
   * started there would begin running `probe` — someone's `gh` quota — with
   * nobody watching and nothing to decide. So the interval is created on the
   * first `running` watch and cleared again the moment the last one stops. That
   * also means `close()` on a daemon that never watched anything has nothing to
   * tear down, which is the leaked-handle failure mode this avoids.
   */
  let timer: LoomTimer | null = null;

  const nowMs = (): number => deps.now().getTime();

  const save = (projectId: string, watch: LoomWatch): LoomWatch => writeWatch(deps.paths, projectId, watch);

  const pass = async (projectId: string): Promise<LoomWatch> => {
    const watch = readWatch(deps.paths, projectId);
    if (!watch.running || closed) return watch;

    const at = nowMs();
    const program = deps.readProgram(projectId);
    const root = deps.projectRoot(projectId);

    // A watch running against a project with no Program is not an error to
    // throw — the human turned it on and the Program may land in a minute. It
    // is recorded where the deck can show it, and nothing is woken.
    if (!program || !root) {
      return save(projectId, {
        ...watch,
        lastProbeAt: at,
        nextProbeAt: at + watch.intervalSec * 1000,
        lastError: !root
          ? `project ${projectId} has no root on this machine, so nothing can be probed`
          : `project ${projectId} has no .telar/loom.md, so there is no probe to run`,
      });
    }

    const active = activeCount(deps, projectId);

    // NO PROBE DECLARED ⇒ PURE HEARTBEAT (§3.8: every event source is additive,
    // none is required for correctness). A project with no tracker, no git and
    // no credentials still works — it just wakes on the timer, which is the
    // slower system the spec promises rather than the broken one.
    const probe = program.commands.probe;
    if (!probe) {
      wakeFor(projectId, active, "heartbeat (the Program declares no probe)");
      return save(projectId, {
        ...watch,
        lastProbeAt: at,
        quietChecks: 0,
        nextProbeAt: at + watch.intervalSec * 1000,
        lastError: undefined,
      });
    }

    const result = await deps.exec({ command: probe, cwd: root, timeoutMs: Math.min(PROBE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS) });

    if (result.code !== 0) {
      // See the header. `unknown`: record it, wake nothing, and leave the
      // backoff exactly where the last REAL observation put it.
      const detail = (result.stderr.trim() || result.stdout.trim() || "no output").split("\n").slice(0, 4).join(" ");
      return save(projectId, {
        ...watch,
        lastProbeAt: at,
        nextProbeAt: at + watch.intervalSec * 1000,
        lastError: result.timedOut
          ? `probe timed out after ${Math.round(PROBE_TIMEOUT_MS / 1000)}s; a probe is contractually cheap, so this one is probably doing too much`
          : `probe exited ${result.code}: ${detail}`,
      });
    }

    const next = fingerprintFrom(result.stdout, at);
    // `undefined` is NEVER PROBED, which is deliberately not the same as
    // "probed and printed an empty line" — so it counts as a change and the
    // first pass on a fresh project wakes. `hasChanged` owns that rule.
    const previous = readSentinel(deps.paths, projectId);
    const changed = hasChanged(previous, next);
    writeSentinel(deps.paths, projectId, next);

    if (changed) {
      wakeFor(projectId, active, "the probe fingerprint changed");
      return save(projectId, {
        ...watch,
        intervalSec: nextInterval(watch.intervalSec, true, program),
        quietChecks: 0,
        lastProbeAt: at,
        lastChangeAt: at,
        nextProbeAt: at + nextInterval(watch.intervalSec, true, program) * 1000,
        // A SUCCESSFUL PROBE DOES NOT CLEAR A FAILED `list`. It clears what it
        // is evidence about — itself — and an outstanding world-read failure
        // stays on the record until the read that failed succeeds. The tick
        // this wake is about to fire is what will settle that either way.
        lastError: unreadable.get(projectId),
      });
    }

    // UNCHANGED. The two branches below are the file's thesis.
    if (active > 0) {
      // Something is in flight. Advance it — git commands, no agent — and do
      // NOT count this as a quiet pass: the world is busy, it just is not busy
      // in a way `probe` can see. Backing off here would make a finished worker
      // wait an hour to be noticed.
      (deps.onAdvance ?? ((id: string) => deps.onWake(id, "a loom is in flight")))(projectId);
      return save(projectId, {
        ...watch,
        lastProbeAt: at,
        nextProbeAt: at + watch.intervalSec * 1000,
        // See the `changed` branch: the probe answers for the probe only.
        lastError: unreadable.get(projectId),
      });
    }

    /**
     * Nothing changed and nothing in flight. THE FREE PASS: back off, return,
     * and spend nothing.
     *
     * UNLESS THE LAST WORLD-READ NEVER HAPPENED, in which case this pass is not
     * evidence of quiet and must not be spent as though it were. The probe here
     * succeeded — but a probe is one look and `list` is another, and a project
     * whose credential expired can easily keep passing a `git`-only probe while
     * its backlog has been unreadable for hours. Counting that as quiet is how
     * a broken project decays to an hourly cadence and stops being retried at
     * the rate its human configured. Same rule as the failing-probe branch
     * above, same reason: the interval stays where the last REAL observation
     * left it.
     */
    const outstanding = unreadable.get(projectId);
    if (outstanding !== undefined) {
      return save(projectId, {
        ...watch,
        lastProbeAt: at,
        nextProbeAt: at + watch.intervalSec * 1000,
        lastError: outstanding,
      });
    }

    const backedOff = nextInterval(watch.intervalSec, false, program);
    return save(projectId, {
      ...watch,
      intervalSec: backedOff,
      quietChecks: watch.quietChecks + 1,
      lastProbeAt: at,
      nextProbeAt: at + backedOff * 1000,
      lastError: undefined,
    });
  };

  function wakeFor(projectId: string, active: number, reason: string): void {
    deps.onWake(projectId, active > 0 ? `${reason}; ${active} loom(s) in flight` : reason);
  }

  const sweep = (): void => {
    if (closed) return;
    const at = nowMs();
    const watches = listWatches(deps);
    // The last watch was turned off, or its project's store was removed. Stop
    // burning a timer on a sweep that can never find anything.
    if (!watches.some((watch) => watch.running)) {
      disarm();
      return;
    }
    for (const watch of watches) {
      if (!watch.running) continue;
      if (watch.nextProbeAt !== undefined && watch.nextProbeAt > at) continue;
      if (inPass.has(watch.projectId)) continue;
      inPass.add(watch.projectId);
      // DETACHED, AND THE `.catch` IS NOT DECORATION: an unhandled rejection on
      // a background promise takes the daemon down in Bun (`state.ts:2112-2126`).
      // A pass that throws must cost this project's pass and nothing else.
      void pass(watch.projectId)
        .catch(() => undefined)
        .finally(() => inPass.delete(watch.projectId));
    }
  };

  const arm = (): void => {
    if (timer || closed) return;
    timer = makeInterval(sweep, deps.pollMs ?? POLL_MS);
  };
  const disarm = (): void => {
    timer?.clear();
    timer = null;
  };

  return {
    watch: (projectId) => readWatch(deps.paths, projectId),
    setWatch(projectId, running) {
      const current = readWatch(deps.paths, projectId);
      const at = nowMs();
      const program = deps.readProgram(projectId);
      // Turning a watch ON resets the cadence to the Program's base. The
      // backoff describes how long nothing has been happening, and a human
      // reaching for the switch is itself evidence that something has.
      const intervalSec = running ? (program?.watch.intervalSec ?? current.intervalSec) : current.intervalSec;
      const saved = save(projectId, {
        ...current,
        running,
        intervalSec,
        quietChecks: running ? 0 : current.quietChecks,
        nextProbeAt: running ? at : undefined,
        lastError: running ? undefined : current.lastError,
      });
      // A HUMAN REACHING FOR THE SWITCH is evidence that something changed —
      // usually that they just fixed the credential. The mark is dropped for
      // the same reason the backoff is reset, and the next tick re-earns it if
      // the world is still unreadable.
      if (running) unreadable.delete(projectId);
      if (running) arm();
      else if (!listWatches(deps).some((watch) => watch.running)) disarm();
      return saved;
    },
    resume() {
      if (listWatches(deps).some((watch) => watch.running)) arm();
    },
    list: () => listWatches(deps),
    wake(projectId, reason) {
      const current = readWatch(deps.paths, projectId);
      const program = deps.readProgram(projectId);
      save(projectId, {
        ...current,
        intervalSec: program?.watch.intervalSec ?? current.intervalSec,
        quietChecks: 0,
        nextProbeAt: nowMs(),
      });
      arm();
      deps.onWake(projectId, reason);
    },
    observe(projectId, read) {
      const current = readWatch(deps.paths, projectId);
      if (read.outcome === "pass") {
        // ONLY WHAT THIS MARKED IS CLEARED. A `lastError` written by something
        // else — a failing probe, a missing Program — is a different fact about
        // a different command, and a tick succeeding is no evidence about it.
        // Erasing it here would let one working read hide another broken one,
        // which is the same collapse this whole change exists to undo.
        if (!unreadable.delete(projectId)) return current;
        return save(projectId, { ...current, lastError: undefined });
      }
      unreadable.set(projectId, read.error);
      // NO WAKE, NO BACKOFF CHANGE. Recording, and nothing else: the interval
      // stays where the last real observation left it, which is what keeps the
      // project being retried at its normal cadence through the outage.
      return save(projectId, { ...current, lastError: read.error });
    },
    pass: (projectId) => pass(projectId).catch(() => readWatch(deps.paths, projectId)),
    close() {
      closed = true;
      disarm();
    },
  };
}

/** Non-terminal looms, which is §6's "anything in flight". */
function activeCount(deps: Pick<LoomSupervisorDeps, "paths">, projectId: string): number {
  try {
    return listLooms(deps.paths, projectId).looms.filter((loom) => isActive(loom)).length;
  } catch {
    // A store that cannot be read is not a reason to stop watching. Treating it
    // as "nothing in flight" is the conservative half: it can only cause a
    // back-off, never a spend.
    return 0;
  }
}

function listWatches(deps: Pick<LoomSupervisorDeps, "paths">): LoomWatch[] {
  try {
    return listProjectIds(deps.paths).map((projectId) => readWatch(deps.paths, projectId));
  } catch {
    // A store root that does not exist yet is the ordinary first-run state, not
    // a failure: there is nothing to watch, so the sweep has nothing to do.
    return [];
  }
}
