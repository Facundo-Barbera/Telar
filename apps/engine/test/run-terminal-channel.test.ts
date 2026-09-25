/**
 * RUN ON A TERMINAL THE DESKTOP SHELL HOLDS — "Run = a new terminal".
 *
 * The terminal owns its process; the engine records what the host tells it and
 * tracks no liveness of its own. So the assertions this file is built around
 * are about the WIRE:
 *
 *   - `/open` carries the session that owns the terminal, its origin and its
 *     title, and two opens are two terminals.
 *   - A close is the host's `/close`, addressed by terminal id, and the record
 *     says WHO closed it.
 *   - A channel that drops is NOT a terminal that ended. The client
 *     reconnects and asks `/state` once: a terminal the host still holds keeps
 *     running; one it no longer holds is recorded closed by Telar. Nothing is
 *     ever `unknown`, and nothing is ever held.
 *
 * BOTH REAL HALVES ARE IN THE LOOP. The desktop's `run-terminal-server.js` is
 * required here rather than re-implemented, because two hand-rolled ends of a
 * protocol agree with each other by construction and with nothing else. The
 * host behind it is a fake only in that it starts no process.
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
  onMirror?: (id: string, data: string, cursor?: number) => void;
  heartbeatMs?: number;
}) => Promise<{ port: number; onData: (id: string, data: string) => void; onExit: (id: string, ending: unknown) => void; close: () => Promise<unknown> }>;
const { startRunTerminalServer } = (await import(desktopServer)) as { startRunTerminalServer: StartServer };

// ── a terminal host that is a fake only in that it starts no process ─────────

type OpenRequest = { shell?: string; cwd?: string; env?: Record<string, string>; sessionId?: string; origin?: string; title?: string };
type FakeTerminal = { id: string; pid: number; sessionId?: string; origin?: string; title?: string };

class FakeHost {
  readonly terminals = new Map<string, FakeTerminal>();
  readonly opened: OpenRequest[] = [];
  readonly killed: Array<{ id: string; signal: string; owner: string }> = [];
  readonly closed: Array<{ id: string; owner: string }> = [];
  /** What the engine typed, and under whose scope. The real host refuses an id
   *  whose owner is not the caller, so recording the owner is how this file
   *  notices a route that stopped naming one. */
  readonly wrote: Array<{ id: string; data: string; owner: string }> = [];
  readonly resized: Array<{ id: string; cols: number; rows: number; owner: string }> = [];
  /** Set to make the host drop writes, the way it does for a terminal that has
   *  already ended — which is an answer, not an error. */
  refuseWrites = false;
  /** Set to make the terminal ignore SIGINT, as a server that traps it would. */
  ignoreKills = false;
  onData: (id: string, data: string) => void = () => {};
  onExit: (id: string, ending: unknown) => void = () => {};
  private sequence = 0;
  /** Set to make the spawn itself throw, the one thing that is `failed`. */
  failWith?: string;

  open(request: OpenRequest): unknown {
    const id = `term_${(this.sequence += 1).toString(36)}`;
    this.opened.push(request);
    if (this.failWith) {
      const ending = { id, fate: "failed", error: this.failWith, at: Date.now() };
      return { id, pid: undefined, ending };
    }
    const terminal = { id, pid: 40000 + this.sequence, sessionId: request.sessionId, origin: request.origin ?? "run", title: request.title };
    this.terminals.set(id, terminal);
    return { id, pid: terminal.pid };
  }

  get lastRequest(): OpenRequest | undefined {
    return this.opened.at(-1);
  }

  kill(id: string, signal: string, owner: string): boolean {
    if (!this.terminals.has(id)) return false;
    this.killed.push({ id, signal, owner });
    if (!this.ignoreKills) this.end(id, { exitCode: 130 });
    return true;
  }

  /** CLOSE = KILL: the real host's escalation, answered once it is over, with
   *  the exit carrying why the host was ending it. */
  async close(id: string, owner: string): Promise<boolean> {
    if (!this.terminals.has(id)) return false;
    this.closed.push({ id, owner });
    this.end(id, { exitCode: 0, signal: "1", closed: "close" });
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
    this.end(id, { exitCode });
  }

  /** The terminal ends without anybody on the channel hearing about it — what
   *  a close while the engine was away looks like from the engine's side. */
  forget(id: string): void {
    this.terminals.delete(id);
  }

  say(id: string, data: string): void {
    this.onData(id, data);
  }

  private end(id: string, detail: Record<string, unknown>): void {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    this.terminals.delete(id);
    this.onExit(id, { id, pid: terminal.pid, fate: "exited", at: Date.now(), ...detail });
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
 * to leave both.
 */
afterEach(async () => {
  while (managers.length) {
    try {
      await managers.pop()!.shutdown();
    } catch {
      /* a manager that already failed is not a second failure */
    }
  }
  while (clients.length) clients.pop()!.detach();
  while (servers.length) await servers.pop()!.close();
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

async function serve(host: FakeHost, options: { port?: number; heartbeatMs?: number } = {}) {
  /** What came BACK over the channel for a renderer to draw — the redacted
   *  mirror (#890). */
  const mirrored: Array<{ id: string; data: string; cursor?: number }> = [];
  const server = await startRunTerminalServer({
    port: options.port ?? 0,
    token: "test-token",
    getTerminalHost: () => host,
    onMirror: (id, data, cursor) => mirrored.push({ id, data, ...(cursor === undefined ? {} : { cursor }) }),
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
  });
  servers.push(server);
  host.onData = server.onData;
  host.onExit = server.onExit;
  return { server, mirrored };
}

async function harness(options: { heartbeatMs?: number; missedBeats?: number } = {}) {
  const host = new FakeHost();
  const { server, mirrored } = await serve(host, options);
  const client = new RunTerminalClient({
    baseUrl: `http://127.0.0.1:${server.port}`,
    token: "test-token",
    reconnectMs: 20,
    reconnectMaxMs: 50,
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    ...(options.missedBeats === undefined ? {} : { missedBeats: options.missedBeats }),
  });
  clients.push(client);
  const manager = new RunManager({ launcher: terminalLauncher(client), closeSettleMs: 150 });
  managers.push(manager);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-run-channel-"));
  tempDirs.push(dir);
  return { host, server, client, manager, dir, mirrored };
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
  sessionId: "sess_1",
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

// ── opening ──────────────────────────────────────────────────────────────────

test("the engine tells the host which session owns the terminal, that it is a run, and what its tab says", async () => {
  const { host, manager, dir } = await harness();
  const first = await manager.start(input(dir));
  const second = await manager.start(input(dir));

  expect(host.opened.map((request) => [request.sessionId, request.origin, request.title])).toEqual([
    ["sess_1", "run", "dev"],
    ["sess_1", "run", "dev #2"],
  ]);
  // Two terminals on the host, and neither blocked the other.
  expect(host.terminals.size).toBe(2);
  expect(first.terminalId).not.toBe(second.terminalId);
  expect([first.status, second.status]).toEqual(["running", "running"]);
});

test("a live terminal names itself by the host's id, and keeps that name after it ends", async () => {
  /**
   * #890: the cockpit draws a run as a chip in the Terminal strip, so the view
   * carries the HOST's id. Since "Run = a new terminal" it is also the record's
   * identity, so it stays after the end; the pid is what goes.
   */
  const { host, manager, dir } = await harness();
  const started = await manager.start(input(dir));
  const id = [...host.terminals.keys()][0]!;
  expect(started.terminalId).toBe(id);
  expect(started.pid).toBeGreaterThan(0);

  host.exit(id, 0);
  expect(await until(() => manager.run(id).status === "exited")).toBe(true);
  expect(manager.run(id).terminalId).toBe(id);
  expect(manager.run(id).pid).toBeUndefined();
  expect(manager.run(id).exitCode).toBe(0);
});

// ── closing ──────────────────────────────────────────────────────────────────

test("closing goes to the host's /close by terminal id, and the record says who closed it", async () => {
  const { host, manager, dir } = await harness();
  const mine = await manager.start(input(dir));
  const theirs = await manager.start(input(dir));

  const closed = await manager.close(mine.terminalId, "person");
  // BY ID, NEVER BY PID, and in the engine's own scope.
  expect(host.closed).toEqual([{ id: mine.terminalId, owner: "engine" }]);
  expect(closed.status).toBe("closed");
  expect(closed.closedBy).toBe("person");
  // Only that one: the other instance is still running.
  expect(manager.run(theirs.terminalId).status).toBe("running");

  const byAgent = await manager.close(theirs.terminalId, "agent");
  expect(byAgent.closedBy).toBe("agent");
});

test("a Ctrl-C-shaped close sends the signal first, and closes only if that did not end it", async () => {
  const { host, manager, dir } = await harness();
  const polite = await manager.start(input(dir));
  const closed = await manager.close(polite.terminalId, "agent", "SIGINT");
  expect(host.killed).toEqual([{ id: polite.terminalId, signal: "SIGINT", owner: "engine" }]);
  // SIGINT ended it, so no close was needed — and it is still recorded as a close.
  expect(host.closed).toEqual([]);
  expect(closed.status).toBe("closed");
  expect(closed.closedBy).toBe("agent");

  host.ignoreKills = true;
  const stubborn = await manager.start(input(dir));
  await manager.close(stubborn.terminalId, "person", "SIGINT");
  expect(host.closed.map((entry) => entry.id)).toEqual([stubborn.terminalId]);
});

test("a terminal the host closes on its own — Telar quitting, a session closed — is recorded as Telar's", async () => {
  const { host, manager, dir } = await harness();
  const started = await manager.start(input(dir));
  host.onExit(started.terminalId, { id: started.terminalId, fate: "exited", exitCode: 0, signal: "1", closed: "quit" });
  host.terminals.delete(started.terminalId);
  expect(await until(() => manager.run(started.terminalId).status === "closed")).toBe(true);
  expect(manager.run(started.terminalId).closedBy).toBe("telar");
});

test("a close the host cannot be asked for changes nothing, and says so", async () => {
  const { server, manager, dir } = await harness();
  const started = await manager.start(input(dir));
  await server.close();
  await expect(manager.close(started.terminalId, "person")).rejects.toThrow(/could not close/);
  expect(manager.run(started.terminalId).status).toBe("running");
  expect(manager.run(started.terminalId).closedBy).toBeUndefined();
});

// ── the channel dropping is not the terminal ending ──────────────────────────

test("a channel that drops leaves the terminal running, and a reconnect re-lists it from the host", async () => {
  const { host, server, manager, dir } = await harness();
  const started = await manager.start(input(dir));
  const port = server.port;

  // The stream goes away without a word about any terminal.
  await server.close();
  servers.pop();
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(manager.run(started.terminalId).status).toBe("running");

  // The host comes back on the same door and still holds the terminal: the
  // client re-attaches, asks /state once, and the terminal carries on —
  // including its output.
  await serve(host, { port });
  const id = started.terminalId;
  expect(
    await until(() => {
      host.say(id, "still here\r\n");
      return manager.output(id).lines.some((line) => line.text === "still here");
    }),
  ).toBe(true);
  expect(manager.run(id).status).toBe("running");
});

test("a terminal the host no longer holds after a reconnect is recorded closed by Telar, never held", async () => {
  const { host, server, manager, dir } = await harness();
  const started = await manager.start(input(dir));
  const port = server.port;
  await server.close();
  servers.pop();
  // It ended while nobody was listening — the host is the only thing that
  // could have ended it.
  host.forget(started.terminalId);
  await serve(host, { port });

  expect(await until(() => manager.run(started.terminalId).status === "closed")).toBe(true);
  expect(manager.run(started.terminalId).closedBy).toBe("telar");
  // Nothing held: the next start goes straight through.
  expect((await manager.start(input(dir))).status).toBe("running");
});

test("a host that is connected but silent is reconnected to, not written off", async () => {
  /**
   * A TCP connection survives a process that has stopped answering, so the
   * stream heartbeats and a watchdog notices silence. What that triggers now is
   * a reconnect and one `/state` — never a verdict about the terminal.
   */
  const { server, manager, dir } = await silentHarness({ heartbeatMs: 40, missedBeats: 2 });
  const started = await manager.start(input(dir));
  expect(started.status).toBe("running");
  expect(await until(() => server.attached >= 2 && server.stateReads >= 1, 3000)).toBe(true);
  expect(manager.run(started.terminalId).status).toBe("running");
  expect(manager.run(started.terminalId).exitCode).toBeUndefined();
});

/**
 * A host that answers `/open` and `/state` and holds the event stream open in
 * silence. Hand-rolled rather than the real server BECAUSE the real one
 * heartbeats — the thing under test here is what the engine does when nobody
 * does.
 */
async function silentHarness(options: { heartbeatMs: number; missedBeats: number }) {
  const state = { attached: 0, stateReads: 0 };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/events") {
      state.attached += 1;
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.write(`event: attached\ndata: {"heartbeatMs":${options.heartbeatMs}}\n\n`);
      return; // …and then nothing, ever.
    }
    if (url.pathname === "/open") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ id: "term_silent", pid: 424242 }));
      return;
    }
    if (url.pathname === "/state") {
      state.stateReads += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ terminals: [{ id: "term_silent", pid: 424242 }] }));
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
    reconnectMs: 20,
    reconnectMaxMs: 50,
  });
  clients.push(client);
  const manager = new RunManager({ launcher: terminalLauncher(client), closeSettleMs: 150 });
  managers.push(manager);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-run-silent-"));
  tempDirs.push(dir);
  return { server: state, client, manager, dir };
}

