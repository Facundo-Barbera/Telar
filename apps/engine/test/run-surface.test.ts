/**
 * The two doors — HTTP routes and the `run_*` toolkit — over ONE capability.
 *
 * The point of these tests is that neither door has rules of its own: a refusal
 * a human sees from the panel is the refusal the agent gets, worded for a model.
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, type FetchLike } from "@telar/engine-client";
import { clientRunCapability } from "../src/run/client-capability";
import { RunManager, type RunManagerOptions } from "../src/run/manager";
import { matchRunRoute } from "../src/run/routes";
import { RunStore } from "../src/run/store";
import { storeRunCapability, type RunSessionContext } from "../src/run/store-capability";
import { RUN_READ_ONLY_TOOLS, runTools } from "../src/run/tools";
import type { RunCapability } from "../src/run/capability";

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

/** A `ToolFactory` that keeps the tools instead of registering them. */
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
  // Nothing this file starts outlives it.
  while (managers.length) await managers.pop()!.shutdown();
});

/** And nothing it wrote stays on disk — after the managers, so a group still
 *  draining is not left without a working directory. */
afterAll(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const route = (method: string, tail: string) => {
  const found = matchRunRoute(method, tail);
  if (!found) throw new Error(`no route for ${method} ${tail}`);
  return found;
};

test("every tool on this wall is run_-prefixed, and the read-only list names real tools", () => {
  const tools = surface(() => ({ sessionId: "s", projectId: "p", worktreePath: temp("tree") })).tools;

  expect(tools.size).toBe(10);
  for (const name of tools.keys()) {
    expect(name).toMatch(/^run_[a-z_]+$/);
  }
  // The host reads this list to decide what may skip approval, so a typo in it
  // would either over-expose a mutation or park a harmless read forever.
  for (const name of RUN_READ_ONLY_TOOLS) {
    expect(tools.has(name)).toBe(true);
  }
  expect(RUN_READ_ONLY_TOOLS).not.toContain("run_start");
  expect(RUN_READ_ONLY_TOOLS).not.toContain("run_release");
  expect(RUN_READ_ONLY_TOOLS).not.toContain("run_stop");
  // `run_wait` BLOCKS AND IS STILL A READ (#890). It signals nothing, starts
  // nothing and changes nothing; putting it behind an approval prompt would
  // make the deterministic path the expensive one, and an agent that cannot
  // wait sleeps and guesses instead — which is the behaviour it replaces.
  expect(RUN_READ_ONLY_TOOLS).toContain("run_wait");
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
  // The recipe keeps the secret for the launch; neither door hands it back.
  expect(listed.text).not.toContain("sk_live_secret");
});

test("an absolute working directory is refused at the door, in words a human could act on", async () => {
  const { capability } = surface(() => ({ sessionId: "s", projectId: "p", worktreePath: temp("tree") }));
  await expect(
    route("POST", "/run/configs").route.handle({ params: [], input: { name: "bad", command: "ls", cwd: "/etc" }, capability }),
  ).rejects.toThrow(/must stay inside the worktree/i);
});

test("run_status describes the project's deployment, not this conversation's", async () => {
  const theirTree = temp("theirs");
  const myTree = temp("mine");
  let worktreePath = theirTree;
  const { store, tools } = surface(() => ({ sessionId: "s", projectId: "p", worktreePath }));
  const config = store.create("p", { name: "server", command: "sleep 30" });

  const empty = await tools.get("run_status")!.call();
  expect(empty.text).toContain("Nothing is deployed");

  const started = await tools.get("run_start")!.call({ configId: config.id });
  expect(started.isError).toBe(false);
  expect(started.text).toContain("running");

  // Same project, a session sitting on a different tree: it sees the same run
  // and is told plainly that the tree is not its own.
  worktreePath = myTree;
  const seen = await tools.get("run_status")!.call();
  expect(seen.text).toContain(theirTree);
  expect(seen.text).toContain("NOTE: this session works in");
  expect(seen.text).toContain(myTree);
}, 15_000);

test("run_start against a live deployment refuses and names the two ways out", async () => {
  const tree = temp("tree");
  const { store, tools } = surface(() => ({ sessionId: "s", projectId: "p", worktreePath: tree }));
  const config = store.create("p", { name: "server", command: "sleep 30" });
  await tools.get("run_start")!.call({ configId: config.id });

  const second = await tools.get("run_start")!.call({ configId: config.id });
  expect(second.isError).toBe(true);
  // A model that gets a bare "conflict" retries the identical call.
  expect(second.text).toMatch(/already/i);
  expect(second.text).toContain("run_stop");
  expect(second.text).toContain("replace");
}, 15_000);

test("a run id belonging to another project is not found rather than acted on", async () => {
  const tree = temp("tree");
  let projectId = "p";
  const { store, manager, tools, capability } = surface(() => ({ sessionId: "s", projectId, worktreePath: tree }));
  const config = store.create("p", { name: "server", command: "sleep 30" });
  const started = await tools.get("run_start")!.call({ configId: config.id });
  const runId = /run (run_[0-9a-f]+)/.exec(started.text)![1]!;

  projectId = "other";
  const stopped = await tools.get("run_stop")!.call({ runId });
  expect(stopped.isError).toBe(true);
  expect(stopped.text).toMatch(/no run/);
  await expect(route("POST", "/run/stop").route.handle({ params: [], input: { runId }, capability })).rejects.toThrow(/no run/);

  // And it really was not touched.
  projectId = "p";
  expect(manager.run(runId).status).toBe("running");
}, 15_000);

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

test("release refuses a healthy run through either door", async () => {
  const tree = temp("tree");
  const { store, tools, capability } = surface(() => ({ sessionId: "s", projectId: "p", worktreePath: tree }));
  const config = store.create("p", { name: "server", command: "sleep 30" });
  const started = await tools.get("run_start")!.call({ configId: config.id });
  const runId = /run (run_[0-9a-f]+)/.exec(started.text)![1]!;

  const released = await tools.get("run_release")!.call({ runId });
  expect(released.isError).toBe(true);
  expect(released.text).toMatch(/lost contact/);
  await expect(route("POST", "/run/release").route.handle({ params: [], input: { runId }, capability })).rejects.toThrow(/lost contact/);
}, 15_000);

test("the route table covers the whole capability and nothing else", () => {
  expect(matchRunRoute("GET", "/run/configs")).toBeDefined();
  expect(matchRunRoute("POST", "/run/configs")).toBeDefined();
  expect(matchRunRoute("POST", "/run/configs/runcfg_1")?.params).toEqual(["runcfg_1"]);
  expect(matchRunRoute("DELETE", "/run/configs/runcfg_1")?.params).toEqual(["runcfg_1"]);
  for (const tail of ["/run/start", "/run/stop", "/run/restart", "/run/release"]) {
    expect(matchRunRoute("POST", tail)).toBeDefined();
    expect(matchRunRoute("GET", tail)).toBeUndefined();
  }
  expect(matchRunRoute("GET", "/run/status")).toBeDefined();
  expect(matchRunRoute("GET", "/run/output")).toBeDefined();
  expect(matchRunRoute("POST", "/run/anything-else")).toBeUndefined();
  expect(matchRunRoute("POST", "/run/configs/a/b")).toBeUndefined();
});

// ── what an agent needs from a process that keeps talking (#890) ────────────

/**
 * A recipe that prints on a schedule, so the four conditions are reachable
 * without a port. `sh -c` is what an unpinned recipe resolves to anyway.
 */
const chatty = (command: string) => ({ name: "server", command });

test("run_wait blocks until a line matches, and says WHICH condition fired", async () => {
  // The whole point of the tool: "start the dev server then curl it" stops
  // being `sleep 2 && curl` and becomes a step that either matched or did not.
  const tree = temp("tree");
  const { store, tools } = surface(() => ({ sessionId: "s", projectId: "p", worktreePath: tree }));
  const config = store.create("p", chatty("echo booting; sleep 0.3; echo 'Listening on http://localhost:3000'; sleep 30"));
  await tools.get("run_start")!.call({ configId: config.id });

  const waited = await tools.get("run_wait")!.call({ pattern: "Listening on", timeoutMs: 10_000 });
  expect(waited.isError).toBe(false);
  expect(waited.text).toContain("MATCHED");
  expect(waited.text).toContain("Listening on http://localhost:3000");
  // The lines are the ones that arrived WHILE WAITING, and the cursor resumes.
  expect(waited.text).toMatch(/\[cursor \d+\]/);
}, 20_000);

test("a wait that times out says so first, rather than burying it under the log", async () => {
  // An agent that read past `timeout` in a wall of output would curl a port
  // nothing is listening on and report the refusal as the project's bug.
  const tree = temp("tree");
  const { store, tools } = surface(() => ({ sessionId: "s", projectId: "p", worktreePath: tree }));
  const config = store.create("p", chatty("echo quiet; sleep 30"));
  await tools.get("run_start")!.call({ configId: config.id });

  const waited = await tools.get("run_wait")!.call({ pattern: "never happens", timeoutMs: 300 });
  expect(waited.isError).toBe(false);
  expect(waited.text.startsWith("TIMED OUT")).toBe(true);
  expect(waited.text).toContain("do not assume it is up");
}, 20_000);

test("run_wait exit waits a build out, and fires only once the VERDICT is in", async () => {
  const tree = temp("tree");
  const { store, tools, manager } = surface(() => ({ sessionId: "s", projectId: "p", worktreePath: tree }));
  const config = store.create("p", chatty("echo building; sleep 0.2; echo done"));
  const started = await tools.get("run_start")!.call({ configId: config.id });
  const runId = /run (run_[0-9a-f]+)/.exec(started.text)![1]!;

  const waited = await tools.get("run_wait")!.call({ exit: true, timeoutMs: 10_000 });
  expect(waited.text).toContain("EXITED");
  // SETTLED, not merely "the shell is gone": the group verdict is what decides
  // between `exited` and an `unknown` that holds the project's slot, and an
  // agent told "exited" while that was still open would start the next thing.
  expect(["exited", "failed"]).toContain(manager.run(runId).status);
}, 20_000);

test("waiting for readiness on a recipe with no readiness URL is refused, not waited out", async () => {
  // Nothing could ever make it fire, so honouring it would spend a minute of
  // somebody's turn arriving at `timeout` — which reads as "it did not come up".
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

  // THE CURSOR IS THE WINDOW'S, NOT THE FILTER'S. Every one of these narrows
  // what comes BACK and still reports the position a reader would resume from,
  // which is what lets a caller grep now and read everything later.
  const tailed = await capability.output({ tail: 2 });
  expect(tailed.lines.length).toBe(2);
  expect(tailed.cursor).toBe(whole.cursor);

  const grepped = await capability.output({ grep: "^ERROR" });
  expect(grepped.lines.map((line) => line.text)).toEqual(["ERROR three"]);
  expect(grepped.cursor).toBe(whole.cursor);

  const errs = await capability.output({ stream: "stderr" });
  expect(errs.lines.map((line) => line.text)).toEqual(["four"]);
  expect(errs.cursor).toBe(whole.cursor);

  // And through the tool, where an empty ANSWER has to say which empty it is.
  const none = await tools.get("run_output")!.call({ grep: "nothing matches this" });
  expect(none.text).toContain("no line in this window matched");
  expect(none.text).not.toContain("no output yet");
}, 20_000);

test("run_stop sends the signal it was asked for, and escalates with SIGKILL regardless", async () => {
  // Ctrl-C semantics matter to a dev server that traps SIGTERM to drain
  // connections: for that process SIGTERM is a request it declines and SIGINT
  // is the one it obeys. What must NOT be configurable is the escalation — a
  // second attempt that can be refused is not a second attempt.
  const tree = temp("tree");
  const signalled: Array<{ pid: number; signal: string }> = [];
  const { store, tools } = surface(
    () => ({ sessionId: "s", projectId: "p", worktreePath: tree }),
    {
      // A group that swallows the polite signal, so the escalation is reached.
      processGroup: {
        detached: true,
        stop: (pid, force, signal) => {
          signalled.push({ pid, signal: force ? "SIGKILL" : (signal ?? "SIGTERM") });
        },
        liveness: () => "gone",
      },
      stopGraceMs: 120,
    },
  );
  const config = store.create("p", chatty("sleep 30"));
  await tools.get("run_start")!.call({ configId: config.id });

  await tools.get("run_stop")!.call({ signal: "SIGINT" });
  expect(signalled[0]!.signal).toBe("SIGINT");
  expect(signalled.map((entry) => entry.signal)).toContain("SIGKILL");
}, 20_000);

test("the wait route exists, refuses a budget past the ceiling, and is a POST", async () => {
  // The tool schema is the model's contract; the HTTP surface is everyone
  // else's. A route that trusted the caller could be made to park a worker for
  // as long as it liked.
  const { capability } = surface(() => ({ sessionId: "s", projectId: "p", worktreePath: temp("tree") }));
  expect(matchRunRoute("GET", "/run/wait")).toBeUndefined();
  await expect(
    route("POST", "/run/wait").route.handle({ params: [], input: { timeoutMs: 600_000, exit: true }, capability }),
  ).rejects.toThrow(/timeoutMs/);
});

test("every call the worker's capability makes hits a route that exists", async () => {
  // The two halves are written apart — a REST table here, a client over there —
  // and nothing but this test makes the client's spelling wrong out loud. An
  // earlier draft asked for `configs/create`, which typechecked and 404'd.
  //
  // The REAL client with a fake socket, not a stub that re-spells the paths: a
  // double would only prove the test agrees with itself.
  const asked: Array<{ method: string; path: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    // The session prefix is the daemon's to strip before it consults the table,
    // and the query string is parsed into `input` rather than matched.
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
  await capability.release({ runId: "run_1" });
  await capability.output({});
  // AND THE TWO #890 VERBS. `wait` is the one that would have been easiest to
  // spell differently on each side, since it is the only POST among the reads.
  await capability.output({ tail: 5, grep: "error", stream: "stderr" });
  await capability.wait({ runId: "run_1", pattern: "up", timeoutMs: 1 });
  await capability.stop({ signal: "SIGINT" });

  expect(asked).toHaveLength(13);
  for (const { method, path } of asked) {
    expect({ method, path, matched: Boolean(matchRunRoute(method, path)) }).toEqual({ method, path, matched: true });
  }
});
