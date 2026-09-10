/**
 * THE RUN DOOR AS THE DAEMON MOUNTS IT — the three things `run/routes.ts`
 * deliberately cannot do for itself, and therefore the three things only a test
 * against a real daemon can check:
 *
 *   - the session is resolved to a project and a worktree, per call
 *   - a body is parsed, and a GET's query string counts as one
 *   - a `RunError` becomes the HTTP shape every other refusal here has, rather
 *     than a 500
 *
 * The route table's own behaviour is `run-surface.test.ts`'s subject and is not
 * re-tested here. NOTHING IN THIS FILE LAUNCHES A PROCESS: every case stops at
 * configuration and refusal, because a test that started a dev server would be
 * a test that leaves one running.
 *
 * Temp engine root, temp checkout. No real home is read.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, type EngineClientError } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-run-mount-"));
  roots.push(directory);
  return directory;
};

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function ready(): Promise<{ daemon: EngineDaemon; base: string; token: string; tree: string }> {
  const tree = root();
  const daemon = await startEngine({ engineRoot: root() });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: tree });
  await client.createSession({ id: "session_one", projectId: "project_one" });
  // `realpath`, because macOS hands out `/var/...` and the store resolves to
  // `/private/var/...` — the same directory, and a test that compared the
  // unresolved spelling would be asserting a symlink rather than a tree.
  return {
    daemon,
    base: `http://127.0.0.1:${daemon.discovery.port}/v2/sessions/session_one`,
    token: daemon.discovery.token,
    tree: fs.realpathSync(tree),
  };
}

async function call(base: string, token: string, method: string, tail: string, body?: unknown) {
  const response = await fetch(`${base}${tail}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await response.json()) as { error?: { code?: string; message?: string } } & Record<string, unknown>;
  return { status: response.status, json, error: json.error };
}

test("the REST surface the cockpit speaks is mounted, and a configuration round-trips", async () => {
  const { base, token, tree } = await ready();

  const empty = await call(base, token, "GET", "/run/configs");
  expect(empty.status).toBe(200);
  expect(empty.json.configurations).toEqual([]);

  const created = await call(base, token, "POST", "/run/configs", {
    name: "dev",
    command: "echo hello",
    cwd: ".",
  });
  expect(created.status).toBe(200);
  const config = created.json as { id: string; name: string };
  expect(config.name).toBe("dev");

  const listed = await call(base, token, "GET", "/run/configs");
  expect((listed.json.configurations as { id: string }[]).map((entry) => entry.id)).toEqual([config.id]);

  // The path parameter is a capture group, and an id with a space in it has to
  // survive being one — the cockpit encodes, the mount must decode.
  const renamed = await call(base, token, "POST", `/run/configs/${encodeURIComponent(config.id)}`, { name: "dev server" });
  expect(renamed.status).toBe(200);
  expect((renamed.json as { name: string }).name).toBe("dev server");

  const removed = await call(base, token, "DELETE", `/run/configs/${encodeURIComponent(config.id)}`);
  expect(removed.status).toBe(200);
  expect((await call(base, token, "GET", "/run/configs")).json.configurations).toEqual([]);

  // The session's tree is resolved from the store, not from the request.
  const status = await call(base, token, "GET", "/run/status");
  expect(status.status).toBe(200);
  expect(status.json.sessionWorktreePath).toBe(tree);
  expect(status.json.active).toBeUndefined();
});

test("a GET's query string is the body, so a read with parameters reaches the route", async () => {
  const { base, token } = await ready();
  // `run/output` takes `after`, and a GET carries it in the query string. The
  // mount is what turns one into the other; a route that received `{}` here
  // would silently ignore the cursor and replay from the start forever.
  const answer = await call(base, token, "GET", "/run/output?after=5");
  // Nothing is deployed, so this is a refusal — but it is the ROUTE's refusal,
  // which proves dispatch happened rather than the arm being unreachable. A
  // `after` the mount had dropped would have been a zod failure instead.
  expect(answer.status).toBe(404);
  expect(answer.error).toMatchObject({ code: "not_found" });
});

test("a run refusal is an answer with a code, not a 500", async () => {
  const { base, token } = await ready();

  // Nothing deployed: stop and restart refuse rather than crash.
  for (const verb of ["stop", "restart"]) {
    const refused = await call(base, token, "POST", `/run/${verb}`, {});
    expect(refused.status).toBe(404);
    expect(refused.error).toMatchObject({ code: "not_found" });
  }

  // A malformed body is the route's own validation, surfaced as 400.
  const invalid = await call(base, token, "POST", "/run/start", {});
  expect(invalid.status).toBe(400);
  expect(invalid.error).toMatchObject({ code: "invalid_request" });

  // A configuration that does not exist is a refusal about the id.
  const missing = await call(base, token, "POST", "/run/start", { configId: "nope" });
  expect(missing.status).toBe(404);
});

/**
 * THE WORKER'S DOOR IS MOUNTED — `EngineClient.run()` reaches the same table the
 * cockpit does. What this case asserts is only that: dispatch happens, and a
 * refusal comes back shaped like every other refusal here.
 *
 * WHAT IT DELIBERATELY DOES NOT ASSERT. The worker's `run/client-capability.ts`
 * and the mounted `run/routes.ts` do not yet speak the same vocabulary — the
 * client POSTs every verb, the table is REST — and one of those mismatches sends
 * a READ (`configurations()`) at the CREATE route. That is a BLOCKER recorded in
 * the #198 handoff, not behaviour to pin: a test that asserted today's refusals
 * would go red the day somebody fixed it, which is precisely backwards. The
 * blocker is why the `run_*` toolkit is not registered and `run` is not in
 * `TELAR_CORE_CAPABILITIES`; when it is reconciled, this file gains real
 * per-verb coverage instead.
 */
test("the worker's door reaches the same table the cockpit does", async () => {
  const { daemon } = await ready();
  const client = new EngineClient(daemon.discovery);

  // `stop` is one of the verbs whose spelling already lines up. Nothing is
  // deployed, so the route refuses — which is the route ANSWERING, and the
  // thing this case exists to show: the arm is reachable from the worker's
  // client, not only from the cockpit's REST calls.
  await expect(client.run("session_one", "stop", {})).rejects.toMatchObject({
    status: 404,
    code: "not_found",
  } satisfies Partial<EngineClientError>);
});
