/**
 * The `terminal_*` tools, the `run_*` aliases, and "closed by the person".
 *
 * ON A FAKE HOST. The rules under test are the toolkit's and the manager's —
 * which terminal a call means, who closed it, what the agent is told — and a
 * host that records what it was asked to open, and prints what the test tells
 * it to, is a sharper witness to them than a real process.
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, type FetchLike } from "@telar/engine-client";
import { withTurnNotes } from "../src/attribution";
import { clientRunCapability } from "../src/run/client-capability";
import type { RunHandle, RunLaunchEvents, RunLaunchRequest, RunLauncher } from "../src/run/launcher";
import { RunManager } from "../src/run/manager";
import { personClosedNote } from "../src/run/mount";
import { matchRunRoute } from "../src/run/routes";
import { RunStore } from "../src/run/store";
import { storeRunCapability } from "../src/run/store-capability";
import { runTools } from "../src/run/tools";
import type { RunView } from "../src/run/types";
import { EngineStore } from "../src/state";

const tempDirs: string[] = [];
const temp = (label: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `telar-terminal-${label}-`));
  tempDirs.push(dir);
  return dir;
};
const managers: RunManager[] = [];

afterEach(async () => {
  while (managers.length) await managers.pop()!.shutdown();
});
afterAll(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A host that opens nothing: it names each terminal, remembers what it was
 * asked for, prints on request, and ends a terminal the way the real one does —
 * `close` when the engine asked, or `personCloses` for a tab the person closed
 * from the cockpit without going through the engine.
 */
function fakeHost() {
  const opened: Array<{ id: string; request: RunLaunchRequest; events: RunLaunchEvents }> = [];
  let sequence = 0;
  const launcher: RunLauncher = {
    kind: "pty",
    async launch(request, events) {
      const id = `term_${(sequence += 1)}`;
      opened.push({ id, request, events });
      const handle: RunHandle = {
        pid: 50_000 + sequence,
        terminalId: id,
        async close() {
          events.exited({ exitCode: 143, closed: "close" });
        },
        async signal() {},
        write: async () => true,
        resize: async () => true,
      };
      return handle;
    },
  };
  const find = (id: string) => opened.find((entry) => entry.id === id)!;
  return {
    launcher,
    opened,
    print: (id: string, text: string) => find(id).events.output("stdout", text),
    personCloses: (id: string) => find(id).events.exited({ exitCode: 143, closed: "close" }),
  };
}

type Answer = { text: string; isError: boolean };

function surface() {
  const host = fakeHost();
  const closedByPerson: RunView[] = [];
  const manager = new RunManager({ launcher: host.launcher, personClosed: (run) => closedByPerson.push(run) });
  managers.push(manager);
  const store = new RunStore(temp("state"));
  const tree = temp("tree");
  const capability = storeRunCapability({ store, manager, context: () => ({ sessionId: "s", projectId: "p", worktreePath: tree }) });
  const tools = new Map<string, { description: string; call: (args?: Record<string, unknown>) => Promise<Answer> }>();
  runTools((name, description, _shape, handler) => {
    tools.set(name, {
      description,
      call: async (args = {}) => {
        const result = await handler(args);
        return { text: (result.content as { text?: string }[]).map((part) => part.text ?? "").join("\n"), isError: result.isError === true };
      },
    });
    return name;
  }, capability);
  const call = (name: string, args?: Record<string, unknown>) => tools.get(name)!.call(args);
  return { host, manager, store, tree, capability, tools, call, closedByPerson };
}

const idIn = (text: string) => /terminalId: (term_\d+)/.exec(text)![1]!;

// ── the new wall ────────────────────────────────────────────────────────────

test("terminal_open opens a NEW terminal on every call, owned by the session, and returns its terminalId", async () => {
  const { call, host, manager } = surface();
  const first = await call("terminal_open", { command: "bun run dev --port 3000" });
  const second = await call("terminal_open", { command: "bun run dev --port 3000" });
  expect(first.isError).toBe(false);
  expect(second.isError).toBe(false);
  const [a, b] = [idIn(first.text), idIn(second.text)];
  expect(a).not.toBe(b);
  // An agent's command is `origin: agent`, titled from the command when it has
  // no name, and numbered like any other instance.
  expect(host.opened.map((entry) => [entry.request.sessionId, entry.request.origin, entry.request.title])).toEqual([
    ["s", "agent", "bun run dev"],
    ["s", "agent", "bun run dev #2"],
  ]);
  expect(manager.run(a).status).toBe("running");
  expect(manager.run(b).status).toBe("running");
});

