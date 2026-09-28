import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, type FetchLike } from "@telar/engine-client";
import { clientRunCapability } from "./client-capability";
import { RunManager } from "./manager";
import { type RunManagerOptions } from "./live-run";
import { matchRunRoute } from "./routes";
import { RunStore } from "./store";
import { storeRunCapability, type RunSessionContext } from "./store-capability";
import { runTools } from "./tools";
import type { RunCapability } from "./capability";

const tempDirs: string[] = [];
const temp = (label: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `telar-run-${label}-`));
  tempDirs.push(dir);
  return dir;
};

type FakeTool = {
  name: string;
  description: string;
  shape: Record<string, unknown>;
  call: (args?: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
};

function harness(capability: RunCapability): Map<string, FakeTool> {
  const tools = new Map<string, FakeTool>();
  runTools((name, description, shape, handler) => {
    tools.set(name, {
      name,
      description,
      shape,
      call: async (args = {}) => {
        const result = await handler(args);
        const text = (result.content as { text?: string }[]).map((part) => part.text ?? "").join("\n");
        return { text, isError: result.isError === true };
      },
    });
    return name;
  }, capability);
  return tools;
}

const managers: RunManager[] = [];

function surface(context: () => RunSessionContext, options: RunManagerOptions = {}) {
  const manager = new RunManager(options);
  managers.push(manager);
  const store = new RunStore(temp("state"));
  const capability = storeRunCapability({ store, manager, context });
  return { manager, store, capability, tools: harness(capability) };
}

afterEach(async () => {
  while (managers.length) await managers.pop()!.shutdown();
});

afterAll(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const route = (method: string, tail: string) => {
  const found = matchRunRoute(method, tail);
  if (!found) throw new Error(`no route for ${method} ${tail}`);
  return found;
};

test("every tool on this wall is terminal_- or run_-prefixed", () => {
  const tools = surface(() => ({ sessionId: "s", projectId: "p", worktreePath: temp("tree") })).tools;

  expect(tools.size).toBe(15);
  for (const name of tools.keys()) {
    expect(name).toMatch(/^(terminal|run)_[a-z_]+$/);
  }
});

test("a configuration saved through the route is the one the agent's tool reads back", async () => {
  const tree = temp("tree");
  const { capability, tools } = surface(() => ({ sessionId: "s", projectId: "p", worktreePath: tree }));

  const created = (await route("POST", "/run/configs").route.handle({
    params: [],
    input: { name: "web dev", command: "echo hi", cwd: "apps/web", env: [{ key: "TOKEN", value: "sk_live_secret", secret: true }] },
    capability,
  })) as { id: string };

  const listed = await tools.get("run_configs")!.call();
  expect(listed.isError).toBe(false);
  expect(listed.text).toContain("web dev");
  expect(listed.text).toContain(created.id);
  expect(listed.text).not.toContain("sk_live_secret");
});

test("an absolute working directory is refused at the door, in words a human could act on", async () => {
  const { capability } = surface(() => ({ sessionId: "s", projectId: "p", worktreePath: temp("tree") }));
  await expect(
    route("POST", "/run/configs").route.handle({ params: [], input: { name: "bad", command: "ls", cwd: "/etc" }, capability }),
  ).rejects.toThrow(/must stay inside the worktree/i);
});

const terminalIn = (text: string): string => /terminal (pipe_[0-9a-f]+|term_[0-9a-z_]+)/.exec(text)![1]!;

test("run_status lists THIS session's terminals, each with its id", async () => {
  const tree = temp("tree");
  let sessionId = "s";
  const { store, tools } = surface(() => ({ sessionId, projectId: "p", worktreePath: tree }));
  const config = store.create("p", { name: "server", command: "sleep 30" });

  const empty = await tools.get("run_status")!.call();
  expect(empty.text).toContain("no terminals");

  const started = await tools.get("run_start")!.call({ configId: config.id });
  expect(started.isError).toBe(false);
  expect(started.text).toContain("running");
  const id = terminalIn(started.text);

  const seen = await tools.get("run_status")!.call();
  expect(seen.text).toContain(id);
  expect(seen.text).toContain(tree);

  sessionId = "other";
  expect((await tools.get("run_status")!.call()).text).toContain("no terminals");
}, 15_000);

test("run_start on a configuration already open opens another instance, and ignores replace", async () => {
  const tree = temp("tree");
  const { store, tools, manager } = surface(() => ({ sessionId: "s", projectId: "p", worktreePath: tree }));
  const config = store.create("p", { name: "server", command: "sleep 30" });
  const first = await tools.get("run_start")!.call({ configId: config.id });
  const second = await tools.get("run_start")!.call({ configId: config.id, replace: true });

  expect(second.isError).toBe(false);
  expect(second.text).toContain('"server #2"');
  expect(manager.run(terminalIn(first.text)).status).toBe("running");
  expect(manager.run(terminalIn(second.text)).status).toBe("running");
}, 15_000);

test("run_stop closes the terminal, records the agent as who closed it, and names the choice when there are two", async () => {
  const tree = temp("tree");
  const { store, tools, manager } = surface(() => ({ sessionId: "s", projectId: "p", worktreePath: tree }));
  const config = store.create("p", { name: "server", command: "sleep 30" });
  const first = terminalIn((await tools.get("run_start")!.call({ configId: config.id })).text);
  const second = terminalIn((await tools.get("run_start")!.call({ configId: config.id })).text);

  const ambiguous = await tools.get("run_stop")!.call({});
  expect(ambiguous.isError).toBe(true);
  expect(ambiguous.text).toContain(first);
  expect(ambiguous.text).toContain(second);

  const closed = await tools.get("run_stop")!.call({ runId: first });
  expect(closed.isError).toBe(false);
  expect(manager.run(first).status).toBe("closed");
  expect(manager.run(first).closedBy).toBe("agent");
  expect(manager.run(second).status).toBe("running");

  expect((await tools.get("run_status")!.call()).text).toContain("Closed by you");
}, 15_000);

test("a close from the cockpit is the person's, and the agent is told so", async () => {
  const tree = temp("tree");
  const { store, tools, capability } = surface(() => ({ sessionId: "s", projectId: "p", worktreePath: tree }));
  const config = store.create("p", { name: "server", command: "sleep 30" });
  const id = terminalIn((await tools.get("run_start")!.call({ configId: config.id })).text);

  const closed = (await route("POST", "/run/stop").route.handle({ params: [], input: { terminalId: id }, capability })) as { closedBy?: string };
  expect(closed.closedBy).toBe("person");
  expect((await tools.get("run_status")!.call()).text).toContain("Closed by the person");
  expect((await tools.get("run_status")!.call()).text).toContain("Do not reopen it unless they ask");
}, 15_000);

test("a terminal id belonging to another session is not found rather than acted on", async () => {
  const tree = temp("tree");
  let sessionId = "s";
  const { store, manager, tools, capability } = surface(() => ({ sessionId, projectId: "p", worktreePath: tree }));
  const config = store.create("p", { name: "server", command: "sleep 30" });
  const started = await tools.get("run_start")!.call({ configId: config.id });
  const id = terminalIn(started.text);

  sessionId = "other";
  const stopped = await tools.get("run_stop")!.call({ runId: id });
  expect(stopped.isError).toBe(true);
  expect(stopped.text).toMatch(/no terminal/);
  await expect(route("POST", "/run/stop").route.handle({ params: [], input: { terminalId: id }, capability })).rejects.toThrow(/no terminal/);

  expect(manager.run(id).status).toBe("running");
}, 15_000);

test("run_release is kept only to say it is no longer needed", async () => {
  const tree = temp("tree");
  const { tools } = surface(() => ({ sessionId: "s", projectId: "p", worktreePath: tree }));
  const released = await tools.get("run_release")!.call({ runId: "anything" });
  expect(released.isError).toBe(false);
  expect(released.text).toContain("No longer needed");
  expect(matchRunRoute("POST", "/run/release")).toBeUndefined();
});

test("output read through the tool is bounded, cursored, and scrubbed of secret values", async () => {
  const tree = temp("tree");
  const { store, tools } = surface(() => ({ sessionId: "s", projectId: "p", worktreePath: tree }));
  const config = store.create("p", {
    name: "noisy",
    command: 'echo "token=$TOKEN"; echo oops >&2',
    env: [{ key: "TOKEN", value: "sk_live_secret", secret: true }],
  });
  await tools.get("run_start")!.call({ configId: config.id });

  let output = await tools.get("run_output")!.call();
  for (let attempt = 0; attempt < 100 && !output.text.includes("token="); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    output = await tools.get("run_output")!.call();
  }
  expect(output.text).toContain("token=«redacted»");
  expect(output.text).not.toContain("sk_live_secret");
  expect(output.text).toContain("! oops");
  expect(output.text).toMatch(/\[cursor \d+\]/);
}, 15_000);

test("the route table covers the whole capability and nothing else", () => {
  expect(matchRunRoute("GET", "/run/configs")).toBeDefined();
  expect(matchRunRoute("POST", "/run/configs")).toBeDefined();
  expect(matchRunRoute("POST", "/run/configs/runcfg_1")?.params).toEqual(["runcfg_1"]);
  expect(matchRunRoute("DELETE", "/run/configs/runcfg_1")?.params).toEqual(["runcfg_1"]);
  for (const tail of ["/run/start", "/run/stop", "/run/restart"]) {
    expect(matchRunRoute("POST", tail)).toBeDefined();
    expect(matchRunRoute("GET", tail)).toBeUndefined();
  }
  expect(matchRunRoute("GET", "/run/status")).toBeDefined();
  expect(matchRunRoute("GET", "/run/output")).toBeDefined();
  expect(matchRunRoute("POST", "/run/anything-else")).toBeUndefined();
  expect(matchRunRoute("POST", "/run/configs/a/b")).toBeUndefined();
});

const chatty = (command: string) => ({ name: "server", command });

test("run_wait blocks until a line matches, and says WHICH condition fired", async () => {
  const tree = temp("tree");
  const { store, tools } = surface(() => ({ sessionId: "s", projectId: "p", worktreePath: tree }));
  const config = store.create("p", chatty("echo booting; sleep 0.3; echo 'Listening on http://localhost:3000'; sleep 30"));
  await tools.get("run_start")!.call({ configId: config.id });

  const waited = await tools.get("run_wait")!.call({ pattern: "Listening on", timeoutMs: 10_000 });
  expect(waited.isError).toBe(false);
  expect(waited.text).toContain("MATCHED");
  expect(waited.text).toContain("Listening on http://localhost:3000");
  expect(waited.text).toMatch(/\[cursor \d+\]/);
}, 20_000);

test("a wait that times out says so first, rather than burying it under the log", async () => {
  const tree = temp("tree");
  const { store, tools } = surface(() => ({ sessionId: "s", projectId: "p", worktreePath: tree }));
  const config = store.create("p", chatty("echo quiet; sleep 30"));
  await tools.get("run_start")!.call({ configId: config.id });

  const waited = await tools.get("run_wait")!.call({ pattern: "never happens", timeoutMs: 300 });
  expect(waited.isError).toBe(false);
  expect(waited.text.startsWith("TIMED OUT")).toBe(true);
  expect(waited.text).toContain("do not assume it is up");
}, 20_000);

test("run_wait exit waits a build out, and fires once the terminal has ended", async () => {
  const tree = temp("tree");
  const { store, tools, manager } = surface(() => ({ sessionId: "s", projectId: "p", worktreePath: tree }));
  const config = store.create("p", chatty("echo building; sleep 0.2; echo done"));
  const started = await tools.get("run_start")!.call({ configId: config.id });
  const id = terminalIn(started.text);

  const waited = await tools.get("run_wait")!.call({ exit: true, timeoutMs: 10_000 });
  expect(waited.text).toContain("ENDED");
  expect(manager.run(id).status).toBe("exited");
}, 20_000);

test("waiting for readiness on a recipe with no readiness URL is refused, not waited out", async () => {
  const tree = temp("tree");
  const { store, tools } = surface(() => ({ sessionId: "s", projectId: "p", worktreePath: tree }));
  const config = store.create("p", chatty("sleep 30"));
  await tools.get("run_start")!.call({ configId: config.id });

  const began = Date.now();
  const waited = await tools.get("run_wait")!.call({ ready: true, timeoutMs: 60_000 });
  expect(waited.isError).toBe(true);
  expect(waited.text).toContain("readinessUrl");
  expect(Date.now() - began).toBeLessThan(5_000);
}, 20_000);

test("a wait with nothing to wait FOR is refused, because that is a sleep", async () => {
  const tree = temp("tree");
  const { store, tools } = surface(() => ({ sessionId: "s", projectId: "p", worktreePath: tree }));
  const config = store.create("p", chatty("sleep 30"));
  await tools.get("run_start")!.call({ configId: config.id });

  const waited = await tools.get("run_wait")!.call({ timeoutMs: 5_000 });
  expect(waited.isError).toBe(true);
  expect(waited.text).toMatch(/pattern, ready or exit/);
}, 20_000);

test("a bad regular expression is the CALLER'S mistake, worded as one", async () => {
  const tree = temp("tree");
  const { store, tools } = surface(() => ({ sessionId: "s", projectId: "p", worktreePath: tree }));
  const config = store.create("p", chatty("sleep 30"));
  await tools.get("run_start")!.call({ configId: config.id });

  const waited = await tools.get("run_wait")!.call({ pattern: "[unclosed", timeoutMs: 1_000 });
  expect(waited.isError).toBe(true);
  expect(waited.text).toContain("not a valid regular expression");
}, 20_000);

test("run_output narrows with tail, grep and stream WITHOUT moving the cursor", async () => {
  const tree = temp("tree");
  const { store, tools, capability } = surface(() => ({ sessionId: "s", projectId: "p", worktreePath: tree }));
  const config = store.create("p", chatty("echo one; echo two; echo ERROR three; echo four >&2; sleep 30"));
  await tools.get("run_start")!.call({ configId: config.id });
  await tools.get("run_wait")!.call({ pattern: "four", timeoutMs: 10_000 });

  const whole = await capability.output({});
  expect(whole.lines.length).toBeGreaterThanOrEqual(4);

  const tailed = await capability.output({ tail: 2 });
  expect(tailed.lines.length).toBe(2);
  expect(tailed.cursor).toBe(whole.cursor);

  const grepped = await capability.output({ grep: "^ERROR" });
  expect(grepped.lines.map((line) => line.text)).toEqual(["ERROR three"]);
  expect(grepped.cursor).toBe(whole.cursor);

  const errs = await capability.output({ stream: "stderr" });
  expect(errs.lines.map((line) => line.text)).toEqual(["four"]);
  expect(errs.cursor).toBe(whole.cursor);

  const none = await tools.get("run_output")!.call({ grep: "nothing matches this" });
  expect(none.text).toContain("no line in this window matched");
  expect(none.text).not.toContain("no output yet");
}, 20_000);

test("run_stop sends the signal it was asked for first, and the close escalates to SIGKILL regardless", async () => {
  const tree = temp("tree");
  const signalled: Array<{ pid: number; signal: string }> = [];
  const { store, tools } = surface(
    () => ({ sessionId: "s", projectId: "p", worktreePath: tree }),
    {
      processGroup: {
        detached: true,
        stop: (pid, force, signal) => {
          signalled.push({ pid, signal: force ? "SIGKILL" : (signal ?? "SIGTERM") });
        },
        emptied: () => false,
        liveness: () => "alive",
      },
      stopGraceMs: 60,
      closeSettleMs: 60,
    },
  );
  const config = store.create("p", chatty("sleep 30"));
  await tools.get("run_start")!.call({ configId: config.id });

  try {
    await tools.get("run_stop")!.call({ signal: "SIGINT" });
    expect(signalled.map((entry) => entry.signal)).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
  } finally {
    for (const pid of new Set(signalled.map((entry) => entry.pid))) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
      }
    }
  }
}, 20_000);