// ── what the host may and may not say ────────────────────────────────────────

test("a host from before this change that says `unknown` is read as gone — closed by Telar, nothing held", async () => {
  const { host, manager, dir } = await harness();
  const started = await manager.start(input(dir));
  const id = started.terminalId;
  host.terminals.delete(id);
  host.onExit(id, { id, fate: "unknown", reason: "this terminal did not report an exit within 5000ms of being signalled", at: Date.now() });

  expect(await until(() => manager.run(id).status === "closed")).toBe(true);
  expect(manager.run(id).closedBy).toBe("telar");
  expect((await manager.start(input(dir))).status).toBe("running");
});

test("a bad command arrives as a nonzero exit with a real pid, not as `failed`-to-start", async () => {
  // W1 measured this and it is the premise most likely to be mis-assumed: a
  // missing binary (126) and an unusable cwd (1) both fork successfully, so the
  // failure is INSIDE the child and has to be read off the code.
  const { host, manager, dir } = await harness();
  const started = await manager.start(input(dir));
  expect(started.pid).toBeGreaterThan(0);
  host.exit(started.terminalId, 126);

  expect(await until(() => manager.run(started.terminalId).status === "failed")).toBe(true);
  expect(manager.run(started.terminalId).exitCode).toBe(126);
  expect(manager.run(started.terminalId).closedBy).toBeUndefined();
});

