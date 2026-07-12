// Telar run initializer (docs/loom-model.md D13, deferred-then-unblocked
// minimal version): a bundle loom's Critic Panel drives "the running
// product" (§4), but a shared, hardcoded `manifest.urls.dev` collides across
// concurrent looms. This gives each loom that has NO static url its own
// throwaway dev server on a free port, and a way to tear it down. No
// worktree isolation yet — D13 names that as a later step; this is the
// minimal "spin up on a free port at loom start, tear down at end" unblock.
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import type { ReadyCheck, ServersConfig, ServiceConfig } from "./schemas";

export type StartedServer = { url: string; port: number; stop: () => Promise<void> };

export type StartProjectServerOpts = {
  timeoutMs?: number;
  abort?: AbortController;
  // Test seams (never used outside tests): swap the real spawn/poll for
  // fakes so tests never spawn a real long-running process. Default to the
  // real implementations below.
  spawnFn?: (command: string, cwd: string, env: NodeJS.ProcessEnv) => ChildProcess;
  pollFn?: (url: string, signal: AbortSignal) => Promise<boolean>;
  // NEW (additive, opt-in): a declared readiness gate. Present ⇒ the real
  // readyCheck runner (§6) replaces pollFn/defaultPoll's "any response = up".
  // Absent ⇒ byte-identical to today's `pollFn ?? defaultPoll` path.
  readyCheck?: ReadyCheck;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 250;
const POLL_ATTEMPT_TIMEOUT_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Bind to port 0 so the OS assigns a free ephemeral port, read it back, then
// release it immediately — there is an inherent (tiny) race between release
// and the child binding, the same tradeoff every "find a free port" helper
// makes.
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : null;
      probe.close(() => (port ? resolve(port) : reject(new Error("could not determine a free port"))));
    });
  });
}

function defaultSpawn(command: string, cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  // detached => own process group, so stop() can kill the whole tree
  // (same pattern as gates.ts:runGate).
  return nodeSpawn(command, { shell: true, cwd, env, detached: true, stdio: "ignore" });
}

// Supervision-only spawn (opt-in via StartLaneOpts.captureLogs): pipe stdout/
// stderr so a ring buffer can feed `logTail()` on escalation. The default
// non-supervised path keeps `stdio:"ignore"` (byte-identical) — logs cost
// nothing until a caller asks to supervise.
function defaultSpawnPiped(command: string, cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  return nodeSpawn(command, { shell: true, cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
}

const LOG_TAIL_MAX = 16_384;

// Attach a bounded ring buffer to a child's piped stdout/stderr. Returns the
// getter used for `handle.logTail()`. Reused across restarts (same buffer).
function attachLogTail(ring: { text: string }, child: ChildProcess): void {
  const append = (chunk: unknown) => {
    ring.text += String(chunk);
    if (ring.text.length > LOG_TAIL_MAX) ring.text = ring.text.slice(-LOG_TAIL_MAX);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
}

async function defaultPoll(url: string, signal: AbortSignal): Promise<boolean> {
  try {
    await fetch(url, { signal });
    return true; // any response (including a non-2xx status) means "up"
  } catch {
    return false;
  }
}

// Kill the whole process group (SIGTERM, then SIGKILL if it doesn't exit in
// time). Falls back to killing just the child when the group kill fails
// (e.g. a fake/non-detached child in tests, or a process that already
// exited) — mirrors gates.ts's timeout-kill fallback.
function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.killed) return resolve();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(escalate);
      resolve();
    };
    child.once("exit", finish);

    const term = () => {
      try {
        if (!child.pid) throw new Error("no pid");
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          finish(); // nothing left to kill
        }
      }
    };
    term();

    const escalate = setTimeout(() => {
      try {
        if (!child.pid) throw new Error("no pid");
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
      // Safety net in case 'exit' never fires for a fake/detached child.
      setTimeout(finish, 200);
    }, 3_000);
  });
}

/**
 * Start `devCommand` in `root` on a free port and wait until it answers.
 * Returns the url/port plus a `stop()` that tears down the whole process
 * tree. Throws (after tearing the process down) if it never answers within
 * `timeoutMs` (default 60s).
 */