test("terminal_open with a configId opens that configuration as a run; with neither, or both, it says what it needs", async () => {
  const { call, host, store } = surface();
  const config = store.create("p", { name: "web dev", command: "bun run dev" });
  const opened = await call("terminal_open", { configId: config.id });
  expect(opened.isError).toBe(false);
  expect(host.opened[0]!.request.origin).toBe("run");
  expect(host.opened[0]!.request.title).toBe("web dev");

  expect((await call("terminal_open", {})).text).toContain("needs a command");
  expect((await call("terminal_open", { command: "ls", configId: config.id })).text).toContain("not both");
});

test("terminal_open keeps a command inside the worktree, like a saved one", async () => {
  const { call } = surface();
  const outside = await call("terminal_open", { command: "ls", cwd: "../elsewhere" });
  expect(outside.isError).toBe(true);
  expect(outside.text).toContain("inside the worktree");
});

test("terminal_list, terminal_output and terminal_wait read the terminal they are given", async () => {
  const { call, host } = surface();
  const id = idIn((await call("terminal_open", { command: "bun run dev", name: "web" })).text);

  const listed = await call("terminal_list");
  expect(listed.text).toContain('"web" is running');
  expect(listed.text).toContain(id);

  const waiting = call("terminal_wait", { terminalId: id, pattern: "Listening on", timeoutMs: 5_000 });
  host.print(id, "booting\r\nListening on http://localhost:3000\r\n");
  const waited = await waiting;
  expect(waited.text.startsWith("MATCHED")).toBe(true);
  expect(waited.text).toContain("Listening on http://localhost:3000");

  const output = await call("terminal_output", { terminalId: id, grep: "^booting" });
  expect(output.text).toContain("booting");
  expect(output.text).not.toContain("Listening");
  expect(output.text).toMatch(/\[cursor \d+\]/);
});

test("a ready pattern makes the terminal ready when its output prints it", async () => {
  const { call, host, manager } = surface();
  const id = idIn((await call("terminal_open", { command: "bun run dev", ready: "ready in \\d+ms" })).text);
  expect(manager.run(id).readiness.kind).toBe("pending");

  const waiting = call("terminal_wait", { terminalId: id, ready: true, timeoutMs: 5_000 });
  host.print(id, "compiling\r\nready in 420ms\r\n");
  expect((await waiting).text.startsWith("READY")).toBe(true);
  expect(manager.run(id).status).toBe("ready");
});

test("a ready URL is a readiness URL, not a pattern", async () => {
  const { call, manager } = surface();
  const id = idIn((await call("terminal_open", { command: "bun run dev", ready: "http://localhost:65011" })).text);
  expect(manager.run(id).readinessUrl).toBe("http://localhost:65011");
});

test("terminal_kill closes the terminal and records the agent as who closed it", async () => {
  const { call, manager, closedByPerson } = surface();
  const id = idIn((await call("terminal_open", { command: "bun run dev" })).text);
  const killed = await call("terminal_kill", { terminalId: id });
  expect(killed.isError).toBe(false);
  expect(killed.text).toContain("Closed by you");
  expect(manager.run(id).status).toBe("closed");
  expect(manager.run(id).closedBy).toBe("agent");
  // The agent's own close is not news to the agent.
  expect(closedByPerson).toEqual([]);
});

// ── closed by the person ────────────────────────────────────────────────────

