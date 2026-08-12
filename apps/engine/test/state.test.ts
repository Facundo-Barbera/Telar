import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireDaemonLock, EngineStateError, EngineStore, statePaths, vnextRootFromEnv } from "../src/state";

const roots: string[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-vnext-engine-"));
  roots.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function readyStore(): { store: EngineStore; root: string } {
  const stateRoot = root();
  const store = new EngineStore(stateRoot, () => 100);
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  store.createSession({ id: "session_one", projectId: "project_one" });
  return { store, root: stateRoot };
}

test("the engine requires an explicit absolute home and writes only beneath its vNext root", () => {
  expect(() => vnextRootFromEnv({})).toThrow(EngineStateError);
  expect(() => vnextRootFromEnv({ TELAR_HOME: "relative" })).toThrow(EngineStateError);
  expect(vnextRootFromEnv({ TELAR_HOME: "/tmp/telar" })).toBe(path.join(fs.realpathSync.native("/tmp"), "telar", "vnext"));
  const { root: stateRoot } = readyStore();
  expect(fs.existsSync(path.join(stateRoot, "projects.json"))).toBe(true);
  expect(fs.existsSync(path.join(stateRoot, "sessions", "session_one", "session.json"))).toBe(true);
  expect(fs.existsSync(path.join(path.dirname(stateRoot), "chats.json"))).toBe(false);
});

test("submitting a stable run id is idempotent and a session has only one active turn", () => {
  const { store } = readyStore();
  const initial = store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  expect(initial.replayed).toBe(false);
  expect(store.submitTurn("session_one", { runId: "run_one", input: "Hello" })).toEqual({ ...initial, replayed: true });
  expect(() => store.submitTurn("session_one", { runId: "run_one", input: "Different" })).toThrow(EngineStateError);
  expect(store.readEvents("session_one").map((event) => event.type)).toEqual(["session.created", "turn.accepted"]);

  // A SECOND SUBMISSION IS NOW ACCEPTED AND QUEUED, where it used to be a
  // conflict. What has NOT changed is that only one turn ever executes:
  // `claimTurn` refuses while another is claimed or running, which the
  // queue-drain test below pins. The old assertion here described the
  // waiting, not the invariant.
  const queued = store.submitTurn("session_one", { runId: "run_two", input: "Second" });
  expect(queued.turn.state).toBe("queued");
});

test("stop is durable and idempotent", () => {
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  expect(store.stopTurn("session_one", "run_one").stopped).toBe(true);
  expect(store.turns("session_one")[0]?.state).toBe("stopped");
  expect(store.stopTurn("session_one", "run_one").stopped).toBe(false);
  expect(store.readEvents("session_one").at(-1)?.type).toBe("turn.stopped");
});

test("recovery returns merely claimed work to queued and makes running work explicitly ambiguous", () => {
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "claimed_turn", input: "Hello" });
  expect(store.claimTurn("session_one", "worker_one")?.state).toBe("claimed");
  expect(store.recover()).toEqual({ requeued: ["claimed_turn"], ambiguous: [] });
  expect(store.turns("session_one")[0]?.state).toBe("queued");
  const claimed = store.claimTurn("session_one", "worker_one");
  store.markRunning("session_one", "claimed_turn", claimed!.claim!.token);
  expect(store.recover()).toEqual({ requeued: [], ambiguous: ["claimed_turn"] });
  expect(store.turns("session_one")[0]?.state).toBe("ambiguous");
  expect(() => store.submitTurn("session_one", { runId: "later_turn", input: "must wait" })).toThrow(/ambiguous/);
  expect(store.readEvents("session_one").at(-1)).toMatchObject({ type: "turn.ambiguous", runId: "claimed_turn" });
});