export async function startProjectServer(
  root: string,
  devCommand: string,
  opts: StartProjectServerOpts = {},
): Promise<StartedServer> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  const pollFn = opts.pollFn ?? defaultPoll;
  const abortSignal = opts.abort?.signal;

  const port = await findFreePort();
  const url = `http://localhost:${port}`;
  const child = spawnFn(devCommand, root, { ...process.env, PORT: String(port) });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await killTree(child);
  };

  let spawnError: Error | null = null;
  child.once("error", (err) => {
    spawnError = err instanceof Error ? err : new Error(String(err));
  });

  // Byte-identical default path: with no readyCheck the predicate is exactly
  // `pollFn(url, signal)` (pollFn ?? defaultPoll). An opt-in readyCheck swaps
  // in the real §6 runner (status match / exit-0), reusing the same loop.
  const predicate: ReadyPredicate = opts.readyCheck
    ? makeReadyPredicate(opts.readyCheck, {
        port,
        url,
        root,
        env: { ...process.env, PORT: String(port) },
        fetchImpl: fetch,
        runCommand: defaultRunCommand,
      })
    : (signal) => pollFn(url, signal);

  await awaitReady({
    predicate,
    timeoutMs,
    abortSignal,
    getSpawnError: () => spawnError,
    cleanup: stop,
    messages: {
      aborted: `startProjectServer: aborted while waiting for "${devCommand}" at ${url}`,
      spawnError: (m) => `startProjectServer: failed to spawn "${devCommand}": ${m}`,
      timeout: `startProjectServer: "${devCommand}" did not respond at ${url} within ${timeoutMs}ms`,
    },
  });

  return { url, port, stop };
}

// ---------------------------------------------------------------------------
// Lane (§3–§6): additive, opt-in one-shot bring-up of a project's declared
// services. Reuses findFreePort / defaultSpawn / killTree verbatim. Changes no
// executor call site; a `driver: none` / empty config is a no-op empty lane.
// ---------------------------------------------------------------------------

export type ServiceHandle = {
  name: string;
  port: number | null; // null: fixed service with no declared port
  url: string | null; // `http://localhost:${port}` when a port is known
  stop: () => Promise<void>;
  // Restart seam (Unit 3, all OPTIONAL for back-compat). Present only on lanes
  // brought up by startLane; the supervisor requires them. `isAlive`/`restart`
  // read a mutable current-child cell, so they track the process across
  // restarts. `logTail` is present only when `captureLogs` opts into piped
  // stdio (else stdio stays "ignore" and no tail exists).
  isAlive?: () => boolean; // child.exitCode === null && !child.killed
  restart?: () => Promise<void>; // re-spawn on the SAME port; resolves ready, rejects on spawn/timeout
  logTail?: () => string; // ring-buffered stdout/stderr for escalation
};

export type Lane = {
  services: Record<string, ServiceHandle>;
  stopAll: () => Promise<void>; // reverse order, idempotent, error-aggregating
};

// Pick the lane URL a read-only verify drives: the named app service if given,
// else the first service exposing a URL. Shared by frozenLaneVerify (the M4
// auto-repair leg) and runVerification (the M7 normal verify leg) so both
// resolve a lane target identically instead of duplicating the rule.
export function laneTarget(lane: Lane, appService?: string): string | undefined {
  if (appService && lane.services[appService]?.url) return lane.services[appService]!.url ?? undefined;
  for (const svc of Object.values(lane.services)) if (svc.url) return svc.url;
  return undefined;
}

export type CommandResult = { exitCode: number };

export type RunCommand = (
  cmd: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
) => Promise<CommandResult>;

export type StartLaneOpts = {
  timeoutMs?: number; // per-service readiness deadline (default 60_000)
  abort?: AbortController;
  env?: NodeJS.ProcessEnv; // base env (default process.env)
  spawnFn?: (command: string, cwd: string, env: NodeJS.ProcessEnv) => ChildProcess; // default defaultSpawn
  fetchImpl?: typeof fetch; // http readyCheck (default global fetch)
  runCommand?: RunCommand; // command readyCheck (default real exec)
  findPort?: () => Promise<number>; // default findFreePort
  // Opt-in (Unit 3): pipe child stdio into a per-service ring buffer and expose
  // it via `handle.logTail()` for escalation. Default false ⇒ stdio:"ignore".
  captureLogs?: boolean;
};

// Everything a restart needs (Unit 3 §6): the resolved spec computed once
// during the first bring-up and reused verbatim on every restart, so the same
// port/env peers already baked into their config stays valid.
type ResolvedService = {
  name: string;
  root: string;
  command: string;
  spawnEnv: NodeJS.ProcessEnv;
  port: number | null;
  url: string | null;
  readyCheck?: ReadyCheck;
};

