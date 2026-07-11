// Unit 3 — Lane Service Supervisor.
//
// Owns a lane's process lifecycle independently of any single build/verify
// attempt (verification-environments.md §4.4). It runs each service's
// `healthcheck` continuously and splits "the service is misbehaving" into two
// orthogonal axes that §4.4 treats completely differently:
//
//   LIVENESS — is the child process alive? (handle.isAlive()) → PROCESS DEATH
//     → restart, gated by restartPolicy, bounded, crash-loop-broken. Edit
//     activity is IRRELEVANT: a dead process is dead.
//   HEALTH — does the alive process answer its probe? (checkHealth) →
//     TRANSIENT UNHEALTH → tolerate-or-escalate, NEVER restart. A live-but-
//     failing dev server is a code error the framework already survives;
//     restarting it is futile and races the builder.
//
// Cardinal rule: restart is ONLY ever triggered by process death, never by
// unhealth. Unhealth's only outcomes are *tolerate* (while editing) or
// *escalate* (after quiescence-and-still-down).
//
// A NEW, OPT-IN module: nothing supervises unless superviseLane/superviseService
// is called. No executor wiring (Unit 7). Everything is injectable so tests are
// fully hermetic — no real timers, processes, network, or fs-watch.
import type { Lane, ServiceHandle } from "./run-server";
import { defaultRunCommand, makeReadyPredicate } from "./run-server";
import { RestartPolicy, type HealthCheck, type ServersConfig, type ServiceConfig } from "./schemas";

// The Unit-2 handle plus the restart seam. The three seam fields are OPTIONAL
// on ServiceHandle for back-compat; the supervisor requires isAlive/restart.
export type SupervisedHandle = ServiceHandle & {
  isAlive: () => boolean;
  restart: () => Promise<void>;
  logTail?: () => string;
};

export type ServiceState =
  | "starting"
  | "healthy"
  | "unhealthy" // alive but probe failing (and quiescent)
  | "mid-edit-degraded" // unhealthy AND builder editing → tolerated
  | "restarting"
  | "crash-looped"
  | "stopped";

export type EscalationReason = "crash-loop" | "down-after-quiescence";

export type Escalation = {
  service: string;
  reason: EscalationReason;
  restarts: number; // restarts counted in the window (crash-loop)
  windowMs: number;
  logTail: string; // captured tail — the "why" a human needs
  lastError?: string; // last spawn/readiness error message
  at: number; // now()
};

// Injectable edit-activity signal. Real fs-watch wiring is DEFERRED to Unit 7;
// here it is pure data so tests are hermetic and the executor can feed it later.
export type EditActivity = {
  lastEditAt: () => number | null; // ms epoch of last file touch, null = unknown/never
  editedWithin?: (windowMs: number) => boolean; // derived default provided if absent
};

export type SuperviseOpts = {
  // clock + scheduler (hermetic tests): no real timers required.
  now?: () => number; // default Date.now
  schedule?: (cb: () => void, ms: number) => unknown; // default setTimeout
  cancel?: (h: unknown) => void; // default clearTimeout

  // health probe (default reuses Unit-2's http-status / command-exit-0 probe)
  checkHealth?: (h: SupervisedHandle, hc: HealthCheck, signal: AbortSignal) => Promise<"healthy" | "unhealthy">;

  // mid-edit tolerance
  editActivity?: EditActivity; // default: lastEditAt()=>null (never editing → never suppresses alarms)
  quiescenceMs?: number; // no-edit window before an unhealthy service alarms (default 10_000)

  // crash-loop breaker
  crashLoopWindowMs?: number; // sliding window for maxRestarts (default 60_000)

  // outputs
  onEscalate?: (e: Escalation) => void; // default: no-op
  onStateChange?: (service: string, s: ServiceState) => void; // observability
  logTail?: (h: SupervisedHandle) => string; // default: h.logTail?.() ?? ""
};

export type LaneSupervisor = {
  stop: () => Promise<void>; // stop SUPERVISING — does NOT stop the services (lane.stopAll owns that)
  states: () => Record<string, ServiceState>;
};

const DEFAULT_QUIESCENCE_MS = 10_000;
const DEFAULT_CRASH_LOOP_WINDOW_MS = 60_000;
const DEFAULT_INTERVAL_MS = 5_000;
const PROBE_ATTEMPT_TIMEOUT_MS = 2_000; // mirrors run-server POLL_ATTEMPT_TIMEOUT_MS