test("a human discard resolves only an ambiguous turn and permits a fresh submitted run", () => {
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "uncertain_run", input: "Hello" });
  const claimed = store.claimTurn("session_one", "worker_one");
  store.markRunning("session_one", "uncertain_run", claimed!.claim!.token);
  store.recover();

  const discarded = store.discardAmbiguousTurn("session_one", "uncertain_run");
  expect(discarded).toMatchObject({ runId: "uncertain_run", state: "discarded", completedAt: 100 });
  expect(discarded.claim).toBeUndefined();
  expect(store.readEvents("session_one").at(-1)).toMatchObject({
    type: "turn.discarded",
    runId: "uncertain_run",
  });
  expect(store.submitTurn("session_one", { runId: "fresh_run", input: "Hello" })).toMatchObject({
    replayed: false,
    turn: { runId: "fresh_run", state: "queued" },
  });
  expect(store.turns("session_one").map((turn) => [turn.runId, turn.state])).toEqual([
    ["uncertain_run", "discarded"],
    ["fresh_run", "queued"],
  ]);
});

test("startup recovery repairs provider continuity from a completed turn after an interrupted metadata write", () => {
  const { store, root: stateRoot } = readyStore();
  store.submitTurn("session_one", { runId: "first", input: "Hello" });
  const claimed = store.claimTurn("session_one", "worker_one")!;
  store.markRunning("session_one", "first", claimed.claim!.token);
  store.completeTurn("session_one", "first", claimed.claim!.token, { text: "Done", providerSessionId: "claude-session-one" });

  // queue.json is written before session.json, so a crash in that interval
  // leaves the terminal turn as the only record of the resume cursor.
  const metadataFile = path.join(stateRoot, "sessions", "session_one", "session.json");
  const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8")) as { resumeCursor?: string };
  delete metadata.resumeCursor;
  fs.writeFileSync(metadataFile, `${JSON.stringify(metadata)}\n`);

  const restarted = new EngineStore(stateRoot, () => 200);
  restarted.recover();
  expect(restarted.getSession("session_one").resumeCursor).toBe("claude-session-one");
  restarted.submitTurn("session_one", { runId: "second", input: "Again" });
  expect(restarted.claimNextTurn("worker_two")?.resumeCursor).toBe("claude-session-one");
});

test("observations become durable items and deltas, and only under a live claim", () => {
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const claimed = store.claimTurn("session_one", "worker_one")!;
  const token = claimed.claim!.token;

  // A worker may only report against a RUNNING turn it holds the claim for.
  expect(() =>
    store.ingestObservations("session_one", "run_one", token, [
      { kind: "item.started", item: { id: "i1", detail: { type: "assistant_message", text: "" } } },
    ]),
  ).toThrow(/not running/);

  store.markRunning("session_one", "run_one", token);
  expect(() =>
    store.ingestObservations("session_one", "run_one", "not-the-token-at-all", [
      { kind: "item.started", item: { id: "i1", detail: { type: "assistant_message", text: "" } } },
    ]),
  ).toThrow(EngineStateError);

  store.ingestObservations("session_one", "run_one", token, [
    { kind: "item.started", item: { id: "i1", detail: { type: "command_execution", command: { command: "ls" } }, title: "ls" } },
    { kind: "content.delta", itemId: "i1", stream: "command_output", text: "a" },
    { kind: "item.completed", itemId: "i1", status: "completed" },
  ]);

  const items = store.items("session_one");
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ id: "i1", runId: "run_one", sessionId: "session_one", status: "completed", title: "ls" });
  expect(store.readEvents("session_one").map((event) => event.type)).toEqual([
    "session.created",
    "turn.accepted",
    "turn.claimed",
    "turn.started",
    "item.started",
    "content.delta",
    "item.completed",
  ]);
});

test("a follow-up may be QUEUED while a turn runs, and drains in the order it was typed", () => {
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "First" });
  const claimed = store.claimTurn("session_one", "worker_one")!;
  store.markRunning("session_one", "run_one", claimed.claim!.token);

  // THE POINT: this used to be a conflict, so a human had to sit and wait
  // through a long turn before they could say the next thing.
  const second = store.submitTurn("session_one", { runId: "run_two", input: "Second" });
  expect(second.turn.state).toBe("queued");
  store.submitTurn("session_one", { runId: "run_three", input: "Third" });

  // Still exactly ONE turn executing: nothing may be claimed while one runs.
  expect(store.claimNextTurn("worker_two")).toBeUndefined();

  store.completeTurn("session_one", "run_one", claimed.claim!.token, { text: "done" });
  // Oldest first, so a backlog runs in the order it was typed.
  expect(store.claimNextTurn("worker_two")?.turn.runId).toBe("run_two");

  // A queued follow-up can be withdrawn before it ever runs.
  expect(store.stopTurn("session_one", "run_three").stopped).toBe(true);
});

