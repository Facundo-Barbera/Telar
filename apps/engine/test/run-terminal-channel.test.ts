/**
 * RUN ON A TERMINAL THE DESKTOP SHELL HOLDS — and the one guarantee that had to
 * be rebuilt rather than restated when the handle moved into another process.
 *
 * `manager.ts` could say "the pid is only ever used while our own
 * `ChildProcess` has not yet fired exit" because it held the child. It does not
 * any more. So the assertion this file is built around is the failure that
 * replaces it:
 *
 *   WHEN THE CHANNEL DIES, THE RUN IS `unknown` AND STILL HOLDS ITS PROJECT'S
 *   SLOT — never `exited`.
 *
 * A test that the run settles `exited` on a healthy channel proves nothing
 * about that, so both are here and they are THE SAME SETUP WITH THE OPPOSITE
 * ANSWER: same manager, same recipe, same fake host; one has its channel
 * killed and one does not, and the slot is asserted in both directions. A
 * regression that stopped distinguishing them cannot pass both.
 *
 * BOTH REAL HALVES ARE IN THE LOOP. The desktop's `run-terminal-server.js` is
 * required here rather than re-implemented, because two hand-rolled ends of a
 * protocol agree with each other by construction and with nothing else.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { terminalLauncher } from "../src/run/launcher";
import { RunManager, type StartRunInput } from "../src/run/manager";
import { RunTerminalClient } from "../src/run/terminal-client";
import { PTY_MASK } from "../src/run/pty-stream";
import type { RunConfiguration } from "../src/run/types";

/**
 * Loaded through a computed specifier ON PURPOSE. `tsc -p apps/engine` compiles
 * this directory and would have to be taught to reach a plain CommonJS file in
 * a sibling workspace to resolve a literal one; a computed path is `any` to the
 * compiler and the real module to bun, which is what this test needs.
 */
const desktopServer = path.join(import.meta.dir, "..", "..", "desktop", "run-terminal-server.js");
type StartServer = (options: {
  port: number;
  token: string;
  getTerminalHost: () => unknown;
  heartbeatMs?: number;
}) => Promise<{ port: number; onData: (id: string, data: string) => void; onExit: (id: string, ending: unknown) => void; close: () => Promise<unknown> }>;
const { startRunTerminalServer } = (await import(desktopServer)) as { startRunTerminalServer: StartServer };

// ── a terminal host that is a fake only in that it starts no process ─────────

type FakeTerminal = { id: string; pid: number };

class FakeHost {
  readonly terminals = new Map<string, FakeTerminal>();
  readonly killed: Array<{ id: string; signal: string; owner: string }> = [];
  /** What the engine typed, and under whose scope. The real host refuses an id
   *  whose owner is not the caller, so recording the owner is how this file
   *  notices a route that stopped naming one. */
  readonly wrote: Array<{ id: string; data: string; owner: string }> = [];
  readonly resized: Array<{ id: string; cols: number; rows: number; owner: string }> = [];
  /** Set to make the host drop writes, the way it does for a terminal that has
   *  already ended — which is an answer, not an error. */
  refuseWrites = false;
  onData: (id: string, data: string) => void = () => {};
  onExit: (id: string, ending: unknown) => void = () => {};
  private sequence = 0;
  /** Set to make the spawn itself throw, the one thing that is `failed`. */
  failWith?: string;

  open(request: { shell?: string; cwd?: string; env?: Record<string, string> }): unknown {
    const id = `term_${(this.sequence += 1).toString(36)}`;
    if (this.failWith) {
      const ending = { id, fate: "failed", error: this.failWith, at: Date.now() };
      return { id, pid: undefined, ending };
    }
    const terminal = { id, pid: 40000 + this.sequence };
    this.terminals.set(id, terminal);
    this.lastRequest = request;
    return { id, pid: terminal.pid };
  }
  lastRequest?: { shell?: string; cwd?: string; env?: Record<string, string> };

  kill(id: string, signal: string, owner: string): boolean {
    if (!this.terminals.has(id)) return false;
    this.killed.push({ id, signal, owner });
    return true;
  }

  write(id: string, data: string, owner: string): boolean {
    if (this.refuseWrites || !this.terminals.has(id)) return false;
    this.wrote.push({ id, data, owner });
    return true;
  }

  resize(id: string, cols: number, rows: number, owner: string): boolean {
    if (!this.terminals.has(id)) return false;
    this.resized.push({ id, cols, rows, owner });
    return true;
  }