type BringUpDeps = {
  spawnFn: (command: string, cwd: string, env: NodeJS.ProcessEnv) => ChildProcess;
  fetchImpl: typeof fetch;
  runCommand: RunCommand;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  onSpawn?: (child: ChildProcess) => void; // log-capture wiring
};

type ReadyPredicate = (signal: AbortSignal) => Promise<boolean>;

// Shared readiness loop — the exact skeleton startProjectServer used (interval
// POLL_INTERVAL_MS, per-attempt abort at POLL_ATTEMPT_TIMEOUT_MS, deadline
// timeoutMs, honoring an outer abort). Resolves once the predicate is true;
// runs `cleanup()` then throws on abort / spawn error / timeout.
async function awaitReady(params: {
  predicate: ReadyPredicate;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  getSpawnError?: () => Error | null;
  cleanup: () => Promise<void>;
  messages: { aborted: string; spawnError: (m: string) => string; timeout: string };
}): Promise<void> {
  const { predicate, timeoutMs, abortSignal, getSpawnError, cleanup, messages } = params;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (abortSignal?.aborted) {
      await cleanup();
      throw new Error(messages.aborted);
    }
    const spawnError = getSpawnError?.();
    if (spawnError) {
      await cleanup();
      throw new Error(messages.spawnError(spawnError.message));
    }

    const attemptAbort = new AbortController();
    const onOuterAbort = () => attemptAbort.abort();
    abortSignal?.addEventListener("abort", onOuterAbort);
    const attemptTimer = setTimeout(() => attemptAbort.abort(), POLL_ATTEMPT_TIMEOUT_MS);
    const ready = await predicate(attemptAbort.signal);
    clearTimeout(attemptTimer);
    abortSignal?.removeEventListener("abort", onOuterAbort);

    if (ready) return;
    await sleep(POLL_INTERVAL_MS);
  }
  await cleanup();
  throw new Error(messages.timeout);
}

// Real exec for command readyChecks: run the command to completion and report
// its exit code. Injectable in the lane (opts.runCommand) so tests never exec.
export function defaultRunCommand(cmd: string, cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = nodeSpawn(cmd, { shell: true, cwd, env, stdio: "ignore" });
    const onAbort = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort);
    const done = (exitCode: number) => {
      signal.removeEventListener("abort", onAbort);
      resolve({ exitCode });
    };
    child.once("error", () => done(1));
    child.once("exit", (code) => done(code ?? 1));
  });
}

// §6: build the ready predicate for one service from its declared ReadyCheck.
// http ⇒ status must equal the declared status; command ⇒ exit 0; absent ⇒
// weak fallback (any response if a url exists, else ready once spawned).
export function makeReadyPredicate(
  readyCheck: ReadyCheck | undefined,
  ctx: {
    port: number | null;
    url: string | null;
    root: string;
    env: NodeJS.ProcessEnv;
    fetchImpl: typeof fetch;
    runCommand: RunCommand;
  },
): ReadyPredicate {
  if (!readyCheck) {
    // Weak, discouraged fallback (§6): declare a readyCheck instead.
    const url = ctx.url;
    if (url) return (signal) => defaultPoll(url, signal);
    return async () => true; // no url to probe → "ready once spawned"
  }
  if (readyCheck.kind === "http") {
    if (ctx.port === null) {
      throw new Error(`lane: http readyCheck needs a known port (fixed service missing \`port\`?)`);
    }
    const target = `http://localhost:${ctx.port}${readyCheck.path}`;
    const wantStatus = readyCheck.status;
    return async (signal) => {
      try {
        const res = await ctx.fetchImpl(target, { signal });
        return res.status === wantStatus;
      } catch {
        return false;
      }
    };
  }
  // command
  const run = readyCheck.run;
  return async (signal) => {
    try {
      const { exitCode } = await ctx.runCommand(run, ctx.root, ctx.env, signal);
      return exitCode === 0;
    } catch {
      return false;
    }
  };
}

// §4.2 topological sort by dependsOn. Missing dep ⇒ throw; cycle ⇒ throw with
// the offending path (`lane: dependency cycle: a → b → a`).
function laneOrder(services: Record<string, ServiceConfig>): string[] {
  const names = Object.keys(services);
  const known = new Set(names);
  for (const name of names) {
    for (const dep of services[name].dependsOn) {
      if (!known.has(dep)) {
        throw new Error(`lane: service "${name}" depends on unknown service "${dep}"`);
      }
    }
  }
  const visited = new Set<string>();
  const onPath = new Set<string>();
  const path: string[] = [];
  const order: string[] = [];
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    if (onPath.has(name)) {
      const cycle = [...path.slice(path.indexOf(name)), name].join(" → ");
      throw new Error(`lane: dependency cycle: ${cycle}`);
    }
    onPath.add(name);
    path.push(name);
    for (const dep of services[name].dependsOn) visit(dep);
    path.pop();
    onPath.delete(name);
    visited.add(name);
    order.push(name);
  };
  for (const name of names) visit(name);
  return order;
}

