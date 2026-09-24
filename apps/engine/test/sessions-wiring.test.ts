/**
 * The `sessions` toolkit's WIRING — the two seams between the wall and a real
 * turn, neither of which `sessions-tools.test.ts` can reach.
 *
 *   1. THE DRIVER SEAM. That the seven tools reach a model at all, under the
 *      one `telar` server like every other Telar capability, and that a turn
 *      carrying no capability gets NO sessions tools rather than empty ones —
 *      a model handed a `sessions_list` that answers "nothing is live" for an
 *      engine it cannot see would report that as the truth.
 *   2. THE WORKER SEAM, which is the deployment an actual session runs in. The
 *      worker holds no store handle: it builds the capability out of
 *      `EngineClient` calls, so every rule has to survive a round trip over
 *      loopback rather than being enforced in the same process. The one that
 *      matters most is `origin: "session"` — it is declared by the worker's own
 *      code, and without it a list could not say an agent asked.
 *
 * NOTHING HERE SPENDS ANYTHING. The SDK is a fake with a `tool` factory that
 * remembers names, and the turn driver is a fake that calls the capability it
 * was handed and returns. No provider is loaded, no CLI is resolved.
 */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, type RuntimeMode, type Session } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { createClaudeDriver, type SessionsCapability, type TurnDriver } from "../src/driver";
import { SessionsToolSocket } from "../src/sessions-tools/run-socket";
import { EngineWorker } from "../src/worker";
import { stubModels } from "./stub-models";

/**
 * A Claude default this temp home already knows, so a claim is not withheld
 * waiting for a model list nobody is going to read here. Real homes learn this
 * from the provider; see `rememberClaudeDefault`.
 */
function knownClaudeDefault(directory: string): string {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
}


const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const workers: EngineWorker[] = [];
const sockets: SessionsToolSocket[] = [];

