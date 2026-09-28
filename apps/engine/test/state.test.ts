import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Turn } from "@telar/engine-client";
import { acquireDaemonLock, EngineStateError, EngineStore, migrateLegacyEngineRoot, engineRootFromEnv } from "../src/state";
import { statePaths } from "../src/platform/fs/state-paths";
import type { ExecutionStore } from "../src/platform/db/execution-store";

const roots: string[] = [];
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-engine-"));
  roots.push(directory);
  return knownClaudeDefault(directory);
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

const documents = (store: EngineStore) => (store as unknown as { kernel: { executionStore: ExecutionStore } }).kernel.executionStore;

// Rewrites a stored session_one document, as an older build left it.
function editDocument(store: EngineStore, stateRoot: string, name: string, edit: (value: any) => void): void {
  const file = path.join(stateRoot, "sessions", "session_one", name);
  const value = documents(store).read(file);
  edit(value);
  documents(store).write(file, value);
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

test("the event cursor is the last journal id", () => {
  const { store } = readyStore();
  expect(store.eventCursor("session_one")).toBe(1); // session.created
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  store.stopTurn("session_one", "run_one");
  expect(store.eventCursor("session_one")).toBe(store.readEvents("session_one").at(-1)!.id);
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
  expect(first.page).toEqual({ before: "run_4", more: true, total: 6 });
  // Items follow their turns — the window is what makes the read small.
  expect(first.items.map((item) => item.id).sort()).toEqual(["i_4", "i_5"]);

  const older = store.snapshotWindow("session_one", { limit: 2, before: "run_4" });
  expect(older.turns.map((turn) => turn.runId)).toEqual(["run_2", "run_3"]);
  expect(older.page).toEqual({ before: "run_2", more: true, total: 6 });

  const oldest = store.snapshotWindow("session_one", { limit: 2, before: "run_2" });
  expect(oldest.turns.map((turn) => turn.runId)).toEqual(["run_1"]);
  expect(oldest.page).toEqual({ before: null, more: false, total: 6 });

  // A limit past the start is the whole history, first page, no cursor.
  const whole = store.snapshotWindow("session_one", { limit: 50 });
  expect(whole.turns).toHaveLength(6);
  expect(whole.page).toEqual({ before: null, more: false, total: 6 });

  expect(() => store.snapshotWindow("session_one", { limit: 2, before: "run_nope" })).toThrow(EngineStateError);
});

test("a windowed snapshot carries the window's requests and every open one, not the whole history", () => {
  // THE KEY THAT USED TO IGNORE THE WINDOW. On the dogfood store this was 549
  // requests / 315 KB per read, of which 44 were in the window and none were
  // unresolved — re-read every second by every open cockpit.
  const stateRoot = root();
  const store = new EngineStore(stateRoot, () => 100);
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  store.createSession({ id: "session_one", projectId: "project_one", detached: false });

  for (const n of [1, 2, 3, 4, 5]) {
    const runId = `run_${n}`;
    store.submitTurn("session_one", { runId, input: `Turn ${n}` });
    const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
    store.markRunning("session_one", runId, token);
    store.openRequest("session_one", runId, token, {
      requestId: `req_${n}`,
      kind: "command_execution",
      detail: { kind: "command_execution", command: { command: `echo ${n}` } },
    });
    store.resolveRequest("session_one", `req_${n}`, { decision: "accept" });
    store.completeTurn("session_one", runId, token, { text: `Answer ${n}` });
  }
  // …and one still running, holding the question nobody has answered.
  store.submitTurn("session_one", { runId: "run_live", input: "Now" });
  const liveToken = store.claimTurn("session_one", "worker_one")!.claim!.token;
  store.markRunning("session_one", "run_live", liveToken);
  store.openRequest("session_one", "run_live", liveToken, {
    requestId: "req_open",
    kind: "command_execution",
    detail: { kind: "command_execution", command: { command: "rm -rf build" } },
  });

  const first = store.snapshotWindow("session_one", { limit: 2 });
  expect(first.requests.map((request) => request.id)).toEqual(["req_4", "req_5", "req_open"]);

  // An older page drops the newer turns' settled requests — but NOT the open
  // one: a client replaces this key rather than merging it, so a question left
  // off a page is a question the composer stops being able to answer.
  const older = store.snapshotWindow("session_one", { limit: 2, before: "run_4" });
  expect(older.requests.map((request) => request.id)).toEqual(["req_2", "req_3", "req_open"]);

  // The unwindowed read is unchanged: everything the session ever opened.
  expect(store.requests("session_one")).toHaveLength(6);
});

test("streamed deltas journal without rewriting the item projection, and the close still lands", () => {
  /**
   * A `content.delta` deliberately does not touch the projection — the text is
   * folded in when the item closes — and yet every batch rewrote the whole
   * document anyway, which on a long session is hundreds of kilobytes
   * re-serialised per streamed token-chunk. This pins BOTH halves: the deltas
   * write nothing, and the close still writes the text a reader opening the
   * session later depends on.
   */
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
  store.markRunning("session_one", "run_one", token);
  store.ingestObservations("session_one", "run_one", token, [
    { kind: "item.started", item: { id: "i_1", detail: { type: "assistant_message", text: "" } } },
  ]);

  const upserts = spyOn(documents(store), "upsertItems");
  const texts = spyOn(documents(store), "writeText");
  const projectionWrites = () => upserts.mock.calls.length + texts.mock.calls.filter(([file]) => file.endsWith("items.json")).length;
  try {
    for (const text of ["hel", "lo ", "there"]) {
      store.ingestObservations("session_one", "run_one", token, [
        { kind: "content.delta", itemId: "i_1", stream: "assistant_text", text },
      ]);
    }
    expect(projectionWrites()).toBe(0);

    store.ingestObservations("session_one", "run_one", token, [
      { kind: "item.completed", itemId: "i_1", status: "completed", detail: { type: "assistant_message", text: "hello there" } },
    ]);
    expect(projectionWrites()).toBe(1);
  } finally {
    upserts.mockRestore();
    texts.mockRestore();
  }

  // The deltas are still durable, and the projection carries the folded text —
  // read back through a path that does not share the writer's copy.
  expect(store.readEvents("session_one").filter((event) => event.type === "content.delta")).toHaveLength(3);
  expect(store.items("session_one").map((item) => item.detail)).toEqual([{ type: "assistant_message", text: "hello there" }]);
});

test("the cached item projection is per session and never outlives a write", () => {
  // The cache is what makes the read above cheap; a stale one would serve a
  // closed item as still open, or one session's rows to another.
  const { store } = readyStore();
  store.createSession({ id: "session_two", projectId: "project_one" });
  const open = (sessionId: string, runId: string, itemId: string): string => {
    store.submitTurn(sessionId, { runId, input: "Hello" });
    const token = store.claimTurn(sessionId, `worker_${sessionId}`)!.claim!.token;
    store.markRunning(sessionId, runId, token);
    store.ingestObservations(sessionId, runId, token, [
      { kind: "item.started", item: { id: itemId, detail: { type: "assistant_message", text: "" } } },
    ]);
    return token;
  };
  const oneToken = open("session_one", "run_one", "i_one");
  const twoToken = open("session_two", "run_two", "i_two");

  // Interleaved, so a cache keyed by anything but the session would cross them.
  store.ingestObservations("session_one", "run_one", oneToken, [{ kind: "content.delta", itemId: "i_one", stream: "assistant_text", text: "a" }]);
  store.ingestObservations("session_two", "run_two", twoToken, [{ kind: "content.delta", itemId: "i_two", stream: "assistant_text", text: "b" }]);
  store.ingestObservations("session_one", "run_one", oneToken, [{ kind: "item.completed", itemId: "i_one", status: "completed", detail: { type: "assistant_message", text: "a" } }]);

  expect(store.items("session_one").map((item) => [item.id, item.status])).toEqual([["i_one", "completed"]]);
  expect(store.items("session_two").map((item) => [item.id, item.status])).toEqual([["i_two", "inProgress"]]);
});

test("stop is durable and idempotent", () => {
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  expect(store.stopTurn("session_one", "run_one").stopped).toBe(true);
  expect(store.turns("session_one")[0]?.state).toBe("stopped");
  expect(store.stopTurn("session_one", "run_one").stopped).toBe(false);
  expect(store.readEvents("session_one").at(-1)?.type).toBe("turn.stopped");
});

test("a stopped turn closes the tool row it was inside; a background task is left alone", () => {
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
  store.markRunning("session_one", "run_one", token);
  store.ingestObservations("session_one", "run_one", token, [
    { kind: "item.started", item: { id: "shell", detail: { type: "command_execution", command: { command: "sleep 60" } }, title: "sleep 60" } },
    { kind: "item.started", item: { id: "done", detail: { type: "assistant_message", text: "ok" } } },
    { kind: "item.completed", itemId: "done", status: "completed" },
    { kind: "task.started", task: { id: "task_bg", kind: "background", state: "running", title: "watch", backgrounded: true } },
  ]);
  expect(store.stopTurn("session_one", "run_one").stopped).toBe(true);

  const byId = new Map(store.items("session_one").map((item) => [item.id, item]));
  expect(byId.get("shell")).toMatchObject({ status: "failed", completedAt: 100 });
  expect(byId.get("done")?.status).toBe("completed");
  expect(store.tasks("session_one").find((task) => task.id === "task_bg")?.state).toBe("running");
  const closes = store.readEvents("session_one").filter((event) => event.type === "item.completed" && event.item.id === "shell");
  expect(closes).toHaveLength(1);
  // Idempotent: a second sweep finds nothing open.
  expect(store.recover()).toEqual({ stopped: [] });
  expect(store.readEvents("session_one").filter((event) => event.type === "item.completed" && event.item.id === "shell")).toHaveLength(1);
});

test("a turn that fails while parked on a question retires the question; the session is idle and recoverable", () => {
  // Reproduced live: the provider CLI was killed while inside AskUserQuestion.
  // The turn failed, but the request stayed open — sidebar "Waiting on you",
  // composer in answer mode, continuation unreachable.
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Write a checkpoint then wait" });
  const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
  store.markRunning("session_one", "run_one", token);
  const asked = store.openRequest("session_one", "run_one", token, {
    requestId: "req_question",
    kind: "user_input",
    detail: { kind: "user_input", prompt: "Wait or continue?", fields: [{ key: "choice", label: "Choice", kind: "choice", choices: ["Wait", "Continue"] }] },
  });
  expect(asked.state).toBe("open");
  expect(store.getSession("session_one").activity).toBe("blocked");

  store.failTurn("session_one", "run_one", token, { code: "driver_failed", message: "Claude Code process terminated by signal SIGKILL" });

  const request = store.requests("session_one").find((candidate) => candidate.id === "req_question");
  expect(request).toMatchObject({ state: "resolved", decision: "cancel", resolvedBy: "cancelled", resolvedAt: 100 });
  expect(store.getSession("session_one")).toMatchObject({ activity: "idle", lastTurnFailed: true });
  expect(store.readEvents("session_one").filter((event) => event.type === "request.resolved" && event.requestId === "req_question")).toHaveLength(1);
  // Nothing left for a human to answer — and answering again is refused.
  expect(() => store.resolveRequest("session_one", "req_question", { decision: "accept" })).toThrow(/already been resolved/);
  // The next human turn is accepted: the session is not stuck behind the question.
  expect(store.submitTurn("session_one", { runId: "run_two", input: "Keep the existing checkpoint." }).turn.state).toBe("queued");
});

test("a request left open on an already-ended turn is retired at boot; one on an ambiguous turn is kept", () => {
  // Persisted histories from before requests were retired with their turn.
  const { store, root: stateRoot } = readyStore();
  store.updateSession("session_one", { runtimeMode: "approval-required" });
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
  store.markRunning("session_one", "run_one", token);
  store.openRequest("session_one", "run_one", token, {
    requestId: "req_stale",
    kind: "command_execution",
    detail: { kind: "command_execution", command: { command: "sleep 180" } },
  });
  // Fail the turn behind the store's back, as an older build did: the
  // request stays open on disk beside a failed turn.
  editDocument(store, stateRoot, "queue.json", (queue) => {
    Object.assign(queue.turns[0], { state: "failed", completedAt: 90, failure: { code: "driver_failed", message: "old build" } });
  });
  store.closeExecutionStore();

  const reopened = new EngineStore(stateRoot, () => 200);
  // Read alone already refuses to call the session blocked...
  expect(reopened.getSession("session_one").activity).toBe("idle");
  // ...and the boot sweep retires the request durably.
  reopened.recover();
  expect(reopened.requests("session_one")[0]).toMatchObject({ id: "req_stale", state: "resolved", resolvedBy: "cancelled", resolvedAt: 200 });
  expect(reopened.recover()).toEqual({ stopped: [] });
  expect(reopened.readEvents("session_one").filter((event) => event.type === "request.resolved")).toHaveLength(1);

  /**
   * A TURN THE RESTART INTERRUPTED IS STOPPED, AND ITS REQUEST RETIRED WITH IT.
   *
   * Both halves used to be a decision the person had to make: the turn became
   * `ambiguous` and its question stayed open, holding the session `blocked`.
   * Stop is stop, including when a restart is what stopped it — so the turn is
   * terminal and the question, which no answer can now reach, is cancelled.
   */
  const other = readyStore().store;
  other.updateSession("session_one", { runtimeMode: "approval-required" });
  other.submitTurn("session_one", { runId: "run_amb", input: "Hello" });
  const ambToken = other.claimTurn("session_one", "worker_one")!.claim!.token;
  other.markRunning("session_one", "run_amb", ambToken);
  other.openRequest("session_one", "run_amb", ambToken, {
    requestId: "req_amb",
    kind: "command_execution",
    detail: { kind: "command_execution", command: { command: "ls" } },
  });
  expect(other.recover()).toEqual({ stopped: ["run_amb"] });
  // Retired on the FIRST boot: the turn was still `running` when the request
  // sweep passed over it, so closing it only there would have cured this on no
  // boot at all.
  expect(other.requests("session_one")[0]).toMatchObject({ state: "resolved", resolvedBy: "cancelled" });
  expect(other.getSession("session_one").activity).not.toBe("blocked");
  // AND THE TURN IS DONE — terminal, with why it ended, and asking nobody for
  // a decision. Its text and items stay exactly where they were.
  expect(other.turns("session_one")[0]).toMatchObject({ state: "stopped", stopReason: "engine_restart", input: "Hello" });
  // Nothing to resume and nothing to discard: the next message just runs.
  expect(other.submitTurn("session_one", { runId: "run_next", input: "carry on" }).turn.state).toBe("queued");
  expect(other.claimTurn("session_one", "worker_two")?.runId).toBe("run_next");
});

test("a restart STOPS what it interrupted — claimed and running alike — and asks nobody to decide", () => {
  /**
   * A restart is a stop. This used to be two different endings that both
   * needed a person: merely-claimed work went back to `queued` and ran again
   * on its own (replay nobody asked for), and running work became `ambiguous`
   * and blocked the session until somebody pressed Continue or Discard.
   */
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "claimed_turn", input: "Hello" });
  expect(store.claimTurn("session_one", "worker_one")?.state).toBe("claimed");
  expect(store.recover()).toEqual({ stopped: ["claimed_turn"] });
  // NOT requeued. Going back to `queued` is what made a restart re-run work.
  expect(store.turns("session_one")[0]).toMatchObject({ state: "stopped", stopReason: "engine_restart" });

  // And the same for work that had actually started.
  const { store: second } = readyStore();
  second.submitTurn("session_one", { runId: "running_turn", input: "Hello" });
  const claimed = second.claimTurn("session_one", "worker_one")!;
  second.markRunning("session_one", "running_turn", claimed.claim!.token);
  expect(second.recover()).toEqual({ stopped: ["running_turn"] });
  expect(second.turns("session_one")[0]).toMatchObject({ state: "stopped", stopReason: "engine_restart" });

  // THE NEXT MESSAGE JUST RUNS. No decision gate, no discard first.
  expect(second.submitTurn("session_one", { runId: "later_turn", input: "carry on from what you have" }).turn.state).toBe("queued");
  expect(second.claimTurn("session_one", "worker_two")?.runId).toBe("later_turn");
  // Nothing is announced as ambiguous, because nothing is.
  expect(second.readEvents("session_one").filter((event) => event.type === "turn.ambiguous")).toEqual([]);
  expect(second.readEvents("session_one").filter((event) => event.type === "turn.stopped" && event.runId === "running_turn")).toHaveLength(1);
});

