/**
 * WHAT SETTLED SESSIONS STILL HOLD — the rest of issue #883.
 *
 * The engine asks the terminal host how many terminals each session holds,
 * whoever opened them, so the person's own shells count: on the rail, before a
 * Settle, against the machine-wide limit, and at the end of an automatic
 * settle's grace. Past the limit the session settled longest ago closes first,
 * as Telar, and the session says so.
 *
 * Both real halves of the wire are in the loop, as in `settle-ends-terminals`:
 * the desktop's `run-terminal-server.js` over loopback, and a host behind it
 * that is a fake only in that it starts no process. The clock is the store's
 * own, turned by hand.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SETTLED_TERMINAL_LIMIT } from "@telar/engine-client";
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
}) => Promise<{ port: number; onExit: (id: string, ending: unknown) => void; close: () => Promise<unknown> }>;
const { startRunTerminalServer } = (await import(desktopServer)) as { startRunTerminalServer: StartServer };

const HOUR = 60 * 60 * 1000;

type FakeTerminal = { id: string; pid: number; sessionId?: string; owner: "engine" | "renderer" };

/** The engine's terminals and the person's, like the real host; it answers `countBySession` too. */
class FakeHost {
  readonly terminals = new Map<string, FakeTerminal>();
  readonly sessionCloses: string[] = [];
  onExit: (id: string, ending: unknown) => void = () => {};
  private sequence = 0;

  open(request: { sessionId?: string }): unknown {
    const id = `term_${(this.sequence += 1)}`;
    this.terminals.set(id, { id, pid: 40_000 + this.sequence, sessionId: request.sessionId, owner: "engine" });
    return { id, pid: 40_000 + this.sequence };
  }

  /** A shell the person opened in the session's panel. The engine never sees its id. */
  personShell(sessionId: string): string {
    const id = `term_${(this.sequence += 1)}`;
    this.terminals.set(id, { id, pid: 40_000 + this.sequence, sessionId, owner: "renderer" });
    return id;
  }

  countBySession(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const terminal of this.terminals.values()) if (terminal.sessionId) counts[terminal.sessionId] = (counts[terminal.sessionId] ?? 0) + 1;
    return counts;
  }

  async killBySession(sessionId: string): Promise<number> {
    this.sessionCloses.push(sessionId);
    const records = [...this.terminals.values()].filter((terminal) => terminal.sessionId === sessionId);
    for (const record of records) {
      this.terminals.delete(record.id);
      if (record.owner === "engine") this.onExit(record.id, { id: record.id, pid: record.pid, fate: "exited", exitCode: 0, signal: "1", at: Date.now(), closed: "session" });
    }
    return records.length;
  }

  held(sessionId: string): number {
    return [...this.terminals.values()].filter((terminal) => terminal.sessionId === sessionId).length;
  }

  list(): FakeTerminal[] {
    return [...this.terminals.values()].filter((terminal) => terminal.owner === "engine");
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

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-settled-limit-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  let now = 1_000 * HOUR;
  const store = new EngineStore(home, () => now);
  store.attachTerminals(manager);
  store.registerProject({ id: "project_one", name: "One", root: home });
  for (const id of ["session_one", "session_two", "session_three", "session_four"]) store.createSession({ id, projectId: "project_one" });

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
  const advance = (ms: number) => (now += ms);
  /** Shelved by a decision the host missed, as a person's shells opened after it would be. */
  const settle = (sessionId: string) => {
    store.updateSession(sessionId, { settledOverride: "settled" });
    advance(60_000);
  };
  return { host, manager, store, closedByPerson, open, advance, settle };
}

test("past the limit, the session settled longest ago closes first, as Telar, and says so", async () => {
  const { host, manager, store, closedByPerson, open, settle } = await scene();
  store.setInboxPolicy({ settledTerminalLimit: 3 });
  const run = await open("session_one");
  host.personShell("session_two");
  host.personShell("session_two");
  host.personShell("session_three");
  // An active session's terminals are not the limit's business, however many.
  for (let index = 0; index < 4; index += 1) host.personShell("session_four");
  settle("session_one");
  settle("session_two");
  settle("session_three");

  // 1 + 2 + 1 settled, limit 3: the oldest goes, and only it.
  await store.refreshTerminalCensus();
  expect(await store.enforceSettledTerminalLimit()).toEqual(["session_one"]);
  expect(host.sessionCloses).toEqual(["session_one"]);
  expect(manager.run(run.terminalId)).toMatchObject({ status: "closed", closedBy: "telar" });
  expect(closedByPerson).toEqual([]);
  expect(host.held("session_two")).toBe(2);
  expect(host.held("session_four")).toBe(4);

  // Recorded on the session, without making it look worked on.
  const one = store.getSession("session_one");
  expect(one.terminalsClosed).toMatchObject({ terminals: 1, reason: "limit" });
  expect(one.terminalsClosed!.at).toBeGreaterThanOrEqual(one.updatedAt);
  expect(one.settledOverride).toBe("settled");
  expect(store.getSession("session_two").terminalsClosed).toBeUndefined();

  // Under the limit now: a second check closes nothing.
  expect(await store.enforceSettledTerminalLimit()).toEqual([]);
});