test("a spawn that threw is `failed` with no process", async () => {
  // Reported the way the pipe launcher reports a spawn that emitted `error`:
  // the terminal comes back `failed` rather than the call throwing.
  const { host, manager, dir } = await harness();
  host.failWith = "posix_spawnp failed";
  const started = await manager.start(input(dir));
  expect(started.status).toBe("failed");
  expect(started.error).toContain("posix_spawnp");
  expect(started.pid).toBeUndefined();
  expect(host.terminals.size).toBe(0);
  host.failWith = undefined;
  expect((await manager.start(input(dir))).status).toBe("running");
});

// ── the bytes, redacted ──────────────────────────────────────────────────────

test("a secret in a run's environment is masked in captured PTY output, escapes intact", async () => {
  const { host, manager, dir } = await harness();
  const secret = "sk-live-7b3f91";
  const started = await manager.start(input(dir, { config: config({ env: [{ key: "TOKEN", value: secret, secret: true }] }) }));
  const id = started.terminalId;
  // The host hands the engine what a shell wrote: colour, the value, a newline.
  host.say(id, `\x1b[32mdeploying\x1b[0m with ${secret}\r\n`);
  expect(await until(() => manager.output(id).lines.length > 0)).toBe(true);

  const line = manager.output(id).lines[0]!.text;
  expect(line).not.toContain(secret);
  // The surrounding bytes AND the escapes survived — a guard that only asserted
  // the secret's absence would be satisfied by an empty or mangled line.
  expect(line).toBe(`\x1b[32mdeploying\x1b[0m with ${PTY_MASK.repeat(secret.length)}`);
  expect(line).toHaveLength(`\x1b[32mdeploying\x1b[0m with ${secret}`.length);

  // The env is still readable as a key with its value withheld.
  expect(manager.run(id).env).toEqual([{ key: "TOKEN", secret: true }]);
  // And the real value did reach the process, which is the whole point of not
  // redacting the launch itself.
  expect(host.lastRequest?.env?.TOKEN).toBe(secret);
});

