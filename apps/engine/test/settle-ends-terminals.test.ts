/**
 * SETTLING A SESSION ENDS WHAT IT LEFT RUNNING — issue #883.
 *
 * An explicit settle closes every terminal the session owns at once, the
 * person's own shells included, through the host's `/close-session`; they are
 * recorded as closed by Telar and the agent is not told the person did it. The
 * clock's settle waits `SETTLED_TERMINAL_GRACE_MS` first, and live background
 * work (#965) keeps the clock from settling at all.
 *
 * BOTH REAL HALVES OF THE WIRE ARE IN THE LOOP, as in `run-terminal-channel`:
 * the desktop's `run-terminal-server.js` over loopback, and a host behind it
 * that is a fake only in that it starts no process.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { terminalLauncher } from "../src/run/launcher";
import { RunManager, type StartRunInput } from "../src/run/manager";
import { RunTerminalClient } from "../src/run/terminal-client";
import type { RunView } from "../src/run/types";
import { EngineStore, SETTLED_TERMINAL_GRACE_MS } from "../src/state";

const desktopServer = path.join(import.meta.dir, "..", "..", "desktop", "run-terminal-server.js");
type StartServer = (options: {
  port: number;
  token: string;
  getTerminalHost: () => unknown;
}) => Promise<{ port: number; onData: (id: string, data: string) => void; onExit: (id: string, ending: unknown) => void; close: () => Promise<unknown> }>;
const { startRunTerminalServer } = (await import(desktopServer)) as { startRunTerminalServer: StartServer };

const HOUR = 60 * 60 * 1000;

type FakeTerminal = { id: string; pid: number; sessionId?: string; origin: string; owner: "engine" | "renderer" };

/** Holds terminals for two owners, like the real one: the engine's and the person's. */
class FakeHost {
  readonly terminals = new Map<string, FakeTerminal>();
  readonly sessionCloses: string[] = [];
  onExit: (id: string, ending: unknown) => void = () => {};
  private sequence = 0;

  open(request: { sessionId?: string; origin?: string }): unknown {
    const id = `term_${(this.sequence += 1)}`;
    this.terminals.set(id, { id, pid: 40_000 + this.sequence, sessionId: request.sessionId, origin: request.origin ?? "run", owner: "engine" });
    return { id, pid: 40_000 + this.sequence };
  }

  /** A shell the person opened in the session's panel. The engine never sees it. */
  personShell(sessionId: string): string {
    const id = `term_${(this.sequence += 1)}`;
    this.terminals.set(id, { id, pid: 40_000 + this.sequence, sessionId, origin: "user", owner: "renderer" });
    return id;
  }

  async close(id: string): Promise<boolean> {
    return this.end(id, "close");
  }

  async killBySession(sessionId: string): Promise<number> {
    this.sessionCloses.push(sessionId);
    const records = [...this.terminals.values()].filter((terminal) => terminal.sessionId === sessionId);
    for (const record of records) this.end(record.id, "session");
    return records.length;
  }

  /** Quitting Telar: the desktop's `before-quit` closes every terminal. */
  async closeAll(): Promise<number> {
    const records = [...this.terminals.values()];
    for (const record of records) this.end(record.id, "quit");
    return records.length;
  }

  kill(): boolean {
    return false;
  }

  list(): FakeTerminal[] {
    return [...this.terminals.values()].filter((terminal) => terminal.owner === "engine");
  }

  private end(id: string, closed: "close" | "session" | "quit"): boolean {
    const terminal = this.terminals.get(id);
    if (!terminal) return false;
    this.terminals.delete(id);
    if (terminal.owner === "engine") this.onExit(id, { id, pid: terminal.pid, fate: "exited", exitCode: 0, signal: "1", at: Date.now(), closed });
    return true;
  }
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function scene() {
  const host = new FakeHost();
  const server = await startRunTerminalServer({ port: 0, token: "test-token", getTerminalHost: () => host });
  cleanups.push(() => server.close());
  host.onExit = server.onExit;
  const client = new RunTerminalClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: "test-token", reconnectMs: 20, reconnectMaxMs: 50 });
  cleanups.push(() => client.detach());
  const closedByPerson: RunView[] = [];
  const manager = new RunManager({ launcher: terminalLauncher(client), closeSettleMs: 150, personClosed: (run) => closedByPerson.push(run) });
  cleanups.push(() => manager.shutdown());

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-settle-terminals-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  let now = 1_000 * HOUR;
  const store = new EngineStore(home, () => now);
  store.attachTerminals(manager);
  store.registerProject({ id: "project_one", name: "One", root: home });
  store.createSession({ id: "session_one", projectId: "project_one" });
  store.createSession({ id: "session_two", projectId: "project_one" });

  const open = (sessionId: string, overrides: Partial<StartRunInput> = {}) =>
    manager.start({
      projectId: "project_one",
      sessionId,
      config: { id: "", projectId: "project_one", name: "dev", command: "sleep 60", createdAt: 1, updatedAt: 1 },
      worktreePath: home,
      origin: "agent",
      openedBy: "agent",
      ...overrides,
    });
  return { host, manager, store, closedByPerson, open, advance: (ms: number) => (now += ms) };
}