// §5 template model. `{port}` = this service; `{peer.port}`/`{peer.url}` = an
// already-resolved dependsOn peer. Any other/unresolvable token throws (never
// leak a literal `{db.url}` into the child env — the §4.2 self-reference bug).
function resolveTemplate(
  template: string,
  serviceName: string,
  selfPort: number | null,
  resolved: Record<string, ServiceHandle>,
  deps: Set<string>,
): string {
  return template.replace(/\{([^}]+)\}/g, (_match, raw: string) => {
    const token = raw.trim();
    if (token === "port") {
      if (selfPort === null) {
        throw new Error(`lane: service "${serviceName}" references {port} but has no known port`);
      }
      return String(selfPort);
    }
    const dot = token.indexOf(".");
    const peer = dot > 0 ? token.slice(0, dot) : "";
    const field = dot > 0 ? token.slice(dot + 1) : "";
    if (peer && (field === "port" || field === "url")) {
      if (!deps.has(peer)) {
        throw new Error(`lane: service "${serviceName}" references "{${token}}" but does not depend on "${peer}"`);
      }
      const handle = resolved[peer];
      if (!handle) {
        throw new Error(`lane: service "${serviceName}" references "{${token}}" but "${peer}" is not resolved yet`);
      }
      const value = field === "port" ? (handle.port === null ? null : String(handle.port)) : handle.url;
      if (value === null) {
        throw new Error(`lane: "{${token}}" — peer "${peer}" has no known ${field}`);
      }
      return value;
    }
    throw new Error(`lane: unknown template token "{${token}}" in service "${serviceName}"`);
  });
}

// Pure extraction (Unit 3 §7.1) of the spawn-and-await-ready body: spawn the
// resolved spec, capture spawn errors, run the readiness gate. Byte-identical
// to the inline first-pass logic; reused verbatim by `restart()`. `cleanupPeers`
// tears down already-started peers on a first-pass failure (a restart passes a
// no-op — the supervisor, not the lane, owns a restart's failure handling).
async function bringUpService(
  spec: ResolvedService,
  deps: BringUpDeps,
  cleanupPeers: () => Promise<void>,
): Promise<ChildProcess> {
  const child = deps.spawnFn(spec.command, spec.root, spec.spawnEnv);
  deps.onSpawn?.(child);

  let spawnError: Error | null = null;
  child.once("error", (err) => {
    spawnError = err instanceof Error ? err : new Error(String(err));
  });

  const cleanup = async (): Promise<void> => {
    await killTree(child);
    await cleanupPeers();
  };

  const predicate = makeReadyPredicate(spec.readyCheck, {
    port: spec.port,
    url: spec.url,
    root: spec.root,
    env: spec.spawnEnv,
    fetchImpl: deps.fetchImpl,
    runCommand: deps.runCommand,
  });
  await awaitReady({
    predicate,
    timeoutMs: deps.timeoutMs,
    abortSignal: deps.abortSignal,
    getSpawnError: () => spawnError,
    cleanup,
    messages: {
      aborted: `lane: aborted while waiting for service "${spec.name}"`,
      spawnError: (m) => `lane: failed to spawn service "${spec.name}": ${m}`,
      timeout: `lane: service "${spec.name}" not ready within ${deps.timeoutMs}ms`,
    },
  });
  return child;
}

/**
 * One-shot bring-up (§4) of a project's declared services: correct ports, real
 * readiness, self-referential env resolved — plus handles to stop them. Opt-in
 * and additive: a `driver: none` / empty config is a no-op empty lane, so the
 * legacy static-url / devCommand path (startProjectServer) is untouched.
 */
