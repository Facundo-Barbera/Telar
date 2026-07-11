// Unit 3 — supervisor: fully hermetic. No real timers/processes/network/fs-watch.
// A manual clock (now/schedule/cancel + advance) drives every interval and
// backoff; a fake SupervisedHandle scripts isAlive/restart/logTail; checkHealth
// is injected with a scripted health sequence; onEscalate is captured.
import { describe, expect, test } from "bun:test";
import { superviseService, type Escalation, type ServiceState, type SupervisedHandle } from "../src/supervisor";
import { ServiceConfig } from "../src/schemas";

// --- manual clock -----------------------------------------------------------

function fakeClock(start = 0) {
  let t = start;
  let seq = 1;
  type Task = { id: number; at: number; cb: () => void };
  let tasks: Task[] = [];

  const now = () => t;
  const schedule = (cb: () => void, ms: number): number => {
    const id = seq++;
    tasks.push({ id, at: t + ms, cb });
    return id;
  };
  const cancel = (h: unknown): void => {
    tasks = tasks.filter((task) => task.id !== h);
  };
  // Let queued microtasks/promises settle (checkHealth/restart are immediate
  // promises). A single macrotask boundary drains the whole microtask queue.
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));

  async function advance(ms: number): Promise<void> {
    const target = t + ms;
    // Fire due tasks in time order; each may schedule follow-ups (reschedule,
    // backoff) which are picked up on the next iteration.
    for (;;) {
      const due = tasks
        .filter((task) => task.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id);
      if (due.length === 0) break;
      const next = due[0];
      tasks = tasks.filter((task) => task.id !== next.id);
      t = next.at;
      next.cb();
      await flush();
    }
    t = target;
    await flush();
  }

  return { now, schedule, cancel, advance, pending: () => tasks.length };
}

// --- fake handle ------------------------------------------------------------

function fakeHandle(
  overrides: Partial<Pick<SupervisedHandle, "isAlive" | "restart" | "logTail">> = {},
): SupervisedHandle {
  return {
    name: "web",
    port: 5000,
    url: "http://localhost:5000",
    stop: async () => {},
    isAlive: overrides.isAlive ?? (() => true),
    restart: overrides.restart ?? (async () => {}),
    logTail: overrides.logTail,
  };
}

// A ServiceConfig with a healthcheck (so it is supervised) at intervalMs, and
// an optional restartPolicy override.
function svcCfg(intervalMs: number, restartPolicy?: Record<string, unknown>): ServiceConfig {
  return ServiceConfig.parse({
    command: "run",
    portStrategy: "fixed",
    port: 5000,
    healthcheck: { kind: "http", path: "/", status: 200, intervalMs },
    ...(restartPolicy ? { restartPolicy } : {}),
  });
}

const INTERVAL = 500;

// A scripted health probe: returns each verdict in turn, repeating the last.
function scriptedHealth(seq: Array<"healthy" | "unhealthy">) {
  let i = 0;
  return async () => {
    const v = seq[Math.min(i, seq.length - 1)];
    i++;
    return v;
  };
}

// --- tests ------------------------------------------------------------------

describe("superviseService — health", () => {
  test("(a) a healthy service stays quiet — no escalation, no restart", async () => {
    const clock = fakeClock();
    const escalations: Escalation[] = [];
    let restarts = 0;
    const h = fakeHandle({ restart: async () => void restarts++ });
    const sup = superviseService(h, svcCfg(INTERVAL), {
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
      checkHealth: scriptedHealth(["healthy"]),
      onEscalate: (e) => escalations.push(e),
    });

    await clock.advance(INTERVAL * 10);
    expect(escalations).toHaveLength(0);
    expect(restarts).toBe(0);
    expect(sup.state()).toBe("healthy");
    await sup.stop();
    expect(clock.pending()).toBe(0);
  });

  test("healthcheck detects unhealth (quiescent) → alarms, never restarts", async () => {
    const clock = fakeClock();
    const escalations: Escalation[] = [];
    let restarts = 0;
    const h = fakeHandle({ restart: async () => void restarts++, logTail: () => "overlay error" });
    // No editActivity ⇒ default lastEditAt()=>null ⇒ always quiescent.
    const sup = superviseService(h, svcCfg(INTERVAL), {
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
      checkHealth: scriptedHealth(["unhealthy"]),
      onEscalate: (e) => escalations.push(e),
    });

    await clock.advance(INTERVAL * 5);
    expect(restarts).toBe(0); // unhealth NEVER restarts
    expect(escalations).toHaveLength(1); // once per episode
    expect(escalations[0].reason).toBe("down-after-quiescence");
    expect(escalations[0].logTail).toBe("overlay error");
    expect(sup.state()).toBe("unhealthy");
    await sup.stop();
  });
});

