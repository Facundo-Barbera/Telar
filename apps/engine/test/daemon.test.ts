import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, EngineClientError, TELAR_DARK, TELAR_LIGHT, type PublishedAppearance } from "@telar/engine-client";
import { connectEngine } from "@telar/engine-client/node";
import { startEngine, type EngineDaemon } from "../src/daemon";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-daemon-"));
  roots.push(directory);
  return directory;
};

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test("daemon is authenticated, loopback-only, and discovers a typed engine client", async () => {
  const daemon = await startEngine({ engineRoot: root() });
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
  const daemon = await startEngine({ engineRoot: root() });
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
  const daemon = await startEngine({ engineRoot: root() });
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
  const daemon = await startEngine({ engineRoot: root(), now: () => time, workerLeaseMs: 5, workerPruneIntervalMs: 1 });
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
  const daemon = await startEngine({ engineRoot: root() });
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
    browser: { scopeKey: session.session.id, provider: "none", running: false, tabs: [], canStart: false },
  });
});

test("MCP servers are environment-scoped and survive a daemon restart", async () => {
  const stateRoot = root();
  const first = await startEngine({ engineRoot: stateRoot });
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
  const second = await startEngine({ engineRoot: stateRoot });
  daemons.push(second);
  const reconnected = new EngineClient(second.discovery);
  await expect(reconnected.listMcpServers()).resolves.toEqual({
    mcpServers: [expect.objectContaining({ id: "linear" })],
  });
  await expect(reconnected.removeMcpServer("linear")).resolves.toEqual({ removed: true });
});

test("the provider registry answers with its probe, and never with a secret", async () => {
  const daemon = await startEngine({
    engineRoot: root(),
    // Injected so the suite never depends on which CLIs happen to be installed
    // on the machine running it.
    probeProviderVersion: async (driver) =>
      driver === "claude" ? { installed: true, version: "2.1.0" } : { installed: false, message: "codex is not on PATH" },
  });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);

  const seeded = await client.listProviderInstances();
  expect(seeded.providerInstances.map((instance) => instance.id)).toEqual(["claude", "codex"]);
  // One call for both, so the page cannot paint a green dot beside an instance
  // a second call is about to report missing.
  expect(seeded.probes.map((probe) => probe.status)).toEqual(["ready", "error"]);

  await client.saveProviderInstance({
    id: "claude_work",
    driver: "claude",
    displayName: "Work",
    configDir: "~/.claude-work",
    env: [{ name: "SECRET_TOKEN", value: "sk-live-1234", sensitive: true }],
  });
  const listed = await client.listProviderInstances();
  const work = listed.providerInstances.find((instance) => instance.id === "claude_work")!;
  expect(work.env).toEqual([{ name: "SECRET_TOKEN", value: "", sensitive: true, valueRedacted: true }]);
  // The folder does not exist on this machine, which is a warning rather than
  // an error: the CLI is installed, so the thing to fix is the folder.
  expect(listed.probes.find((probe) => probe.instanceId === "claude_work")).toMatchObject({ status: "warning" });

  await expect(client.removeProviderInstance("claude")).rejects.toMatchObject({ status: 409 });
  await expect(client.removeProviderInstance("claude_work")).resolves.toEqual({ removed: true });
});

/** A minimal but REAL published look — the client parses what it reads, so a
 *  hand-waved blob would come back as `null` and prove nothing. Only the
 *  members the parser treats as load-bearing are spelt out; the rest of a Look
 *  falls back on its own, which is itself part of the contract. */
function publishedLook(label: string): PublishedAppearance {
  return {
    version: 2,
    updatedAtHint: 1,
    scheme: "dark",
    translucent: false,
    frost: "blur",
    resolved: {
      accent: {
        name: "sea",
        light: { primary: "oklch(0.488 0.1 205)", primaryForeground: "oklch(1 0 0)" },
        dark: { primary: "oklch(0.68 0.11 205)", primaryForeground: "oklch(0.17 0.04 205)" },
      },
      fontStacks: { sans: '"Geist", sans-serif', mono: '"Geist Mono", monospace' },
    },
    look: {
      version: 1,
      id: "published",
      label,
      theme: { light: TELAR_LIGHT, dark: TELAR_DARK },
      backdrop: { kind: "none" },
      accent: "sea",
      fontSans: "geist",
      fontMono: "geist",
      fontSansCustom: "",
      fontMonoCustom: "",
      fontSize: 17,
      fontMonoSize: 13,
      translucencyLevel: 50,
    },
  };
}