const tmp = (prefix: string): string => {
  const directory = knownClaudeDefault(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(directory);
  return directory;
};

afterEach(async () => {
  for (const worker of workers.splice(0).reverse()) await worker.stop();
  for (const socket of sockets.splice(0)) await socket.close();
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/**
 * THE EXECUTABLE RESOLVER IS FAKED, exactly as `driver.test.ts` fakes it.
 *
 * The real one probes the machine's own Claude Code and refuses a turn when
 * there is none, which is correct behaviour and the wrong thing to depend on
 * here: left to it, the driver-seam test below would pass on a laptop with
 * Claude Code installed and fail in CI, on an assertion about tool
 * REGISTRATION that has nothing to do with resolution.
 */
const claudeDriver: typeof createClaudeDriver = (loadSdk, options = {}) =>
  createClaudeDriver(loadSdk, { resolveExecutable: () => "/fake/bin/claude", ...options });

/** A throwaway repository with one commit — the house idiom. */
function repo(): string {
  const root = tmp("telar-sessions-wiring-repo-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@telar.local");
  git("config", "user.name", "Telar Test");
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "initial");
  return root;
}

// ── 1. the driver seam ──────────────────────────────────────────────────────

test("the sessions toolkit registers under the SAME one server, and only when the turn carries one", async () => {
  // THE SEAM, not the toolkit — `sessions-tools.test.ts` owns what the seven
  // tools do. What this pins is that they reach the model, under `telar`, and
  // that their absence is an absence rather than a stub.
  const seen: { serverKeys?: string[] } = {};
  const names: string[] = [];
  const sdk = async () => ({
    tool: (name: string, _d: string, _s: unknown, handler: (a: Record<string, unknown>) => Promise<{ content: unknown[] }>) => {
      names.push(name);
      return { name, handler };
    },
    createSdkMcpServer: (input: { tools: { name: string }[] }) => input,
    async *query(input: { options: { mcpServers?: Record<string, { tools: { name: string }[] }> } }) {
      seen.serverKeys = Object.keys(input.options.mcpServers ?? {});
      yield { type: "result", subtype: "success" };
    },
  });

  // A capability that ANSWERS EMPTILY rather than succeeding at everything: the
  // seam under test is registration, and a stub that pretended to create
  // sessions would be asserting something this file does not check.
  const sessions: SessionsCapability = {
    list: async () => ({ sessions: [], projects: [] }),
    create: async () => {
      throw new Error("this test does not create sessions");
    },
    send: async () => {
      throw new Error("this test does not send");
    },
    read: async () => [],
    status: async () => {
      throw new Error("this test does not read status");
    },
    stop: async () => ({ stopped: false }),
    settle: async () => {
      throw new Error("this test does not settle");
    },
    diff: async () => {
      throw new Error("this test does not diff");
    },
    subscribe: async () => {
      throw new Error("this test does not subscribe");
    },
    unsubscribe: async () => false,
    subscriptions: async () => [],
    requests: async () => [],
    resolveRequest: async () => {
      throw new Error("this test does not resolve");
    },
  };

  await claudeDriver(sdk).run({
    prompt: "prompt",
    cwd: "/tmp",
    signal: new AbortController().signal,
    onObservations: async () => undefined,
    sessions,
  });
  expect(seen.serverKeys).toEqual(["telar"]);
  expect(names).toEqual([
    "sessions_list",
    "sessions_create",
    "sessions_send",
    "sessions_read",
    "sessions_status",
    "sessions_stop",
    "sessions_settle",
    "sessions_diff",
    "sessions_subscribe",
    "sessions_unsubscribe",
    "sessions_subscriptions",
    "sessions_requests",
    "sessions_resolve_request",
    "sessions_report_window",
    "sessions_find",
    "sessions_outline",
    "sessions_answer",
    "sessions_steps",
    "sessions_step",
    "sessions_grep",
    // #543, appended at the END so the wall GROWS rather than reorders.
    "sessions_schedule",
  ]);
  // #877 retired `warp`, which was the one name on this wall that was not a
  // sessions verb and the one registered whether or not the turn carried a
  // capability. Pinned as an absence so a re-add fails here.
  expect(names).not.toContain("warp");

  // …and without one the sessions tools are GONE, and nothing is left to
  // register: the server itself does not appear. Anti-vacuity for the list
  // above is the COUNT — twenty-one names, not zero — rather than a tool that
  // happened to be unconditional.
  expect(names.length).toBe(21);
  names.length = 0;
  await claudeDriver(sdk).run({
    prompt: "prompt",
    cwd: "/tmp",
    signal: new AbortController().signal,
    onObservations: async () => undefined,
  });
  expect(names).toEqual([]);
  expect(seen.serverKeys).toEqual([]);
});

// ── 2. the worker seam ──────────────────────────────────────────────────────

/**
 * Run one turn against a driver that does whatever `body` says with the
 * `sessions` capability the worker handed it. The turn is real: a real daemon,
 * a real worker, a real claim, and a capability made of real HTTP calls.
 */
async function turnWith(
  body: (sessions: SessionsCapability) => Promise<void>,
  /** The backend the daemon opens with. Absent is the JSON store these tests
   *  have always used; `"sqlite"` is what the query routes need, because two of
   *  them refuse outright without an index to read (#516). */
  options: {
    executionStorage?: "sqlite";
    /** What the session DOING the asking is allowed to do. The privilege
     *  ceiling (#541 G1) caps anything it creates at this. */
    hostRuntimeMode?: RuntimeMode;
  } = {},
): Promise<{ client: EngineClient; hostId: string; projectId: string; sawCapability: boolean }> {
  const daemon = await startEngine({
    models: stubModels,
    engineRoot: tmp("telar-sessions-wiring-"),
    workerLeaseMs: 1_000,
    ...(options.executionStorage ? { executionStorage: options.executionStorage } : {}),
  });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  const { project } = await client.registerProject({ name: "aurora", root: repo() });
  const { session } = await client.createSession({ projectId: project.id, title: "the one doing the asking" });
  if (options.hostRuntimeMode) await client.updateSession(session.id, { runtimeMode: options.hostRuntimeMode });

  let sawCapability = false;
  let failed: unknown;
  const driver: TurnDriver = {
    async run({ sessions }) {
      sawCapability = sessions !== undefined;
      if (sessions) {
        try {
          await body(sessions);
        } catch (error) {
          failed = error;
        }
      }
      return { text: "done" };
    },
  };
  const worker = new EngineWorker({ client, workerId: "worker_one", driver, pollMs: 60_000 });
  workers.push(worker);
  await worker.start();
  await client.submitTurn(session.id, { runId: "run_one", input: "go" });
  await worker.tick();
  // `tick` CLAIMS; it does not await the execution — `void this.execute(claim)`
  // is deliberate there, so the turn settling is what this waits on. The house
  // idiom (see `worker.test.ts`).
  for (let attempt = 0; attempt < 200; attempt++) {
    const turn = (await client.session(session.id)).turns[0];
    if (turn && turn.state !== "queued" && turn.state !== "claimed" && turn.state !== "running") break;
    await Bun.sleep(5);
  }
  // A throw inside the driver body is this test's failure, not the turn's —
  // surfaced rather than swallowed into a failed turn nobody reads.
  if (failed) throw failed;
  return { client, hostId: session.id, projectId: project.id, sawCapability };
}

test("a running turn is handed the toolkit, and what it creates is stamped as an agent's", async () => {
  let made: Session | undefined;
  let listed: { sessions: Session[]; projects: Array<{ id: string; name: string }> } | undefined;
  const { client, hostId, sawCapability } = await turnWith(async (sessions) => {
    const { projects } = await sessions.list();
    made = await sessions.create({ projectId: projects[0]!.id, title: "made mid-turn", envMode: "worktree" });
    listed = await sessions.list();
  });

  expect(sawCapability).toBe(true);
  expect(made).toBeDefined();
  // THE STAMP, over a real round trip. Declared by the WORKER's own code — no
  // tool shape carries it.
  expect(made!.origin).toBe("session");
  expect(made!.envMode).toBe("worktree");
  // THE CHECKOUT ARRIVES AFTER THE ROW DOES (#496). The tool answers the agent
  // as soon as the session exists — the row says `preparing` — and the cut
  // lands behind it, which is the whole reason creating one no longer stalls
  // every other session on the machine.
  expect(made!.preparation).toMatchObject({ state: "preparing" });
  for (let i = 0; i < 400 && !fs.existsSync(path.join(made!.workspace.path, "README.md")); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(fs.existsSync(path.join(made!.workspace.path, "README.md"))).toBe(true);

  // The engine agrees, read back through the ordinary API.
  const { session } = await client.session(made!.id);
  expect(session.origin).toBe("session");
  // The list the turn saw held both, as peers — the session doing the asking is
  // on it exactly as the one it made is, with nothing linking them.
  expect(listed!.sessions.map((each) => each.id).sort()).toEqual([hostId, made!.id].sort());
  expect(JSON.stringify(session)).not.toContain(hostId);
});

/**
 * THE PRIVILEGE CEILING, OVER A REAL ROUND TRIP — issue #541 G1.
 *
 * The owner's decision: a session created by an agent must never have more
 * permissions than its creator. The STORE's own rule is held in
 * `runtime-ceiling.test.ts`; this is the WIRING, which is the half that was
 * actually broken — `sessions_create` could not pass a mode, so every session
 * an agent made landed in `auto` however narrow its creator was.
 *
 * THE WORKER SEAM IS THE ONE THAT MATTERS. This is the deployment a real
 * session runs in: the capability is built out of `EngineClient` calls, so the
 * ceiling has to survive a round trip over loopback rather than being applied
 * in the same process. `ceilingFrom` is declared by the worker's own code, like
 * `origin` — no tool shape on the wall carries it.
 */
test("a session that has to ask cannot create one that does not — over the wire", async () => {
  let made: Session | undefined;
  const { client, hostId } = await turnWith(
    async (sessions) => {
      const { projects } = await sessions.list();
      made = await sessions.create({ projectId: projects[0]!.id, title: "capped", envMode: "local" });
    },
    { hostRuntimeMode: "approval-required" },
  );

  // Before this, `auto` — unconditionally, because the mode came from
  // `detached` alone and a created session is detached by default.
  expect(made!.runtimeMode).toBe("approval-required");
  // The engine agrees, read back through the ordinary API rather than from the
  // tool's own answer.
  expect((await client.session(made!.id)).session.runtimeMode).toBe("approval-required");
  // AND NOTHING WAS LINKED BY IT. The ceiling is read once at creation and
  // stored nowhere — it is not `startedFrom`, and it confers no standing
  // authority. The host's id must not appear in the child's record.
  expect(JSON.stringify((await client.session(made!.id)).session)).not.toContain(hostId);
});

test("a session with full access still creates a detached peer at the posture's own default", async () => {
  let made: Session | undefined;
  await turnWith(
    async (sessions) => {
      const { projects } = await sessions.list();
      made = await sessions.create({ projectId: projects[0]!.id, title: "not widened", envMode: "local" });
    },
    { hostRuntimeMode: "full-access" },
  );
  // A CEILING IS A MAXIMUM, NOT AN ASSIGNMENT. A creator that can do anything
  // does not hand that down; the new session gets what its own posture says.
  expect(made!.runtimeMode).toBe("auto");
});

test("the worker cannot archive, delete or accept anything — the client it holds has no such reach", async () => {
  // The Pick in `WorkerClient` is the structural half of "this wall lands
  // nothing": a handler that tried would not compile. Asserted at runtime too,
  // because a Pick widened by accident is exactly the change nobody notices.
  const { sawCapability } = await turnWith(async (sessions) => {
    const surface = Object.keys(sessions).sort();
    // `cursor` joined the list with #515: the journal's last event id, so the
    // wall can answer "what happened lately" from one page rather than by
    // walking 61,933 events to reach the end. A READ, like every other member
    // that is not one of the five verbs.
    // `setReportWindow` joined with #723, and it is the narrowest member here:
    // one field of `updateSession`, on the CALLER's own session, reached through
    // `setSessionReportWindow` rather than by widening the Pick to the whole
    // patch — the same treatment `settle` already gets.
    // `query` joined with #516: the six READS that ask a conversation something
    // rather than paging it, grouped as a sub-port because they are answered by
    // the projection and the query routes rather than by a store verb each.
    // Read-only by construction — see `SessionsQueryCapability`, which has no
    // member that writes for one to be misfiled as.
    // The verb that addressed the built-in Agent came and went with it (#784, #908).
    expect(surface).toEqual([
      "create", "cursor", "diff", "list", "query", "read", "requests", "resolveRequest", "self", "send", "setReportWindow", "settle", "status", "stop", "subscribe", "subscriptions", "unsubscribe",
    ]);
    expect(Object.keys(sessions.query).sort()).toEqual(["answer", "find", "grep", "outline", "step", "steps"]);
    for (const forbidden of ["archive", "delete", "accept", "merge", "commit"]) {
      expect(surface).not.toContain(forbidden);
    }
  });
  expect(sawCapability).toBe(true);
});

/**
 * THE HALF #516 COULD NOT SHIP WITHOUT — the six queries over HTTP.
 *
 * The daemon's embedded worker answers these from `store.*` and is nearly free;
 * this one had no client method for a single one of the five routes behind
 * them, so mounting the tools without this would have made a session's answer
 * to "what did step twelve do" depend on which worker claimed its turn. Nothing
 * here is stubbed: a real daemon, a real claim, and six reads that go out over
 * the loopback socket and come back shaped.
 */
test("the six queries reach the engine's routes from an out-of-process turn", async () => {
  const seen: Record<string, unknown> = {};
  const { sawCapability } = await turnWith(async (sessions) => {
    // WHO IS ASKING is on the capability itself — the claim's own session id,
    // which is the only id a turn holds without being told one.
    const self = sessions.self!.sessionId;
    // The turn running RIGHT NOW is this session's own, so the outline has a
    // row for it and the row says what it was asked.
    seen.outline = await sessions.query.outline(self, { limit: 10 });
    seen.find = await sessions.query.find({ q: "asking", limit: 5 });
    seen.grep = await sessions.query.grep(self, "go", { limit: 5 });
    seen.steps = await sessions.query.steps(self, "run_one");
    // AND THE ERROR PATHS CROSS THE WIRE TOO, which is the half a happy-path
    // test would miss: a 404 from a route has to arrive as a throw the wall can
    // turn into a sentence, not as an empty answer.
    seen.step = await sessions.query.step(self, "run_one", 99, 1_000).catch((error: Error) => error.message);
    seen.answer = await sessions.query.answer(self, { from: 0, limit: 100 }).catch((error: Error) => error.message);
  }, { executionStorage: "sqlite" });
  expect(sawCapability).toBe(true);

  const outline = seen.outline as { turns: Array<{ runId: string; input: string }>; total: number };
  expect(outline.turns.map((turn) => turn.runId)).toContain("run_one");
  expect(outline.turns.find((turn) => turn.runId === "run_one")!.input).toBe("go");
  expect(outline.total).toBe(1);

  // A SEARCH ACROSS SESSIONS, answered by whichever index this engine has, and
  // it finds the session by its own title.
  const found = seen.find as { sessions: Array<{ id: string }>; index: string };
  expect(["fts5", "like"]).toContain(found.index);
  expect(found.sessions.length).toBeGreaterThan(0);

  // A JOURNAL SEARCH, scanned inside sqlite with only the page materialised.
  expect((seen.grep as { matches: unknown[] }).matches.length).toBeGreaterThan(0);

  // A RUN WITH NO REPORTED ITEMS IS AN EMPTY LIST, never a failure: this driver
  // reports no observations, and "it has done nothing yet" is a real answer.
  expect((seen.steps as { items: unknown[] }).items).toEqual([]);

  // A step that is not there and an answer that does not exist yet both arrive
  // as the store's own sentence rather than as silence.
  expect(String(seen.step)).toContain("no such step");
  expect(String(seen.answer)).toContain("answered turn");
});

test("a turn's capability knows who it is, and a subscription made mid-turn wakes the host over the wire", async () => {
  // THE WORKER SEAM FOR SUBSCRIPTIONS: `self` is the claim's own session id,
  // closed over by the worker's code; the subscription goes through the
  // client; and when the made session finishes a turn — completed here by the
  // ordinary API, as a worker would — the engine queues a wake on the host.
  let made: Session | undefined;
  let self = "";
  const { client, hostId } = await turnWith(async (sessions) => {
    self = sessions.self!.sessionId;
    const { projects } = await sessions.list();
    made = await sessions.create({ projectId: projects[0]!.id, title: "a worker", envMode: "local" });
    await sessions.subscribe(self, { targetSessionId: made.id, events: ["turn_completed"] });
  });
  expect(self).toBe(hostId);
  expect((await client.subscriptions(hostId)).subscriptions).toHaveLength(1);

  await client.submitTurn(made!.id, { runId: "run_made", input: "work" });
  const worker = new EngineWorker({
    client,
    workerId: "worker_two",
    driver: { async run() { return { text: "all done here" }; } },
    pollMs: 60_000,
  });
  workers.push(worker);
  await worker.start();
  await worker.tick();
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await client.session(made!.id)).turns[0]?.state === "completed") break;
    await Bun.sleep(5);
  }

  const { turns } = await client.session(hostId);
  const wake = turns.find((turn) => turn.origin === "session");
  expect(wake).toBeDefined();
  expect(wake!.wakeReason).toEqual({ kind: "turn_completed", sessionId: made!.id, runId: "run_made" });
  // #550: the engine's prose rides the notification over the wire, and `input`
  // is the machine label — so a client cannot draw it as the person's bubble
  // by reading the field it always read.
  expect(wake!.notification!.kind).toBe("wake");
  expect(wake!.notification!.body).toContain("[wake: completed]");
  expect(wake!.input).toStartWith("[notification: wake");
  // A PING OVER THE WIRE TOO: the answer is not in the notice, the run-scoped
  // read that fetches it is.
  expect(wake!.notification!.body).not.toContain("all done here");
  expect(wake!.notification!.body).toContain(`runId: "run_made"`);
  // A REAL TURN: the worker on this daemon may already have claimed and run
  // it by the time we look — which is the point. Queued or done, never lost.
  expect(["queued", "claimed", "running", "completed"]).toContain(wake!.state);
});