describe("superviseService — process death & restart policy", () => {
  test("(b) a dead process is respawned within policy and returns healthy", async () => {
    const clock = fakeClock();
    const escalations: Escalation[] = [];
    let dead = true; // starts dead → first tick restarts it
    let restarts = 0;
    const h = fakeHandle({
      isAlive: () => !dead,
      restart: async () => {
        restarts++;
        dead = false; // came back ready
      },
    });
    const sup = superviseService(h, svcCfg(INTERVAL, { backoffMs: 1000, maxRestarts: 3 }), {
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
      checkHealth: scriptedHealth(["healthy"]),
      onEscalate: (e) => escalations.push(e),
    });

    await clock.advance(INTERVAL); // tick → death detected → restarting
    await clock.advance(1000); // backoff elapses → restart resolves
    expect(restarts).toBe(1);
    expect(escalations).toHaveLength(0);
    expect(sup.state()).toBe("healthy");
    await sup.stop();
  });

  test("(c) crash-loop (> maxRestarts in window) circuit-breaks & escalates ONCE with a log tail", async () => {
    const clock = fakeClock();
    const escalations: Escalation[] = [];
    let restarts = 0;
    // restart() resolves but the process is dead again immediately (boot-crash).
    const h = fakeHandle({
      isAlive: () => false,
      restart: async () => void restarts++,
      logTail: () => "SyntaxError: boom\n",
    });
    const sup = superviseService(h, svcCfg(INTERVAL, { maxRestarts: 3, backoffMs: 1000 }), {
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
      checkHealth: scriptedHealth(["healthy"]),
      onEscalate: (e) => escalations.push(e),
    });

    // Drive many interval+backoff cycles; the breaker must trip and then stop.
    await clock.advance((INTERVAL + 1000) * 10);
    expect(restarts).toBe(3); // exactly maxRestarts attempts, then no more
    expect(escalations).toHaveLength(1);
    expect(escalations[0].reason).toBe("crash-loop");
    expect(escalations[0].restarts).toBe(3);
    expect(escalations[0].logTail).toBe("SyntaxError: boom\n");
    expect(sup.state()).toBe("crash-looped");
    await sup.stop();
    expect(clock.pending()).toBe(0);
  });

  test("(d) onCrash:false → never restarts, goes stopped and escalates once", async () => {
    const clock = fakeClock();
    const escalations: Escalation[] = [];
    let restarts = 0;
    const h = fakeHandle({ isAlive: () => false, restart: async () => void restarts++ });
    const sup = superviseService(h, svcCfg(INTERVAL, { onCrash: false }), {
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
      checkHealth: scriptedHealth(["healthy"]),
      onEscalate: (e) => escalations.push(e),
    });

    await clock.advance(INTERVAL * 5);
    expect(restarts).toBe(0);
    expect(escalations).toHaveLength(1);
    expect(escalations[0].reason).toBe("crash-loop");
    expect(escalations[0].restarts).toBe(0);
    expect(sup.state()).toBe("stopped");
    await sup.stop();
    expect(clock.pending()).toBe(0);
  });

  test("(h) a restart that never comes ready counts toward maxRestarts → breaker trips", async () => {
    const clock = fakeClock();
    const escalations: Escalation[] = [];
    let attempts = 0;
    const h = fakeHandle({
      isAlive: () => false,
      restart: async () => {
        attempts++;
        throw new Error("did not respond within 60000ms");
      },
      logTail: () => "boot log",
    });
    const sup = superviseService(h, svcCfg(INTERVAL, { maxRestarts: 2, backoffMs: 1000 }), {
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
      checkHealth: scriptedHealth(["healthy"]),
      onEscalate: (e) => escalations.push(e),
    });

    await clock.advance((INTERVAL + 1000) * 6);
    expect(attempts).toBe(2); // both failed attempts count
    expect(escalations).toHaveLength(1);
    expect(escalations[0].reason).toBe("crash-loop");
    expect(escalations[0].restarts).toBe(2);
    expect(escalations[0].lastError).toContain("did not respond");
    expect(sup.state()).toBe("crash-looped");
    await sup.stop();
  });
});