test("the boot sweep closes every terminal turn's leftovers in one pass over each document", () => {
  /**
   * THE SWEEP IS PER SESSION, NOT PER TURN, and this is the property that makes
   * that safe. `recover()` used to call the item/request/task closers once per
   * terminal turn, and each call re-read that session's whole document: on a
   * real store (114 sessions, 1471 terminal turns, items averaging 577 KB) that
   * was 15.7 s of a 21 s engine start, and the desktop shell shows no window
   * until the engine answers `/v2/health`.
   *
   * Batched by run id, the outcome has to be identical — every turn's leftovers
   * closed, one event each, nothing belonging to a turn that is still live.
   */
  const { store, root: stateRoot } = readyStore();
  // Otherwise the policy answers each request the moment it is asked, and there
  // is nothing left open for the sweep to retire.
  store.updateSession("session_one", { runtimeMode: "approval-required" });
  for (const runId of ["run_a", "run_b", "run_c"]) {
    store.submitTurn("session_one", { runId, input: `work ${runId}` });
    const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
    store.markRunning("session_one", runId, token);
    store.ingestObservations("session_one", runId, token, [
      { kind: "item.started", item: { id: `item_${runId}`, detail: { type: "command_execution", command: { command: "sleep 60" } }, title: "sleep 60" } },
      { kind: "task.started", task: { id: `task_${runId}`, kind: "agent", state: "running", title: "helper" } },
    ]);
    store.openRequest("session_one", runId, token, {
      requestId: `req_${runId}`,
      kind: "command_execution",
      detail: { kind: "command_execution", command: { command: "sleep 180" } },
    });
    // End each turn behind the store's back, the way an older build's crash
    // left them: terminal on disk with its rows still open.
    editDocument(store, stateRoot, "queue.json", (queue) => {
      const turn = queue.turns.find((candidate: Turn) => candidate.runId === runId);
      Object.assign(turn, { state: "failed", completedAt: 90, failure: { code: "driver_failed", message: "old build" } });
    });
  }
  store.closeExecutionStore();

  const reopened = new EngineStore(stateRoot, () => 300);
  reopened.recover();

  // Every turn's item, task and request — not just the last one's.
  for (const runId of ["run_a", "run_b", "run_c"]) {
    expect(reopened.items("session_one").find((item) => item.id === `item_${runId}`)).toMatchObject({ status: "failed", completedAt: 300 });
    expect(reopened.tasks("session_one").find((task) => task.id === `task_${runId}`)).toMatchObject({ state: "failed" });
    expect(reopened.requests("session_one").find((request) => request.id === `req_${runId}`)).toMatchObject({ state: "resolved", resolvedBy: "cancelled", resolvedAt: 300 });
  }
  // One event each, and the run id on each event is the turn's own — a batched
  // sweep must not attribute one turn's closure to another.
  for (const runId of ["run_a", "run_b", "run_c"]) {
    const closures = reopened.readEvents("session_one").filter((event) => event.type === "item.completed" && event.item.id === `item_${runId}`);
    expect(closures).toHaveLength(1);
    expect(closures[0]!.runId).toBe(runId);
  }
  // Idempotent: a second boot finds nothing open.
  expect(reopened.recover()).toEqual({ stopped: [] });
  expect(reopened.readEvents("session_one").filter((event) => event.type === "request.resolved")).toHaveLength(3);
});