test("the engine attaches to the event stream before it starts anything", async () => {
  // A command that dies instantly would otherwise end before anyone was
  // listening. The host's backlog and the client's attach-first both cover it.
  const { host, manager, dir } = await harness();
  const started = await manager.start(input(dir));
  host.say(started.terminalId, "instant\r\n");
  host.exit(started.terminalId, 0);
  expect(await until(() => manager.run(started.terminalId).status === "exited")).toBe(true);
  expect(manager.output(started.terminalId).lines.map((line) => line.text)).toContain("instant");
});

// ── the keyboard, over the real server ───────────────────────────────────────

test("keystrokes cross the real channel and reach the terminal the run started", async () => {
  const { host, manager, dir } = await harness();
  const started = await manager.start(input(dir));
  const id = started.terminalId;

  expect(await manager.write(id, "y\r")).toBe(true);
  expect(await manager.resize(id, 132, 43)).toBe(true);

  // ADDRESSED BY ID AND SCOPED TO THE ENGINE.
  expect(host.wrote).toEqual([{ id, data: "y\r", owner: "engine" }]);
  expect(host.resized).toEqual([{ id, cols: 132, rows: 43, owner: "engine" }]);
});

test("a write the host drops is `false`, and the terminal is untouched by it", async () => {
  const { host, manager, dir } = await harness();
  const started = await manager.start(input(dir));
  host.refuseWrites = true;

  expect(await manager.write(started.terminalId, "y\r")).toBe(false);
  expect(manager.run(started.terminalId).status).toBe("running");
  host.refuseWrites = false;
  expect(await manager.write(started.terminalId, "n\r")).toBe(true);
});

