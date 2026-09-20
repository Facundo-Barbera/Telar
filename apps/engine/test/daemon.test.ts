import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_BASE_DARK,
  DEFAULT_BASE_LIGHT,
  EngineClient,
  EngineClientError,
  type PublishedAppearance,
} from "@telar/engine-client";
import { connectEngine } from "@telar/engine-client/node";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { stubModels } from "./stub-models";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
/**
 * A Claude default this temp home already knows, so a claim is not withheld
 * waiting for a model list nobody is going to read here. Real homes learn this
 * from the provider; see `rememberClaudeDefault`.
 */
const knownClaudeDefault = (directory: string): string => {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
};

const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-daemon-"));
  roots.push(directory);
  return knownClaudeDefault(directory);
};

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test("daemon is authenticated, loopback-only, and discovers a typed engine client", async () => {
  const daemon = await startEngine({ models: stubModels, engineRoot: root() });
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
  const daemon = await startEngine({ models: stubModels, engineRoot: root() });
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

test("the authenticated API settles an interrupted run and takes a fresh one with no gesture in between", async () => {
  // This route used to require an explicit discard before the session would
  // take new work. There is nothing to discard now — a restart is a stop.
  const daemon = await startEngine({ models: stubModels, engineRoot: root() });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await client.createSession({ id: "session_one", projectId: "project_one" });
  await client.registerWorker("worker_one");
  await client.submitTurn("session_one", { runId: "uncertain_run", input: "Hello" });
  const claim = (await client.claimTurn("worker_one", 1)).claim!;
  await client.markTurnRunning(claim.sessionId, claim.turn.runId, claim.turn.claim!.token);
  expect(daemon.store.recover()).toEqual({ stopped: ["uncertain_run"] });

  await expect(client.submitTurn("session_one", { runId: "fresh_run", input: "Hello" })).resolves.toMatchObject({
    replayed: false,
    turn: { runId: "fresh_run", state: "queued" },
  });
  expect(daemon.store.turns("session_one")[0]).toMatchObject({ state: "stopped", stopReason: "engine_restart" });
  // And the vestigial verb refuses rather than pretending to settle something.
  await expect(client.discardAmbiguousTurn("session_one", "uncertain_run")).rejects.toMatchObject({
    code: "conflict",
    status: 409,
  } satisfies Partial<EngineClientError>);
});

test("a read receipt crosses the API as a turn name, and refuses everything else", async () => {
  // THE ROUTE EXISTS SO EVERY CLIENT AGREES. The desktop shell, a browser tab
  // and a paired phone all read the same session, so which answer has been
  // seen cannot live in one of them.
  const daemon = await startEngine({ models: stubModels, engineRoot: root() });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await client.createSession({ id: "session_one", projectId: "project_one" });
  await client.registerWorker("worker_one");
  await client.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const claim = (await client.claimTurn("worker_one", 1)).claim!;
  await client.markTurnRunning("session_one", "run_one", claim.turn.claim!.token);

  // Nothing to read while it runs.
  await expect(client.markSessionRead("session_one", "run_one")).rejects.toMatchObject({
    code: "invalid_request",
    status: 400,
  } satisfies Partial<EngineClientError>);

  await client.completeTurn("session_one", "run_one", claim.turn.claim!.token, { text: "Done" });
  const unread = await client.session("session_one");
  expect(unread.session.lastTurnSequence).toBe(1);
  expect(unread.session.lastReadTurnSequence).toBeUndefined();

  const read = await client.markSessionRead("session_one", "run_one");
  expect(read.session.lastReadTurnSequence).toBe(1);
  expect((await client.session("session_one")).session.lastReadTurnSequence).toBe(1);
  // A receipt naming nothing this session ran is refused rather than ignored.
  await expect(client.markSessionRead("session_one", "run_absent")).rejects.toMatchObject({ status: 400 });
});

test("lease expiry is pruned without another worker control request", async () => {
  let time = 0;
  const daemon = await startEngine({ models: stubModels, engineRoot: root(), now: () => time, workerLeaseMs: 5, workerPruneIntervalMs: 1 });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await client.createSession({ id: "session_one", projectId: "project_one" });
  await client.registerWorker("worker_one");
  await client.submitTurn("session_one", { runId: "claim_me", input: "Hello" });
  expect((await client.claimTurn("worker_one", 1)).claim?.turn.state).toBe("claimed");
  time = 10;
  // The retiring registration ENDS the claim it was holding. It used to go
  // back to `queued` and be replayed by the next worker.
  for (let attempts = 0; attempts < 20 && daemon.store.turns("session_one")[0]?.state !== "stopped"; attempts += 1) await Bun.sleep(2);
  expect(daemon.store.turns("session_one")[0]).toMatchObject({ state: "stopped", stopReason: "worker_unavailable" });
  await expect(client.health()).resolves.toMatchObject({ worker: { registered: false } });
});

test("attachments upload as raw bytes, ride the turn, and the browser answers even with no browser", async () => {
  const daemon = await startEngine({ models: stubModels, engineRoot: root() });
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
  const claim = await client.claimTurn("worker_one", 1);
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
  const first = await startEngine({ models: stubModels, engineRoot: stateRoot });
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
  const second = await startEngine({ models: stubModels, engineRoot: stateRoot });
  daemons.push(second);
  const reconnected = new EngineClient(second.discovery);
  await expect(reconnected.listMcpServers()).resolves.toEqual({
    mcpServers: [expect.objectContaining({ id: "linear" })],
  });
  await expect(reconnected.removeMcpServer("linear")).resolves.toEqual({ removed: true });
});

test("the provider registry answers with its probe, and never with a secret", async () => {
  const daemon = await startEngine({ models: stubModels,
    engineRoot: root(),
    // Injected so the suite never depends on which CLIs happen to be installed
    // on the machine running it.
    probeProviderVersion: async (driver) =>
      driver === "claude" ? { installed: true, version: "2.1.0" } : { installed: false, message: "codex is not on PATH" },
  });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);

  const seeded = await client.listProviderInstances();
  expect(seeded.providerInstances.map((instance) => instance.id)).toEqual(["claude", "codex", "opencode"]);
  // One call for both, so the page cannot paint a green dot beside an instance
  // a second call is about to report missing. (A fourth, `telar`, read ready
  // without the probe being consulted until #531 removed the driver.)
  expect(seeded.probes.map((probe) => probe.status)).toEqual(["ready", "error", "disabled"]);

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

test("configuring a login reports what it stopped inheriting, and can be told to keep it", async () => {
  // An engine launched from a terminal that had a proxy set — the situation
  // #594 is about. Values are synthetic and checked for ABSENCE below.
  const ambientEnv = { PATH: "/usr/bin", ANTHROPIC_BASE_URL: "http://127.0.0.1:4000", ANTHROPIC_AUTH_TOKEN: "sk-ant-not-a-real-token" };
  const daemon = await startEngine({
    models: stubModels,
    engineRoot: root(),
    ambientEnv,
    probeProviderVersion: async () => ({ installed: true, version: "2.1.0" }),
  });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);

  // The compaction control's own write: one variable, about something that has
  // nothing to do with this login's identity.
  const first = await client.saveProviderInstance({
    id: "claude",
    env: [{ name: "DISABLE_AUTO_COMPACT", value: "1", sensitive: false }],
  });
  expect(first.stoppedInheriting).toEqual(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]);
  // NAMES CROSS THE WIRE, VALUES DO NOT. Two of the fourteen owned names are
  // credentials, and a response that showed what was about to be lost would be
  // the leak this warning exists to prevent.
  const wire = JSON.stringify(first);
  expect(wire).not.toContain(ambientEnv.ANTHROPIC_AUTH_TOKEN);
  expect(wire).not.toContain(ambientEnv.ANTHROPIC_BASE_URL);

  // Keeping one sends its NAME back; the engine reads the value from its own
  // environment, so the credential never travels in either direction.
  const kept = await client.saveProviderInstance({ id: "claude", carryOverInherited: ["ANTHROPIC_AUTH_TOKEN"] });
  expect(kept.stoppedInheriting).toBeUndefined();
  // It is stored as a secret, so the settings page still cannot read it.
  expect(kept.providerInstance.env).toContainEqual({ name: "ANTHROPIC_AUTH_TOKEN", value: "", sensitive: true, valueRedacted: true });
  expect(JSON.stringify(kept)).not.toContain(ambientEnv.ANTHROPIC_AUTH_TOKEN);

  // A second variable on an already-configured login says nothing: it stopped
  // inheriting on the first one, and nothing changes here.
  const second = await client.saveProviderInstance({
    id: "claude",
    env: [
      { name: "DISABLE_AUTO_COMPACT", value: "1", sensitive: false },
      { name: "ANTHROPIC_AUTH_TOKEN", value: "", sensitive: true, valueRedacted: true },
      { name: "CLAUDE_CODE_DISABLE_ADVISOR_TOOL", value: "1", sensitive: false },
    ],
  });
  expect(second.stoppedInheriting).toBeUndefined();

  // A carry-over the engine would have to guess at is refused rather than
  // written as an empty variable the CLI would read.
  await expect(client.saveProviderInstance({ id: "claude", carryOverInherited: ["ANTHROPIC_API_KEY"] })).rejects.toMatchObject({
    status: 400,
  });
});

/** A minimal but REAL published look — the client parses what it reads, so a
 *  hand-waved blob would come back as `null` and prove nothing. Only the
 *  members the parser treats as load-bearing are spelt out; the rest of a Look
 *  falls back on its own, which is itself part of the contract.
 *
 *  A VERSION 2 LOOK, because this test asserts a ROUND TRIP. The parser
 *  migrates a version 1 look into a composition on the way through (#471), so a
 *  v1 fixture here would come back legitimately different from what went in and
 *  the equality would be measuring the migration rather than the mailbox. That
 *  migration has its own tests, over both the theme pair and every old backdrop
 *  kind — packages/engine-client/test/look.test.ts. */
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
      version: 2,
      id: "published",
      label,
      composition: {
        light: { base: DEFAULT_BASE_LIGHT, layers: [], overrides: {} },
        dark: { base: DEFAULT_BASE_DARK, layers: [], overrides: {} },
      },
      images: {},
      accent: "sea",
      fontSans: "geist",
      fontMono: "geist",
      fontSansCustom: "",
      fontMonoCustom: "",
      fontSize: 17,
      fontMonoSize: 13,
      translucencyLevel: 50,
      depth: "soft",
    },
  };
}

