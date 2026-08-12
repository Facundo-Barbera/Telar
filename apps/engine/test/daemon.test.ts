import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, EngineClientError } from "@telar/engine-client";
import { connectEngine } from "@telar/engine-client/node";
import { startEngine, type EngineDaemon } from "../src/daemon";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-vnext-daemon-"));
  roots.push(directory);
  return directory;
};

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test("daemon is authenticated, loopback-only, and discovers a typed engine client", async () => {
  const daemon = await startEngine({ vnextRoot: root() });
  daemons.push(daemon);
  expect(daemon.discovery.host).toBe("127.0.0.1");
  expect(fs.statSync(daemon.store.paths.engine).mode & 0o777).toBe(0o600);
  // Auth is checked BEFORE routing, so an unauthenticated caller gets 401
  // whether or not the path exists. Probing the real v2 route keeps this a test
  // about authentication rather than one that would pass over a 404.
  const unauthenticated = await fetch(`http://127.0.0.1:${daemon.discovery.port}/v2/health`);
  expect(unauthenticated.status).toBe(401);
  // …and a v1 client is refused rather than half-understood: the routes moved
  // with the protocol version deliberately.
  const legacy = await fetch(`http://127.0.0.1:${daemon.discovery.port}/v1/health`, {
    headers: { authorization: `Bearer ${daemon.discovery.token}` },
  });
  expect(legacy.status).toBe(404);
  const client = await connectEngine(daemon.store.paths.root);
  await expect(client.health()).resolves.toMatchObject({ daemonId: daemon.discovery.daemonId, worker: { registered: false } });
});

test("the API rejects an unregistered worker and then durably schedules a claimable turn", async () => {
  const daemon = await startEngine({ vnextRoot: root() });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  const project = await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  const session = await client.createSession({ id: "session_one", projectId: project.project.id });
  await expect(client.submitTurn(session.session.id, { runId: "run_one", input: "Hello" })).rejects.toMatchObject({
    code: "worker_unavailable",
    status: 503,
  } satisfies Partial<EngineClientError>);
  await client.registerWorker("worker_one");
  const accepted = await client.submitTurn(session.session.id, { runId: "run_one", input: "Hello" });
  expect(accepted).toMatchObject({ replayed: false, turn: { state: "queued" } });
  const replay = await client.submitTurn(session.session.id, { runId: "run_one", input: "Hello" });
  expect(replay.replayed).toBe(true);
  expect((await client.events(session.session.id)).events.map((event) => event.type)).toEqual(["session.created", "turn.accepted"]);
  expect((await client.stopTurn(session.session.id, "run_one")).turn?.state).toBe("stopped");
});

test("the authenticated API journals explicit ambiguous-turn discard before allowing a fresh run", async () => {
  const daemon = await startEngine({ vnextRoot: root() });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await client.createSession({ id: "session_one", projectId: "project_one" });
  await client.registerWorker("worker_one");
  await client.submitTurn("session_one", { runId: "uncertain_run", input: "Hello" });
  const claim = (await client.claimTurn("worker_one")).claim!;
  await client.markTurnRunning(claim.sessionId, claim.turn.runId, claim.turn.claim!.token);
  expect(daemon.store.recover()).toEqual({ requeued: [], ambiguous: ["uncertain_run"] });

  await expect(client.discardAmbiguousTurn("session_one", "uncertain_run")).resolves.toMatchObject({
    turn: { runId: "uncertain_run", state: "discarded" },
  });
  await expect(client.submitTurn("session_one", { runId: "fresh_run", input: "Hello" })).resolves.toMatchObject({
    replayed: false,
    turn: { runId: "fresh_run", state: "queued" },
  });
  expect((await client.events("session_one")).events.at(-2)).toMatchObject({
    type: "turn.discarded",
    runId: "uncertain_run",
  });
  await expect(client.discardAmbiguousTurn("session_one", "uncertain_run")).rejects.toMatchObject({
    code: "conflict",
    status: 409,
  } satisfies Partial<EngineClientError>);
});