test("a terminal that has ended refuses the keyboard rather than writing into nothing", async () => {
  const { host, manager, dir } = await harness();
  const started = await manager.start(input(dir));
  const id = started.terminalId;
  expect(await manager.write(id, "a")).toBe(true);

  host.exit(id, 0);
  expect(await until(() => manager.run(id).status === "exited")).toBe(true);
  await expect(manager.write(id, "b")).rejects.toThrow(/not running/);
  expect(host.wrote.map((entry) => entry.data)).toEqual(["a"]);
});

// ── the byte ring, which is what the cockpit's emulator draws ────────────────

test("the byte view carries the redacted stream, escapes and columns intact", async () => {
  const { host, manager, dir } = await harness();
  const secret = "sk-live-7b3f91";
  const started = await manager.start(input(dir, { config: config({ env: [{ key: "TOKEN", value: secret, secret: true }] }) }));
  const id = started.terminalId;
  const screen = `\x1b[2J\x1b[1;1Hkey=${secret}\x1b[2;1Hnext`;
  host.say(id, screen);
  expect(await until(() => manager.bytes(id).chunks.length > 0)).toBe(true);

  const drawn = manager.bytes(id).chunks.join("");
  expect(drawn).toBe(`\x1b[2J\x1b[1;1Hkey=${PTY_MASK.repeat(secret.length)}\x1b[2;1Hnext`);
  expect(drawn).toHaveLength(screen.length);
});

// ── the mirror: what the cockpit's Terminal strip is allowed to draw ─────────

test("the bytes mirrored back to the shell are the REDACTED ones, at the journal's own cursor", async () => {
  const { host, manager, dir, mirrored } = await harness();
  const secret = "sk-live-7b3f91";
  const started = await manager.start(input(dir, { config: config({ env: [{ key: "TOKEN", value: secret, secret: true }] }) }));
  const id = started.terminalId;

  host.say(id, `\x1b[32mup\x1b[0m with ${secret}`);
  expect(await until(() => mirrored.length > 0)).toBe(true);

  expect(mirrored[0]!.id).toBe(id);
  expect(mirrored[0]!.data).toBe(manager.bytes(id).chunks.join(""));
  expect(mirrored[0]!.data).toBe(`\x1b[32mup\x1b[0m with ${PTY_MASK.repeat(secret.length)}`);
  expect(mirrored[0]!.cursor).toBe(manager.bytes(id).cursor);

  host.say(id, "more");
  expect(await until(() => mirrored.length > 1)).toBe(true);
  expect(mirrored[1]!.cursor).toBe(manager.bytes(id).cursor);
  expect(manager.bytes(id, mirrored[0]!.cursor!).chunks.join("")).toBe(mirrored[1]!.data);
});

test("a shell that cannot take the mirror does not cost the terminal anything", async () => {
  // A repaint is not worth a terminal. The mirror is fire-and-forget, so a host
  // refusing it — here, a host that has gone — leaves the terminal running.
  const { host, server, manager, dir } = await harness();
  const started = await manager.start(input(dir));
  host.say(started.terminalId, "before");
  expect(await until(() => manager.bytes(started.terminalId).chunks.length > 0)).toBe(true);
  await server.close();
  servers.pop();
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(manager.run(started.terminalId).status).toBe("running");
});

test("the byte cursor resumes, and a cursor that went backwards means another terminal", async () => {
  const { host, manager, dir } = await harness();
  const started = await manager.start(input(dir));
  const id = started.terminalId;

  host.say(id, "first");
  expect(await until(() => manager.bytes(id).cursor === 1)).toBe(true);
  const first = manager.bytes(id);
  expect(first.chunks.join("")).toBe("first");

  host.say(id, "second");
  expect(await until(() => manager.bytes(id).cursor === 2)).toBe(true);
  const next = manager.bytes(id, first.cursor);
  expect(next.chunks.join("")).toBe("second");
  expect(next.dropped).toBe(0);
  expect(manager.bytes(id, 0).chunks.join("")).toBe("firstsecond");
});