test("a fresh message needs no discard first — there is nothing to decide", () => {
  /**
   * `discardAmbiguousTurn` was the human's half of the recovery gate: the
   * interrupted turn sat `ambiguous`, blocking dispatch, until somebody chose
   * Discard. A restart is a stop now, so the turn is already terminal and the
   * verb has nothing to act on. Kept as an API for old clients; it refuses,
   * rather than pretending to settle something.
   */
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "uncertain_run", input: "Hello" });
  const claimed = store.claimTurn("session_one", "worker_one");
  store.markRunning("session_one", "uncertain_run", claimed!.claim!.token);
  store.recover();

  expect(store.turns("session_one")[0]).toMatchObject({ state: "stopped", stopReason: "engine_restart" });
  expect(() => store.discardAmbiguousTurn("session_one", "uncertain_run")).toThrow(EngineStateError);

  // The next message is accepted and claimable with no gesture in between.
  expect(store.submitTurn("session_one", { runId: "fresh_run", input: "Hello" })).toMatchObject({
    replayed: false,
    turn: { runId: "fresh_run", state: "queued" },
  });
  expect(store.turns("session_one").map((turn) => [turn.runId, turn.state])).toEqual([
    ["uncertain_run", "stopped"],
    ["fresh_run", "queued"],
  ]);
  expect(store.claimTurn("session_one", "worker_two")?.runId).toBe("fresh_run");
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

test("a report against a SETTLED turn is a typed conflict that says the turn ended, not a claim mix-up", () => {
  /**
   * THE RACE WINDOW CAN NEVER BE FULLY ZERO: a provider tool call can land
   * moments after its turn settles. What the store owes that caller is a
   * TYPED refusal a worker can key off (`conflict` — the code its settle
   * paths already treat as "drop, don't fail the turn") with a message that
   * reads as LATE, so the daemon log diagnoses the premature-completion bug
   * instead of suggesting a foreign worker stole the claim. The terminal turn
   * itself stays immutable — nothing is accepted, nothing lands after
   * `turn.completed`.
   */
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const claimed = store.claimTurn("session_one", "worker_one")!;
  const token = claimed.claim!.token;
  store.markRunning("session_one", "run_one", token);
  store.completeTurn("session_one", "run_one", token, { text: "done" });

  const late = () =>
    store.ingestObservations("session_one", "run_one", token, [
      { kind: "item.started", item: { id: "i_late", detail: { type: "command_execution", command: { command: "echo late" } } } },
    ]);
  expect(late).toThrow(EngineStateError);
  expect(late).toThrow(/already settled \(completed\)/);
  try {
    late();
  } catch (error) {
    expect(error).toBeInstanceOf(EngineStateError);
    expect((error as EngineStateError).code).toBe("conflict");
  }
  // Refused means refused: the settled turn's journal gained nothing.
  expect(store.items("session_one").some((item) => item.id === "i_late")).toBe(false);

  // A WRONG token against the same settled turn stays the generic claim
  // refusal — "settled" is only claimed for the worker that really ran it.
  expect(() =>
    store.ingestObservations("session_one", "run_one", "not-the-token-at-all", [
      { kind: "item.started", item: { id: "i_late", detail: { type: "assistant_message", text: "" } } },
    ]),
  ).toThrow(/not running under this worker claim/);
});

test("the backlog is bounded, and an interrupted turn holds no dispatch at all", () => {
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "First" });
  const claimed = store.claimTurn("session_one", "worker_one")!;
  store.markRunning("session_one", "run_one", claimed.claim!.token);

  // A runaway client with a fresh runId each time would otherwise grow
  // queue.json without bound, and the queue is rewritten whole per transition.
  for (let i = 0; i < 16; i += 1) store.submitTurn("session_one", { runId: `run_q${i}`, input: "more" });
  expect(() => store.submitTurn("session_one", { runId: "run_over", input: "one too many" })).toThrow(/maximum number of queued/);

  // AND NOTHING WAITS ON A DECISION. An interrupted turn used to hold the
  // session's dispatch until a human chose; it is terminal now, so the next
  // message is claimed as soon as it is written.
  const { store: other } = readyStore();
  other.submitTurn("session_one", { runId: "run_a", input: "First" });
  const lost = other.claimTurn("session_one", "worker_one")!;
  other.markRunning("session_one", "run_a", lost.claim!.token);
  other.recover();
  expect(other.submitTurn("session_one", { runId: "run_b", input: "next" }).turn.state).toBe("queued");
  expect(other.claimTurn("session_one", "worker_two")?.runId).toBe("run_b");
});

test("work queued BEFORE the crash is STOPPED, not replayed and not held", () => {
  /**
   * The guarantee this has always been about is NO REPLAY, and it used to be
   * bought with a hold: a message written before the crash was marked
   * `engine_restart` and waited for a human to re-read it, because running it
   * against the resumed provider conversation could repeat a side effect.
   *
   * It is bought by ending it instead. Nothing waits on a person, nothing runs
   * on its own, and the words stay in the transcript where they can be read
   * and sent again if they are still wanted.
   */
  const { store, root: stateRoot } = readyStore();
  store.submitTurn("session_one", { runId: "run_lost", input: "Refactor" });
  const claim = store.claimTurn("session_one", "worker_one")!;
  store.markRunning("session_one", "run_lost", claim.claim!.token);
  // One written while the turn ran (steered) and one plain queued behind it.
  store.submitTurn("session_one", { runId: "run_steered", input: "and the tests" });
  expect(store.turns("session_one").find((turn) => turn.runId === "run_steered")?.state).toBe("steering");

  const rebooted = new EngineStore(stateRoot, () => 200);
  expect(rebooted.recover().stopped.sort()).toEqual(["run_lost", "run_steered"]);
  for (const runId of ["run_lost", "run_steered"]) {
    const turn = rebooted.turns("session_one").find((candidate) => candidate.runId === runId)!;
    expect(turn).toMatchObject({ state: "stopped", stopReason: "engine_restart" });
    // Not held: a hold is a question, and there is no question.
    expect(turn.held).toBeUndefined();
  }
  // THE TEXT SURVIVES. Nothing is deleted by being cancelled.
  expect(rebooted.turns("session_one").find((turn) => turn.runId === "run_steered")?.input).toBe("and the tests");
  // Nothing dispatches on its own — there is nothing left to dispatch.
  expect(rebooted.claimNextTurn("worker_two")).toBeUndefined();
});

test("a restart settles ONLY the sessions that had work — others are untouched", () => {
  // `recover()` walks every session, and an earlier draft of this sweep read a
  // cross-session accumulator, which would have swept the queue of every
  // session processed after the first unlucky one.
  const stateRoot = root();
  const store = new EngineStore(stateRoot, () => 100);
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  store.createSession({ id: "session_lost", projectId: "project_one" });
  store.createSession({ id: "session_fine", projectId: "project_one" });
  store.submitTurn("session_lost", { runId: "run_lost", input: "Refactor" });
  const claim = store.claimTurn("session_lost", "worker_one")!;
  store.markRunning("session_lost", "run_lost", claim.claim!.token);
  store.submitTurn("session_lost", { runId: "run_behind", input: "before the crash" });
  store.submitTurn("session_fine", { runId: "run_untouched", input: "nothing happened here" });

  const rebooted = new EngineStore(stateRoot, () => 200);
  const { stopped } = rebooted.recover();
  /**
   * EVERY SESSION'S PENDING WORK IS SETTLED, the idle one's included: a
   * message queued before a restart is work that never started, and starting
   * it now would be the app deciding on its own to run something the person
   * wrote before it went away. Isolation here is about the JOURNAL, not about
   * exemption — each session records only its own runIds.
   */
  expect(stopped.sort()).toEqual(["run_behind", "run_lost", "run_untouched"]);
  expect(rebooted.turns("session_fine")[0]).toMatchObject({ runId: "run_untouched", state: "stopped", stopReason: "engine_restart" });
  // Nothing runs by itself afterwards, in either session.
  expect(rebooted.claimNextTurn("worker_two")).toBeUndefined();
  // AND NEITHER SESSION CARRIES THE OTHER'S EVENTS. An earlier draft of this
  // sweep journalled a cross-session accumulator, which wrote the first
  // session's stops onto every session walked after it.
  const stops = (id: string) => rebooted.readEvents(id).filter((event) => event.type === "turn.stopped").map((event) => event.runId).sort();
  expect(stops("session_lost")).toEqual(["run_behind", "run_lost"]);
  expect(stops("session_fine")).toEqual(["run_untouched"]);
});

test("a fresh message continues the conversation from the provider cursor, never replaying the lost prompt", () => {
  // What the cockpit's Continue used to drive, now with no gesture at all: say
  // something NEW and it resumes the same provider thread. The transcript and
  // the cursor both survive, and the original prompt is never resent.
  const { store, root: stateRoot } = readyStore();
  store.submitTurn("session_one", { runId: "run_lost", input: "Refactor the parser and run the tests" });
  const claim = store.claimTurn("session_one", "worker_one")!;
  store.markRunning("session_one", "run_lost", claim.claim!.token);
  store.ingestObservations("session_one", "run_lost", claim.claim!.token, [
    { kind: "provider.session", providerSessionId: "provider-thread-abc" },
    { kind: "item.started", item: { id: "msg_1", detail: { type: "assistant_message", text: "Reading the parser…" } } },
    { kind: "item.completed", itemId: "msg_1", status: "completed" },
  ]);

  const rebooted = new EngineStore(stateRoot, () => 200);
  rebooted.recover();
  rebooted.submitTurn("session_one", { runId: "run_next", input: "What did you find?" });
  const claimed = rebooted.claimNextTurn("worker_two");

  expect(claimed?.turn.input).toBe("What did you find?");
  expect(claimed?.resumeCursor).toBe("provider-thread-abc");
  // The lost run stays in the record, and so does everything it streamed.
  expect(rebooted.turns("session_one")[0]).toMatchObject({ runId: "run_lost", state: "stopped", stopReason: "engine_restart" });
  expect(rebooted.items("session_one").map((item) => item.id)).toContain("msg_1");
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
  editDocument(store, stateRoot, "queue.json", (queue) => { queue.version = 1; });
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

test("stale lock recovery uses exclusive replacement and never removes a newly held lock", () => {
  const stateRoot = root();
  const paths = statePaths(stateRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: -1, token: "dead" }));
  const first = acquireDaemonLock(paths);
  expect(() => acquireDaemonLock(paths)).toThrow(/already locked/);
  first.release();
});