test("a wait on a terminal the person closes answers plainly, at once, and the agent gets a note", async () => {
  const { call, capability, closedByPerson } = surface();
  const id = idIn((await call("terminal_open", { command: "bun run dev", name: "web" })).text);

  // Waiting on a pattern that will now never print — the close must end it,
  // not the timeout.
  const began = Date.now();
  const waiting = call("terminal_wait", { terminalId: id, pattern: "never printed", timeoutMs: 30_000 });
  // The cockpit's close: the route with no `closedBy` is the person.
  await matchRunRoute("POST", "/run/stop")!.route.handle({ params: [], input: { terminalId: id }, capability });
  const waited = await waiting;
  expect(Date.now() - began).toBeLessThan(5_000);
  expect(waited.text).toContain("Closed by the person (exit 143). Do not reopen it unless they ask.");

  const output = await call("terminal_output", { terminalId: id });
  expect(output.text.startsWith("Closed by the person (exit 143)")).toBe(true);

  expect(closedByPerson.map((run) => run.terminalId)).toEqual([id]);
  expect(personClosedNote(closedByPerson[0]!)).toBe(`The person closed terminal "web" (${id}). Do not reopen it unless they ask.`);
});

test("a tab the person closes from the cockpit is recorded as theirs", async () => {
  const { call, host, manager, closedByPerson } = surface();
  const id = idIn((await call("terminal_open", { command: "bun run dev" })).text);
  host.personCloses(id);
  expect(manager.run(id).status).toBe("closed");
  expect(manager.run(id).closedBy).toBe("person");
  expect(closedByPerson).toHaveLength(1);
});

test("the person closing a terminal the agent never touched is not a note", async () => {
  const { host, manager, store, capability, closedByPerson } = surface();
  const config = store.create("p", { name: "web dev", command: "bun run dev" });
  // Pressed Run in the cockpit: the person's, not the agent's.
  const run = await capability.start({ configId: config.id });
  host.personCloses(run.terminalId);
  expect(manager.run(run.terminalId).closedBy).toBe("person");
  expect(closedByPerson).toEqual([]);
});

test("a note reaches the session's next claim once, before the turn's own input", () => {
  const home = temp("engine");
  const store = new EngineStore(path.join(home, "state"));
  store.registerProject({ id: "project_one", name: "One", root: home });
  store.createSession({ id: "session_one", projectId: "project_one", driver: "codex" });
  store.noteForNextTurn("session_one", 'The person closed terminal "web" (term_1). Do not reopen it unless they ask.');

  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const claim = store.claimNextTurn("worker_one")!;
  expect(claim.notes).toEqual(['The person closed terminal "web" (term_1). Do not reopen it unless they ask.']);
  expect(withTurnNotes("Hello", claim.notes)).toBe(
    '[telar note, not typed by the person] The person closed terminal "web" (term_1). Do not reopen it unless they ask.\n\nHello',
  );
  expect(withTurnNotes("Hello", undefined)).toBe("Hello");
});

test("a note is handed over once", () => {
  const home = temp("engine");
  const store = new EngineStore(path.join(home, "state"));
  store.registerProject({ id: "project_one", name: "One", root: home });
  store.createSession({ id: "session_one", projectId: "project_one", driver: "codex" });
  store.noteForNextTurn("session_one", "note");
  store.noteForNextTurn("session_one", "note");
  store.submitTurn("session_one", { runId: "run_one", input: "one" });
  const first = store.claimNextTurn("worker_one")!;
  expect(first.notes).toEqual(["note"]);
  const token = first.turn.claim!.token;
  store.markRunning("session_one", "run_one", token);
  store.completeTurn("session_one", "run_one", token, { text: "done" });

  store.submitTurn("session_one", { runId: "run_two", input: "two" });
  expect(store.claimNextTurn("worker_one")!.notes).toBeUndefined();
});

// ── the old names ───────────────────────────────────────────────────────────