// Default health probe: reuse the identical Unit-2 readiness probe against the
// healthcheck treated as a ready-shaped view. http → res.status===hc.status;
// command → exitCode===0. (The command path uses the real cwd/env; command
// health real-wiring is a Unit-7 concern — tests inject checkHealth directly.)
function defaultCheckHealth(
  h: SupervisedHandle,
  hc: HealthCheck,
  signal: AbortSignal,
): Promise<"healthy" | "unhealthy"> {
  const readyView =
    hc.kind === "http"
      ? ({ kind: "http", path: hc.path, status: hc.status } as const)
      : ({ kind: "command", run: hc.run } as const);
  const predicate = makeReadyPredicate(readyView, {
    port: h.port,
    url: h.url,
    root: process.cwd(),
    env: process.env,
    fetchImpl: fetch,
    runCommand: defaultRunCommand,
  });
  return predicate(signal).then((ok) => (ok ? "healthy" : "unhealthy"));
}

/**
 * Supervise a single service. Built on by superviseLane; exported for tests.
 * Runs one self-rescheduling tick (period = healthcheck.intervalMs) that does
 * liveness-first, then health. Returns { stop, state }: stop() ends supervision
 * (cancels the pending timer, force-resolves an in-flight backoff, and awaits
 * the in-flight tick) but deliberately leaves the process running.
 */
export function superviseService(
  handle: SupervisedHandle,
  svc: ServiceConfig,
  opts: SuperviseOpts = {},
): { stop: () => Promise<void>; state: () => ServiceState } {
  const now = opts.now ?? Date.now;
  const schedule = opts.schedule ?? ((cb, ms) => setTimeout(cb, ms));
  const cancel = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const checkHealth = opts.checkHealth ?? defaultCheckHealth;
  const quiescenceMs = opts.quiescenceMs ?? DEFAULT_QUIESCENCE_MS;
  const crashLoopWindowMs = opts.crashLoopWindowMs ?? DEFAULT_CRASH_LOOP_WINDOW_MS;
  const onEscalate = opts.onEscalate ?? (() => {});
  const onStateChange = opts.onStateChange;
  const logTailFn = opts.logTail ?? ((h: SupervisedHandle) => h.logTail?.() ?? "");
  const editActivity = opts.editActivity ?? { lastEditAt: () => null };
  const editedWithin =
    editActivity.editedWithin ??
    ((w: number) => {
      const last = editActivity.lastEditAt();
      return last !== null && now() - last < w;
    });

  const hc = svc.healthcheck;
  const intervalMs = hc?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const policy = svc.restartPolicy ?? RestartPolicy.parse({});
  const name = handle.name;

  let state: ServiceState = "starting";
  let stopped = false;
  let unhealthySince: number | null = null;
  let alarmed = false; // down-after-quiescence fired this unhealthy episode
  let lastError: string | undefined;
  let restartTimes: number[] = []; // sliding window of restart timestamps

  let timer: unknown = null;
  let inflight: Promise<void> | null = null;
  let probeAbort: AbortController | null = null;
  let pendingBackoff: (() => void) | null = null; // resolve an in-flight backoff on stop

  const setState = (s: ServiceState): void => {
    if (state === s) return;
    state = s;
    onStateChange?.(name, s);
  };

  const escalate = (reason: EscalationReason, restarts: number, windowMs: number): void => {
    onEscalate({ service: name, reason, restarts, windowMs, logTail: logTailFn(handle), lastError, at: now() });
  };

  // A cancellable delay on the injected clock. stop() calls pendingBackoff to
  // force-resolve it so the in-flight tick unwinds without a real timer firing.
  const delay = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const h = schedule(() => {
        pendingBackoff = null;
        resolve();
      }, ms);
      pendingBackoff = () => {
        cancel(h);
        pendingBackoff = null;
        resolve();
      };
    });

  const reschedule = (): void => {
    if (stopped) return;
    timer = schedule(() => {
      timer = null;
      inflight = tick().finally(() => {
        inflight = null;
      });
    }, intervalMs);
  };

  // PROCESS DEATH path (§5). Reached only from a failed liveness check. Ends by
  // either reschedule() (restart succeeded) or by stopping the loop (policy
  // forbids / breaker tripped). Rejection from restart() counts as a re-death.
  const handleDeath = async (): Promise<void> => {
    if (stopped) return;

    if (!policy.onCrash) {
      setState("stopped");
      escalate("crash-loop", 0, crashLoopWindowMs);
      stopped = true; // policy forbids revival — stop supervising this service
      return;
    }

    const t = now();
    restartTimes = restartTimes.filter((ts) => t - ts < crashLoopWindowMs);
    if (restartTimes.length >= policy.maxRestarts) {
      setState("crash-looped");
      escalate("crash-loop", restartTimes.length, crashLoopWindowMs);
      stopped = true; // circuit-break: futile to keep restarting — hand a human the tail
      return;
    }

    restartTimes.push(t);
    setState("restarting");
    await delay(policy.backoffMs);
    if (stopped) return;
    try {
      await handle.restart();
      if (stopped) return;
      lastError = undefined;
      unhealthySince = null;
      alarmed = false;
      setState("starting");
      setState("healthy");
      reschedule();
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (stopped) return;
      // A restart that can't come ready is an immediate re-death → back to the
      // breaker (so a boot-crasher trips it instead of spinning forever).
      await handleDeath();
    }
  };

  const probe = async (): Promise<"healthy" | "unhealthy"> => {
    if (!hc) return "healthy"; // no healthcheck → liveness-only supervision
    const ac = new AbortController();
    probeAbort = ac;
    const timeoutHandle = schedule(() => ac.abort(), PROBE_ATTEMPT_TIMEOUT_MS);
    try {
      return await checkHealth(handle, hc, ac.signal);
    } catch {
      return "unhealthy";
    } finally {
      cancel(timeoutHandle);
      probeAbort = null;
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;

    // 1. LIVENESS FIRST. Edit activity is not consulted — a dead process is
    //    dead, restarted even mid-edit.
    if (!handle.isAlive()) {
      await handleDeath();
      return;
    }

    // 2. Alive → probe health.
    const result = await probe();
    if (stopped) return;

    if (result === "healthy") {
      unhealthySince = null;
      alarmed = false;
      setState("healthy");
      reschedule();
      return;
    }

    // 3. TRANSIENT UNHEALTH (alive, probe failing). NEVER restarts.
    if (unhealthySince === null) unhealthySince = now();
    if (editedWithin(quiescenceMs)) {
      // Tolerate: dev-server-overlay case — a compile error the framework shows
      // and recovers from on save. Stay quiet, keep probing.
      setState("mid-edit-degraded");
    } else {
      // Quiescent (no edits ≥ quiescenceMs) AND still down → alarm once per
      // episode (re-armed after a return to healthy, so it doesn't spam).
      setState("unhealthy");
      if (!alarmed) {
        alarmed = true;
        escalate("down-after-quiescence", 0, quiescenceMs);
      }
    }
    reschedule();
  };

  const stop = async (): Promise<void> => {
    stopped = true;
    if (timer != null) {
      cancel(timer);
      timer = null;
    }
    probeAbort?.abort();
    pendingBackoff?.(); // unblock an in-flight backoff so the tick unwinds
    if (inflight) await inflight;
  };

  reschedule(); // first tick fires one interval from now
  return { stop, state: () => state };
}