/**
 * ISSUE #894. The pid is the only thing a person can act on, and until this it
 * was nowhere: the engine threw "engine state root is already locked", the
 * desktop turned any engine exit into a silent `app.quit()`, and the owner got
 * a Telar that opened and closed again with nothing on screen. `main.ts` prints
 * this message beside the lock's path and the shell puts the pid in the dialog,
 * so it has to be IN the message rather than only in the file.
 */
test("a live owner's refusal names the pid holding the lock", () => {
  const stateRoot = root();
  const paths = statePaths(stateRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  // This process: alive by construction, so `processExists` is true for the
  // one pid this test can be certain about.
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, token: "live", hostname: os.hostname() }));
  expect(() => acquireDaemonLock(paths)).toThrow(new RegExp(`already locked \\(pid ${process.pid}\\)`));
  // The lock is still whole: refusing must not have broken what it named.
  expect(JSON.parse(fs.readFileSync(paths.lock, "utf8")).token).toBe("live");
  fs.unlinkSync(paths.lock);
});

test("the live-owner refusal and the other-machine one stay distinguishable", () => {
  /**
   * `/locked by/` is how the #630 test below tells the cross-host refusal from
   * every other one. A live-owner message spelled "already locked by pid N"
   * would satisfy that regex too and quietly make it vacuous — a marker both
   * states emit is not a marker. The spelling is `(pid N)` for that reason,
   * and this is the assertion that keeps it so.
   */
  const stateRoot = root();
  const paths = statePaths(stateRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, token: "live", hostname: os.hostname() }));
  let live = "";
  try { acquireDaemonLock(paths); } catch (error) { live = (error as Error).message; }
  fs.unlinkSync(paths.lock);

  fs.writeFileSync(paths.lock, JSON.stringify({ pid: -1, token: "elsewhere", hostname: `${os.hostname()}-other` }));
  let elsewhere = "";
  try { acquireDaemonLock(paths); } catch (error) { elsewhere = (error as Error).message; }

  expect(live).toMatch(/already locked/);
  expect(live).not.toMatch(/locked by/);
  expect(elsewhere).toMatch(/locked by/);
  expect(elsewhere).not.toMatch(/already locked/);
});

/**
 * ISSUE #630. A store on a removable volume can be carried to a second Mac, so
 * "is that pid alive?" stops being a sound staleness test: pids are small
 * integers every machine hands out from the same range, and the one recorded by
 * a daemon still running over there is very likely dead here. Breaking that
 * lock puts two daemons on one store.
 */
test("a lock written by another machine is held, not stale, however dead its pid looks here", () => {
  const stateRoot = root();
  const paths = statePaths(stateRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  // A pid that cannot exist, which is exactly what makes this the dangerous
  // case: every local test says the owner is gone.
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: -1, token: "elsewhere", hostname: `${os.hostname()}-other` }));
  expect(() => acquireDaemonLock(paths)).toThrow(/locked by/);
  // And it is still there afterwards: refusing must not have broken it.
  expect(JSON.parse(fs.readFileSync(paths.lock, "utf8")).token).toBe("elsewhere");
});

test("a lock from before hostnames were compared is still reclaimable when its pid is gone", () => {
  const stateRoot = root();
  const paths = statePaths(stateRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: -1, token: "old" }));
  const lock = acquireDaemonLock(paths);
  expect(lock.token).not.toBe("old");
  lock.release();
});

test("this machine's own stale lock is still reclaimed", () => {
  const stateRoot = root();
  const paths = statePaths(stateRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: -1, token: "dead", hostname: os.hostname() }));
  const lock = acquireDaemonLock(paths);
  expect(lock.token).not.toBe("dead");
  lock.release();
});

test("concurrent stale-lock breakers elect exactly one replacement owner", async () => {
  const stateRoot = root();
  const paths = statePaths(stateRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: -1, token: "dead" }));
  const source = path.resolve(import.meta.dir, "../src/state.ts");
  const program = `import { acquireDaemonLock } from ${JSON.stringify(source)}; import { statePaths } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/platform/fs/state-paths.ts"))};
const lock = acquireDaemonLock(statePaths(${JSON.stringify(stateRoot)}));
setTimeout(() => { lock.release(); process.exit(0); }, 1_000);`;
  const left = Bun.spawn([process.execPath, "-e", program], { stdout: "ignore", stderr: "ignore" });
  const right = Bun.spawn([process.execPath, "-e", program], { stdout: "ignore", stderr: "ignore" });
  const statuses = await Promise.all([left.exited, right.exited]);
  expect(statuses.sort()).toEqual([0, 1]);
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
  // As named: a bare id is the standard-window row, a choice in its own right.
  expect(store.claimNextTurn("worker_one")?.model?.model).toBe("claude-opus-5");
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

test("a file patch cannot be asked for outside the session's own workspace", () => {
  // `git diff -- <path>` takes a pathspec, and `../../` in one is how a client
  // asks to read a file it was never offered. Fenced in the store rather than at
  // the route, so an in-process caller cannot walk past it either.
  const store = new EngineStore(root(), () => 100, { git: () => ({ status: 0, stdout: "", stderr: "" }) });
  store.registerProject({ id: "project_one", name: "One", root: fs.realpathSync.native(root()) });
  store.createSession({ id: "session_one", projectId: "project_one" });
  expect(() => store.sessionFilePatchAsync("session_one", "../../etc/passwd")).toThrow(EngineStateError);
  expect(() => store.sessionFilePatchAsync("session_one", "  ")).toThrow(EngineStateError);
});

test("a commit needs a message and the message has a ceiling", () => {
  const store = new EngineStore(root(), () => 100, { git: () => ({ status: 0, stdout: "", stderr: "" }) });
  store.registerProject({ id: "project_one", name: "One", root: fs.realpathSync.native(root()) });
  store.createSession({ id: "session_one", projectId: "project_one" });
  expect(() => store.commitSessionWork("session_one", "   ")).toThrow(EngineStateError);
  expect(() => store.commitSessionWork("session_one", "x".repeat(2_001))).toThrow(EngineStateError);
});

/**
 * CLONE AND REGISTER, which the Sources palette makes one gesture.
 *
 * Git is stubbed: what is worth pinning is that the registration happens against
 * the folder the clone created and that a failed clone leaves no registration
 * behind, neither of which needs a network.
 */
describe("cloneProject", () => {
  /** A git that creates what it claims to have cloned, and records its argv. */
  const cloningGit = (calls: string[][] = []): import("../src/platform/git/runner").GitRunner => (_cwd, args) => {
    calls.push(args);
    if (args[0] === "clone") fs.mkdirSync(args[args.length - 1], { recursive: true });
    return { status: 0, stdout: "", stderr: "" };
  };

  test("what landed is what gets registered, named after the folder git chose", async () => {
    const parent = fs.realpathSync.native(root());
    const calls: string[][] = [];
    const store = new EngineStore(root(), () => 100, { git: cloningGit(calls) });
    const project = await store.cloneProject({ url: "https://github.com/owner/repo.git", parent });
    expect(project).toMatchObject({ name: "repo", root: path.join(parent, "repo") });
    // And it is in the registry, which is the half a two-call client could miss.
    expect(store.listProjects().map((entry) => entry.id)).toEqual([project.id]);
    expect(calls[0]).toEqual(["clone", "--", "https://github.com/owner/repo.git", path.join(parent, "repo")]);
  });

  test("a name can be given, and a blank one falls back to the folder", async () => {
    const parent = fs.realpathSync.native(root());
    const store = new EngineStore(root(), () => 100, { git: cloningGit() });
    expect((await store.cloneProject({ url: "https://x.test/a/one.git", parent, name: "Mine" })).name).toBe("Mine");
    expect((await store.cloneProject({ url: "https://x.test/a/two.git", parent, name: "   " })).name).toBe("two");
  });

  test("a clone that failed registers nothing, and says why in git's own words", async () => {
    const parent = fs.realpathSync.native(root());
    const store = new EngineStore(root(), () => 100, {
      git: () => ({ status: 128, stdout: "", stderr: "fatal: repository not found\n" }),
    });
    await expect(store.cloneProject({ url: "https://x.test/a/gone.git", parent })).rejects.toThrow(/repository not found/);
    expect(store.listProjects()).toEqual([]);
  });

  test("a target that already exists is a conflict rather than a merge into it", async () => {
    const parent = fs.realpathSync.native(root());
    fs.mkdirSync(path.join(parent, "repo"));
    const calls: string[][] = [];
    const store = new EngineStore(root(), () => 100, { git: cloningGit(calls) });
    await expect(store.cloneProject({ url: "https://x.test/a/repo.git", parent })).rejects.toThrow(EngineStateError);
    // Refused before git ran, so nothing was written into somebody's folder.
    expect(calls).toEqual([]);
  });
});

test("the gitignore write has an undo, and it is the project's own block only", () => {
  // Adding a project ignores Telar's files WITHOUT asking now, so the toast's
  // Undo has to reach the engine — and reach only what the engine wrote.
  const projectRoot = fs.realpathSync.native(root());
  fs.writeFileSync(path.join(projectRoot, ".gitignore"), "node_modules/\n");
  const store = new EngineStore(root(), () => 100, { git: () => ({ status: 0, stdout: "", stderr: "" }) });
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });

  const added = store.projectGitignore("project_one");
  expect(added.added.length).toBeGreaterThan(0);
  const removal = store.undoProjectGitignore("project_one");
  expect(removal.removed).toEqual(added.added);
  expect(fs.readFileSync(path.join(projectRoot, ".gitignore"), "utf8")).toBe("node_modules/\n");
  // Twice is not an error: the toast may arrive after a hand edit.
  expect(store.undoProjectGitignore("project_one").removed).toEqual([]);
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

  // And it survives the turn, which is where it actually has to arrive — beside
  // the long-window default the claim fills in, since Telar publishes no short
  // Claude rows and a turn that named no model must not run one.
  store.submitTurn("session_one", { runId: "run_one", input: "hi" });
  expect(store.claimNextTurn("worker_one")?.model).toEqual({ instanceId: session.providerInstanceId, effort: "max", model: "claude-opus-5[1m]" });
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