test("each run_* alias maps onto the terminal it replaced", async () => {
  const { call, store, manager, host, closedByPerson } = surface();
  const config = store.create("p", { name: "web dev", command: "bun run dev" });

  // run_start → terminal_open({configId}), `replace` ignored, opened by the agent.
  const started = await call("run_start", { configId: config.id, replace: true });
  const id = idIn(started.text);
  expect(host.opened[0]!.request.origin).toBe("run");
  await call("run_start", { configId: config.id });
  expect(manager.terminals("s").filter((run) => run.status === "running")).toHaveLength(2);

  // run_status → terminal_list, only runs: an agent's own command is not listed.
  const agentId = idIn((await call("terminal_open", { command: "bun test --watch" })).text);
  const status = await call("run_status");
  expect(status.text).toContain(id);
  expect(status.text).not.toContain(agentId);
  expect((await call("terminal_list")).text).toContain(agentId);

  // run_output / run_wait → terminal_output / terminal_wait, runId as the id.
  host.print(id, "Listening on 3000\r\n");
  expect((await call("run_output", { runId: id })).text).toContain("Listening on 3000");
  const waiting = call("run_wait", { runId: id, pattern: "compiled", timeoutMs: 5_000 });
  host.print(id, "compiled\r\n");
  expect((await waiting).text.startsWith("MATCHED")).toBe(true);

  // run_restart → kill, then open: a new id, and the old one closed by the agent.
  const restarted = await call("run_restart", { runId: id });
  const newId = idIn(restarted.text);
  expect(newId).not.toBe(id);
  expect(manager.run(id).closedBy).toBe("agent");
  expect(manager.run(newId).title).toBe("web dev");

  // run_stop → terminal_kill, as the agent.
  await call("run_stop", { runId: newId });
  expect(manager.run(newId).closedBy).toBe("agent");

  // A configuration the agent opened is the agent's: the person closing it is news.
  const opened = manager.terminals("s").find((run) => run.title === "web dev #2")!;
  host.personCloses(opened.terminalId);
  expect(closedByPerson.map((run) => run.terminalId)).toEqual([opened.terminalId]);
});

test("run_release answers that it is no longer needed", async () => {
  const { call } = surface();
  const released = await call("run_release", { runId: "anything" });
  expect(released.isError).toBe(false);
  expect(released.text).toContain("No longer needed");
});

test("there is no terminal_send: the agent never types into a terminal", () => {
  const { tools } = surface();
  expect(tools.has("terminal_send")).toBe(false);
  expect([...tools.keys()].filter((name) => /send|write|type|input/.test(name))).toEqual([]);
});

test("every deprecated alias says which tool replaced it", () => {
  const { tools } = surface();
  for (const [name, replacement] of [
    ["run_start", "terminal_open"],
    ["run_status", "terminal_list"],
    ["run_stop", "terminal_kill"],
    ["run_restart", "terminal_open"],
    ["run_output", "terminal_output"],
    ["run_wait", "terminal_wait"],
  ] as const) {
    expect(tools.get(name)!.description).toStartWith("Deprecated: use ");
    expect(tools.get(name)!.description).toContain(replacement);
  }
});

/**
 * THE WALL'S DESCRIPTIONS ARE PAID FOR ON EVERY TURN of every session with a
 * project, whether or not a terminal is ever opened. The same per-tool cap the
 * other walls keep, and a total that the aliases must not grow past.
 */
test("the wall's descriptions stay inside their budget", () => {
  const { tools } = surface();
  const over = [...tools].filter(([, entry]) => entry.description.length > 350).map(([name, entry]) => `${name} (${entry.description.length})`);
  expect(over).toEqual([]);
  const total = [...tools.values()].reduce((sum, entry) => sum + entry.description.length, 0);
  expect(total).toBeLessThanOrEqual(3_200);
  // An alias is a pointer, not a second copy of the contract.
  for (const [name, entry] of tools) if (name.startsWith("run_") && entry.description.startsWith("Deprecated")) expect(entry.description.length).toBeLessThanOrEqual(160);
});

test("the worker's terminal_open reaches the daemon's open route", async () => {
  const asked: Array<{ method: string; path: string; body: unknown }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    asked.push({ method: init?.method ?? "GET", path: url.pathname.replace(/^\/v2\/sessions\/[^/]+/, ""), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as FetchLike;
  const capability = clientRunCapability(
    new EngineClient({ version: 2, daemonId: "dmn_1", host: "127.0.0.1", port: 1, token: "t".repeat(32), startedAt: new Date().toISOString() }, fetchImpl),
    "sess_1",
  );
  await capability.open({ command: "bun run dev", readyPattern: "ready" });
  await capability.start({ configId: "runcfg_1", openedBy: "agent" });
  expect(asked).toEqual([
    { method: "POST", path: "/run/open", body: { command: "bun run dev", readyPattern: "ready" } },
    { method: "POST", path: "/run/start", body: { configId: "runcfg_1", openedBy: "agent" } },
  ]);
  for (const { method, path: tail } of asked) expect(matchRunRoute(method, tail)).toBeDefined();
});