// ── 3. the codex transport seam ─────────────────────────────────────────────

test("a Codex turn is handed the wall over the socket with its own self bound; a Claude turn is not", async () => {
  // THE TRANSPORT HALF OF THE WORKER SEAM. Claude gets the capability
  // in-process (seam 1); a Codex claim additionally gets `{url, token}` for
  // the worker-hosted socket, and the token must serve the SAME wall with the
  // SAME `self` — proven by subscribing over plain HTTP and reading the
  // subscription back through the ordinary API as the codex session's own.
  const daemon = await startEngine({ models: stubModels, engineRoot: tmp("telar-sessions-run-seam-"), workerLeaseMs: 1_000 });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  const { project } = await client.registerProject({ name: "aurora", root: repo() });
  const codex = (await client.createSession({ projectId: project.id, title: "the codex one", driver: "codex" })).session;
  const claude = (await client.createSession({ projectId: project.id, title: "the claude one" })).session;

  const handed = new Map<string, { url: string; token: string } | undefined>();
  const driver: TurnDriver = {
    async run({ sessionId, sessionsSocket, sessions }) {
      handed.set(sessionId, sessionsSocket);
      // The in-process capability is NOT withdrawn by the socket's arrival.
      expect(sessions).toBeDefined();
      return { text: "done" };
    },
  };
  const socket = new SessionsToolSocket();
  sockets.push(socket);
  const worker = new EngineWorker({ client, workerId: "worker_seam3", driver, sessionsSocket: socket, pollMs: 60_000 });
  workers.push(worker);
  await worker.start();
  await client.submitTurn(codex.id, { runId: "run_codex", input: "go" });
  await client.submitTurn(claude.id, { runId: "run_claude", input: "go" });
  for (let attempt = 0; attempt < 200; attempt++) {
    await worker.tick();
    const settled = await Promise.all(
      [codex.id, claude.id].map(async (id) => (await client.session(id)).turns[0]?.state === "completed"),
    );
    if (settled.every(Boolean)) break;
    await Bun.sleep(5);
  }

  const lease = handed.get(codex.id);
  expect(lease).toBeDefined();
  // Claude's registration is in-process; a lease for it would be a credential
  // nobody redeems.
  expect(handed.get(claude.id)).toBeUndefined();

  // The token opens the wall AS the codex session, over nothing but HTTP —
  // exactly what the provider subprocess will hold.
  const answered = await fetch(lease!.url, {
    method: "POST",
    headers: { authorization: `Bearer ${lease!.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "sessions_subscribe", arguments: { sessionId: claude.id, events: ["turn_completed"] } },
    }),
  });
  const { result } = (await answered.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  expect(result.isError).not.toBe(true);
  const { subscriptions } = await client.subscriptions(codex.id);
  expect(subscriptions).toHaveLength(1);
  expect(subscriptions[0]).toMatchObject({ subscriberSessionId: codex.id, targetSessionId: claude.id });
});

// ── 4. attribution over the wire ─────────────────────────────────────────────

test("sessions_send from a turn is stamped with the sender over the wire, and the provider is told an agent spoke", async () => {
  /**
   * THE BUG THIS PINS, measured on the dogfood app: an orchestrator's
   * `sessions_send` went through the worker's plain `submitTurn`, arrived with
   * no origin, was drawn as the person's own bubble and reached the provider
   * as the user speaking. The worker now sends through `submitAgentTurn` with
   * its own claim as proof, and the engine stamps who spoke.
   */
  let made: Session | undefined;
  const { client, hostId } = await turnWith(async (sessions) => {
    const { projects } = await sessions.list();
    made = await sessions.create({ projectId: projects[0]!.id, title: "the peer", envMode: "local" });
    await sessions.send(made.id, { intent: "task", runId: "run_peer", input: "please review the diff" });
  });
  const { turns } = await client.session(made!.id);
  expect(turns[0]).toMatchObject({ runId: "run_peer", origin: "session", sender: { sessionId: hostId }, input: "please review the diff" });

  // The peer's own worker runs it: the provider hears the frame, the record
  // keeps the bare words.
  const prompts: string[] = [];
  const worker = new EngineWorker({
    client,
    workerId: "worker_peer",
    driver: { async run({ prompt }) { prompts.push(prompt); return { text: "reviewed" }; } },
    pollMs: 60_000,
  });
  workers.push(worker);
  await worker.start();
  await worker.tick();
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await client.session(made!.id)).turns[0]?.state === "completed") break;
    await Bun.sleep(5);
  }
  expect(prompts).toHaveLength(1);
  // #550: the prose frame that used to precede this was standing in for a role
  // the channel could not express. The notice goes over as written, and the
  // role rides the notification item and the driver's own channel.
  expect(prompts[0]).toStartWith("[agent message · task]");
  /**
   * AND THE PROVIDER IS HANDED THE NOTICE, NOT THE BODY — end to end, over the
   * real HTTP surface and a real worker, which is the only place the whole
   * chain (tool → `/turns/agent` → store → claim → `framedTurnInput`) is
   * exercised at once. A task's notice says it IS a task and names the read;
   * the RECORD still holds the message exactly as sent.
   */
  expect(prompts[0]).toContain(`[agent message · task] session ${hostId} ASSIGNED this session work (run run_peer, 22 chars).`);
  expect(prompts[0]).toContain(`sessions_read(sessionId: "${made!.id}", runId: "run_peer")`);
  expect((await client.session(made!.id)).turns[0]?.input).toBe("please review the diff");
});

test("a LONG task is handed to the provider as the assignment notice, with the body withheld", async () => {
  /**
   * The test above sends 22 characters, so a notice that leaked the whole body
   * would still look small — it can pin the ASSIGNMENT WORDING but not the
   * withholding, which is the half the branch exists for. This one sends a task
   * nobody would want quoted and pins both: the provider hears that it was
   * assigned work and where to read it, not one word of the message reaches the
   * prompt, and the record still holds every byte.
   */
  const brief = `Rewrite the parser's error recovery.\nIt currently swallows the column.\n\n${"Background nobody needs up front. ".repeat(100)}`;
  let made: Session | undefined;
  const { client, hostId } = await turnWith(async (sessions) => {
    const { projects } = await sessions.list();
    made = await sessions.create({ projectId: projects[0]!.id, title: "the assignee", envMode: "local" });
    await sessions.send(made.id, { intent: "task", runId: "run_brief", input: brief });
  });

  const prompts: string[] = [];
  const worker = new EngineWorker({
    client,
    workerId: "worker_assignee",
    driver: { async run({ prompt }) { prompts.push(prompt); return { text: "on it" }; } },
    pollMs: 60_000,
  });
  workers.push(worker);
  await worker.start();
  await worker.tick();
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await client.session(made!.id)).turns[0]?.state === "completed") break;
    await Bun.sleep(5);
  }
  expect(prompts).toHaveLength(1);
  // IT IS AN ASSIGNMENT, IN WORDS. This is the sentence the delivery
  // investigation found missing: without it a peer's `intent: "task"` reads as
  // a suggestion the model is free to park on the human.
  expect(prompts[0]).toContain(`[agent message · task] session ${hostId} ASSIGNED this session work (run run_brief,`);
  expect(prompts[0]).toContain(`Read it with sessions_read(sessionId: "${made!.id}", runId: "run_brief") before acting on it.`);
  // AND NO PART OF THE BODY IS THERE — not the bulk, and since #631 not the
  // opening either. The measurement, not the adjective.
  expect(prompts[0]).not.toContain("Background nobody needs up front.");
  expect(prompts[0]).not.toContain("Rewrite the parser's error recovery.");
  expect(prompts[0]!.length).toBeLessThan(brief.length / 8);
  // The record keeps what the notice stands in for, unabridged.
  expect((await client.session(made!.id)).turns[0]?.input).toBe(brief);
});