test("the wait route exists, refuses a budget past the ceiling, and is a POST", async () => {
  const { capability } = surface(() => ({ sessionId: "s", projectId: "p", worktreePath: temp("tree") }));
  expect(matchRunRoute("GET", "/run/wait")).toBeUndefined();
  await expect(
    route("POST", "/run/wait").route.handle({ params: [], input: { timeoutMs: 600_000, exit: true }, capability }),
  ).rejects.toThrow(/timeoutMs/);
});

test("every call the worker's capability makes hits a route that exists", async () => {
  const asked: Array<{ method: string; path: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    asked.push({ method: init?.method ?? "GET", path: url.pathname.replace(/^\/v2\/sessions\/[^/]+/, "") });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as FetchLike;
  const capability = clientRunCapability(
    new EngineClient(
      { version: 2, daemonId: "dmn_1", host: "127.0.0.1", port: 1, token: "t".repeat(32), startedAt: new Date().toISOString() },
      fetchImpl,
    ),
    "sess_1",
  );

  await capability.configurations();
  await capability.createConfiguration({ name: "n", command: "c" });
  await capability.updateConfiguration("runcfg_1", { command: "c" });
  await capability.removeConfiguration("runcfg_1");
  await capability.status();
  await capability.start({ configId: "runcfg_1" });
  await capability.stop({});
  await capability.restart({});
  await capability.output({});
  await capability.output({ tail: 5, grep: "error", stream: "stderr" });
  await capability.wait({ runId: "run_1", pattern: "up", timeoutMs: 1 });
  await capability.stop({ signal: "SIGINT", closedBy: "agent" });

  expect(asked).toHaveLength(12);
  for (const { method, path } of asked) {
    expect({ method, path, matched: Boolean(matchRunRoute(method, path)) }).toEqual({ method, path, matched: true });
  }
});

test("the worker's capability names the terminal and who closed it on the wire", async () => {
  const bodies: Array<{ path: string; body: unknown }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    bodies.push({ path: `${url.pathname.replace(/^\/v2\/sessions\/[^/]+/, "")}${url.search}`, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as FetchLike;
  const capability = clientRunCapability(
    new EngineClient({ version: 2, daemonId: "dmn_1", host: "127.0.0.1", port: 1, token: "t".repeat(32), startedAt: new Date().toISOString() }, fetchImpl),
    "sess_1",
  );
  await capability.stop({ runId: "term_1", closedBy: "agent" });
  await capability.wait({ runId: "term_1", exit: true, timeoutMs: 1 });
  await capability.output({ runId: "term_1" });
  expect(bodies).toEqual([
    { path: "/run/stop", body: { terminalId: "term_1", closedBy: "agent" } },
    { path: "/run/wait", body: { exit: true, timeoutMs: 1, terminalId: "term_1" } },
    { path: "/run/output?terminalId=term_1", body: undefined },
  ]);
});