test("the appearance mailbox round-trips a published look, caches it, and answers the right refusals", async () => {
  // The cockpit's look lives in a browser's localStorage; this route is the
  // only way a paired phone can learn it. The daemon deliberately understands
  // nothing about the payload — see EngineStore.setAppearance — while the
  // CLIENT parses it, because the blob crossed a trust boundary to get here.
  const daemon = await startEngine({ models: stubModels, engineRoot: root() });
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

  // THE ETAG AND ITS 304. A published look carries its layer images, so a
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
  // The pixels live in `images`, shared by both states, and each state's stack
  // names the layer that paints them — one picture, not two megabytes twice.
  heavy.look.images = { wallpaper: `data:image/webp;base64,${"A".repeat(2 * 1024 * 1024)}` };
  const wallpaper = { type: "image", id: "wallpaper", x: 50, y: 50, scale: 100, opacity: 100, tiled: false } as const;
  heavy.look.composition.light.layers = [{ ...wallpaper }];
  heavy.look.composition.dark.layers = [{ ...wallpaper }];
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
  const daemon = await startEngine({ models: stubModels, engineRoot: root() });
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
  const daemon = await startEngine({ models: stubModels, engineRoot: root() });
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

test("the appearance home is served, written and refuses what is not an image", async () => {
  const daemon = await startEngine({ models: stubModels, engineRoot: root() });
  daemons.push(daemon);
  const base = `http://127.0.0.1:${daemon.discovery.port}/v2/appearance/home`;
  const auth = { authorization: `Bearer ${daemon.discovery.token}` };
  const json = { ...auth, "content-type": "application/json" };

  // An untouched home is empty rather than an error.
  const empty = await (await fetch(base, { headers: auth })).json();
  expect(empty).toEqual({ settings: null, themes: [], looks: [], images: [], skipped: [] });

  await fetch(`${base}/themes/dusk`, { method: "PUT", headers: json, body: JSON.stringify({ label: "Dusk", light: {}, dark: {} }) });
  await fetch(`${base}/settings`, { method: "PUT", headers: json, body: JSON.stringify({ accent: "sea" }) });
  const filled = (await (await fetch(base, { headers: auth })).json()) as { themes: { id: string }[]; settings: unknown };
  expect(filled.themes.map((theme) => theme.id)).toEqual(["dusk"]);
  expect(filled.settings).toEqual({ accent: "sea" });

  // A PNG round-trips under its content hash and comes back immutable.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
  const stored = (await (await fetch(`${base}/images`, { method: "POST", headers: auth, body: png })).json()) as { name: string };
  expect(stored.name.endsWith(".png")).toBe(true);
  const served = await fetch(`${base}/images/${stored.name}`, { headers: auth });
  expect(served.headers.get("content-type")).toBe("image/png");
  expect(served.headers.get("cache-control")).toContain("immutable");
  expect(Buffer.from(await served.arrayBuffer())).toEqual(png);

  // A shell script named like a picture is refused where the bytes are read.
  const refused = await fetch(`${base}/images`, { method: "POST", headers: auth, body: Buffer.from("#!/bin/sh\n") });
  expect(refused.status).toBe(400);

  // A traversal cannot reach out of images/.
  expect((await fetch(`${base}/images/${encodeURIComponent("../settings.json")}`, { headers: auth })).status).toBe(404);

  // Deleting is idempotent, and the verb set is stated rather than 404'd.
  expect((await fetch(`${base}/themes/dusk`, { method: "DELETE", headers: auth })).status).toBe(200);
  expect((await fetch(`${base}/themes/dusk`, { method: "DELETE", headers: auth })).status).toBe(200);
  const wrongVerb = await fetch(base, { method: "POST", headers: json, body: "{}" });
  expect(wrongVerb.status).toBe(405);
  expect(wrongVerb.headers.get("allow")).toBe("GET");
});

test("DELETE on a project unregisters it, and refuses while a turn is in flight", async () => {
  // The wire half of the settings row: a DELETE on the REGISTRATION. The
  // checkout is a temporary directory here and is asserted intact afterwards —
  // this route must never be able to reach into somebody's repository.
  const daemon = await startEngine({ models: stubModels, engineRoot: root() });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  const checkout = root();
  fs.writeFileSync(path.join(checkout, "source.ts"), "export const kept = true;\n");
  const { project } = await client.registerProject({ name: "Removable", root: checkout });
  const { session } = await client.createSession({ projectId: project.id });

  await client.registerWorker("worker_one");
  await client.submitTurn(session.id, { runId: "run_one", input: "keep going" });
  await expect(client.unregisterProject(project.id)).rejects.toMatchObject({ code: "conflict", status: 409 });

  await client.stopTurn(session.id, "run_one");
  const removed = await client.unregisterProject(project.id);
  expect(removed.project.id).toBe(project.id);
  expect(removed.sessions).toBe(1);
  // Gone from the list every surface reads; present, and marked, for the one
  // that offers to put it back.
  expect((await client.listProjects()).projects).toEqual([]);
  const withRemoved = (await client.listProjects({ includeRemoved: true })).projects;
  expect(withRemoved.map((each) => each.id)).toEqual([project.id]);
  expect(typeof withRemoved[0]!.removedAt).toBe("number");
  await expect(client.unregisterProject(project.id)).rejects.toMatchObject({ code: "conflict", status: 409 });

  // Nothing on disk moved, and the session's own record is still readable.
  expect(fs.readFileSync(path.join(checkout, "source.ts"), "utf8")).toBe("export const kept = true;\n");
  expect((await client.session(session.id)).session.id).toBe(session.id);

  // Restoring is an undo: the same id, back on the live list.
  expect((await client.restoreProject(project.id)).project.id).toBe(project.id);
  expect((await client.listProjects()).projects.map((each) => each.id)).toEqual([project.id]);
  await expect(client.restoreProject("project_nope")).rejects.toMatchObject({ code: "not_found", status: 404 });
});

test("the inbox route carries the delegation grace, and `null` over the wire is the off switch", async () => {
  // ISSUE #378. Two windows in one document, and the reason they are two keys
  // rather than one is exactly what this asserts: patching either leaves the
  // other alone, so turning the delegation settling off cannot quietly change
  // how long a quiet conversation stays in the list.
  const daemon = await startEngine({ models: stubModels, engineRoot: root() });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);

  expect((await client.inboxPolicy()).inbox).toEqual({ autoSettleAfterHours: 72, settleDelegatedAfterHours: 1 });
  expect((await client.setInboxPolicy({ settleDelegatedAfterHours: 6 })).inbox).toEqual({
    autoSettleAfterHours: 72,
    settleDelegatedAfterHours: 6,
  });
  expect((await client.setInboxPolicy({ autoSettleAfterHours: 12 })).inbox).toEqual({
    autoSettleAfterHours: 12,
    settleDelegatedAfterHours: 6,
  });
  // PRESENT-BUT-NULL is the off switch; an empty patch is "leave it alone".
  expect((await client.setInboxPolicy({ settleDelegatedAfterHours: null })).inbox).toEqual({
    autoSettleAfterHours: 12,
    settleDelegatedAfterHours: null,
  });
  expect((await client.setInboxPolicy({})).inbox).toEqual({ autoSettleAfterHours: 12, settleDelegatedAfterHours: null });
  // The bound lives beside the schema that states it, not in the route.
  await expect(client.setInboxPolicy({ settleDelegatedAfterHours: 0 })).rejects.toMatchObject({ code: "invalid_request" });
});

test("POST /v2/projects/clone clones and registers in one request, with git stubbed", async () => {
  // The Sources palette's "Git URL" and "GitHub repository" rows, on the wire.
  // ONE request because the cockpit cannot name the path in between: `git clone`
  // chooses the folder from the URL, so a two-step client would be registering
  // a directory it never picked.
  const parent = fs.realpathSync.native(root());
  /** CLONES ONLY. Registering a project also asks git for a branch, so an
   *  unfiltered log would count reads this test says nothing about. */
  const argv: string[][] = [];
  const clones = () => argv.filter((args) => args[0] === "clone");
  const daemon = await startEngine({ models: stubModels,
    engineRoot: root(),
    git: (_cwd, args) => {
      argv.push(args);
      if (args[0] === "clone") fs.mkdirSync(args[args.length - 1], { recursive: true });
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);

  const { project } = await client.cloneProject({ url: "https://github.com/owner/repo.git", parent });
  expect(project).toMatchObject({ name: "repo", root: path.join(parent, "repo") });
  // Registered, not merely cloned — the half a client doing this itself could
  // get wrong, and the reason the route answers a Project rather than a path.
  expect((await client.listProjects()).projects.map((each) => each.id)).toEqual([project.id]);
  // `--` ends the options, so a URL spelled as one is an operand.
  expect(clones()[0]).toEqual(["clone", "--", "https://github.com/owner/repo.git", path.join(parent, "repo")]);

  // `owner/repo` is expanded by the engine, so the cockpit holds no opinion
  // about which forge a bare pair belongs to.
  await client.cloneProject({ url: "Facundo-Barbera/Telar", parent });
  expect(clones()[1]?.[2]).toBe("https://github.com/Facundo-Barbera/Telar.git");

  // The same target twice is a conflict rather than a merge into it, and it is
  // refused BEFORE git runs.
  const before = clones().length;
  await expect(client.cloneProject({ url: "https://github.com/owner/repo.git", parent })).rejects.toMatchObject({
    code: "conflict",
    status: 409,
  });
  expect(clones().length).toBe(before);
  // And a parent that is not a directory never reaches a subprocess either.
  await expect(client.cloneProject({ url: "https://x.test/a/b.git", parent: "relative/path" })).rejects.toMatchObject({
    code: "invalid_request",
    status: 400,
  });
  expect(clones().length).toBe(before);
});

test("the gitignore write has a DELETE that undoes it, and takes back only its own block", async () => {
  // Adding a project ignores Telar's files WITHOUT asking now — the switch in
  // the old Register dialog became a default — so the toast's Undo needs a
  // route, and that route must not reach a rule somebody wrote themselves.
  const daemon = await startEngine({ models: stubModels, engineRoot: root() });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  const checkout = root();
  fs.writeFileSync(path.join(checkout, ".gitignore"), "node_modules/\n");
  const { project } = await client.registerProject({ name: "Ignorable", root: checkout });

  const { gitignore: added } = await client.projectGitignore(project.id);
  expect(added.added.length).toBeGreaterThan(0);
  expect(fs.readFileSync(path.join(checkout, ".gitignore"), "utf8")).toContain(".telar/");

  const { gitignore: removed } = await client.undoProjectGitignore(project.id);
  expect(removed.removed).toEqual(added.added);
  // Byte-identical to what was found: the write and its undo cancel exactly.
  expect(fs.readFileSync(path.join(checkout, ".gitignore"), "utf8")).toBe("node_modules/\n");
  // Twice is a success with nothing to do, not a failure — the toast can arrive
  // after somebody has already edited the file by hand.
  expect((await client.undoProjectGitignore(project.id)).gitignore.removed).toEqual([]);
});