test("an ambiguous turn still blocks new work, and the backlog is bounded", () => {
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "First" });
  const claimed = store.claimTurn("session_one", "worker_one")!;
  store.markRunning("session_one", "run_one", claimed.claim!.token);

  // A runaway client with a fresh runId each time would otherwise grow
  // queue.json without bound, and the queue is rewritten whole per transition.
  for (let i = 0; i < 16; i += 1) store.submitTurn("session_one", { runId: `run_q${i}`, input: "more" });
  expect(() => store.submitTurn("session_one", { runId: "run_over", input: "one too many" })).toThrow(/maximum number of queued/);

  // Ambiguity is different from busy: it needs a human decision first.
  const { store: other } = readyStore();
  other.submitTurn("session_one", { runId: "run_a", input: "First" });
  const held = other.claimTurn("session_one", "worker_one")!;
  other.markRunning("session_one", "run_a", held.claim!.token);
  other.recover();
  expect(() => other.submitTurn("session_one", { runId: "run_b", input: "next" })).toThrow(/ambiguous/);
});

test("runtime mode can be tightened mid-session and binds the very next tool call", () => {
  const { store } = readyStore();
  expect(store.getSession("session_one").runtimeMode).toBe("auto");

  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const claimed = store.claimTurn("session_one", "worker_one")!;
  const token = claimed.claim!.token;
  store.markRunning("session_one", "run_one", token);

  // Under `auto`, a command resolves itself with nobody watching.
  const before = store.openRequest("session_one", "run_one", token, {
    requestId: "req_before",
    kind: "command_execution",
    detail: { kind: "command_execution", command: { command: "rm -rf /tmp/x" } },
  });
  expect(before.state).toBe("resolved");

  // A human takes the rope back WHILE THE TURN IS STILL RUNNING.
  const tightened = store.updateSession("session_one", { runtimeMode: "approval-required" });
  expect(tightened.runtimeMode).toBe("approval-required");

  // The next tool call parks. This is what makes it usable as a brake: it binds
  // the running turn, not merely the next one.
  const after = store.openRequest("session_one", "run_one", token, {
    requestId: "req_after",
    kind: "command_execution",
    detail: { kind: "command_execution", command: { command: "rm -rf /tmp/y" } },
  });
  expect(after.state).toBe("open");
});

test("a session can be renamed, and a no-op update writes no journal row", () => {
  const { store } = readyStore();
  const renamed = store.updateSession("session_one", { title: "  Ship the parser  " });
  expect(renamed.title).toBe("Ship the parser");
  expect(store.readEvents("session_one").filter((e) => e.type === "session.updated")).toHaveLength(1);

  // A client polling a save button must not fill the journal with rows saying
  // nothing happened.
  store.updateSession("session_one", { title: "Ship the parser" });
  expect(store.readEvents("session_one").filter((e) => e.type === "session.updated")).toHaveLength(1);

  expect(() => store.updateSession("session_one", { title: "   " })).toThrow(/cannot be empty/);
  expect(() => store.updateSession("session_one", { runtimeMode: "yolo" as "auto" })).toThrow(/unknown runtime mode/);
});

