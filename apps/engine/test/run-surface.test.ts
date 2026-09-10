/**
 * The two doors — HTTP routes and the `run_*` toolkit — over ONE capability.
 *
 * The point of these tests is that neither door has rules of its own: a refusal
 * a human sees from the panel is the refusal the agent gets, worded for a model.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clientRunCapability } from "../src/run/client-capability";
import { RunManager } from "../src/run/manager";
import { matchRunRoute } from "../src/run/routes";
import { RunStore } from "../src/run/store";
import { storeRunCapability, type RunSessionContext } from "../src/run/store-capability";
import { RUN_READ_ONLY_TOOLS, runTools } from "../src/run/tools";
import type { RunCapability } from "../src/run/capability";

const temp = (label: string) => fs.mkdtempSync(path.join(os.tmpdir(), `telar-run-${label}-`));

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

function surface(context: () => RunSessionContext) {
  const manager = new RunManager();
  managers.push(manager);
  const store = new RunStore(temp("state"));
  const capability = storeRunCapability({ store, manager, context });
  return { manager, store, capability, tools: harness(capability) };
}

afterEach(async () => {
  // Nothing this file starts outlives it.
  while (managers.length) await managers.pop()!.shutdown();
});

const route = (method: string, tail: string) => {
  const found = matchRunRoute(method, tail);
  if (!found) throw new Error(`no route for ${method} ${tail}`);
  return found;
};

test("every tool on this wall is run_-prefixed, and the read-only list names real tools", () => {
  const tools = surface(() => ({ sessionId: "s", projectId: "p", worktreePath: temp("tree") })).tools;

  expect(tools.size).toBe(9);
  for (const name of tools.keys()) {
    expect(name).toMatch(/^run_[a-z_]+$/);
  }
  // The host reads this list to decide what may skip approval, so a typo in it
  // would either over-expose a mutation or park a harmless read forever.
  for (const name of RUN_READ_ONLY_TOOLS) {
    expect(tools.has(name)).toBe(true);
    expect(Object.keys(tools.get(name)!.shape).length).toBeLessThanOrEqual(2);
  }
  expect(RUN_READ_ONLY_TOOLS).not.toContain("run_start");
  expect(RUN_READ_ONLY_TOOLS).not.toContain("run_release");
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

test("every call the worker's capability makes hits a route that exists", async () => {
  // The two halves are written apart — a REST table here, a client over there —
  // and nothing but this test makes the client's spelling wrong out loud. An
  // earlier draft asked for `configs/create`, which typechecked and 404'd.
  const asked: Array<{ method: string; path: string }> = [];
  const capability = clientRunCapability(
    {
      run: async <T,>(_sessionId: string, request: { method: string; path: string }) => {
        asked.push({ method: request.method, path: request.path });
        return {} as T;
      },
    },
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

  expect(asked).toHaveLength(10);
  for (const { method, path } of asked) {
    expect({ method, path, matched: Boolean(matchRunRoute(method, path)) }).toEqual({ method, path, matched: true });
  }
});
