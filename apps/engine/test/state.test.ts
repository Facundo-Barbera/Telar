import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireDaemonLock, EngineStateError, EngineStore, migrateLegacyEngineRoot, statePaths, engineRootFromEnv } from "../src/state";

const roots: string[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-engine-"));
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

test("the engine requires an explicit absolute home and writes only beneath its Telar root", () => {
  expect(() => engineRootFromEnv({})).toThrow(EngineStateError);
  expect(() => engineRootFromEnv({ TELAR_HOME: "relative" })).toThrow(EngineStateError);
  expect(engineRootFromEnv({ TELAR_HOME: "/tmp/telar" })).toBe(path.join(fs.realpathSync.native("/tmp"), "telar", "engine"));
  const { root: stateRoot } = readyStore();
  expect(fs.existsSync(path.join(stateRoot, "projects.json"))).toBe(true);
  expect(fs.existsSync(path.join(stateRoot, "sessions", "session_one", "session.json"))).toBe(true);
  expect(fs.existsSync(path.join(path.dirname(stateRoot), "chats.json"))).toBe(false);
});

describe("the store survives being renamed out of vnext/", () => {
  /**
   * THE FAILURE THIS PREVENTS IS SILENT AND TOTAL. The engine root moved from
   * `<TELAR_HOME>/vnext` to `<TELAR_HOME>/engine` when the app stopped being
   * called vNext. Without the migration the daemon finds an empty directory,
   * creates it, and comes up perfectly healthy with every project and session
   * gone — no error anywhere, because nothing was ever wrong with the new root.
   */
  test("an existing vnext/ store is renamed into place", () => {
    const home = root();
    const legacy = path.join(home, "vnext");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "projects.json"), '{"projects":[]}', "utf8");

    expect(migrateLegacyEngineRoot(path.join(home, "engine"))).toBe(true);
    expect(fs.existsSync(path.join(home, "engine", "projects.json"))).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
  });

  test("a store already in place is never overwritten by a stale vnext/", () => {
    // Both names existing means somebody ran an old build after a new one. The
    // CURRENT root wins; renaming over it would replace live state with older
    // state, which is worse than the leftover directory.
    const home = root();
    fs.mkdirSync(path.join(home, "vnext"), { recursive: true });
    fs.mkdirSync(path.join(home, "engine"), { recursive: true });
    fs.writeFileSync(path.join(home, "engine", "projects.json"), '{"projects":[]}', "utf8");

    expect(migrateLegacyEngineRoot(path.join(home, "engine"))).toBe(false);
    expect(fs.existsSync(path.join(home, "vnext"))).toBe(true);
  });

  test("nothing to migrate is not an error, and says nothing", () => {
    expect(migrateLegacyEngineRoot(path.join(root(), "engine"))).toBe(false);
  });

  test("a root explicitly pinned AT the old name is left exactly where it is", () => {
    // Tests and anyone who passed `--engine-root .../vnext` by hand. Renaming a
    // directory onto itself is either a no-op or a crash, depending on the
    // platform; neither is something to find out at somebody's boot.
    const home = root();
    const pinned = path.join(home, "vnext");
    fs.mkdirSync(pinned, { recursive: true });
    expect(migrateLegacyEngineRoot(pinned)).toBe(false);
    expect(fs.existsSync(pinned)).toBe(true);
  });
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

test("the event cursor is the last journal id, read without the journal", () => {
  const { store, root: stateRoot } = readyStore();
  expect(store.eventCursor("session_one")).toBe(1); // session.created
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  store.stopTurn("session_one", "run_one");
  const whole = store.readEvents("session_one");
  expect(store.eventCursor("session_one")).toBe(whole.at(-1)!.id);

  // A crash mid-append leaves an unterminated last line; the cursor names the
  // last COMPLETE record, the same one readJournal keeps after its repair.
  const file = path.join(stateRoot, "sessions", "session_one", "events.ndjson");
  fs.appendFileSync(file, '{"id":99,"at":1,"sessionId":"session_one","type":"turn.st');
  expect(store.eventCursor("session_one")).toBe(whole.at(-1)!.id);

  // A record far larger than the first read window is still found.
  const big = { id: whole.at(-1)!.id + 1, at: 1, sessionId: "session_one", type: "note", text: "x".repeat(20_000) };
  fs.writeFileSync(file, `${whole.map((event) => JSON.stringify(event)).join("\n")}\n${JSON.stringify(big)}\n`);
  expect(store.eventCursor("session_one")).toBe(big.id);
});

test("a windowed snapshot is the newest settled turns plus everything unsettled, paged by runId", () => {
  const { store } = readyStore();
  for (const n of [1, 2, 3, 4, 5]) {
    const runId = `run_${n}`;
    store.submitTurn("session_one", { runId, input: `Turn ${n}` });
    const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
    store.markRunning("session_one", runId, token);
    store.ingestObservations("session_one", runId, token, [
      { kind: "item.started", item: { id: `i_${n}`, detail: { type: "assistant_message", text: `Answer ${n}` } } },
      { kind: "item.completed", itemId: `i_${n}`, status: "completed" },
    ]);
    store.completeTurn("session_one", runId, token, { text: `Answer ${n}` });
  }
  store.submitTurn("session_one", { runId: "run_live", input: "Now" }); // queued — unsettled

  const first = store.snapshotWindow("session_one", { limit: 2 });
  expect(first.turns.map((turn) => turn.runId)).toEqual(["run_4", "run_5", "run_live"]);
  expect(first.page).toEqual({ before: "run_4", more: true });
  // Items follow their turns — the window is what makes the read small.
  expect(first.items.map((item) => item.id).sort()).toEqual(["i_4", "i_5"]);

  const older = store.snapshotWindow("session_one", { limit: 2, before: "run_4" });
  expect(older.turns.map((turn) => turn.runId)).toEqual(["run_2", "run_3"]);
  expect(older.page).toEqual({ before: "run_2", more: true });

  const oldest = store.snapshotWindow("session_one", { limit: 2, before: "run_2" });
  expect(oldest.turns.map((turn) => turn.runId)).toEqual(["run_1"]);
  expect(oldest.page).toEqual({ before: null, more: false });

  // A limit past the start is the whole history, first page, no cursor.
  const whole = store.snapshotWindow("session_one", { limit: 50 });
  expect(whole.turns).toHaveLength(6);
  expect(whole.page).toEqual({ before: null, more: false });

  expect(() => store.snapshotWindow("session_one", { limit: 2, before: "run_nope" })).toThrow(EngineStateError);
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

test("settling is a pin in either direction, and null hands the session back to the clock", () => {
  const { store } = readyStore();
  // Three answers, which is why this is an enum and not a boolean: shelve it,
  // keep it, or let the inactivity rule decide.
  expect(store.updateSession("session_one", { settledOverride: "settled" })).toMatchObject({ settledOverride: "settled", settledAt: 100 });
  expect(store.updateSession("session_one", { settledOverride: "active" })).toMatchObject({ settledOverride: "active" });
  const cleared = store.updateSession("session_one", { settledOverride: null });
  expect(cleared.settledOverride).toBeUndefined();
  expect(cleared.settledAt).toBeUndefined();
  expect(() => store.updateSession("session_one", { settledOverride: "maybe" as "settled" })).toThrow(/settledOverride/);
});

test("a snooze carries BOTH stamps, because 'has anything happened since' needs a baseline", () => {
  const { store } = readyStore();
  const snoozed = store.updateSession("session_one", { snoozedUntil: 9_000 });
  expect(snoozed).toMatchObject({ snoozedUntil: 9_000, snoozedAt: 100 });
  const woken = store.updateSession("session_one", { snoozedUntil: null });
  expect(woken.snoozedUntil).toBeUndefined();
  expect(woken.snoozedAt).toBeUndefined();
  expect(() => store.updateSession("session_one", { snoozedUntil: Number.NaN })).toThrow(/timestamp/);
});

test("a settled or snoozed session comes back on its own when a human queues work", () => {
  const { store } = readyStore();
  store.updateSession("session_one", { settledOverride: "settled", snoozedUntil: 9_000 });
  // THE RULE THAT KEEPS SETTLING FROM BEING A PLACE THINGS GET LOST: a person
  // settled this meaning "done for now", and typing at it means they are not.
  store.submitTurn("session_one", { runId: "run_wake", input: "Actually, one more thing" });
  const session = store.getSession("session_one");
  expect(session.settledOverride).toBeUndefined();
  expect(session.snoozedUntil).toBeUndefined();
  expect(session.snoozedAt).toBeUndefined();
  // The client is told, rather than having to poll for it.
  expect(store.readEvents("session_one").filter((event) => event.type === "session.updated")).toHaveLength(2);
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
  // The built-in slot's id IS the driver kind — t3 code's
  // `defaultInstanceIdForDriver` — which is what keeps an instance id a plain
  // slug that survives a URL path segment. It used to be `<driver>:default`.
  const codex = store.createSession({ id: "session_codex", projectId: "project_one", driver: "codex" });
  expect(codex).toMatchObject({ driver: "codex", providerInstanceId: "codex" });
  expect(store.createSession({ id: "session_default", projectId: "project_one" })).toMatchObject({
    driver: "claude",
    providerInstanceId: "claude",
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

  // THE LEGACY HOME HAS TO EXIST for the symlink half to mean anything.
  // canonicalPath resolves through realpath, and a symlink to a missing target
  // is not resolvable — it walks up to the nearest existing parent and rebuilds
  // the rest literally, so `alias` never becomes ~/.telar and the guard has
  // nothing to match. On a developer's machine ~/.telar is usually there and
  // this passed by luck; on a CI runner it is not, which is exactly where the
  // test was failing. Created only if absent, and removed with rmdir, which
  // refuses a non-empty directory — a real ~/.telar is never touched.
  const legacy = path.join(os.homedir(), ".telar");
  const createdLegacy = !fs.existsSync(legacy);
  if (createdLegacy) fs.mkdirSync(legacy, { recursive: true });
  try {
    const alias = path.join(stateRoot, "legacy-link");
    fs.symlinkSync(legacy, alias);
    expect(() => engineRootFromEnv({ TELAR_HOME: legacy })).toThrow(/legacy Telar state/);
    expect(() => engineRootFromEnv({ TELAR_HOME: alias })).toThrow(/legacy Telar state/);
  } finally {
    if (createdLegacy) fs.rmdirSync(legacy);
  }
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

test("a daemon-injected computer-use resolver reaches a claim", () => {
  // The resolver is an OPTION, not a default — a store built without one (every
  // other test in this file) never reads the machine's installs.
  const stateRoot = root();
  const resolved = {
    backend: "cua" as const,
    server: {
      id: "mac",
      label: "Computer Use (Mac)",
      enabled: true,
      spec: { transport: "stdio" as const, command: "/fake/cua-driver", args: ["mcp"] },
      createdAt: 0,
      updatedAt: 0,
    },
  };
  const store = new EngineStore(stateRoot, () => 100, { computerUse: () => resolved });
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  store.createSession({ id: "session_one", projectId: "project_one" });
  store.submitTurn("session_one", { runId: "run_one", input: "Hi" });
  expect(store.claimNextTurn("worker_one")?.mcpServers?.map((server) => server.id)).toEqual(["mac"]);
});

test("a store with no browser attached reports none rather than failing", async () => {
  const { store } = readyStore();
  // The ordinary answer for a session that has never browsed, and the same one
  // a deployment whose worker owns the browser gives. One code path, not two.
  // `canStart: false` is what tells a client not to offer an "open a browser"
  // button that would start one beside the worker's own.
  expect(await store.browserState("session_one")).toEqual({
    scopeKey: "session_one",
    provider: "none",
    running: false,
    tabs: [],
    canStart: false,
  });
});

test("a hand-started browser journals its tabs exactly once, so the panel can show them", async () => {
  const { store } = readyStore();
  const tabs = [{ id: "0", url: "http://x", title: "X", active: true }];
  store.attachBrowser({
    state: async () => ({ provider: "headless" as const, running: true, tabs }),
    release: async () => undefined,
  } as never);

  // A plain read journals nothing: asking what the browser shows must never
  // become history. Only the explicit `start` gesture is an event.
  await store.browserState("session_one");
  const before = store.readEvents("session_one").filter((event) => event.type === "browser.state.changed");
  expect(before).toHaveLength(0);

  const started = await store.browserState("session_one", { start: true });
  expect(started.canStart).toBe(true);
  // A second press with the same tab set journals nothing new.
  await store.browserState("session_one", { start: true });
  const events = store.readEvents("session_one").filter((event) => event.type === "browser.state.changed");
  expect(events).toHaveLength(1);
  expect((events[0] as { tabs: { url: string }[] }).tabs[0]?.url).toBe("http://x");
});

test("a local session records the commit it started from, so its review survives the agent committing", () => {
  // Without a base, "what has this session done" was answerable only for
  // worktree sessions: `git status` forgets a change the instant it is
  // committed, so a session that committed its work reviewed as having done
  // nothing at all.
  const projectRoot = fs.realpathSync.native(root());
  const store = new EngineStore(root(), () => 100, {
    git: (_cwd, args) => (args.join(" ") === "rev-parse HEAD" ? { status: 0, stdout: "base000\n", stderr: "" } : { status: 1, stdout: "", stderr: "" }),
  });
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  const session = store.createSession({ id: "session_one", projectId: "project_one" });
  expect(session.workspace).toEqual({ mode: "local", path: projectRoot, baseRef: "base000" });
});

test("an unversioned project still gets a session, with no base rather than a refusal", () => {
  // `envMode: "local"` exists precisely so an unversioned directory can host
  // sessions; a failure to resolve HEAD must not cost the session.
  const projectRoot = fs.realpathSync.native(root());
  const store = new EngineStore(root(), () => 100, { git: () => ({ status: 128, stdout: "", stderr: "not a git repository" }) });
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  expect(store.createSession({ id: "session_one", projectId: "project_one" }).workspace).toEqual({ mode: "local", path: projectRoot });
});

test("a file patch cannot be asked for outside the session's own workspace", () => {
  // `git diff -- <path>` takes a pathspec, and `../../` in one is how a client
  // asks to read a file it was never offered. Fenced in the store rather than at
  // the route, so an in-process caller cannot walk past it either.
  const store = new EngineStore(root(), () => 100, { git: () => ({ status: 0, stdout: "", stderr: "" }) });
  store.registerProject({ id: "project_one", name: "One", root: fs.realpathSync.native(root()) });
  store.createSession({ id: "session_one", projectId: "project_one" });
  expect(() => store.sessionFilePatch("session_one", "../../etc/passwd")).toThrow(EngineStateError);
  expect(() => store.sessionFilePatch("session_one", "  ")).toThrow(EngineStateError);
});

test("a commit needs a message and the message has a ceiling", () => {
  const store = new EngineStore(root(), () => 100, { git: () => ({ status: 0, stdout: "", stderr: "" }) });
  store.registerProject({ id: "project_one", name: "One", root: fs.realpathSync.native(root()) });
  store.createSession({ id: "session_one", projectId: "project_one" });
  expect(() => store.commitSessionWork("session_one", "   ")).toThrow(EngineStateError);
  expect(() => store.commitSessionWork("session_one", "x".repeat(2_001))).toThrow(EngineStateError);
});

/** Whether a `gh` argv is the BOARD half of a read — the one asking for
 *  `projectItems`, which is separate precisely so it can fail alone. */
const isBoardCall = (args: string[]) => args.includes("number,projectItems");

test("a GitHub read is cached, and only a refresh gets past the cache", async () => {
  // The one cached read in this store, because it is the one that costs
  // somebody else's rate limit. A panel opened, closed and reopened must not
  // spend five API calls per glance.
  let calls = 0;
  let clock = 1_000;
  const store = new EngineStore(root(), () => clock, {
    git: () => ({ status: 0, stdout: "", stderr: "" }),
    gh: async (_cwd, args) => {
      calls += 1;
      return { status: 0, stdout: args[0] === "repo" ? JSON.stringify({ nameWithOwner: "o/r" }) : "[]", stderr: "" };
    },
  });
  store.registerProject({ id: "project_one", name: "One", root: fs.realpathSync.native(root()) });

  // FIVE, ALL AT ONCE: the two lists, the repository name, and the two board reads.
  await store.projectGitHub("project_one");
  expect(calls).toBe(5);
  await store.projectGitHub("project_one");
  expect(calls).toBe(5);

  // The refresh button is the only thing that may bypass it; a timer must not.
  await store.projectGitHub("project_one", { force: true });
  expect(calls).toBe(10);

  clock += 31_000;
  await store.projectGitHub("project_one");
  expect(calls).toBe(15);
});

test("WHICH ROWS is part of the cache key, so a filter cannot be answered by the wrong list", async () => {
  // Without the states in the key, switching Pull requests from open to all is
  // answered instantly from a cache of open ones — a filter that silently does
  // nothing for thirty seconds, which is worse than a slow one.
  let calls = 0;
  const store = new EngineStore(root(), () => 1_000, {
    git: () => ({ status: 0, stdout: "", stderr: "" }),
    gh: async (_cwd, args) => {
      calls += 1;
      return { status: 0, stdout: args[0] === "repo" ? JSON.stringify({ nameWithOwner: "o/r" }) : "[]", stderr: "" };
    },
  });
  store.registerProject({ id: "project_one", name: "One", root: fs.realpathSync.native(root()) });

  const open = { state: "open" as const, labels: [] };
  await store.projectGitHub("project_one", { issues: open, pulls: open });
  expect(calls).toBe(5);
  await store.projectGitHub("project_one", { issues: open, pulls: { state: "all", labels: [] } });
  expect(calls).toBe(10);
  // And the first combination is still cached, so going back is free.
  await store.projectGitHub("project_one", { issues: open, pulls: open });
  expect(calls).toBe(10);

  // EVERY FIELD IS IN THE KEY, not just the state: a milestone filter answered from
  // a cache of everybody's issues is a filter that silently does nothing.
  await store.projectGitHub("project_one", { issues: { state: "open", milestone: "v2", labels: [] }, pulls: open });
  expect(calls).toBe(15);
  await store.projectGitHub("project_one", { issues: { state: "open", assignee: "@me", labels: [] }, pulls: open });
  expect(calls).toBe(20);

  // BUT LABELS IN A DIFFERENT ORDER ARE THE SAME QUESTION. `gh` ANDs them, so
  // without normalising, picking `bug` then `web` and `web` then `bug` would spend
  // two network reads to get identical rows.
  await store.projectGitHub("project_one", { issues: { state: "open", labels: ["bug", "web"] }, pulls: open });
  expect(calls).toBe(25);
  await store.projectGitHub("project_one", { issues: { state: "open", labels: ["web", "bug"] }, pulls: open });
  expect(calls).toBe(25);
});

test("what there is to FILTER BY is its own cache, and a longer one", async () => {
  // Milestones and labels change on the timescale of a sprint, not of a page view,
  // and nothing asks for them until a filter menu opens.
  let calls = 0;
  let clock = 1_000;
  const store = new EngineStore(root(), () => clock, {
    git: () => ({ status: 0, stdout: "", stderr: "" }),
    gh: async (_cwd, args) => {
      calls += 1;
      return { status: 0, stdout: args[0] === "label" ? "[]" : args[1] === "user" ? "{}" : "[]", stderr: "" };
    },
  });
  store.registerProject({ id: "project_one", name: "One", root: fs.realpathSync.native(root()) });

  await store.projectForgeFacets("project_one");
  expect(calls).toBe(4);
  await store.projectForgeFacets("project_one");
  expect(calls).toBe(4);

  // Past the LIST cache's thirty seconds and still fresh — this is the whole point
  // of it being separate.
  clock += 60_000;
  await store.projectForgeFacets("project_one");
  expect(calls).toBe(4);

  clock += 5 * 60_000;
  await store.projectForgeFacets("project_one");
  expect(calls).toBe(8);
});

test("a token with no read:project is asked ONCE, then left alone", async () => {
  // Two extra network calls per read, to be told the same thing every time, is a
  // toll on somebody whose token is simply scoped the ordinary way.
  const seen: string[][] = [];
  const store = new EngineStore(root(), () => 1_000, {
    git: () => ({ status: 0, stdout: "", stderr: "" }),
    gh: async (_cwd, args) => {
      seen.push(args);
      if (args[0] === "repo") return { status: 0, stdout: JSON.stringify({ nameWithOwner: "o/r" }), stderr: "" };
      if (isBoardCall(args)) return { status: 1, stdout: "", stderr: "requires one of the following scopes: ['read:project']" };
      return { status: 0, stdout: "[]", stderr: "" };
    },
  });
  store.registerProject({ id: "project_one", name: "One", root: fs.realpathSync.native(root()) });

  const first = await store.projectGitHub("project_one");
  expect(first.projectsUnavailable).toBe("scope");
  expect(seen.filter(isBoardCall)).toHaveLength(2);

  // A different filter is a fresh read, and it must not ask again.
  const second = await store.projectGitHub("project_one", { pullState: "all" });
  expect(seen.filter(isBoardCall)).toHaveLength(2);
  /**
   * BUT THE REASON SURVIVES, and this assertion used to say the opposite.
   *
   * Driving the real cockpit found it: the app's own first read consumed the scope
   * failure, so every read after it carried no reason, and a panel opened a minute
   * later showed every row on no boards with nothing to explain it. Not re-asking
   * does not unlearn the answer.
   */
  expect(second.projectsUnavailable).toBe("scope");

  // THE REFRESH BUTTON IS THE WAY BACK, because `gh auth refresh -s read:project`
  // is a thing somebody does and then presses refresh.
  await store.projectGitHub("project_one", { force: true });
  expect(seen.filter(isBoardCall)).toHaveLength(4);
});

/**
 * A store whose `gh` answers one pull request, recording every call.
 *
 * The BOARD calls are recorded as `board` rather than as `pr view`, because they
 * are the same two words as the detail read and a test counting "how many times was
 * this pull request fetched" would otherwise count double.
 */
function forgeStore(pull: () => Record<string, unknown>) {
  const calls: string[] = [];
  let clock = 1_000;
  const store = new EngineStore(root(), () => clock, {
    git: () => ({ status: 0, stdout: "", stderr: "" }),
    gh: async (_cwd, args) => {
      calls.push(isBoardCall(args) ? "board" : args.slice(0, 2).join(" "));
      if (args[0] === "repo") return { status: 0, stdout: JSON.stringify({ nameWithOwner: "o/r" }), stderr: "" };
      if (isBoardCall(args)) return { status: 0, stdout: args[1] === "list" ? "[]" : "{}", stderr: "" };
      if (args[1] === "list") return { status: 0, stdout: "[]", stderr: "" };
      if (args[1] === "merge") return { status: 0, stdout: "", stderr: "" };
      return { status: 0, stdout: JSON.stringify(pull()), stderr: "" };
    },
  });
  store.registerProject({ id: "project_one", name: "One", root: fs.realpathSync.native(root()) });
  return { store, calls, tick: (ms: number) => (clock += ms) };
}

const OPEN_PULL = {
  number: 12,
  title: "Ship it",
  state: "OPEN",
  isDraft: false,
  url: "u",
  createdAt: "2026-08-01T00:00:00Z",
  baseRefName: "main",
  headRefName: "telar/x",
  headRefOid: "head-1",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
};

test("a detail read has its OWN cache, so reopening a tab does not re-read the list", async () => {
  // Folding this into the snapshot cache would mean a list refresh could answer a
  // detail read with rows that have no body, and reopening one issue would spend
  // three API calls re-reading every issue.
  const { store, calls, tick } = forgeStore(() => OPEN_PULL);
  // Counted by the pull-request read alone: `readPull` also asks the repository
  // which merge methods it allows, concurrently, and that call is not the subject
  // of this test.
  const views = () => calls.filter((call) => call === "pr view").length;
  await store.projectPull("project_one", 12);
  expect(views()).toBe(1);
  await store.projectPull("project_one", 12);
  expect(views()).toBe(1);

  // A different number is a different read.
  await store.projectPull("project_one", 13);
  expect(views()).toBe(2);
  // And the refresh button still gets through, as does time.
  await store.projectPull("project_one", 12, { force: true });
  tick(31_000);
  await store.projectPull("project_one", 12);
  expect(views()).toBe(4);
});

test("a FAILED detail read is not cached — the fix takes less than thirty seconds", async () => {
  // Caching "gh is not signed in" would tell somebody who just ran `gh auth
  // login` that their fix did not work.
  let signedIn = false;
  const calls: string[] = [];
  const store = new EngineStore(root(), () => 1_000, {
    git: () => ({ status: 0, stdout: "", stderr: "" }),
    gh: async (_cwd, args) => {
      // The board half is not the subject: it is a separate call by design.
      if (!isBoardCall(args)) calls.push(args[1] ?? "");
      return signedIn
        ? { status: 0, stdout: JSON.stringify({ number: 4, title: "t", state: "OPEN", url: "u" }), stderr: "" }
        : { status: 1, stdout: "", stderr: "gh auth login" };
    },
  });
  store.registerProject({ id: "project_one", name: "One", root: fs.realpathSync.native(root()) });

  expect(await store.projectIssue("project_one", 4)).toEqual({ unavailable: "not_authenticated" });
  signedIn = true;
  expect(await store.projectIssue("project_one", 4)).toMatchObject({ issue: { number: 4 } });
  expect(calls).toHaveLength(2);
});

test("a merge DROPS both caches, so the panel that merged it does not go on saying open", async () => {
  // The worst possible moment for a thirty-second cache to be right about a
  // stale answer.
  let state = "OPEN";
  const { store, calls } = forgeStore(() => ({ ...OPEN_PULL, state, ...(state === "MERGED" ? { mergedAt: "2026-08-04T00:00:00Z" } : {}) }));
  await store.projectGitHub("project_one");
  await store.projectPull("project_one", 12);
  calls.length = 0;

  const result = await store.projectPullMerge("project_one", 12, { method: "squash", expectedHeadOid: "head-1" });
  state = "MERGED";
  expect(result.merged).toBe(true);

  // The merge's own confirming read is fresher than any cache, so it BECOMES the
  // cached answer rather than being thrown away.
  await store.projectPull("project_one", 12);
  expect(calls.filter((call) => call === "pr view")).toHaveLength(2);
  // And the list is re-read, because the row this merge closed is in it.
  await store.projectGitHub("project_one");
  expect(calls).toContain("issue list");
});

test("a merge with no head to pin against is refused before gh is reached", async () => {
  // There is deliberately no "merge whatever is there now" path.
  const { store, calls } = forgeStore(() => OPEN_PULL);
  await expect(store.projectPullMerge("project_one", 12, { method: "merge", expectedHeadOid: "  " })).rejects.toThrow(EngineStateError);
  await expect(store.projectPullMerge("project_one", 0, { method: "merge", expectedHeadOid: "head-1" })).rejects.toThrow(EngineStateError);
  await expect(store.projectIssue("project_one", 1.5)).rejects.toThrow(EngineStateError);
  expect(calls).toEqual([]);
});

test("an effort can be set without naming a model, and clearing the model keeps it", () => {
  // THE DEFECT THIS PINS: `ModelSelection` used to require a model in order to
  // carry an effort, so a session on the provider default — which is the
  // default — could not be told to think harder. The composer's reasoning pill
  // had nothing to write and read as a missing feature.
  const { store } = readyStore();
  const session = store.getSession("session_one");
  const updated = store.updateSession("session_one", { model: { instanceId: session.providerInstanceId, effort: "max" } });
  expect(updated.model).toEqual({ instanceId: session.providerInstanceId, effort: "max" });

  // And it survives the turn, which is where it actually has to arrive.
  store.submitTurn("session_one", { runId: "run_one", input: "hi" });
  expect(store.claimNextTurn("worker_one")?.model).toEqual({ instanceId: session.providerInstanceId, effort: "max" });
});

test("a per-turn selection may be an effort alone", () => {
  const { store } = readyStore();
  const session = store.getSession("session_one");
  const { turn } = store.submitTurn("session_one", { runId: "run_one", input: "hi", model: { effort: "low" } });
  expect(turn.model).toEqual({ instanceId: session.providerInstanceId, effort: "low" });
});

test("a selection that selects nothing is refused rather than stored", () => {
  // An empty selection is an ABSENT selection, and the engine should see it as
  // one rather than writing a record that says nothing.
  const { store } = readyStore();
  const session = store.getSession("session_one");
  expect(() => store.updateSession("session_one", { model: { instanceId: session.providerInstanceId } as never })).toThrow(
    EngineStateError,
  );
});

test("a model selection can be cleared, which `undefined` could never express", () => {
  // THE BUG THIS PINS: the cockpit's "Provider default" row sent `model:
  // undefined`, `JSON.stringify` dropped the key, and the engine saw no patch
  // at all — so the pill said one thing, the record said another, and a reload
  // snapped the old model back.
  const { store } = readyStore();
  const session = store.getSession("session_one");
  store.updateSession("session_one", { model: { instanceId: session.providerInstanceId, model: "claude-opus-5", effort: "max" } });
  expect(store.getSession("session_one").model).toBeDefined();

  expect(store.updateSession("session_one", { model: null }).model).toBeUndefined();
  // And an absent key still means "leave it alone", which is the other half of
  // the distinction.
  store.updateSession("session_one", { model: { instanceId: session.providerInstanceId, model: "claude-opus-5" } });
  expect(store.updateSession("session_one", { title: "Renamed" }).model?.model).toBe("claude-opus-5");
});

test("fast mode reaches the claim without a model", () => {
  // A Claude-side switch the composer offers on the provider default, so it has
  // to survive a selection that names no model at all.
  const { store } = readyStore();
  const session = store.getSession("session_one");
  store.updateSession("session_one", { model: { instanceId: session.providerInstanceId, fastMode: true } });
  store.submitTurn("session_one", { runId: "run_one", input: "hi" });
  expect(store.claimNextTurn("worker_one")?.model).toEqual({ instanceId: session.providerInstanceId, fastMode: true });
});

test("an MCP server belongs to a project or to the machine, and the project's wins", () => {
  const { store } = readyStore();
  // A distinct root: the registry refuses two projects pointing at one checkout.
  // It must be distinct AFTER canonicalization, which os.tmpdir() is not —
  // readyStore registers project_one at "/tmp", and on Linux os.tmpdir() IS
  // /tmp, so this collided and threw "already registered" in CI while passing
  // on macOS, where os.tmpdir() is a per-user /var/folders path.
  store.registerProject({ id: "project_two", name: "Two", root: root() });
  store.saveMcpServer({ id: "linear", spec: { transport: "http", url: "https://global.example" } });
  store.saveMcpServer({ id: "browser", spec: { transport: "stdio", command: "node" } });
  store.saveMcpServer({ id: "linear", projectId: "project_one", spec: { transport: "http", url: "https://one.example" } });

  // Scope is a property, and the three reads answer three different questions.
  expect(store.listMcpServers({ projectId: null }).map((server) => server.id)).toEqual(["linear", "browser"]);
  expect(store.listMcpServers({ projectId: "project_one" }).map((server) => server.spec)).toEqual([
    { transport: "http", url: "https://one.example" },
  ]);
  expect(store.listMcpServers({ projectId: "project_two" })).toEqual([]);

  // THE PAIR IS THE KEY: the project's `linear` did not overwrite the global
  // one, and a session on that project sees the project's instead.
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const claimed = store.claimNextTurn("worker_one");
  expect(claimed?.mcpServers?.map((server) => [server.id, server.spec])).toEqual([
    ["browser", { transport: "stdio", command: "node" }],
    ["linear", { transport: "http", url: "https://one.example" }],
  ]);

  // …and deleting the project's leaves the global one standing, which an
  // id-only match would not have done.
  expect(store.removeMcpServer("linear", "project_one")).toBe(true);
  expect(store.listMcpServers({ projectId: null }).map((server) => server.id)).toEqual(["linear", "browser"]);
  expect(() => store.saveMcpServer({ id: "x", projectId: "nobody", spec: { transport: "stdio", command: "node" } })).toThrow(
    EngineStateError,
  );
});

test("a session says what it is doing, and a parked request outranks a running turn", () => {
  // THE FIELD THAT MAKES A LIST AN INBOX. Without it a sidebar can only sort by
  // recency — every row reads the same, and the two questions a person actually
  // has ("is one waiting on me", "is one still going") are unanswerable.
  const { store } = readyStore();
  expect(store.getSession("session_one").activity).toBe("idle");
  // Nothing to date on idle: how long ago it last did anything is `updatedAt`,
  // which every caller already has.
  expect(store.getSession("session_one").activityAt).toBeUndefined();

  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  expect(store.getSession("session_one").activity).toBe("queued");

  const claim = store.claimNextTurn("worker_one")!;
  store.markRunning("session_one", "run_one", claim.turn.claim!.token);
  expect(store.getSession("session_one").activity).toBe("working");

  // A mode that actually PARKS. Under the default posture this request
  // auto-resolves and the session stays "working", which is correct and is why
  // the mode has to be named here rather than assumed.
  store.updateSession("session_one", { runtimeMode: "approval-required" });
  store.openRequest("session_one", "run_one", claim.turn.claim!.token, {
    requestId: "req_one",
    kind: "command_execution",
    detail: { kind: "command_execution", command: { command: "rm -rf /" } },
  });
  // BOTH ARE TRUE AT ONCE — the turn is still running — and only one of them is
  // the reader's to act on. Decided in the engine so every client agrees.
  expect(store.getSession("session_one").activity).toBe("blocked");
  // And it dates the WAIT, not the turn: the number that should embarrass us.
  expect(store.getSession("session_one").activityAt).toBe(100);

  // Answering it hands the session back to the work it was doing.
  store.resolveRequest("session_one", "req_one", "accept");
  expect(store.getSession("session_one").activity).toBe("working");
});

test("activity is derived on read and never written to disk", () => {
  // A stored "working" outlives the worker that was working: the next process
  // to open the file would report a turn nobody is running. Every write goes
  // through `storedSession`, so the field cannot reach the document.
  const { store, root: stateRoot } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const claim = store.claimNextTurn("worker_one")!;
  store.markRunning("session_one", "run_one", claim.turn.claim!.token);
  expect(store.getSession("session_one").activity).toBe("working");

  // Force a metadata write while the turn is running, then read the raw file.
  store.updateSession("session_one", { title: "Renamed mid-turn" });
  const onDisk = JSON.parse(fs.readFileSync(path.join(stateRoot, "sessions", "session_one", "session.json"), "utf8"));
  expect("activity" in onDisk).toBe(false);
  expect("activityAt" in onDisk).toBe(false);
  expect("lastTurnEndedAt" in onDisk).toBe(false);
  expect("lastTurnFailed" in onDisk).toBe(false);
  // …and the derived answer survives the round trip unchanged.
  expect(store.getSession("session_one").activity).toBe("working");
});

test("a session reports when its last turn ended, and whether it ended badly", () => {
  // WHAT A SNOOZE NEEDS TO BE "NOT NOW" RATHER THAN "NEVER". A session can be
  // snoozed while a turn is running, so the work you deferred can finish while
  // the row is hidden — and a client with no way to notice would keep it hidden
  // until a wake time chosen before the answer existed.
  const { store } = readyStore();
  expect(store.getSession("session_one").lastTurnEndedAt).toBeUndefined();
  // Absent, never zero: no turn has ended is not "a turn ended at the epoch".
  expect(store.getSession("session_one").lastTurnFailed).toBeUndefined();

  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const first = store.claimNextTurn("worker_one")!;
  store.markRunning("session_one", "run_one", first.turn.claim!.token);
  // Still running: nothing has ended yet.
  expect(store.getSession("session_one").lastTurnEndedAt).toBeUndefined();
  store.completeTurn("session_one", "run_one", first.turn.claim!.token, { text: "Done" });

  const completed = store.getSession("session_one");
  expect(completed.lastTurnEndedAt).toBe(completed.updatedAt);
  expect(completed.lastTurnFailed).toBeUndefined();

  // A LATER FAILURE REPLACES IT, and says so — a failure is not a state the
  // session is IN (it is idle again by now), it is something that happened.
  store.submitTurn("session_one", { runId: "run_two", input: "Again" });
  const second = store.claimNextTurn("worker_one")!;
  store.markRunning("session_one", "run_two", second.turn.claim!.token);
  store.failTurn("session_one", "run_two", second.turn.claim!.token, { code: "driver_failed", message: "boom" });

  const failed = store.getSession("session_one");
  expect(failed.activity).toBe("idle");
  // THE CLOCK IN THIS FIXTURE IS FROZEN, so both turns ended at the same
  // instant — which is the interesting case, not an artefact. Real timestamps
  // are milliseconds and two turns can finish inside one; a strict `>` kept the
  // EARLIER turn, so this assertion is what found it.
  expect(failed.lastTurnEndedAt).toBe(completed.lastTurnEndedAt!);
  expect(failed.lastTurnFailed).toBe(true);
});

test("stopping a turn sweeps its sub-agents but SPARES background work", () => {
  /**
   * THE SESSION-RUNTIME CONTRACT. A sub-agent left at `running` after its turn
   * ends is a roster lie — found in real dogfood data — so the turn's own
   * agents are swept. A background task is the opposite: outliving its turn is
   * the DEFINITION of background, and since the session runtime landed a turn
   * Stop is the provider's own `interrupt()` (declared with
   * `perTaskStopAffordance`), which spares the live process and everything
   * backgrounded inside it. The pre-runtime code killed the process on stop
   * and closed background tasks here; that assumption no longer holds.
   */
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Fan out" });
  const claim = store.claimNextTurn("worker_one")!;
  const token = claim.turn.claim!.token;
  store.markRunning("session_one", "run_one", token);
  store.ingestObservations("session_one", "run_one", token, [
    { kind: "task.started", task: { id: "task_a", kind: "agent", state: "running", title: "Explore" } },
    { kind: "task.started", task: { id: "task_b", kind: "background", state: "running", title: "Tail the log" } },
  ]);
  expect(store.getSession("session_one").activity).toBe("working");

  store.stopTurn("session_one", "run_one");

  const byId = new Map(store.tasks("session_one").map((task) => [task.id, task]));
  // The turn's own agent is swept — no process is running it any more.
  expect(byId.get("task_a")).toMatchObject({ state: "failed" });
  // The background task SURVIVES the turn Stop, exactly as it survives a normal
  // turn end — the interrupt spared it.
  expect(byId.get("task_b")).toMatchObject({ state: "running" });
  expect(store.readEvents("session_one").map((event) => event.type)).toContain("task.completed");
});

test("stopBackgroundTasks ends lingering background work and queues the real kill", () => {
  /**
   * THE "N tasks still working" CHIP. A background task outlives its turn, so
   * there is no turn to stop; this verb marks it `stopped` in the projection
   * (the roster is right at once) and queues the actual process kill for the
   * worker to drain off the heartbeat.
   */
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Tail" });
  const claim = store.claimNextTurn("worker_one")!;
  const token = claim.turn.claim!.token;
  store.markRunning("session_one", "run_one", token);
  store.ingestObservations("session_one", "run_one", token, [
    {
      kind: "task.started",
      task: { id: "task_b", kind: "background", state: "running", title: "Tail the log", providerTaskId: "bqo5yo8lm" },
    },
  ]);
  store.completeTurn("session_one", "run_one", token, { text: "started" });

  // The task lingers past its completed turn — this is the feature.
  expect(store.tasks("session_one").find((t) => t.id === "task_b")).toMatchObject({ state: "running" });

  const stopped = store.stopBackgroundTasks("session_one");
  expect(stopped).toBe(1);
  expect(store.tasks("session_one").find((t) => t.id === "task_b")).toMatchObject({ state: "stopped" });

  // The real kill is queued for the worker — by PROVIDER id, the handle the
  // live CLI process knows the task by.
  const drained = store.drainStopTasks();
  expect(drained).toEqual([{ sessionId: "session_one", providerTaskId: "bqo5yo8lm" }]);
  // Drain-on-read: a second heartbeat carries nothing.
  expect(store.drainStopTasks()).toEqual([]);
});

test("a task's kind is decided once, and a later turn's partial report cannot downgrade it", () => {
  /**
   * THE CROSS-TURN CASE. `knownTasks` in the Claude seam is TURN-SCOPED, and a
   * backgrounded shell reaped at teardown is reported in the FOLLOWING turn:
   * `task_notification` with no `task_type` of its own, against a map that has
   * never heard of the task. `taskKindForType(undefined)` is "agent" by the
   * contract's denylist posture, so the seam fabricates `kind: "agent"` — it
   * has nothing better to say.
   *
   * The projection does know better, because it is the durable record. Kind is
   * a fact about what a task IS and cannot change after the report that
   * established it; letting a partial report overwrite it moved backgrounded
   * shells onto the Agents surface. Measured: four shells reaped at teardown
   * each landed under Agents, while the one stopped inside its own turn stayed
   * correctly under Processes.
   *
   * This is the same rule as `runId` and `startedAt` immediately around it —
   * the seed is folded OVER what is stored, never swapped for it.
   */
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Start the dev server" });
  const first = store.claimNextTurn("worker_one")!;
  const firstToken = first.turn.claim!.token;
  store.markRunning("session_one", "run_one", firstToken);
  store.ingestObservations("session_one", "run_one", firstToken, [
    { kind: "task.started", task: { id: "task_b", kind: "background", state: "running", title: "Start the dev server" } },
  ]);
  store.completeTurn("session_one", "run_one", firstToken, { text: "Started it" });
  expect(store.tasks("session_one").find((task) => task.id === "task_b")).toMatchObject({ kind: "background" });

  // The next turn. The seam has no memory of task_b and says "agent".
  store.submitTurn("session_one", { runId: "run_two", input: "anything" });
  const second = store.claimNextTurn("worker_one")!;
  const secondToken = second.turn.claim!.token;
  store.markRunning("session_one", "run_two", secondToken);
  store.ingestObservations("session_one", "run_two", secondToken, [
    { kind: "task.completed", task: { id: "task_b", kind: "agent", state: "completed" } },
  ]);

  // A shell does not become a delegate by being reported late.
  expect(store.tasks("session_one").find((task) => task.id === "task_b")).toMatchObject({ kind: "background" });
});

test("stop with nothing running settles lingering background work", () => {
  /**
   * THE RETROACTIVE CURE. A background task orphaned before the process-death
   * sweeps existed sits at `running` forever — the session reads "monitoring",
   * and Stop used to no-op because no turn was live. Now the press means the
   * only thing it can mean: settle whatever still claims to be working.
   */
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Watch it" });
  const claim = store.claimNextTurn("worker_one")!;
  const token = claim.turn.claim!.token;
  store.markRunning("session_one", "run_one", token);
  store.ingestObservations("session_one", "run_one", token, [
    { kind: "task.started", task: { id: "task_b", kind: "background", state: "running", title: "Tail the log" } },
  ]);
  store.completeTurn("session_one", "run_one", token, { text: "Started the watcher" });
  expect(store.getSession("session_one").activity).toBe("monitoring");

  const result = store.stopTurn("session_one");
  expect(result.stopped).toBe(true);
  const byId = new Map(store.tasks("session_one").map((task) => [task.id, task]));
  expect(byId.get("task_b")).toMatchObject({ state: "stopped", failure: "stopped from the cockpit" });
  expect(store.getSession("session_one").activity).toBe("idle");
  // A second press has nothing left to stop.
  expect(store.stopTurn("session_one").stopped).toBe(false);
});

test("a session with live background work is not idle, and says which kind", () => {
  /**
   * THE HOLE THE CONTRACT ALREADY NAMED. `TaskKind` says a background task
   * "continues after the turn that started it settles. This is why a session
   * can be 'still working' with no active turn" — and `activity` was derived
   * from the queue alone, so every one of those sessions reported `idle`. The
   * row went quiet while the work went on.
   */
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Watch it" });
  const claim = store.claimNextTurn("worker_one")!;
  const token = claim.turn.claim!.token;
  store.markRunning("session_one", "run_one", token);
  store.ingestObservations("session_one", "run_one", token, [
    { kind: "task.started", task: { id: "task_b", kind: "background", state: "running", title: "Tail the log" } },
  ]);
  store.completeTurn("session_one", "run_one", token, { text: "Started the watcher" });

  // The queue is empty and the watcher is not.
  const monitoring = store.getSession("session_one");
  expect(monitoring.activity).toBe("monitoring");
  expect(monitoring.activityAt).toBe(100);

  // A LIVE AGENT OUTRANKS IT — `livenessOf`'s own rule, applied here rather
  // than restated: a fan-out mid-flight reads as working even while a log tail
  // is also running.
  store.submitTurn("session_one", { runId: "run_two", input: "And fan out" });
  const second = store.claimNextTurn("worker_one")!;
  const secondToken = second.turn.claim!.token;
  store.markRunning("session_one", "run_two", secondToken);
  store.ingestObservations("session_one", "run_two", secondToken, [
    { kind: "task.started", task: { id: "task_c", kind: "agent", state: "running", title: "Explore" } },
  ]);
  // A background task of its own does NOT get swept, so completing the turn
  // leaves the agent closed and the watcher alive.
  store.completeTurn("session_one", "run_two", secondToken, { text: "Done" });
  expect(store.getSession("session_one").activity).toBe("monitoring");

  // And once the watcher stops, the session is genuinely idle.
  store.submitTurn("session_one", { runId: "run_three", input: "Stop it" });
  const third = store.claimNextTurn("worker_one")!;
  const thirdToken = third.turn.claim!.token;
  store.markRunning("session_one", "run_three", thirdToken);
  store.ingestObservations("session_one", "run_three", thirdToken, [
    { kind: "task.completed", task: { id: "task_b", kind: "background", state: "completed" } },
  ]);
  store.completeTurn("session_one", "run_three", thirdToken, { text: "Stopped" });
  expect(store.getSession("session_one").activity).toBe("idle");
  expect(store.getSession("session_one").activityAt).toBeUndefined();
});

test("the inbox policy is one document, defaulted rather than absent", () => {
  // THE POLICY HALF OF SETTLING. The per-session pin says "not this one"; this
  // says how long anything stays in the list at all — and it is on the engine
  // so the desktop shell and a browser tab band the same sessions the same way.
  const { store } = readyStore();
  expect(store.getInboxPolicy()).toEqual({ autoSettleAfterHours: 72 });

  expect(store.setInboxPolicy({ autoSettleAfterHours: 14 })).toEqual({ autoSettleAfterHours: 14 });
  expect(store.getInboxPolicy()).toEqual({ autoSettleAfterHours: 14 });

  // `null` IS THE OFF SWITCH, and it is a value rather than an omission:
  // "never" is an answer, not a very large duration.
  expect(store.setInboxPolicy({ autoSettleAfterHours: null })).toEqual({ autoSettleAfterHours: null });
  // An empty patch changes nothing rather than resetting anything.
  expect(store.setInboxPolicy({})).toEqual({ autoSettleAfterHours: null });

  for (const bad of [0, 90 * 24 + 1, 3.5, "7", Number.NaN]) {
    expect(() => store.setInboxPolicy({ autoSettleAfterHours: bad })).toThrow(EngineStateError);
  }
  // …and the refusal left the stored answer alone.
  expect(store.getInboxPolicy()).toEqual({ autoSettleAfterHours: null });
});

test("a days-shaped inbox document from before the hours move still means what it said", () => {
  const { store, root: stateRoot } = readyStore();
  fs.writeFileSync(path.join(stateRoot, "inbox.json"), '{"version":2,"autoSettleAfterDays":2}');
  expect(store.getInboxPolicy()).toEqual({ autoSettleAfterHours: 48 });
  fs.writeFileSync(path.join(stateRoot, "inbox.json"), '{"version":2,"autoSettleAfterDays":null}');
  expect(store.getInboxPolicy()).toEqual({ autoSettleAfterHours: null });
});

test("the standing session defaults round-trip, and refuse a mode that is not one", () => {
  // WHAT A SESSION IS BUILT WITH WHEN NOBODY SAID. `local` is what the engine
  // did before this document existed, so an install that never opens the
  // settings page behaves exactly as it always has.
  const { store } = readyStore();
  expect(store.getSessionDefaults()).toEqual({ envMode: "local" });

  expect(store.setSessionDefaults({ envMode: "worktree" })).toEqual({ envMode: "worktree" });
  expect(store.getSessionDefaults()).toEqual({ envMode: "worktree" });
  // An empty patch changes nothing rather than resetting anything.
  expect(store.setSessionDefaults({})).toEqual({ envMode: "worktree" });

  for (const bad of ["", "detached", 1, null]) {
    expect(() => store.setSessionDefaults({ envMode: bad })).toThrow(EngineStateError);
  }
  // …and the refusal left the stored answer alone.
  expect(store.getSessionDefaults()).toEqual({ envMode: "worktree" });
});

test("a malformed session-defaults document costs the preference, never the session", () => {
  // Read on the CREATE path, which is why the never-throws rule matters more
  // here than anywhere: garbage in this file must not make sessions unopenable.
  const { store, root: stateRoot } = readyStore();
  fs.writeFileSync(path.join(stateRoot, "session-defaults.json"), '{"version":1,"envMode":"elsewhere"}');
  expect(store.getSessionDefaults()).toEqual({ envMode: "local" });
  fs.writeFileSync(path.join(stateRoot, "session-defaults.json"), "not json at all");
  expect(store.getSessionDefaults()).toEqual({ envMode: "local" });
  expect(() => store.createSession({ id: "session_two", projectId: "project_one" })).not.toThrow();
});

test("a malformed inbox document costs the preference, never the sidebar", () => {
  // EVERY OTHER REGISTRY HERE REFUSES TO PARSE GARBAGE, because a malformed MCP
  // server is a server that must not run. A malformed settling window is a
  // preference, and the worst it can do is band a list wrongly.
  const { store, root: stateRoot } = readyStore();
  fs.writeFileSync(path.join(stateRoot, "inbox.json"), '{"version":1,"autoSettleAfterDays":"soon"}');
  expect(store.getInboxPolicy()).toEqual({ autoSettleAfterHours: 72 });
  fs.writeFileSync(path.join(stateRoot, "inbox.json"), "not json at all");
  expect(store.getInboxPolicy()).toEqual({ autoSettleAfterHours: 72 });
});

test("deleting a session removes everything it owns, and refuses mid-turn", () => {
  // THE OTHER END OF THE LIFECYCLE. Settling is now the only way to put a
  // session down, so the way to get rid of one has to be real — a "delete" that
  // leaves the record behind is the dishonest version of exactly the thing
  // archive was.
  const { store, root: stateRoot } = readyStore();
  const directory = path.join(stateRoot, "sessions", "session_one");
  expect(fs.existsSync(directory)).toBe(true);

  // A turn in flight refuses: the journal is still being appended to, and the
  // checkout is under a live provider process.
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  expect(() => store.deleteSession("session_one")).toThrow(EngineStateError);
  expect(fs.existsSync(directory)).toBe(true);

  // Finish the turn and it goes — metadata, queue, journal, the lot.
  const claim = store.claimNextTurn("worker_one")!;
  store.markRunning("session_one", "run_one", claim.turn.claim!.token);
  store.completeTurn("session_one", "run_one", claim.turn.claim!.token, { text: "done" });
  expect(store.deleteSession("session_one")).toBe(true);
  expect(fs.existsSync(directory)).toBe(false);
  expect(() => store.getSession("session_one")).toThrow(EngineStateError);
  // And it is gone from the list rather than lingering as an unreadable entry.
  expect(store.listSessions("project_one")).toEqual([]);
});

test("the published appearance is an opaque blob, capped, and survives a restart", () => {
  // THE STORE'S WHOLE JOB IS TO NOT UNDERSTAND THIS. The cockpit's look lives
  // in a browser's localStorage and is republished here for paired clients, so
  // the vocabulary belongs to the cockpit and grows on its release schedule.
  // What is tested is the mailbox: it holds what it was given, byte for byte,
  // and it refuses the two things that are not a look.
  const stateRoot = root();
  const store = new EngineStore(stateRoot, () => 100);

  // Nothing published yet is `null`, not a default look — a client with no
  // host to copy wears its own.
  expect(store.getAppearance()).toBeNull();

  const blob = {
    version: 1,
    accent: "sea",
    fontSize: 17,
    // A key this engine has never heard of, which is the point: an iOS client
    // shipping ahead of the engine must not need an engine release.
    somethingInventedLater: { nested: [1, 2, 3] },
    theme: { light: { background: "oklch(1 0 0)" }, dark: { background: "oklch(0.145 0 0)" } },
  };
  const written = store.setAppearance(blob);
  expect(written.blob).toEqual(blob);
  // STAMPED BY THE ENGINE, not by the publisher: the blob's own `updatedAtHint`
  // is advisory, and an ETag cut from two browsers' disagreeing clocks could
  // go backwards. What is recorded is when THIS engine accepted the write.
  expect(written.updatedAt).toBeGreaterThan(0);
  expect(store.getAppearance()).toEqual({ updatedAt: written.updatedAt, blob });

  // A SNAPSHOT, NOT A PATCH: the second publish replaces the first outright,
  // because two merged halves would describe a look nobody is wearing.
  store.setAppearance({ accent: "rose" });
  expect(store.getAppearance()?.blob).toEqual({ accent: "rose" });

  // Not an object is not a look.
  expect(() => store.setAppearance([1, 2, 3])).toThrow(EngineStateError);
  expect(() => store.setAppearance("indigo")).toThrow(EngineStateError);
  expect(() => store.setAppearance(null)).toThrow(EngineStateError);

  // THE CAP MOVED UP AND CHANGED ITS MEANING. It used to forbid an inlined
  // wallpaper at 64 KB; a published look now IS a whole Look and legitimately
  // carries its backdrop's pixels, so a megabyte of image rides through and
  // only the absurd is refused.
  const wallpaper = { look: { backdrop: { image: `data:image/webp;base64,${"A".repeat(2 * 1024 * 1024)}` } } };
  expect(store.setAppearance(wallpaper).blob).toEqual(wallpaper);
  expect(() => store.setAppearance({ wallpaper: "x".repeat(9 * 1024 * 1024) })).toThrow(EngineStateError);
  // …and the refusal left the last good publish alone.
  expect(store.getAppearance()?.blob).toEqual(wallpaper);

  // Cleared is `null` again, and clearing twice is not an error: "nothing is
  // published" is the state the caller asked for either way.
  store.clearAppearance();
  expect(store.getAppearance()).toBeNull();
  store.clearAppearance();
  expect(store.getAppearance()).toBeNull();

  // On disk, so a restarted engine still answers a phone that pairs tomorrow.
  store.setAppearance({ accent: "rose" });
  expect(new EngineStore(stateRoot, () => 100).getAppearance()?.blob).toEqual({ accent: "rose" });

  // Same never-throws rule as the policies: a corrupt file costs the
  // decoration, never the request that asked for it.
  fs.writeFileSync(path.join(stateRoot, "appearance.json"), "not json at all");
  expect(store.getAppearance()).toBeNull();
});