test("tasks are journalled AND projected, so a cold session still knows a sub-agent ran", () => {
  const { store, root: stateRoot } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const claimed = store.claimTurn("session_one", "worker_one")!;
  const token = claimed.claim!.token;
  store.markRunning("session_one", "run_one", token);

  store.ingestObservations("session_one", "run_one", token, [
    { kind: "task.started", task: { id: "task_a", kind: "agent", state: "running", title: "Audit the parser", role: "Explore" } },
    // A row produced INSIDE the sub-agent.
    { kind: "item.started", item: { id: "i1", detail: { type: "command_execution", command: { command: "rg x" } }, taskId: "task_a" } },
    // A patch naming only the state, exactly as `task_updated` sends it.
    { kind: "task.completed", task: { id: "task_a", kind: "agent", state: "completed", resultText: "found it" } },
  ]);

  const tasks = store.tasks("session_one");
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({
    id: "task_a",
    sessionId: "session_one",
    runId: "run_one",
    state: "completed",
    resultText: "found it",
    // Carried through the terminal patch that never mentioned them.
    title: "Audit the parser",
    role: "Explore",
    completedAt: 100,
  });
  // The link survives into the stored item, which is the only way a client
  // opening this session LATER can file the row under its agent.
  expect(store.items("session_one")[0]).toMatchObject({ id: "i1", taskId: "task_a" });
  expect(store.readEvents("session_one").map((event) => event.type)).toEqual([
    "session.created",
    "turn.accepted",
    "turn.claimed",
    "turn.started",
    "task.started",
    "item.started",
    "task.completed",
  ]);
  // A projection, on disk, beside the journal — not derived on read.
  expect(fs.existsSync(path.join(stateRoot, "sessions", "session_one", "tasks.json"))).toBe(true);
});

test("a session names its provider, and the routing instance is derived from it", () => {
  const { store } = readyStore();
  const codex = store.createSession({ id: "session_codex", projectId: "project_one", driver: "codex" });
  expect(codex).toMatchObject({ driver: "codex", providerInstanceId: "codex:default" });
  expect(store.createSession({ id: "session_default", projectId: "project_one" })).toMatchObject({
    driver: "claude",
    providerInstanceId: "claude:default",
  });
  expect(() => store.createSession({ id: "session_bad", projectId: "project_one", driver: "gemini" as "claude" })).toThrow(
    /unknown provider driver/,
  );
  // The claim is what a worker routes on, so the driver has to survive onto it.
  store.submitTurn("session_codex", { runId: "run_one", input: "Hello" });
  expect(store.claimNextTurn("worker_one")).toMatchObject({ sessionId: "session_codex", driver: "codex" });
});

test("a malformed observation rejects the WHOLE batch, leaving no half-written provider message", () => {
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const claimed = store.claimTurn("session_one", "worker_one")!;
  store.markRunning("session_one", "run_one", claimed.claim!.token);
  const before = store.readEvents("session_one").length;

  expect(() =>
    store.ingestObservations("session_one", "run_one", claimed.claim!.token, [
      { kind: "item.started", item: { id: "good", detail: { type: "assistant_message", text: "" } } },
      { kind: "item.started", item: { id: "bad", detail: { type: "file_change", command: { command: "ls" } } } },
    ]),
  ).toThrow(/observations are invalid/);

  expect(store.readEvents("session_one")).toHaveLength(before);
  expect(store.items("session_one")).toEqual([]);
});

test("a delta for an item that was never opened is dropped rather than journalled", () => {
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const claimed = store.claimTurn("session_one", "worker_one")!;
  store.markRunning("session_one", "run_one", claimed.claim!.token);
  store.ingestObservations("session_one", "run_one", claimed.claim!.token, [
    { kind: "content.delta", itemId: "ghost", stream: "assistant_text", text: "x" },
  ]);
  expect(store.readEvents("session_one").some((event) => event.type === "content.delta")).toBe(false);
});

test("a v1 document names the version break instead of reading as corruption", () => {
  const { store, root: stateRoot } = readyStore();
  const queueFile = path.join(stateRoot, "sessions", "session_one", "queue.json");
  const queue = JSON.parse(fs.readFileSync(queueFile, "utf8")) as { version: number };
  queue.version = 1;
  fs.writeFileSync(queueFile, `${JSON.stringify(queue)}\n`);
  // A bare schema failure here would read as disk corruption and send an
  // operator looking in the wrong place.
  expect(() => store.turns("session_one")).toThrow(/protocol v1/);
});