test("a turn's service tier and ultracode reach the claim beside its model", () => {
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "hi", model: { model: "claude-opus-5[1m]", ultracode: true, serviceTier: "priority" } });
  expect(store.claimNextTurn("worker_one")?.model).toMatchObject({ model: "claude-opus-5[1m]", ultracode: true, serviceTier: "priority" });
});

test("fast mode survives a selection that names no model", () => {
  // A Claude-side switch the composer offers on the provider default, so it has
  // to survive a selection that names no model at all — and it travels beside
  // the long-window default the claim supplies for a session that named none.
  const { store } = readyStore();
  const session = store.getSession("session_one");
  store.updateSession("session_one", { model: { instanceId: session.providerInstanceId, fastMode: true } });
  store.submitTurn("session_one", { runId: "run_one", input: "hi" });
  expect(store.claimNextTurn("worker_one")?.model).toEqual({ instanceId: session.providerInstanceId, fastMode: true, model: "claude-opus-5[1m]" });
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
  const queued = store.taskStopsForWorker("worker_one");
  expect(queued.map(({ sessionId, providerTaskId }) => ({ sessionId, providerTaskId }))).toEqual([{ sessionId: "session_one", providerTaskId: "bqo5yo8lm" }]);
  // Acknowledged, it is not delivered again.
  expect(store.taskStopsForWorker("worker_one", queued.map((stop) => stop.deliveryId!))).toEqual([]);
});

test("a vanished worker takes the session's background work with it — a task cannot outlive its process", () => {
  /**
   * PROCESS-DEATH, NOT TURN-END. `completeTurn` deliberately leaves background
   * work alone (outliving its turn is the definition of background), and
   * `failTurn`/a live stop already close it because the provider process died.
   * The worker vanishing mid-turn is the same death by another door — before
   * this, the agent was failed and the SHELL sat at `running` forever, the
   * exact "still has a background task" wedge.
   */
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Watch it" });
  const claim = store.claimNextTurn("worker_one")!;
  const token = claim.turn.claim!.token;
  store.markRunning("session_one", "run_one", token);
  store.ingestObservations("session_one", "run_one", token, [
    { kind: "task.started", task: { id: "task_a", kind: "agent", state: "running", title: "Explore" } },
    { kind: "task.started", task: { id: "task_b", kind: "background", state: "running", title: "Tail the log" } },
  ]);

  store.retireWorkerRegistration("worker_one");

  // THE TURN'S OWN AGENT DIES WITH THE WORKER that was running it.
  const byId = new Map(store.tasks("session_one").map((task) => [task.id, task]));
  expect(byId.get("task_a")).toMatchObject({ state: "failed", failure: "the worker running this agent disappeared" });
  /**
   * BACKGROUND WORK IS LEFT ALONE, and this is a deliberate change. The sweep
   * used to close every background task in EVERY session when one worker
   * retired, which killed independently launched project services along with
   * it. Background work outlives its turn by definition and has its own
   * explicit verb; a retirement is not a licence to kill what nobody pointed
   * at. The engine also cannot see whether that process is still alive, so
   * calling it stopped would be a claim it has no basis for.
   */
  expect(byId.get("task_b")?.state).toBe("running");
  // And the turn itself is terminal, so nothing replays and nothing blocks.
  expect(store.turns("session_one")[0]).toMatchObject({ state: "stopped", stopReason: "worker_unavailable" });
});

test("an engine restart stops every session's background work — the idle-with-monitoring one too", () => {
  /**
   * THE PROCESS IS THE UNIT, NOT THE TURN. Since #126 a session's CLI lives in
   * the worker between turns, so an engine restart (which restarts the
   * worker) kills the process of a session that was merely monitoring just as
   * surely as one mid-turn. The earlier shape spared the idle session and it
   * reported `monitoring` for five days (session_9b43ceec…) over a shell no
   * process anywhere was running.
   */
  const { store, root: stateRoot } = readyStore();
  store.createSession({ id: "session_two", projectId: "project_one" });

  // session_one: RUNNING at the crash.
  store.submitTurn("session_one", { runId: "run_one", input: "Watch it" });
  const first = store.claimNextTurn("worker_one")!;
  store.markRunning("session_one", "run_one", first.turn.claim!.token);
  store.ingestObservations("session_one", "run_one", first.turn.claim!.token, [
    { kind: "task.started", task: { id: "task_b", kind: "background", state: "running", title: "Tail the log" } },
  ]);

  // session_two: idle-with-monitoring at the crash — its turn had settled,
  // its shell lived on in the worker's runtime, and the worker is gone.
  store.submitTurn("session_two", { runId: "run_two", input: "Watch it too" });
  const second = store.claimNextTurn("worker_one")!;
  store.markRunning("session_two", "run_two", second.turn.claim!.token);
  store.ingestObservations("session_two", "run_two", second.turn.claim!.token, [
    { kind: "task.started", task: { id: "task_c", kind: "background", state: "running", title: "Watch the build" } },
  ]);
  store.completeTurn("session_two", "run_two", second.turn.claim!.token, { text: "Watching" });
  expect(store.getSession("session_two").activity).toBe("monitoring");

  const restarted = new EngineStore(stateRoot, () => 200);
  restarted.recover();

  for (const [sessionId, taskId] of [["session_one", "task_b"], ["session_two", "task_c"]] as const) {
    expect(restarted.tasks(sessionId).find((task) => task.id === taskId)).toMatchObject({
      state: "stopped",
      failure: "the process that owned this task is gone",
    });
  }
  expect(restarted.getSession("session_two").activity).toBe("idle");
  // Announced once. A second recover() finds nothing live and appends nothing.
  const closes = restarted.readEvents("session_two").filter((event) => event.type === "task.completed");
  expect(closes).toHaveLength(1);
  restarted.recover();
  expect(restarted.readEvents("session_two").filter((event) => event.type === "task.completed")).toHaveLength(1);
});

test("a provider turn is born running under a claim, and a human message sent meanwhile is steered into it", () => {
  const { store } = readyStore();
  const turn = store.openProviderTurn("session_one", {
    workerId: "worker_one",
    input: "Background task completed (DONE).",
    reason: { kind: "task_notification", taskId: "task_toolu_bg" },
  });
  expect(turn).toMatchObject({ state: "running", origin: "provider", providerReason: { kind: "task_notification", taskId: "task_toolu_bg" } });
  expect(turn.claim?.workerId).toBe("worker_one");
  expect(store.getSession("session_one").activity).toBe("working");
  expect(store.readEvents("session_one").slice(-3).map((event) => event.type)).toEqual(["turn.accepted", "turn.claimed", "turn.started"]);
  // A second one cannot open while this runs — one turn per session.
  expect(() => store.openProviderTurn("session_one", { workerId: "worker_one", input: "x", reason: { kind: "unknown" } })).toThrow("live turn");
  // The usual routes work under its claim.
  store.ingestObservations("session_one", turn.runId, turn.claim!.token, [
    { kind: "item.started", item: { id: "i1", detail: { type: "assistant_message", text: "merging" } } },
  ]);
  // A human message while it runs goes where a message during any running
  // turn goes: straight into it.
  expect(store.submitTurn("session_one", { runId: "run_human", input: "also check the docs" }).turn).toMatchObject({ state: "steering", steer: { intoRunId: turn.runId } });
  store.completeTurn("session_one", turn.runId, turn.claim!.token, { text: "merged" });
  const turns = new Map(store.turns("session_one").map((candidate) => [candidate.runId, candidate]));
  expect(turns.get(turn.runId)).toMatchObject({ state: "completed", resultText: "merged", origin: "provider" });
  // The steered message was not delivered before the turn settled: back to
  // the queue, where it runs as the next human turn.
  expect(turns.get("run_human")?.state).toBe("queued");
});