describe("superviseService — mid-edit tolerance", () => {
  test("(e) unhealthy WHILE editing → mid-edit-degraded, zero restarts, zero alarms", async () => {
    const clock = fakeClock();
    const escalations: Escalation[] = [];
    let restarts = 0;
    const h = fakeHandle({ restart: async () => void restarts++ });
    const sup = superviseService(h, svcCfg(INTERVAL), {
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
      checkHealth: scriptedHealth(["unhealthy"]),
      // Continuous editing: lastEditAt is always "now".
      editActivity: { lastEditAt: () => clock.now() },
      quiescenceMs: 1000,
      onEscalate: (e) => escalations.push(e),
    });

    await clock.advance(INTERVAL * 10);
    expect(restarts).toBe(0);
    expect(escalations).toHaveLength(0); // tolerated, no alarm while editing
    expect(sup.state()).toBe("mid-edit-degraded");
    await sup.stop();
  });

  test("(f) unhealthy, edits stop, quiescence elapses, still down → single down-after-quiescence alarm", async () => {
    const clock = fakeClock();
    const escalations: Escalation[] = [];
    let restarts = 0;
    const lastEdit = 0; // last edit at t=0; clock advances past it
    const h = fakeHandle({ restart: async () => void restarts++, logTail: () => "compile err" });
    const sup = superviseService(h, svcCfg(INTERVAL), {
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
      checkHealth: scriptedHealth(["unhealthy"]),
      editActivity: { lastEditAt: () => lastEdit },
      quiescenceMs: 1000,
      onEscalate: (e) => escalations.push(e),
    });

    // Within quiescence (< 1000ms since edit): tolerated.
    await clock.advance(INTERVAL); // t=500, editedWithin(1000) true
    expect(sup.state()).toBe("mid-edit-degraded");
    expect(escalations).toHaveLength(0);

    // Past quiescence and still unhealthy: exactly one alarm, then quiet.
    await clock.advance(INTERVAL * 10);
    expect(restarts).toBe(0); // still never restarts on unhealth
    expect(escalations).toHaveLength(1);
    expect(escalations[0].reason).toBe("down-after-quiescence");
    expect(escalations[0].logTail).toBe("compile err");
    expect(sup.state()).toBe("unhealthy");
    await sup.stop();
  });

  test("(g) true process DEATH mid-edit restarts anyway (liveness ignores edit activity)", async () => {
    const clock = fakeClock();
    const escalations: Escalation[] = [];
    let dead = true;
    let restarts = 0;
    const h = fakeHandle({
      isAlive: () => !dead,
      restart: async () => {
        restarts++;
        dead = false;
      },
    });
    const sup = superviseService(h, svcCfg(INTERVAL, { backoffMs: 1000 }), {
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
      checkHealth: scriptedHealth(["healthy"]),
      // Continuously editing — must NOT keep a dead process alive.
      editActivity: { lastEditAt: () => clock.now() },
      quiescenceMs: 1000,
      onEscalate: (e) => escalations.push(e),
    });

    await clock.advance(INTERVAL);
    await clock.advance(1000);
    expect(restarts).toBe(1); // death restarted despite active editing
    expect(escalations).toHaveLength(0);
    expect(sup.state()).toBe("healthy");
    await sup.stop();
  });
});

describe("superviseService — stop()", () => {
  test("stop() ends supervision cleanly — no dangling timers", async () => {
    const clock = fakeClock();
    const h = fakeHandle();
    const sup = superviseService(h, svcCfg(INTERVAL), {
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
      checkHealth: scriptedHealth(["healthy"]),
    });

    await clock.advance(INTERVAL * 3);
    expect(clock.pending()).toBe(1); // the next scheduled tick
    await sup.stop();
    expect(clock.pending()).toBe(0); // cancelled
    // Further advancing does nothing (loop is stopped).
    const states: ServiceState[] = [];
    await clock.advance(INTERVAL * 5);
    expect(clock.pending()).toBe(0);
    expect(states).toHaveLength(0);
  });

  test("stop() during a restart backoff unblocks cleanly (no dangling timers)", async () => {
    const clock = fakeClock();
    const h = fakeHandle({ isAlive: () => false, restart: async () => {} });
    const sup = superviseService(h, svcCfg(INTERVAL, { backoffMs: 10_000 }), {
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
      checkHealth: scriptedHealth(["healthy"]),
    });

    await clock.advance(INTERVAL); // death → enters backoff (a 10s delay pending)
    expect(sup.state()).toBe("restarting");
    await sup.stop(); // must force-resolve the in-flight backoff and return
    expect(clock.pending()).toBe(0);
  });
});