  list(): FakeTerminal[] {
    return [...this.terminals.values()];
  }

  /** node-pty's own exit event — the ONLY producer of `exited`. */
  exit(id: string, exitCode: number): void {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    this.terminals.delete(id);
    this.onExit(id, { id, pid: terminal.pid, fate: "exited", exitCode, at: Date.now() });
  }

  say(id: string, data: string): void {
    this.onData(id, data);
  }
}

// ── harness ──────────────────────────────────────────────────────────────────

const servers: Array<{ close: () => Promise<unknown> }> = [];
const clients: RunTerminalClient[] = [];
const managers: RunManager[] = [];
const tempDirs: string[] = [];

/**
 * NOTHING THIS FILE STARTS OUTLIVES IT. Every server here binds a loopback port
 * and every client holds an event stream open; a test that failed midway used
 * to leave both, and the rule in `docs/operations/dispatch-board.md` about not
 * leaving long-running things behind applies to a test's own leftovers first.
 */
afterEach(async () => {
  while (managers.length) {
    try {
      await managers.pop()!.shutdown();
    } catch {
      /* a manager that already failed is not a second failure */
    }
  }
  while (clients.length) clients.pop()!.close();
  while (servers.length) await servers.pop()!.close();
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

async function harness(options: { heartbeatMs?: number; missedBeats?: number } = {}) {
  const host = new FakeHost();
  const server = await startRunTerminalServer({
    port: 0,
    token: "test-token",
    getTerminalHost: () => host,
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
  });
  servers.push(server);
  host.onData = server.onData;
  host.onExit = server.onExit;
  const client = new RunTerminalClient({
    baseUrl: `http://127.0.0.1:${server.port}`,
    token: "test-token",
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    ...(options.missedBeats === undefined ? {} : { missedBeats: options.missedBeats }),
  });
  clients.push(client);
  const manager = new RunManager({ launcher: terminalLauncher(client), groupDrainMs: 10, stopGraceMs: 150 });
  managers.push(manager);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-run-channel-"));
  tempDirs.push(dir);
  return { host, server, client, manager, dir };
}

const config = (overrides: Partial<RunConfiguration> = {}): RunConfiguration => ({
  id: "runcfg_1",
  projectId: "proj_1",
  name: "dev",
  command: "sleep 60",
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const input = (dir: string, overrides: Partial<StartRunInput> = {}): StartRunInput => ({
  projectId: "proj_1",
  config: config(),
  worktreePath: dir,
  ...overrides,
});

/** Wait for a condition without holding the loop open past the test. */
async function until(predicate: () => boolean, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

/** The conflict a held slot produces, or undefined if the slot was free. */
async function secondStartRefusal(manager: RunManager, dir: string): Promise<{ code: string; status?: unknown } | undefined> {
  try {
    await manager.start(input(dir, { config: config({ id: "runcfg_2", name: "second" }) }));
    return undefined;
  } catch (error) {
    const refusal = error as { code?: string; detail?: { status?: unknown } };
    return { code: String(refusal.code), status: refusal.detail?.status };
  }
}

// ── the pair: same setup, opposite answers ───────────────────────────────────

test("a channel that dies leaves the run unknown and the project's slot still held", async () => {
  const { host, server, manager, dir } = await harness();
  const started = await manager.start(input(dir));
  expect(started.status).toBe("running");
  expect(host.terminals.size).toBe(1);

  // The shell goes away without ever reporting how anything ended — the quiet
  // failure the whole fate model exists for.
  await server.close();

  expect(await until(() => manager.run(started.runId).status === "unknown")).toBe(true);
  const lost = manager.run(started.runId);
  expect(lost.status).toBe("unknown");
  // NOT `exited`, and not terminal: the slot is the thing being asserted.
  expect(lost.exitCode).toBeUndefined();
  expect(lost.error).toBeTruthy();

  const refusal = await secondStartRefusal(manager, dir);
  expect(refusal?.code).toBe("conflict");
  expect(refusal?.status).toBe("unknown");
  // And the project's active run is still this one, rather than nothing.
  expect(manager.activeRun("proj_1")?.runId).toBe(started.runId);
});

test("a healthy channel settles the same run exited and frees the slot", async () => {
  const { host, manager, dir } = await harness();
  const started = await manager.start(input(dir));
  expect(started.status).toBe("running");

  const id = [...host.terminals.keys()][0]!;
  host.exit(id, 0);

  expect(await until(() => manager.run(started.runId).status === "exited")).toBe(true);
  expect(manager.run(started.runId).exitCode).toBe(0);
  // The opposite half of the pair: here the slot IS free, so the second start
  // succeeds where the test above required a refusal.
  expect(manager.activeRun("proj_1")).toBeUndefined();
  expect(await secondStartRefusal(manager, dir)).toBeUndefined();
});

test("a host that is connected but silent is lost too, and lands in the same place", async () => {
  /**
   * THE CASE A `close` TEST CANNOT REACH. A TCP connection survives a process
   * that has stopped answering, so "the socket is open" and "the host is alive"
   * are different facts — and a redactor of that difference is the heartbeat.
   *
   * Staged with a server that attaches and then never writes again, which is
   * exactly what a wedged Electron main looks like from here. Nothing about the
   * watchdog itself is faked.
   */
  const { server, manager, dir } = await silentHarness({ heartbeatMs: 60, missedBeats: 2 });
  const started = await manager.start(input(dir));
  expect(started.status).toBe("running");
  expect(server.opened).toBe(1);

  expect(await until(() => manager.run(started.runId).status === "unknown", 3000)).toBe(true);
  expect(manager.run(started.runId).error).toContain("went quiet");
  expect(manager.run(started.runId).exitCode).toBeUndefined();
  expect((await secondStartRefusal(manager, dir))?.status).toBe("unknown");
  // And the host never said anything, so nothing could have been rounded.
  expect(server.opened).toBe(1);
});

/**
 * A host that answers `/open` and then holds the event stream open in silence.
 * Hand-rolled rather than the real server BECAUSE the real one heartbeats — the
 * thing under test here is what the engine does when nobody does.
 */
async function silentHarness(options: { heartbeatMs: number; missedBeats: number }) {
  const state = { opened: 0 };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/events") {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.write(`event: attached\ndata: {"heartbeatMs":${options.heartbeatMs}}\n\n`);
      return; // …and then nothing, ever.
    }
    if (url.pathname === "/open") {
      state.opened += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ id: "term_silent", pid: 424242 }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  servers.push({
    close: () =>
      new Promise((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => done(undefined));
      }),
  });
  const client = new RunTerminalClient({
    baseUrl: `http://127.0.0.1:${port}`,
    token: "test-token",
    heartbeatMs: options.heartbeatMs,
    missedBeats: options.missedBeats,
  });
  clients.push(client);
  const manager = new RunManager({ launcher: terminalLauncher(client), groupDrainMs: 10, stopGraceMs: 150 });
  managers.push(manager);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-run-silent-"));
  tempDirs.push(dir);
  return { server: state, client, manager, dir };
}

// ── what the host may and may not say ────────────────────────────────────────

test("a host that reports `unknown` holds the slot; it is never rounded to exited", async () => {
  const { host, manager, dir } = await harness();
  const started = await manager.start(input(dir));
  const id = [...host.terminals.keys()][0]!;
  const terminal = host.terminals.get(id)!;
  host.terminals.delete(id);
  // The host's own words for "we stopped being able to vouch" — a kill it
  // issued and never saw land.
  host.onExit(id, {
    id,
    pid: terminal.pid,
    fate: "unknown",
    reason: `this terminal did not report an exit within 5000ms of being signalled; its process group (pid ${terminal.pid}) may still be running`,
    at: Date.now(),
  });

  expect(await until(() => manager.run(started.runId).status === "unknown")).toBe(true);
  expect(manager.run(started.runId).error).toContain("did not report an exit");
  expect((await secondStartRefusal(manager, dir))?.status).toBe("unknown");
});

test("a bad command arrives as a nonzero exit with a real pid, not as `failed`-to-start", async () => {
  // W1 measured this and it is the premise most likely to be mis-assumed: a
  // missing binary (126) and an unusable cwd (1) both fork successfully, so the
  // failure is INSIDE the child and has to be read off the code.
  const { host, manager, dir } = await harness();
  const started = await manager.start(input(dir));
  expect(started.pid).toBeGreaterThan(0);
  const id = [...host.terminals.keys()][0]!;
  host.exit(id, 126);

  expect(await until(() => manager.run(started.runId).status === "failed")).toBe(true);
  const ended = manager.run(started.runId);
  expect(ended.exitCode).toBe(126);
  // `failed` here is terminal and frees the slot, which is right: the host
  // OBSERVED the end. That is a different `failed` from a fork that threw.
  expect(manager.activeRun("proj_1")).toBeUndefined();
});

test("a spawn that threw is `failed` with no process and no slot held", async () => {
  // The one failure a caller may treat as terminal: there is no process to be
  // uncertain about. Reported the same way the pipe launcher reports a spawn
  // that emitted `error` — the run comes back `failed` rather than the call
  // throwing, because the slot bookkeeping already succeeded.
  const { host, manager, dir } = await harness();
  host.failWith = "posix_spawnp failed";
  const started = await manager.start(input(dir));
  expect(started.status).toBe("failed");
  expect(started.error).toContain("posix_spawnp");
  expect(started.pid).toBeUndefined();
  // Nothing was created, so nothing may hold the project.
  expect(manager.activeRun("proj_1")).toBeUndefined();
  expect(host.terminals.size).toBe(0);
  expect(await secondStartRefusal(manager, dir)).toBeUndefined();
});

// ── the pid never crosses the wire ───────────────────────────────────────────

test("a stop names the terminal id, never the pid", async () => {
  const { host, manager, dir } = await harness();
  const started = await manager.start(input(dir));
  const id = [...host.terminals.keys()][0]!;
  const pid = manager.run(started.runId).pid;
  expect(pid).toBeGreaterThan(0);

  const stopping = manager.stop(started.runId);
  expect(await until(() => host.killed.length > 0)).toBe(true);
  expect(host.killed[0]!.id).toBe(id);
  expect(host.killed[0]!.signal).toBe("SIGTERM");
  // The id the host minted, and nothing that could be confused with the number
  // the kernel may hand to somebody else.
  expect(host.killed[0]!.id).not.toBe(String(pid));
  host.exit(id, 0);
  await stopping;
  expect(manager.run(started.runId).status).toBe("exited");
});

// ── the bytes, redacted ──────────────────────────────────────────────────────

test("a secret in a run's environment is masked in captured PTY output, escapes intact", async () => {
  const { host, manager, dir } = await harness();
  const secret = "sk-live-7b3f91";
  const started = await manager.start(
    input(dir, { config: config({ env: [{ key: "TOKEN", value: secret, secret: true }] }) }),
  );
  const id = [...host.terminals.keys()][0]!;
  // The host hands the engine what a shell wrote: colour, the value, a newline.
  host.say(id, `\x1b[32mdeploying\x1b[0m with ${secret}\r\n`);
  expect(await until(() => manager.output(started.runId).lines.length > 0)).toBe(true);

  const line = manager.output(started.runId).lines[0]!.text;
  expect(line).not.toContain(secret);
  // The surrounding bytes AND the escapes survived — a guard that only asserted
  // the secret's absence would be satisfied by an empty or mangled line.
  expect(line).toBe(`\x1b[32mdeploying\x1b[0m with ${PTY_MASK.repeat(secret.length)}`);
  expect(line).toContain("\x1b[32m");
  expect(line).toContain("\x1b[0m");
  // And the width is unchanged, which is what keeps a positioned screen intact.
  expect(line).toHaveLength(`\x1b[32mdeploying\x1b[0m with ${secret}`.length);

  // The run's env is still readable as a key with its value withheld.
  expect(manager.run(started.runId).env).toEqual([{ key: "TOKEN", secret: true }]);

  // And the real value did reach the process, which is the whole point of not
  // redacting the launch itself.
  expect(host.lastRequest?.env?.TOKEN).toBe(secret);
});

test("the engine attaches to the event stream before it starts anything", async () => {
  // A command that dies instantly would otherwise end before anyone was
  // listening, leaving the run `starting` forever. The host's backlog and the
  // client's attach-first both cover it; this asserts the outcome.
  const { host, manager, dir } = await harness();
  const started = await manager.start(input(dir));
  const id = [...host.terminals.keys()][0]!;
  host.say(id, "instant\r\n");
  host.exit(id, 0);
  expect(await until(() => manager.run(started.runId).status === "exited")).toBe(true);
  expect(manager.output(started.runId).lines.map((line) => line.text)).toContain("instant");
});

// ── the keyboard, over the real server ───────────────────────────────────────

test("keystrokes cross the real channel and reach the terminal the run started", async () => {
  // THE WHOLE POINT OF THE WRITABLE DECISION, end to end: an installer asking
  // `Proceed (Y/n)` is answerable without stopping the run — which would take
  // the process outside the slot, the journal and the singleton.
  const { host, manager, dir } = await harness();
  const started = await manager.start(input(dir));
  const id = [...host.terminals.keys()][0]!;

  expect(await manager.write(started.runId, "y\r")).toBe(true);
  expect(await manager.resize(started.runId, 132, 43)).toBe(true);

  // ADDRESSED BY ID AND SCOPED TO THE ENGINE. The id is the terminal the run
  // started, not a pid and not a guess; the owner is what stops this channel
  // reaching a shell a person opened in a Terminal tab.
  expect(host.wrote).toEqual([{ id, data: "y\r", owner: "engine" }]);
  expect(host.resized).toEqual([{ id, cols: 132, rows: 43, owner: "engine" }]);
});

test("a write the host drops is `false`, and the run is untouched by it", async () => {
  // The desktop shell learns of an exit before the engine does, so a keystroke
  // across that gap is the ordinary case. It must not settle the run, free the
  // slot, or raise — all three of which a "the write failed" reading would.
  const { host, manager, dir } = await harness();
  const started = await manager.start(input(dir));
  host.refuseWrites = true;

  expect(await manager.write(started.runId, "y\r")).toBe(false);
  expect(manager.run(started.runId).status).toBe("running");
  expect(manager.activeRun("proj_1")?.runId).toBe(started.runId);
  // And the control on the same host: writes work again the moment the host
  // accepts them, so the `false` above was about the host and not about a
  // manager that had given up on this run.
  host.refuseWrites = false;
  expect(await manager.write(started.runId, "n\r")).toBe(true);
});

test("a run that has ended refuses the keyboard rather than writing into nothing", async () => {
  const { host, manager, dir } = await harness();
  const started = await manager.start(input(dir));
  const id = [...host.terminals.keys()][0]!;
  // The control first: while it is running, this is allowed.
  expect(await manager.write(started.runId, "a")).toBe(true);

  host.exit(id, 0);
  expect(await until(() => manager.run(started.runId).status === "exited")).toBe(true);
  await expect(manager.write(started.runId, "b")).rejects.toThrow(/not running/);
  // Nothing was sent after the exit — a refusal that still wrote would satisfy
  // a test that only caught the throw.
  expect(host.wrote.map((entry) => entry.data)).toEqual(["a"]);
});

// ── the byte ring, which is what the cockpit's emulator draws ────────────────

test("the byte view carries the redacted stream, escapes and columns intact", async () => {
  const { host, manager, dir } = await harness();
  const secret = "sk-live-7b3f91";
  const started = await manager.start(
    input(dir, { config: config({ env: [{ key: "TOKEN", value: secret, secret: true }] }) }),
  );
  const id = [...host.terminals.keys()][0]!;
  // A positioned screen rather than a tidy line: this is the shape the line
  // view is a DEGRADED reading of, and the reason the byte view exists.
  const screen = `\x1b[2J\x1b[1;1Hkey=${secret}\x1b[2;1Hnext`;
  host.say(id, screen);
  expect(await until(() => manager.bytes(started.runId).chunks.length > 0)).toBe(true);

  const drawn = manager.bytes(started.runId).chunks.join("");
  expect(drawn).not.toContain(secret);
  // THE EQUALITY, not the absence: an empty or mangled buffer satisfies "the
  // secret is gone" and fails this. Same length in as out, every escape at the
  // offset it was written at.
  expect(drawn).toBe(`\x1b[2J\x1b[1;1Hkey=${PTY_MASK.repeat(secret.length)}\x1b[2;1Hnext`);
  expect(drawn).toHaveLength(screen.length);

  // AND THE TWO VIEWS DO NOT REPLACE EACH OTHER. `/run/output` is still what an
  // agent reads, and it still answers for the same run.
  expect(manager.output(started.runId).cursor).toBeGreaterThanOrEqual(0);
});

test("the byte cursor resumes, and a cursor that went backwards means another run", async () => {
  const { host, manager, dir } = await harness();
  const started = await manager.start(input(dir));
  const id = [...host.terminals.keys()][0]!;

  host.say(id, "first");
  expect(await until(() => manager.bytes(started.runId).cursor === 1)).toBe(true);
  const first = manager.bytes(started.runId);
  expect(first.chunks.join("")).toBe("first");

  host.say(id, "second");
  expect(await until(() => manager.bytes(started.runId).cursor === 2)).toBe(true);
  // Resuming from the cursor hands back ONLY what is new — the property a poll
  // rests on, and the one a reader that re-drew everything would violate
  // invisibly.
  const next = manager.bytes(started.runId, first.cursor);
  expect(next.chunks.join("")).toBe("second");
  expect(next.dropped).toBe(0);
  // From the top, everything, in order.
  expect(manager.bytes(started.runId, 0).chunks.join("")).toBe("firstsecond");
});