test("discard cannot alter a non-ambiguous turn", () => {
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  expect(() => store.discardAmbiguousTurn("session_one", "run_one")).toThrow(/only an ambiguous turn/);
  expect(store.turns("session_one")[0]).toMatchObject({ runId: "run_one", state: "queued" });
  expect(store.readEvents("session_one").map((event) => event.type)).toEqual(["session.created", "turn.accepted"]);
});

test("project roots are canonical existing directories and legacy homes are rejected through symlinks", () => {
  const stateRoot = root();
  const store = new EngineStore(stateRoot);
  expect(() => store.registerProject({ id: "missing", name: "Missing", root: path.join(stateRoot, "missing") })).toThrow(/existing directory/);
  const link = path.join(stateRoot, "project-link");
  fs.symlinkSync("/tmp", link);
  expect(store.registerProject({ id: "canonical", name: "Canonical", root: link }).root).toBe(fs.realpathSync.native("/tmp"));

  const legacy = path.join(os.homedir(), ".telar");
  const alias = path.join(stateRoot, "legacy-link");
  fs.symlinkSync(legacy, alias);
  expect(() => vnextRootFromEnv({ TELAR_HOME: legacy })).toThrow(/legacy Telar state/);
  expect(() => vnextRootFromEnv({ TELAR_HOME: alias })).toThrow(/legacy Telar state/);
});

test("an interrupted final journal append is truncated, while malformed complete records are rejected", () => {
  const { store, root: stateRoot } = readyStore();
  const journal = path.join(stateRoot, "sessions", "session_one", "events.ndjson");
  const valid = fs.readFileSync(journal, "utf8");
  fs.appendFileSync(journal, '{"id":2');
  expect(store.readEvents("session_one")).toHaveLength(1);
  expect(fs.readFileSync(journal, "utf8")).toBe(valid);
  fs.appendFileSync(journal, JSON.stringify({ id: 2, at: 100, type: "turn.accepted", sessionId: "session_one", runId: "run_one", turn: {}, replayed: false }));
  expect(store.readEvents("session_one")).toHaveLength(2);
  expect(fs.readFileSync(journal, "utf8")).toEndWith("\n");
  fs.appendFileSync(journal, "not-json\n");
  expect(() => store.readEvents("session_one")).toThrow();
});

test("stale lock recovery uses exclusive replacement and never removes a newly held lock", () => {
  const stateRoot = root();
  const paths = statePaths(stateRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: -1, token: "dead" }));
  const first = acquireDaemonLock(paths);
  expect(() => acquireDaemonLock(paths)).toThrow(/already locked/);
  first.release();
});

test("concurrent stale-lock breakers elect exactly one replacement owner", async () => {
  const stateRoot = root();
  const paths = statePaths(stateRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: -1, token: "dead" }));
  const source = path.resolve(import.meta.dir, "../src/state.ts");
  const program = `import { acquireDaemonLock, statePaths } from ${JSON.stringify(source)};
const lock = acquireDaemonLock(statePaths(${JSON.stringify(stateRoot)}));
setTimeout(() => { lock.release(); process.exit(0); }, 1_000);`;
  const left = Bun.spawn([process.execPath, "-e", program], { stdout: "ignore", stderr: "ignore" });
  const right = Bun.spawn([process.execPath, "-e", program], { stdout: "ignore", stderr: "ignore" });
  const statuses = await Promise.all([left.exited, right.exited]);
  expect(statuses.sort()).toEqual([0, 1]);
});