test("the appearance mailbox round-trips a published look, caches it, and answers the right refusals", async () => {
  // The cockpit's look lives in a browser's localStorage; this route is the
  // only way a paired phone can learn it. The daemon deliberately understands
  // nothing about the payload — see EngineStore.setAppearance — while the
  // CLIENT parses it, because the blob crossed a trust boundary to get here.
  const daemon = await startEngine({ engineRoot: root() });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  const url = `http://127.0.0.1:${daemon.discovery.port}/v2/appearance`;
  const auth = { authorization: `Bearer ${daemon.discovery.token}` };

  // Nothing published: no look, and no timestamp to revalidate against.
  await expect(client.appearance()).resolves.toEqual({ appearance: null, updatedAt: null });

  const blob = publishedLook("Sea at night");
  const written = await client.setAppearance(blob);
  expect(written.ok).toBe(true);
  expect(written.updatedAt).toBeGreaterThan(0);

  const read = await client.appearance();
  expect(read.appearance).toEqual(blob);
  expect(read.updatedAt).toBe(written.updatedAt);

  // THE ETAG AND ITS 304. A published look carries its backdrop's pixels, so a
  // client that polls this must be able to ask "still the same?" without
  // paying for the answer twice.
  const first = await fetch(url, { headers: auth });
  const etag = first.headers.get("etag");
  expect(etag).toBe(written.etag);
  expect(etag).toBeTruthy();
  const revalidated = await fetch(url, { headers: { ...auth, "if-none-match": etag! } });
  expect(revalidated.status).toBe(304);
  expect(revalidated.headers.get("etag")).toBe(etag);
  expect(await revalidated.text()).toBe("");
  // A tag from before somebody else republished is NOT a match.
  const republished = await client.setAppearance(publishedLook("Sea at noon"));
  expect(republished.etag).not.toBe(etag);
  expect((await fetch(url, { headers: { ...auth, "if-none-match": etag! } })).status).toBe(200);

  // A look several megabytes wide, which the old 64 KB cap forbade, lands: the
  // wallpaper IS part of the look now. (The refusal above it has its own test —
  // see below for why it cannot share a connection with anything.)
  const heavy = publishedLook("With a wallpaper");
  heavy.look.backdrop = { kind: "image", fit: "cover", blur: 0, dim: 0, image: `data:image/webp;base64,${"A".repeat(2 * 1024 * 1024)}` };
  await expect(client.setAppearance(heavy)).resolves.toMatchObject({ ok: true });

  // 405, NOT 404: the path exists, the verb does not — and `Allow` says which.
  const wrongVerb = await fetch(url, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" });
  expect(wrongVerb.status).toBe(405);
  expect(wrongVerb.headers.get("allow")).toBe("GET, PUT, DELETE");

  // DELETE withdraws the look, and is idempotent — "nothing is published" is
  // the state the caller asked for whether or not anything was.
  await expect(client.clearAppearance()).resolves.toEqual({ ok: true });
  await expect(client.appearance()).resolves.toEqual({ appearance: null, updatedAt: null });
  await expect(client.clearAppearance()).resolves.toEqual({ ok: true });

  // A blob the shared parser cannot read comes back as `null` rather than as
  // garbage — but its timestamp still says somebody published something, which
  // is what lets a reader tell "nobody has" from "I cannot read theirs".
  daemon.store.setAppearance({ version: 2, look: { id: "x" } });
  const unreadable = await client.appearance();
  expect(unreadable.appearance).toBeNull();
  expect(unreadable.updatedAt).toBeGreaterThan(0);

  // Still paired-only: the bearer check runs before routing, as everywhere.
  const unauthenticated = await fetch(url);
  expect(unauthenticated.status).toBe(401);
});

test("an oversize appearance is refused before the engine buffers it", async () => {
  // ITS OWN TEST, AND ITS OWN DAEMON, for a reason worth writing down: this
  // request is answered WITHOUT reading its body, which is the entire point —
  // buffering eight megabytes to discover they are too many is the denial of
  // service the cap exists to prevent. The socket is therefore left with an
  // undelivered upload on it and the response says `connection: close`.
  // `fetch` pools by origin and will not reuse such a socket, so anything
  // sharing this daemon after the refusal would wait on a connection that is
  // never coming back. Nothing follows it here; the engine's own state is
  // checked in-process instead.
  const daemon = await startEngine({ engineRoot: root() });
  daemons.push(daemon);
  const url = `http://127.0.0.1:${daemon.discovery.port}/v2/appearance`;

  const refused = await fetch(url, {
    method: "PUT",
    headers: { authorization: `Bearer ${daemon.discovery.token}`, "content-type": "application/json" },
    body: JSON.stringify({ wallpaper: "x".repeat(9 * 1024 * 1024) }),
  });
  expect(refused.status).toBe(413);
  expect(refused.headers.get("connection")).toBe("close");
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
  // Nothing was written: a refusal is not a publish.
  expect(daemon.store.getAppearance()).toBeNull();
});

test("a structured completion validates its request before spending a harness", async () => {
  // ONLY THE REFUSALS ARE TESTED HERE, and deliberately: a valid request spawns
  // a real `claude -p` child, so asserting the happy path would make this suite
  // depend on which CLI is installed and on a network round trip. What belongs
  // to the daemon is the guard in front of that child, and every case below
  // fails before anything is spawned.
  const daemon = await startEngine({ engineRoot: root() });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };

  await expect(client.completeStructured({ prompt: "   ", schema })).rejects.toMatchObject({
    code: "invalid_request",
    status: 400,
  } satisfies Partial<EngineClientError>);
  await expect(client.completeStructured({ prompt: "x".repeat(20_001), schema })).rejects.toMatchObject({ status: 400 });
  await expect(
    client.completeStructured({ prompt: "hello", schema: [] as unknown as Record<string, unknown> }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(client.completeStructured({ prompt: "hello", schema, model: "  " })).rejects.toMatchObject({ status: 400 });
});