/**
 * Supervise every service in `config.services` that declares a `healthcheck`
 * (services without one are unsupervised — nothing to probe). One independent
 * superviseService loop per service. stop() cancels every loop and awaits the
 * in-flight ticks; it deliberately LEAVES THE PROCESSES RUNNING — lifecycle
 * ownership (lane.stopAll) stays with the lane/caller.
 */
export function superviseLane(lane: Lane, config: ServersConfig, opts: SuperviseOpts = {}): LaneSupervisor {
  const loops: Record<string, { stop: () => Promise<void>; state: () => ServiceState }> = {};

  for (const [name, svc] of Object.entries(config.services)) {
    if (!svc.healthcheck) continue; // unsupervised
    const handle = lane.services[name];
    if (!handle) continue; // service not brought up (nothing to supervise)
    if (typeof handle.isAlive !== "function" || typeof handle.restart !== "function") {
      throw new Error(
        `superviseLane: service "${name}" handle lacks the restart seam (isAlive/restart) — ` +
          `bring the lane up via startLane so the supervisor can restart on process death`,
      );
    }
    loops[name] = superviseService(handle as SupervisedHandle, svc, opts);
  }

  return {
    stop: async () => {
      await Promise.all(Object.values(loops).map((l) => l.stop()));
    },
    states: () => {
      const out: Record<string, ServiceState> = {};
      for (const [name, loop] of Object.entries(loops)) out[name] = loop.state();
      return out;
    },
  };
}