export async function startLane(config: ServersConfig, root: string, opts: StartLaneOpts = {}): Promise<Lane> {
  if (config.driver === "none" || Object.keys(config.services).length === 0) {
    return { services: {}, stopAll: async () => {} };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const captureLogs = opts.captureLogs ?? false;
  const spawnFn = opts.spawnFn ?? (captureLogs ? defaultSpawnPiped : defaultSpawn);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const runCommand = opts.runCommand ?? defaultRunCommand;
  const findPort = opts.findPort ?? findFreePort;
  const baseEnv = opts.env ?? process.env;
  const abortSignal = opts.abort?.signal;

  const order = laneOrder(config.services);
  const resolved: Record<string, ServiceHandle> = {};
  const started: Array<{ stop: () => Promise<void> }> = [];

  // Reverse-order, idempotent, error-aggregating teardown (§4.4).
  const stopAll = async (): Promise<void> => {
    const errors: unknown[] = [];
    for (let i = started.length - 1; i >= 0; i--) {
      try {
        await started[i].stop();
      } catch (e) {
        errors.push(e);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, `lane: ${errors.length} service(s) failed to stop`);
    }
  };
  // Failure cleanup must not mask the readiness error with a teardown error.
  const cleanup = async (): Promise<void> => {
    await stopAll().catch(() => {});
  };

  for (const name of order) {
    const svc = config.services[name];
    const deps = new Set(svc.dependsOn);
    try {
      // (a) Port: fixed → keep the declared port (probe, never reassign);
      // dynamic → a fresh free port.
      const port = svc.portStrategy === "fixed" ? (svc.port ?? null) : await findPort();
      const url = port === null ? null : `http://localhost:${port}`;

      // (b) Templates: service env values.
      const resolvedEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(svc.env)) {
        resolvedEnv[k] = resolveTemplate(v, name, port, resolved, deps);
      }

      // (c) Inject the chosen port explicitly (no implicit PORT — §10).
      let command = svc.command;
      const injectEnv: Record<string, string> = {};
      const inject = svc.portInject;
      if (inject) {
        if ("env" in inject) {
          if (port === null) throw new Error(`lane: service "${name}" portInject.env needs a port`);
          injectEnv[inject.env] = String(port);
        } else if ("arg" in inject) {
          command = `${command} ${resolveTemplate(inject.arg, name, port, resolved, deps)}`;
        } else {
          const body = resolveTemplate(inject.template ?? "{port}", name, port, resolved, deps);
          const dest = path.isAbsolute(inject.file) ? inject.file : path.join(root, inject.file);
          fs.writeFileSync(dest, body);
        }
      }

      // (d) Spawn + ready. injectEnv is applied last (authoritative). The
      // resolved spec is captured so restart() can re-spawn on the SAME port
      // (peers already baked this port/url into their env — §6).
      const spawnEnv: NodeJS.ProcessEnv = { ...baseEnv, ...resolvedEnv, ...injectEnv };
      const spec: ResolvedService = { name, root, command, spawnEnv, port, url, readyCheck: svc.readyCheck };

      // Optional log ring (opt-in): the same buffer is re-attached on every
      // restart so escalation sees the tail across the whole lifecycle.
      const ring: { text: string } | null = captureLogs ? { text: "" } : null;
      const onSpawn = ring ? (c: ChildProcess) => attachLogTail(ring, c) : undefined;
      const bringUpDeps: BringUpDeps = { spawnFn, fetchImpl, runCommand, timeoutMs, abortSignal, onSpawn };

      // (e) Bring up (first pass). On failure this tears down peers via cleanup.
      // The mutable `child` cell is what stop/isAlive/restart read, so they
      // always see the CURRENT process across restarts.
      let child = await bringUpService(spec, bringUpDeps, cleanup);

      let stopped = false;
      const stop = async (): Promise<void> => {
        if (stopped) return;
        stopped = true;
        await killTree(child);
      };
      started.push({ stop });

      const isAlive = (): boolean => child.exitCode === null && !child.killed;
      // restart(): kill the current child, re-spawn the SAME spec (same port),
      // re-await readiness. Resolves when ready, rejects on spawn/timeout — the
      // exact signal the crash-loop gate consumes. A restart failure does NOT
      // tear down peers (no-op cleanupPeers); the supervisor owns that path.
      const restart = async (): Promise<void> => {
        if (stopped) return;
        await killTree(child);
        child = await bringUpService(spec, bringUpDeps, async () => {});
      };
      const logTail = ring ? () => ring.text : undefined;

      // (f) Record the handle for peers and the returned lane.
      resolved[name] = { name, port, url, stop, isAlive, restart, logTail };
    } catch (e) {
      // Synchronous setup errors (bad template, missing port) haven't torn
      // down peers yet; awaitReady's cleanup already has (idempotent to redo).
      await cleanup();
      throw e;
    }
  }

  return { services: resolved, stopAll };
}