test("a provider turn can open over a queued one, so a lower sequence can start after a higher one finished", () => {
  let clock = 100;
  const store = new EngineStore(root(), () => (clock += 10));
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  store.createSession({ id: "session_one", projectId: "project_one" });
  const waiting = store.submitTurn("session_one", { runId: "run_waiting", input: "cohort done" }).turn;
  expect(waiting.state).toBe("queued");
  const provider = store.openProviderTurn("session_one", { workerId: "worker_one", input: "Background task completed.", reason: { kind: "unknown" } });
  expect(provider.sequence).toBeGreaterThan(waiting.sequence);
  store.completeTurn("session_one", provider.runId, provider.claim!.token, { text: "done" });
  const claimed = store.claimNextTurn("worker_one")!;
  expect(claimed.turn.runId).toBe("run_waiting");
  store.markRunning("session_one", "run_waiting", claimed.turn.claim!.token);
  const turns = new Map(store.turns("session_one").map((turn) => [turn.runId, turn]));
  expect(turns.get("run_waiting")!.startedAt!).toBeGreaterThan(turns.get(provider.runId)!.completedAt!);
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

test("the live-session read carries the arrangement, so a drag on one device reaches the others", () => {
  // THE PROPAGATION PATH. Every rail — the desktop shell, a browser tab, the
  // phone — polls this one route on its own cadence already; carrying the
  // layout on it is what lets a second device learn about a drop without a new
  // request, a new timer or a new connection. A blank document rides along too:
  // "nobody has arranged anything" is an answer, and a client that got no key
  // could not tell it from an engine too old to have one.
  const { store } = readyStore();
  expect(store.liveSessions().layout).toEqual({ projectOrder: [], sessionOrder: {}, pinnedOrder: [], mode: "grouped" });

  store.setSidebarLayout({ projectOrder: ["p2", "p1"] });
  store.setSidebarLayout({ sessionOrder: { p1: ["s2", "s1"] } });
  store.setSidebarLayout({ pinnedOrder: ["s9"] });
  expect(store.liveSessions().layout).toEqual({
    projectOrder: ["p2", "p1"],
    sessionOrder: { p1: ["s2", "s1"] },
    pinnedOrder: ["s9"],
    mode: "grouped",
  });
});

// ── the claimed→running window (#209) ───────────────────────────────────────

// ── subscriptions — one session woken by another ────────────────────────────

/**
 * THE COST OF AN IDLE CONVERSATION, which is the thing that decides whether a
 * person may keep their history or has to prune it to stay fast.
 */
describe("worker queries scale with live turns, not with the number of sessions", () => {
  function storeWith(idleSessions: number): { store: EngineStore; root: string } {
    const stateRoot = root();
    const store = new EngineStore(stateRoot, () => 100);
    store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
    for (let index = 0; index < idleSessions; index += 1) {
      const id = `session_idle${String(index).padStart(4, "0")}`;
      store.createSession({ id, projectId: "project_one" });
      // Settled work, exactly like a conversation somebody finished last week.
      store.submitTurn(id, { runId: `run_${id}`, input: "done long ago" });
      const claim = store.claimTurn(id, "worker_old")!;
      store.markRunning(id, `run_${id}`, claim.claim!.token);
      store.completeTurn(id, `run_${id}`, claim.claim!.token, { text: "done" });
    }
    return { store, root: stateRoot };
  }

  /** File reads performed while `run` executes. */
  function readsDuring(run: () => void): number {
    const spy = spyOn(fs, "readFileSync");
    try {
      run();
      return spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
  }

  test("a heartbeat's reads do not grow when settled conversations pile up", () => {
    const few = storeWith(4);
    const many = storeWith(40);
    // Warm each index once — the lazily-built scan is paid on first use, not
    // ten times a second, and it is the STEADY state this is about.
    few.store.cancellationsForWorker("worker_one");
    many.store.cancellationsForWorker("worker_one");

    const beat = (store: EngineStore): number =>
      readsDuring(() => {
        store.cancellationsForWorker("worker_one");
        store.resolutionsForWorker("worker_one");
        store.steerForWorker("worker_one");
      });

    // Ten times the history, and the same work: nothing here is per-session.
    expect(beat(few.store)).toBe(beat(many.store));
    expect(beat(many.store)).toBeLessThan(10);
  });

  test("a claim reads the queues that could be claimed and the metadata of the one that wins", () => {
    const claimReads = (idleSessions: number): { sessionId?: string; reads: number } => {
      const { store } = storeWith(idleSessions);
      store.createSession({ id: "session_live", projectId: "project_one" });
      store.submitTurn("session_live", { runId: "run_live", input: "Hello" });
      store.cancellationsForWorker("worker_one"); // warm the index
      let sessionId: string | undefined;
      const reads = readsDuring(() => {
        sessionId = store.claimNextTurn("worker_one")?.sessionId;
      });
      return { ...(sessionId ? { sessionId } : {}), reads };
    };

    const few = claimReads(4);
    const many = claimReads(40);
    expect(few.sessionId).toBe("session_live");
    expect(many.sessionId).toBe("session_live");
    // Ten times the settled history, and not one extra read: the claim touches
    // the claimable queues and the winner's metadata, nothing else.
    expect(many.reads).toBe(few.reads);
  });

  test("the index follows every transition: a settled session leaves it, a stopped one stays until its claim is gone", () => {
    const { store } = storeWith(0);
    store.createSession({ id: "session_a", projectId: "project_one" });
    store.submitTurn("session_a", { runId: "run_a", input: "Hello" });
    const claim = store.claimNextTurn("worker_one")!;
    const token = claim.turn.claim!.token;
    store.markRunning("session_a", "run_a", token);

    // Stopped, but the worker still has to be told — so it is still visible.
    store.stopTurn("session_a", "run_a");
    expect(store.cancellationsForWorker("worker_one")).toEqual([
      { sessionId: "session_a", runId: "run_a", claimToken: token },
    ]);

    // A fresh turn that completes leaves nothing for any worker to ask about.
    store.submitTurn("session_a", { runId: "run_b", input: "Again" });
    const second = store.claimNextTurn("worker_two")!;
    const secondToken = second.turn.claim!.token;
    store.markRunning("session_a", "run_b", secondToken);
    store.completeTurn("session_a", "run_b", secondToken, { text: "done" });
    expect(store.cancellationsForWorker("worker_two")).toEqual([]);
    expect(store.claimNextTurn("worker_two")).toBeUndefined();
  });

  test("across sessions the oldest ACCEPTED message runs first, whatever age its session is", () => {
    const stateRoot = root();
    let clock = 100;
    const store = new EngineStore(stateRoot, () => clock);
    store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
    // `session_old` exists first; the message in it is written second.
    store.createSession({ id: "session_old", projectId: "project_one" });
    store.createSession({ id: "session_new", projectId: "project_one" });
    clock = 200;
    store.submitTurn("session_new", { runId: "run_first", input: "typed first" });
    clock = 300;
    store.submitTurn("session_old", { runId: "run_second", input: "typed second" });

    expect(store.claimNextTurn("worker_one")?.turn.runId).toBe("run_first");
    expect(store.claimNextTurn("worker_two")?.turn.runId).toBe("run_second");
  });
});

test("a shutdown mid-turn settles the message it was carrying — not held, not replayed", () => {
  /**
   * The old shape bought "do not replay" with a hold: the requeued steer was
   * marked `engine_restart` and waited for a human to re-read it. Ending it
   * buys the same guarantee without the waiting, and the words stay readable.
   */
  const { store, root: stateRoot } = readyStore();
  store.submitTurn("session_one", { runId: "run_lost", input: "Refactor the parser" });
  const claim = store.claimTurn("session_one", "worker_one")!;
  store.markRunning("session_one", "run_lost", claim.claim!.token);
  store.submitTurn("session_one", { runId: "run_steer", input: "also update the docs" });
  expect(store.turns("session_one")[1]?.state).toBe("steering");

  store.failTurn("session_one", "run_lost", claim.claim!.token, { code: "interrupted", message: "Telar shut down while this turn was running." });
  // The undelivered steer comes back to the queue — never lost.
  expect(store.turns("session_one")[1]).toMatchObject({ state: "queued" });

  // The next boot settles it rather than holding it or running it.
  const rebooted = new EngineStore(stateRoot, () => 200);
  rebooted.recover();
  expect(rebooted.turns("session_one")[1]).toMatchObject({ state: "stopped", stopReason: "engine_restart", input: "also update the docs" });
  expect(rebooted.claimNextTurn("worker_two")).toBeUndefined();
  // And the person picks up by saying something, with no gesture first.
  rebooted.submitTurn("session_one", { runId: "run_next", input: "carry on" });
  expect(rebooted.claimNextTurn("worker_two")?.turn.runId).toBe("run_next");

  /**
   * AN ORDINARY FAILURE IS UNCHANGED. The person is there, watching, and the
   * session is left idle; the message they just typed running next is what
   * they expect.
   */
  const { store: crashed } = readyStore();
  crashed.submitTurn("session_one", { runId: "run_crash", input: "Refactor" });
  const crashClaim = crashed.claimTurn("session_one", "worker_one")!;
  crashed.markRunning("session_one", "run_crash", crashClaim.claim!.token);
  crashed.submitTurn("session_one", { runId: "run_after", input: "and the docs" });
  crashed.failTurn("session_one", "run_crash", crashClaim.claim!.token, { code: "driver_failed", message: "the CLI died" });
  expect(crashed.turns("session_one")[1]).toMatchObject({ state: "queued" });
  expect(crashed.turns("session_one")[1]?.held).toBeUndefined();
  expect(crashed.claimNextTurn("worker_two")?.turn.runId).toBe("run_after");
});

test("releasing checks the turn's state before its hold, and refuses a removed project", () => {
  /**
   * `releaseHeldTurn` is vestigial — nothing produces a hold any more — but it
   * is still reachable by an older client and by a queue.json written before
   * this change, so its guards still have to be right about a turn that is no
   * longer queued.
   */
  const { store, root: stateRoot } = readyStore();
  store.submitTurn("session_one", { runId: "run_lost", input: "Refactor" });
  const claim = store.claimTurn("session_one", "worker_one")!;
  store.markRunning("session_one", "run_lost", claim.claim!.token);
  store.submitTurn("session_one", { runId: "run_held", input: "before the crash" });
  store.closeExecutionStore();
  const rebooted = new EngineStore(stateRoot, () => 200);
  rebooted.recover();

  /**
   * THE STATE GUARD RAN ONLY WHEN THE TURN WAS UNHELD, so a terminal turn that
   * still carried a stale `held` flag skipped it — and was reported as
   * "released", which is a lie about a turn that has already ended.
   */
  editDocument(rebooted, stateRoot, "queue.json", (queue) => {
    Object.assign(queue.turns.find((turn: Turn) => turn.runId === "run_held"), { state: "stopped", completedAt: 150 });
  });
  rebooted.closeExecutionStore();
  const withStale = new EngineStore(stateRoot, () => 300);
  expect(() => withStale.releaseHeldTurn("session_one", "run_held")).toThrow(/only a queued turn can be released/);

  /**
   * DEFENCE IN DEPTH, and worth being straight about: this pairing is currently
   * UNREACHABLE through the API. `unregisterProject` refuses while a session has
   * work in flight, and `sessionHasWorkInFlight` counts `queued` — which a held
   * turn is — so a removed project cannot acquire one. Releasing nonetheless
   * STARTS work, which is the thing `assertProjectAvailable` guards at the other
   * two doors, and a gate that only holds because a neighbouring gate happens to
   * hold is one refactor away from not holding. Built here by writing the state
   * a future change might make reachable.
   */
  const { store: away, root: awayRoot } = readyStore();
  away.submitTurn("session_one", { runId: "run_held", input: "before the crash" });
  editDocument(away, awayRoot, "queue.json", (queue) => { queue.turns[0].held = { at: 100, reason: "engine_restart" }; });
  away.closeExecutionStore();
  const registryFile = path.join(awayRoot, "projects.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects[0].removedAt = 150;
  fs.writeFileSync(registryFile, JSON.stringify(registry), "utf8");

  const awayBoot = new EngineStore(awayRoot, () => 300);
  expect(() => awayBoot.releaseHeldTurn("session_one", "run_held")).toThrow(/removed from Telar/);
  // ...and it is still held afterwards, rather than half-released by a throw.
  expect(awayBoot.turns("session_one")[0]?.held).toBeDefined();
});

describe("a Claude model is stored and claimed as named — both windows are choices", () => {
  test("a bare id is its standard window and a `[1m]` id its long one, at every door", () => {
    const { store } = readyStore();
    const session = store.getSession("session_one");
    const instanceId = session.providerInstanceId;
    // The session patch keeps the 200k pick rather than rewriting it to 1M.
    expect(store.updateSession("session_one", { model: { instanceId, model: "opus", effort: "medium" } }).model).toEqual({ instanceId, model: "opus", effort: "medium" });
    expect(store.updateSession("session_one", { model: { instanceId, model: "claude-fable-5-1[1m]" } }).model?.model).toBe("claude-fable-5-1[1m]");
    // The per-turn choice and the claim.
    const { turn } = store.submitTurn("session_one", { runId: "run_one", input: "Hi", model: { model: "fable" } });
    expect(turn.model?.model).toBe("fable");
    expect(store.claimNextTurn("worker_one")?.model?.model).toBe("fable");
  });

  test("a session that named no model still claims the long-window default", () => {
    const { store } = readyStore();
    store.submitTurn("session_one", { runId: "run_one", input: "Hi" });
    expect(store.claimNextTurn("worker_one")?.model?.model).toMatch(/\[1m\]$/);
  });

  test("a Codex id is never touched", () => {
    const { store } = readyStore();
    store.createSession({ id: "session_codex", projectId: "project_one", driver: "codex" });
    const instanceId = store.getSession("session_codex").providerInstanceId;
    expect(store.updateSession("session_codex", { model: { instanceId, model: "gpt-5.6-sol" } }).model?.model).toBe("gpt-5.6-sol");
  });
});

describe("stop is stop — there is no pause to resume", () => {
  /**
   * WHAT THESE REPLACED. Two suites pinned a persistent pause: a latch on the
   * session, every queued message held behind it, `claimTurn` refusing while
   * it was set, and a human's Resume as the only way out. The person it was
   * built for rejected it in one sentence — hitting stop should stop a
   * session, not put it in a pause for them to resume.
   *
   * The guarantees underneath it are kept and asserted here: the live turn
   * ends, the work waiting behind it does NOT then start, and nothing is
   * deleted. What is gone is the waiting.
   */
  function busy(): { store: EngineStore; token: string } {
    const { store } = readyStore();
    store.submitTurn("session_one", { runId: "run_live", input: "Long task" });
    const claimed = store.claimTurn("session_one", "worker_one")!;
    store.markRunning("session_one", "run_live", claimed.claim!.token);
    return { store, token: claimed.claim!.token };
  }

  test("stop ends the live turn AND settles what was queued behind it", () => {
    const { store } = busy();
    store.submitTurn("session_one", { runId: "run_steered", input: "also this" });
    store.pauseSession("session_one"); // the deprecated alias — same verb now
    const states = new Map(store.turns("session_one").map((turn) => [turn.runId, turn]));
    expect(states.get("run_live")).toMatchObject({ state: "stopped", stopReason: "user" });
    expect(states.get("run_steered")).toMatchObject({ state: "stopped", stopReason: "user" });
    // NOT held, and not requeued — requeueing is what made stop start the
    // next thing a heartbeat later.
    expect(states.get("run_steered")?.held).toBeUndefined();
    expect(store.claimTurn("session_one", "worker_two")).toBeUndefined();
  });

  test("and then the session is IDLE: the next message runs, with nothing to resume", () => {
    const { store } = busy();
    store.submitTurn("session_one", { runId: "run_queued", input: "waiting" });
    store.stopSession("session_one");
    expect(store.getSession("session_one").paused).toBeUndefined();
    // No gesture in between. This is the whole point.
    expect(store.submitTurn("session_one", { runId: "run_after", input: "carry on" }).turn.state).toBe("queued");
    expect(store.claimTurn("session_one", "worker_two")?.runId).toBe("run_after");
  });

  test("the words survive being cancelled — nothing is deleted", () => {
    const { store } = busy();
    store.submitTurn("session_one", { runId: "run_queued", input: "the thing I typed" });
    store.stopSession("session_one");
    expect(store.turns("session_one").find((turn) => turn.runId === "run_queued")).toMatchObject({
      state: "stopped",
      input: "the thing I typed",
    });
  });

  test("a DELIVERED steer stays steered: its words were part of the run", () => {
    // Cancelling it would be a lie about what the model saw.
    const { store, token } = busy();
    store.submitTurn("session_one", { runId: "run_heard", input: "heard this" });
    store.ackSteer("session_one", "run_heard", token);
    store.stopSession("session_one");
    expect(store.turns("session_one").find((turn) => turn.runId === "run_heard")?.state).toBe("steered");
  });

  test("stopping wakes a subscriber once — for the live turn, not once per cancelled message", () => {
    const { store } = readyStore();
    store.createSession({ id: "session_two", projectId: "project_one", title: "the worker" });
    store.subscribe("session_one", { targetSessionId: "session_two", events: ["turn_stopped"] });
    store.submitTurn("session_two", { runId: "run_live", input: "Long task" });
    const claimed = store.claimTurn("session_two", "worker_one")!;
    store.markRunning("session_two", "run_live", claimed.claim!.token);
    store.submitTurn("session_two", { runId: "run_q1", input: "one" });
    store.submitTurn("session_two", { runId: "run_q2", input: "two" });

    store.stopSession("session_two");
    const wakes = store.turns("session_one").filter((turn) => turn.origin === "session");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.wakeReason).toMatchObject({ kind: "turn_stopped", sessionId: "session_two", runId: "run_live" });
  });

  test("an agent's stop is the person's stop — same verb, same result", () => {
    // `sessions_stop` used to mean pause, so an agent stopping a peer left it
    // latched while the Stop button did something else entirely.
    const { store } = busy();
    store.submitTurn("session_one", { runId: "run_q", input: "queued" });
    store.stopSession("session_one");
    expect(store.getSession("session_one").paused).toBeUndefined();
    expect(store.turns("session_one").find((turn) => turn.runId === "run_q")?.state).toBe("stopped");
  });

  for (const foreground of [true, false]) {
    test(`session Stop cancels background work with foreground=${foreground} and fences late reports`, () => {
      const { store, token } = busy();
      store.ingestObservations("session_one", "run_live", token, [
        { kind: "task.started", task: { id: "task_bg", kind: "background", state: "running", title: "Watch", providerTaskId: "provider_bg" } },
      ]);
      if (!foreground) store.completeTurn("session_one", "run_live", token, { text: "watching" });
      store.createSession({ id: "session_other", projectId: "project_one" });
      store.submitTurn("session_other", { runId: "run_other", input: "unrelated work" });
      const other = store.claimTurn("session_other", "worker_other")!;
      store.markRunning("session_other", "run_other", other.claim!.token);
      store.ingestObservations("session_other", "run_other", other.claim!.token, [
        { kind: "task.started", task: { id: "task_other", kind: "background", state: "running", title: "Other", providerTaskId: "provider_other" } },
      ]);

      store.stopSession("session_one");
      expect(store.tasks("session_one")[0]?.state).toBe("stopped");
      const queued = store.taskStopsForWorker("worker_one");
      expect(queued.map(({ sessionId, providerTaskId }) => ({ sessionId, providerTaskId }))).toEqual([{ sessionId: "session_one", providerTaskId: "provider_bg" }]);
      store.taskStopsForWorker("worker_one", queued.map((stop) => stop.deliveryId!));
      store.reportSessionTasks("session_one", "worker_one", [
        { kind: "task.progress", task: { id: "task_bg", kind: "background", state: "running", title: "late report" } },
      ]);
      expect(store.tasks("session_one")[0]?.state).toBe("stopped");
      expect(store.tasks("session_other")[0]?.state).toBe("running");
      store.stopSession("session_one");
      expect(store.taskStopsForWorker("worker_one")).toEqual([]);
      store.submitTurn("session_one", { runId: "run_after", input: "continue" });
      expect(store.claimTurn("session_one", "worker_one")?.runId).toBe("run_after");
    });
  }

  test("session Stop terminalizes legacy held work before clearing its pause latch", () => {
    const { store, root: directory } = readyStore();
    store.submitTurn("session_one", { runId: "run_held", input: "keep these words" });
    editDocument(store, directory, "queue.json", (queue) => { queue.turns[0].held = { at: 100, reason: "session_paused" }; });
    editDocument(store, directory, "session.json", (metadata) => { metadata.paused = { at: 100, by: "human" }; });
    store.closeExecutionStore();
    const legacy = new EngineStore(directory, () => 200);
    legacy.stopSession("session_one");
    expect(legacy.turns("session_one")[0]).toMatchObject({ state: "stopped", input: "keep these words" });
    expect(legacy.turns("session_one")[0]?.held).toBeUndefined();
    expect(legacy.getSession("session_one").paused).toBeUndefined();
    expect(legacy.claimTurn("session_one", "worker_one")).toBeUndefined();
    legacy.submitTurn("session_one", { runId: "run_after", input: "new instruction" });
    expect(legacy.claimTurn("session_one", "worker_one")?.runId).toBe("run_after");
  });

  test("stopping an idle session with nothing waiting changes nothing", () => {
    const { store } = readyStore();
    expect(store.stopSession("session_one")).toEqual({ stopped: [] });
  });

  test("a late completion cannot resurrect a stopped turn", () => {
    // The fence that makes stop mean stop even when the worker is mid-flight:
    // `completeTurn` takes only a RUNNING claim.
    const { store, token } = busy();
    store.stopSession("session_one");
    expect(() => store.completeTurn("session_one", "run_live", token, { text: "done" })).toThrow(EngineStateError);
    expect(store.turns("session_one")[0]?.state).toBe("stopped");
  });

  test("resume is inert: there is no latch to lift", () => {
    const { store } = busy();
    store.stopSession("session_one");
    expect(store.resumeSession("session_one")).toMatchObject({ released: 0, already: true });
  });
});

/**
 * #290 — A TURN THAT HIT A USAGE LIMIT COMES BACK BY ITSELF.
 *
 * The engine has no timer of its own for this: the sweep rides the claim poll,
 * which is the only periodic pass over live queues. That makes ONE thing easy
 * to get wrong and invisible when you do — a `failed` turn normally drops its
 * session out of `liveQueueIndex` immediately, so without the sixth predicate
 * in `queueConcernsAWorker` the sweep would never look at the session again and
 * the requeue would silently never fire. The cold-boot test below is the one
 * that actually pins that down.
 */
describe("a rate-limited turn resumes itself once the limit resets", () => {
  /** A store whose clock a test can move — the shared helper pins it at 100. */
  function limitedStore(): { store: EngineStore; root: string; at: () => number; setNow: (next: number) => void } {
    const stateRoot = root();
    let now = 1_000;
    const store = new EngineStore(stateRoot, () => now);
    store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
    store.createSession({ id: "session_one", projectId: "project_one" });
    return { store, root: stateRoot, at: () => now, setNow: (next) => { now = next; } };
  }

  /** Run a turn far enough to fail it as `rate_limited`, resetting at `resumeAt`. */
  function hitTheLimit(store: EngineStore, runId: string, resumeAt: number): void {
    store.submitTurn("session_one", { runId, input: "Do the thing" });
    const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
    store.markRunning("session_one", runId, token);
    store.failTurn("session_one", runId, token, {
      code: "rate_limited",
      message: "Claude's five hour usage limit was reached, so this turn stopped where it stood.",
      resumeAt,
      limitType: "five_hour",
    });
  }

  const turnOf = (store: EngineStore, runId: string) => store.turns("session_one").find((candidate) => candidate.runId === runId)!;

  test("the failure records when the limit lifts, and refuses to exist without it", () => {
    const { store } = limitedStore();
    hitTheLimit(store, "run_one", 5_000);
    expect(turnOf(store, "run_one")).toMatchObject({
      state: "failed",
      failure: { code: "rate_limited", resumeAt: 5_000, limitType: "five_hour" },
    });

    // A wait with no instant to wait for would sit failed for ever while
    // claiming to be temporary, and the sweep would skip it in silence.
    store.submitTurn("session_one", { runId: "run_two", input: "again" });
    const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
    store.markRunning("session_one", "run_two", token);
    expect(() =>
      store.failTurn("session_one", "run_two", token, { code: "rate_limited", message: "limited" }),
    ).toThrow(/must say when the limit resets/);
  });

  test("a past reset requeues the turn; a future one leaves it alone", () => {
    const { store, setNow } = limitedStore();
    hitTheLimit(store, "run_one", 5_000);

    // Before the reset: the poll looks, decides nothing, and hands out no work.
    setNow(4_999);
    expect(store.claimNextTurn("worker_one")).toBeUndefined();
    expect(turnOf(store, "run_one").state).toBe("failed");
    expect(turnOf(store, "run_one").failure?.resumeDecidedAt).toBeUndefined();

    // The instant it passes, the same poll brings the turn back and claims it.
    setNow(5_000);
    const claimed = store.claimNextTurn("worker_one");
    expect(claimed?.turn.runId).toBe("run_one");
    expect(turnOf(store, "run_one")).toMatchObject({ resumedAfterRateLimit: 5_000 });
    expect(store.readEvents("session_one").some((event) => event.type === "turn.requeued" && event.reason === "rate_limit_reset")).toBeTrue();
  });

  test("with the setting off the turn stays failed, and is not reconsidered on every poll", () => {
    const { store, setNow } = limitedStore();
    store.updateSession("session_one", { resumeAfterRateLimit: false });
    hitTheLimit(store, "run_one", 5_000);

    setNow(6_000);
    expect(store.claimNextTurn("worker_one")).toBeUndefined();
    const settled = turnOf(store, "run_one");
    expect(settled.state).toBe("failed");
    // Stamped, so `queueConcernsAWorker` stops matching it: without this the
    // session would sit in the live index being re-examined for the life of the
    // daemon. The reset time SURVIVES, because the row still shows it.
    expect(settled.failure).toMatchObject({ code: "rate_limited", resumeAt: 5_000, resumeDecidedAt: 6_000 });
    expect(store.readEvents("session_one").some((event) => event.type === "turn.requeued" && event.reason === "rate_limit_reset")).toBeFalse();
  });

  test("the default is on for Claude and off for another provider, without writing either down", () => {
    const { store, setNow } = limitedStore();
    // Nothing stored: a session made before the setting existed behaves like
    // one made after it.
    expect(store.getSession("session_one").resumeAfterRateLimit).toBeUndefined();
    hitTheLimit(store, "run_one", 5_000);
    setNow(5_001);
    expect(store.claimNextTurn("worker_one")?.turn.runId).toBe("run_one");

    const { store: codex, setNow: setCodexNow } = limitedStore();
    codex.createSession({ id: "session_codex", projectId: "project_one", driver: "codex" });
    codex.submitTurn("session_codex", { runId: "run_codex", input: "Do the thing" });
    const token = codex.claimTurn("session_codex", "worker_one")!.claim!.token;
    codex.markRunning("session_codex", "run_codex", token);
    codex.failTurn("session_codex", "run_codex", token, { code: "rate_limited", message: "limited", resumeAt: 5_000 });
    setCodexNow(5_001);
    expect(codex.claimNextTurn("worker_one")).toBeUndefined();
  });

  test("a session that never chose follows the standing default, and its own choice still wins", () => {
    const { store, setNow } = limitedStore();
    store.setSessionDefaults({ resumeAfterRateLimit: false });
    hitTheLimit(store, "run_one", 5_000);
    setNow(5_001);
    expect(store.claimNextTurn("worker_one")).toBeUndefined();

    const { store: chosen, setNow: setChosenNow } = limitedStore();
    chosen.setSessionDefaults({ resumeAfterRateLimit: false });
    chosen.updateSession("session_one", { resumeAfterRateLimit: true });
    hitTheLimit(chosen, "run_one", 5_000);
    setChosenNow(5_001);
    expect(chosen.claimNextTurn("worker_one")?.turn.runId).toBe("run_one");
  });

  /**
   * THE PREDICATE, PINNED. A fresh store builds `liveQueueIndex` by walking
   * every session on disk and asking `queueConcernsAWorker` — so if a failed
   * `rate_limited` turn does not keep its session in that index, a limit that
   * lifts while Telar is closed is never resumed at all. This is the exact
   * failure the sixth predicate exists to prevent, and nothing else catches it.
   */
  test("a limit that lifts while the engine is down is resumed on the next boot", () => {
    const { store, root: stateRoot } = limitedStore();
    hitTheLimit(store, "run_one", 5_000);

    let now = 9_000;
    const rebooted = new EngineStore(stateRoot, () => now);
    expect(rebooted.claimNextTurn("worker_two")?.turn.runId).toBe("run_one");
    now += 1;
    expect(rebooted.turns("session_one").find((candidate) => candidate.runId === "run_one")).toMatchObject({ resumedAfterRateLimit: 9_000 });
  });

  test("a resumed turn keeps its place, so a backlog still runs in the order it was typed", () => {
    const { store, setNow } = limitedStore();
    hitTheLimit(store, "run_one", 5_000);
    // Typed while the session was sitting out the limit.
    store.submitTurn("session_one", { runId: "run_later", input: "and then this" });

    setNow(5_000);
    expect(store.claimNextTurn("worker_one")?.turn.runId).toBe("run_one");
  });

  test("Resume now runs the turn before its reset, and says a person did it", () => {
    const { store } = limitedStore();
    hitTheLimit(store, "run_one", 5_000);

    // DELIBERATELY NOT CLOCK-CHECKED: another credential came free, the proxy
    // moved account. Refusing until the reset would make the button a
    // decoration on the only occasions it is wanted.
    const resumed = store.resumeRateLimitedTurn("session_one", "run_one");
    expect(resumed.state).toBe("queued");
    // The engine did not bring this one back, so it must not claim it did.
    expect(resumed.resumedAfterRateLimit).toBeUndefined();
    expect(resumed.failure).toMatchObject({ code: "rate_limited", resumeDecidedAt: 1_000 });
    expect(store.claimNextTurn("worker_one")?.turn.runId).toBe("run_one");
  });

  test("Resume now refuses a turn that is not waiting on a limit, and one already running", () => {
    const { store } = limitedStore();
    store.submitTurn("session_one", { runId: "run_one", input: "Do the thing" });
    const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
    store.markRunning("session_one", "run_one", token);
    store.failTurn("session_one", "run_one", token, { code: "driver_failed", message: "the CLI died" });
    expect(() => store.resumeRateLimitedTurn("session_one", "run_one")).toThrow(/not waiting for a usage limit/);

    hitTheLimit(store, "run_two", 5_000);
    store.submitTurn("session_one", { runId: "run_three", input: "live" });
    const live = store.claimTurn("session_one", "worker_one")!.claim!.token;
    store.markRunning("session_one", "run_three", live);
    // One turn at a time is the engine's own invariant; a click must not be the
    // one thing that can break it.
    expect(() => store.resumeRateLimitedTurn("session_one", "run_two")).toThrow(/already running a turn/);
  });

  test("a paused session is neither resumed nor quietly stamped as decided", () => {
    const { store, setNow } = limitedStore();
    hitTheLimit(store, "run_one", 5_000);
    store.stopSession("session_one");

    setNow(6_000);
    store.claimNextTurn("worker_one");
    // Left undecided on purpose: stamping here would mean a session stopped
    // across its own reset time silently lost the resume it was promised.
    const held = turnOf(store, "run_one");
    if (held.state === "failed") expect(held.failure?.resumeDecidedAt).toBeUndefined();
  });
});