test("an attachment is stored under the engine's own name and a turn may only reference one that exists", () => {
  const { store, root: stateRoot } = readyStore();
  const attachment = store.putAttachment("session_one", {
    name: "../../escape.png",
    mediaType: "image/png",
    data: new Uint8Array([1, 2, 3, 4]),
  });

  // THE HUMAN'S NAME NEVER REACHES THE FILESYSTEM. It is kept for display and
  // the path is minted from the engine's own id, so a name full of `..` is a
  // label rather than a traversal.
  expect(attachment.name).toBe("../../escape.png");
  expect(attachment.path.startsWith(path.join(stateRoot, "sessions", "session_one", "attachments"))).toBe(true);
  expect(path.basename(attachment.path)).toBe(`${attachment.id}.png`);
  expect(fs.readFileSync(attachment.path)).toEqual(Buffer.from([1, 2, 3, 4]));

  const { turn } = store.submitTurn("session_one", { runId: "run_one", input: "Look", attachments: [attachment.id] });
  expect(turn.attachments).toEqual([attachment]);

  // Loud rather than silent: a message that says "look at this" and arrives
  // with nothing attached is worse than one that fails to send.
  expect(() => store.submitTurn("session_one", { runId: "run_two", input: "Look", attachments: ["att_missing"] })).toThrow(
    EngineStateError,
  );
});

test("a per-turn model beats the session default and cannot change the provider", () => {
  const { store } = readyStore();
  const session = store.getSession("session_one");
  store.updateSession("session_one", { model: { instanceId: session.providerInstanceId, model: "claude-opus-5" } });

  const { turn } = store.submitTurn("session_one", { runId: "run_one", input: "Hi", model: { model: "claude-haiku-4-5", effort: "low" } });
  // The instance is STAMPED FROM THE SESSION — the wire shape has no field for
  // it, so a client cannot ask for a different provider mid-conversation.
  expect(turn.model).toEqual({ instanceId: session.providerInstanceId, model: "claude-haiku-4-5", effort: "low" });

  const claim = store.claimNextTurn("worker_one");
  expect(claim?.model).toEqual({ instanceId: session.providerInstanceId, model: "claude-haiku-4-5", effort: "low" });
});

test("a turn with no model of its own falls back to the session's", () => {
  const { store } = readyStore();
  const session = store.getSession("session_one");
  store.updateSession("session_one", { model: { instanceId: session.providerInstanceId, model: "claude-opus-5" } });
  store.submitTurn("session_one", { runId: "run_one", input: "Hi" });
  expect(store.claimNextTurn("worker_one")?.model?.model).toBe("claude-opus-5");
});

test("only enabled MCP servers ride the claim, and disabling one keeps its configuration", () => {
  const { store } = readyStore();
  store.saveMcpServer({ id: "linear", label: "Linear", spec: { transport: "http", url: "https://mcp.linear.app/sse" } });
  store.saveMcpServer({ id: "local_tools", spec: { transport: "stdio", command: "node", args: ["server.js"] } });
  expect(store.listMcpServers().map((server) => server.id)).toEqual(["linear", "local_tools"]);
  // The label defaults to the id, which is also the name the provider addresses
  // its tools by.
  expect(store.listMcpServers()[1]!.label).toBe("local_tools");

  store.saveMcpServer({ id: "linear", enabled: false, spec: { transport: "http", url: "https://mcp.linear.app/sse" } });
  store.submitTurn("session_one", { runId: "run_one", input: "Hi" });
  expect(store.claimNextTurn("worker_one")?.mcpServers?.map((server) => server.id)).toEqual(["local_tools"]);

  // Off is a state, not deletion: the configuration survives so it can come back.
  expect(store.listMcpServers().find((server) => server.id === "linear")?.spec).toEqual({
    transport: "http",
    url: "https://mcp.linear.app/sse",
  });
  expect(store.removeMcpServer("linear")).toBe(true);
  expect(store.removeMcpServer("linear")).toBe(false);
  expect(() => store.saveMcpServer({ id: "bad", spec: { transport: "carrier-pigeon" } })).toThrow(EngineStateError);
});

test("a store with no browser attached reports none rather than failing", async () => {
  const { store } = readyStore();
  // The ordinary answer for a session that has never browsed, and the same one
  // a deployment whose worker owns the browser gives. One code path, not two.
  expect(await store.browserState("session_one")).toEqual({ scopeKey: "session_one", provider: "none", running: false, tabs: [] });
});