test("a cockpit cannot forge a sender through /turns, and a bad proof on /turns/agent is refused", async () => {
  const daemon = await startEngine({ models: stubModels, engineRoot: tmp("telar-sessions-forge-"), workerLeaseMs: 1_000 });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  const { project } = await client.registerProject({ name: "aurora", root: repo() });
  const { session } = await client.createSession({ projectId: project.id, title: "target" });
  const worker = new EngineWorker({ client, workerId: "worker_one", driver: { async run() { return { text: "" }; } }, pollMs: 60_000 });
  workers.push(worker);
  await worker.start();

  const forged = await client.submitTurn(session.id, { runId: "run_forge", input: "as an agent", ...({ origin: "session", sender: { sessionId: "session_x" } } as object) });
  expect(forged.turn.origin).toBeUndefined();
  expect(forged.turn.sender).toBeUndefined();

  await expect(
    client.submitAgentTurn(session.id, { runId: "run_bad", input: "x", proof: { sessionId: session.id, runId: "run_forge", claimToken: "y".repeat(32) } }),
  ).rejects.toThrow();
  // Without proof: an agent's, unattributed — the outward socket's case.
  const bare = await client.submitAgentTurn(session.id, { runId: "run_bare", input: "from outside" });
  expect(bare.turn).toMatchObject({ origin: "session", sender: {} });
});