test("an explicit settle closes every terminal of the session through /close-session, as Telar, with no note to the agent", async () => {
  const { host, manager, store, closedByPerson, open } = await scene();
  const agents = [await open("session_one"), await open("session_one", { origin: "run", openedBy: "person" })];
  const shell = host.personShell("session_one");
  const other = await open("session_two");

  store.updateSession("session_one", { settledOverride: "settled" });
  const ended = await store.endSessionLeftovers("session_one");

  expect(host.sessionCloses).toEqual(["session_one"]);
  // The person's shell counts: it was the session's too.
  expect(ended).toEqual({ terminals: 3, backgroundTasks: 0 });
  expect(host.terminals.has(shell)).toBe(false);
  for (const run of agents) expect(manager.run(run.terminalId)).toMatchObject({ status: "closed", closedBy: "telar" });
  expect(closedByPerson).toEqual([]);
  // Another session's terminal is not this settle's.
  expect(manager.run(other.terminalId).status).toBe("running");
  expect(manager.openCount("session_two")).toBe(1);
  expect(manager.openSessions()).toEqual(["session_two"]);
});

test("settling a session with nothing open closes nothing and still answers", async () => {
  const { host, store } = await scene();
  store.updateSession("session_one", { settledOverride: "settled" });
  expect(await store.endSessionLeftovers("session_one")).toEqual({ terminals: 0, backgroundTasks: 0 });
  expect(host.sessionCloses).toEqual(["session_one"]);
});

test("the clock's settle keeps the terminals for the grace, then closes them as Telar", async () => {
  const { host, manager, store, closedByPerson, open, advance } = await scene();
  const run = await open("session_one");
  const window = store.getInboxPolicy().autoSettleAfterHours!;

  // Shelved by the clock, but only just: nothing closes.
  advance(window * HOUR + 60_000);
  expect(await store.sweepSettledTerminals()).toEqual([]);
  expect(manager.run(run.terminalId).status).toBe("running");

  advance(SETTLED_TERMINAL_GRACE_MS);
  expect(await store.sweepSettledTerminals()).toEqual(["session_one"]);
  expect(host.sessionCloses).toEqual(["session_one"]);
  expect(manager.run(run.terminalId)).toMatchObject({ status: "closed", closedBy: "telar" });
  expect(closedByPerson).toEqual([]);
});

test("a session the clock has not settled keeps its terminals, however long they run", async () => {
  const { host, manager, store, open, advance } = await scene();
  const run = await open("session_one");
  store.updateSession("session_one", { settledOverride: "active" });
  advance(30 * 24 * HOUR);
  expect(await store.sweepSettledTerminals()).toEqual([]);
  expect(host.sessionCloses).toEqual([]);
  expect(manager.run(run.terminalId).status).toBe("running");
});

test("live background work holds the clock off (#965), so its terminals stay; an explicit settle ends both", async () => {
  const { manager, store, open, advance } = await scene();
  store.submitTurn("session_one", { runId: "run_bg", input: "Watch the build" });
  const claimed = store.claimNextTurn("worker_one")!;
  const token = claimed.turn.claim!.token;
  store.markRunning("session_one", "run_bg", token);
  store.ingestObservations("session_one", "run_bg", token, [
    { kind: "task.started", task: { id: "task_bg", providerTaskId: "bg1", kind: "background", backgrounded: true, state: "running", title: "Tail the log" } },
  ]);
  store.completeTurn("session_one", "run_bg", token, { text: "Watching" });
  store.markSessionRead("session_one", "run_bg");
  const run = await open("session_one");
  expect(store.getSession("session_one").activity).toBe("monitoring");

  advance(30 * 24 * HOUR);
  expect(await store.sweepSettledTerminals()).toEqual([]);
  expect(manager.run(run.terminalId).status).toBe("running");

  store.updateSession("session_one", { settledOverride: "settled" });
  expect(await store.endSessionLeftovers("session_one")).toEqual({ terminals: 1, backgroundTasks: 1 });
  expect(manager.run(run.terminalId)).toMatchObject({ status: "closed", closedBy: "telar" });
  expect(store.getSession("session_one").activity).toBe("idle");
});

test("quitting Telar closes every session's terminals, recorded as Telar's, with no note to any agent", async () => {
  const { host, manager, closedByPerson, open } = await scene();
  const runs = [await open("session_one"), await open("session_two")];
  expect(await host.closeAll()).toBe(2);
  for (const run of runs) {
    await manager.wait(run.terminalId, { exit: true, timeoutMs: 2000 });
    expect(manager.run(run.terminalId)).toMatchObject({ status: "closed", closedBy: "telar" });
  }
  expect(closedByPerson).toEqual([]);
  expect(manager.openSessions()).toEqual([]);
});

test("a host out of reach does not fail the settle, and leaves the records as they were", async () => {
  const { manager, store, open } = await scene();
  const run = await open("session_one");
  store.attachTerminals({
    openCount: (sessionId) => manager.openCount(sessionId),
    openSessions: () => manager.openSessions(),
    closeSession: async () => {
      throw new Error("connect ECONNREFUSED");
    },
  });
  store.updateSession("session_one", { settledOverride: "settled" });
  expect(await store.endSessionLeftovers("session_one")).toEqual({ terminals: 0, backgroundTasks: 0 });
  expect(store.getSession("session_one").settledOverride).toBe("settled");
  expect(manager.run(run.terminalId).status).toBe("running");
});