test("the setting is the limit: five by default, lowering it applies it, and a bad value is refused", async () => {
  const { host, store, settle } = await scene();
  expect(store.getInboxPolicy().settledTerminalLimit).toBe(DEFAULT_SETTLED_TERMINAL_LIMIT);
  expect(DEFAULT_SETTLED_TERMINAL_LIMIT).toBe(5);
  host.personShell("session_one");
  host.personShell("session_two");
  host.personShell("session_two");
  host.personShell("session_three");
  settle("session_one");
  settle("session_two");
  settle("session_three");
  await store.refreshTerminalCensus();
  // Four under five.
  expect(await store.enforceSettledTerminalLimit()).toEqual([]);
  expect(host.sessionCloses).toEqual([]);

  // One: the two oldest go, and the newest keeps its one terminal.
  store.setInboxPolicy({ settledTerminalLimit: 1 });
  expect(await store.enforceSettledTerminalLimit()).toEqual(["session_one", "session_two"]);
  expect(host.sessionCloses).toEqual(["session_one", "session_two"]);
  expect(host.held("session_three")).toBe(1);

  expect(() => store.setInboxPolicy({ settledTerminalLimit: -1 })).toThrow(/settled terminal limit/);
  expect(() => store.setInboxPolicy({ settledTerminalLimit: 2.5 })).toThrow(/settled terminal limit/);
  expect(store.getInboxPolicy().settledTerminalLimit).toBe(1);
});

test("the automatic settle's sweep closes a shell the person opened, which only the host can see", async () => {
  const { host, manager, store, advance } = await scene();
  const shell = host.personShell("session_one");
  expect(manager.openSessions()).toEqual([]);
  const window = store.getInboxPolicy().autoSettleAfterHours!;

  // Shelved by the clock, but only just: the grace holds.
  advance(window * HOUR + 60_000);
  expect(await store.sweepSettledTerminals()).toEqual([]);
  expect(host.terminals.has(shell)).toBe(true);

  advance(SETTLED_TERMINAL_GRACE_MS);
  expect(await store.sweepSettledTerminals()).toEqual(["session_one"]);
  expect(host.terminals.has(shell)).toBe(false);
  expect(store.getSession("session_one").terminalsClosed).toMatchObject({ terminals: 1, reason: "grace" });
  expect(store.liveSessionRows({ all: true }).terminals).toEqual({});
});

test("the counts include the person's shells: what Settle would close, and what the rail is told", async () => {
  const { host, store, open } = await scene();
  await open("session_one");
  host.personShell("session_one");
  host.personShell("session_three");
  const before = store.sessionsRevision();

  expect(await store.sessionTerminalCount("session_one")).toBe(2);
  expect(await store.sessionTerminalCount("session_two")).toBe(0);
  expect(store.liveSessionRows().terminals).toEqual({ session_one: 2, session_three: 1 });
  // A count that changed moves the cursor, so a conditional read sees it.
  expect(store.sessionsRevision()).toBeGreaterThan(before);

  // An explicit settle closes them all and the row's count goes with them.
  store.updateSession("session_one", { settledOverride: "settled" });
  expect(await store.endSessionLeftovers("session_one")).toEqual({ terminals: 2, backgroundTasks: 0 });
  expect(store.liveSessionRows({ all: true }).terminals).toEqual({ session_three: 1 });
});

test("the person closing a settled session's terminals is recorded as the person's", async () => {
  const { host, manager, store, closedByPerson, open, settle } = await scene();
  const run = await open("session_one");
  host.personShell("session_one");
  settle("session_one");
  expect(await store.closeSessionTerminals("session_one")).toBe(2);
  expect(manager.run(run.terminalId)).toMatchObject({ status: "closed", closedBy: "person" });
  // The agent that opened it is told, as for any close of the person's.
  expect(closedByPerson.map((view) => view.terminalId)).toEqual([run.terminalId]);
  expect(store.getSession("session_one").terminalsClosed).toBeUndefined();
  expect(store.liveSessionRows({ all: true }).terminals).toEqual({});
});