test("lease expiry is pruned without another worker control request", async () => {
  let time = 0;
  const daemon = await startEngine({ vnextRoot: root(), now: () => time, workerLeaseMs: 5, workerPruneIntervalMs: 1 });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await client.createSession({ id: "session_one", projectId: "project_one" });
  await client.registerWorker("worker_one");
  await client.submitTurn("session_one", { runId: "claim_me", input: "Hello" });
  expect((await client.claimTurn("worker_one")).claim?.turn.state).toBe("claimed");
  time = 10;
  for (let attempts = 0; attempts < 20 && daemon.store.turns("session_one")[0]?.state !== "queued"; attempts += 1) await Bun.sleep(2);
  expect(daemon.store.turns("session_one")[0]).toMatchObject({ state: "queued" });
  await expect(client.health()).resolves.toMatchObject({ worker: { registered: false } });
});

test("attachments upload as raw bytes, ride the turn, and the browser answers even with no browser", async () => {
  const daemon = await startEngine({ vnextRoot: root() });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  const project = await client.registerProject({ name: "One", root: "/tmp" });
  const session = await client.createSession({ projectId: project.project.id });

  // RAW BYTES, NOT BASE64 IN JSON — the JSON body cap on every other route is
  // deliberately small, and this path is the largest thing a client sends.
  const uploaded = await client.uploadAttachment(session.session.id, {
    name: "shot.png",
    mediaType: "image/png",
    data: new Uint8Array([1, 2, 3]),
  });
  expect(uploaded.attachment).toMatchObject({ name: "shot.png", mediaType: "image/png", bytes: 3 });
  expect(fs.readFileSync(uploaded.attachment.path)).toEqual(Buffer.from([1, 2, 3]));

  await client.registerWorker("worker_one");
  await client.submitTurn(session.session.id, {
    runId: "run_one",
    input: "look",
    model: { model: "claude-haiku-4-5", effort: "low" },
    attachments: [uploaded.attachment.id],
  });
  const claim = await client.claimTurn("worker_one");
  expect(claim.claim?.turn.attachments).toEqual([uploaded.attachment]);
  // The instance came from the SESSION: the submission has no field for one.
  expect(claim.claim?.model).toEqual({
    instanceId: session.session.providerInstanceId,
    model: "claude-haiku-4-5",
    effort: "low",
  });

  // No browser is attached to a daemon started without an embedded worker, and
  // that is a `none` rather than a failure — the same answer a session that has
  // never browsed gets.
  await expect(client.browserState(session.session.id)).resolves.toEqual({
    browser: { scopeKey: session.session.id, provider: "none", running: false, tabs: [] },
  });
});

test("MCP servers are environment-scoped and survive a daemon restart", async () => {
  const stateRoot = root();
  const first = await startEngine({ vnextRoot: stateRoot });
  daemons.push(first);
  const client = new EngineClient(first.discovery);
  await client.saveMcpServer({ id: "linear", label: "Linear", spec: { transport: "http", url: "https://mcp.linear.app" } });
  await expect(client.listMcpServers()).resolves.toEqual({
    mcpServers: [expect.objectContaining({ id: "linear", label: "Linear", enabled: true })],
  });
  await expect(client.saveMcpServer({ id: "bad", spec: { transport: "smoke-signal" } as never })).rejects.toBeInstanceOf(
    EngineClientError,
  );
  await first.close();
  daemons.length = 0;

  // Written beside projects.json rather than into a session, so a tool
  // configured once is still configured after a restart.
  const second = await startEngine({ vnextRoot: stateRoot });
  daemons.push(second);
  const reconnected = new EngineClient(second.discovery);
  await expect(reconnected.listMcpServers()).resolves.toEqual({
    mcpServers: [expect.objectContaining({ id: "linear" })],
  });
  await expect(reconnected.removeMcpServer("linear")).resolves.toEqual({ removed: true });
});
