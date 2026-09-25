import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Turn } from "@telar/engine-client";
import { acquireDaemonLock, EngineStateError, EngineStore, migrateLegacyEngineRoot, statePaths, engineRootFromEnv } from "../src/state";

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

  const spy = spyOn(fs, "renameSync");
  const projectionWrites = () => spy.mock.calls.filter(([, to]) => String(to).endsWith("items.json")).length;
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
    spy.mockRestore();
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
  const queueFile = path.join(stateRoot, "sessions", "session_one", "queue.json");
  const queue = JSON.parse(fs.readFileSync(queueFile, "utf8"));
  queue.turns[0].state = "failed";
  queue.turns[0].completedAt = 90;
  queue.turns[0].failure = { code: "driver_failed", message: "old build" };
  fs.writeFileSync(queueFile, JSON.stringify(queue), "utf8");

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
    const queueFile = path.join(stateRoot, "sessions", "session_one", "queue.json");
    const queue = JSON.parse(fs.readFileSync(queueFile, "utf8"));
    for (const turn of queue.turns) {
      if (turn.runId !== runId) continue;
      turn.state = "failed";
      turn.completedAt = 90;
      turn.failure = { code: "driver_failed", message: "old build" };
    }
    fs.writeFileSync(queueFile, JSON.stringify(queue), "utf8");
  }

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

test("a message while a turn runs STEERS into it; one that cannot be delivered runs next, in order", () => {
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "First" });
  const claimed = store.claimTurn("session_one", "worker_one")!;
  store.markRunning("session_one", "run_one", claimed.claim!.token);

  // THE POINT: typing at a running turn reaches it — the same turn continues,
  // as it does in T3 Code and at any running CLI. Nothing waits for "Send now".
  const second = store.submitTurn("session_one", { runId: "run_two", input: "Second" });
  expect(second.turn).toMatchObject({ state: "steering", steer: { intoRunId: "run_one" } });
  expect(store.readEvents("session_one").slice(-2).map((event) => event.type)).toEqual(["turn.accepted", "turn.steering"]);
  store.submitTurn("session_one", { runId: "run_three", input: "Third" });

  // Still exactly ONE turn executing: nothing may be claimed while one runs.
  expect(store.claimNextTurn("worker_two")).toBeUndefined();

  // The worker delivers the first; the turn ends before the second lands.
  store.ackSteer("session_one", "run_two", claimed.claim!.token);
  store.completeTurn("session_one", "run_one", claimed.claim!.token, { text: "done" });
  const turns = new Map(store.turns("session_one").map((turn) => [turn.runId, turn]));
  expect(turns.get("run_two")?.state).toBe("steered");
  // NOT LOST: the undelivered one is back to queued and runs as its own turn.
  expect(turns.get("run_three")?.state).toBe("queued");
  expect(store.claimNextTurn("worker_two")?.turn.runId).toBe("run_three");

  // A message to an IDLE session is the next turn, as before.
  const { store: idle } = readyStore();
  expect(idle.submitTurn("session_one", { runId: "run_solo", input: "Hello" }).turn.state).toBe("queued");
  // A claimed-but-not-yet-running turn is not steerable either: queued, not lost.
  idle.claimTurn("session_one", "worker_one");
  expect(idle.submitTurn("session_one", { runId: "run_early", input: "and this" }).turn.state).toBe("queued");
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

describe("a pin survives everything that is not a decision", () => {
  /** One turn, run to completion the way a worker would. */
  function runTurn(store: EngineStore, sessionId: string, runId: string): void {
    store.submitTurn(sessionId, { runId, input: "work" });
    const token = store.claimTurn(sessionId, "worker_one")!.claim!.token;
    store.markRunning(sessionId, runId, token);
    store.completeTurn(sessionId, runId, token, { text: "done" });
  }

  test("a human's own message does not throw the pin away", () => {
    // THE BUG: `settledOverride` holds two opposite decisions, and new work
    // used to clear the field rather than the "settled" half of it — so the
    // next turn silently unpinned a row the reader had pinned on purpose.
    const { store } = readyStore();
    store.updateSession("session_one", { settledOverride: "active" });
    store.submitTurn("session_one", { runId: "run_pinned", input: "one more thing" });
    expect(store.getSession("session_one").settledOverride).toBe("active");
  });

  test("nor does a turn the PROVIDER started, or a peer waking it", () => {
    const { store } = readyStore();
    store.createSession({ id: "session_two", projectId: "project_one", title: "the worker" });
    store.updateSession("session_one", { settledOverride: "active" });

    // A background task finishing wakes the CLI, which opens its own turn.
    const provider = store.openProviderTurn("session_one", {
      workerId: "worker_one",
      input: "Background task completed (DONE).",
      reason: { kind: "task_notification", taskId: "task_bg" },
    });
    store.completeTurn("session_one", provider.runId, provider.claim!.token, { text: "noted" });
    expect(store.getSession("session_one").settledOverride).toBe("active");

    // And a subscribed peer finishing queues a wake turn on the pinned one.
    store.subscribe("session_one", { targetSessionId: "session_two" });
    runTurn(store, "session_two", "run_peer");
    expect(store.turns("session_one").some((turn) => turn.origin === "session")).toBe(true);
    expect(store.getSession("session_one").settledOverride).toBe("active");
  });

  test("only unpinning clears it, and settling still wins over the pin", () => {
    const { store } = readyStore();
    store.updateSession("session_one", { settledOverride: "active" });
    expect(store.updateSession("session_one", { settledOverride: null }).settledOverride).toBeUndefined();
    store.updateSession("session_one", { settledOverride: "active" });
    expect(store.updateSession("session_one", { settledOverride: "settled" }).settledOverride).toBe("settled");
  });

  test("a settled session still comes back on its own, and its snooze goes with it", () => {
    // The half that must NOT change: unpinning-on-work is the rule that keeps
    // settling from being a place things get lost.
    const { store } = readyStore();
    store.updateSession("session_one", { settledOverride: "settled", snoozedUntil: 9_000 });
    store.submitTurn("session_one", { runId: "run_back", input: "actually" });
    const session = store.getSession("session_one");
    expect(session.settledOverride).toBeUndefined();
    expect(session.snoozedUntil).toBeUndefined();
    expect(session.snoozedAt).toBeUndefined();
  });

  test("a pinned session's snooze is still lifted by new work — the pin is not a snooze", () => {
    const { store } = readyStore();
    store.updateSession("session_one", { settledOverride: "active", snoozedUntil: 9_000 });
    store.submitTurn("session_one", { runId: "run_both", input: "hi" });
    const session = store.getSession("session_one");
    expect(session.settledOverride).toBe("active");
    expect(session.snoozedUntil).toBeUndefined();
  });
});

describe("read receipts", () => {
  function completed(store: EngineStore, sessionId: string, runId: string): void {
    store.submitTurn(sessionId, { runId, input: "work" });
    const token = store.claimTurn(sessionId, "worker_one")!.claim!.token;
    store.markRunning(sessionId, runId, token);
    store.completeTurn(sessionId, runId, token, { text: "done" });
  }

  test("a session with no result has nothing to read", () => {
    const { store } = readyStore();
    expect(store.getSession("session_one").lastTurnSequence).toBeUndefined();
    expect(store.getSession("session_one").lastReadTurnSequence).toBeUndefined();
  });

  test("the newest RESULT is what is reported, and it is markable", () => {
    const { store } = readyStore();
    completed(store, "session_one", "run_one");
    const before = store.getSession("session_one");
    expect(before.lastTurnSequence).toBe(1);

    const read = store.markSessionRead("session_one", "run_one");
    expect(read.lastReadTurnSequence).toBe(1);
    expect(read.readAt).toBe(100);
    // AND IT SURVIVES THE PROCESS. The whole reason this is not a browser flag.
    expect(new EngineStore(store.paths.root, () => 200).getSession("session_one")).toMatchObject({
      lastReadTurnSequence: 1,
      readAt: 100,
    });
  });

  test("being read is not work: `updatedAt` does not move", () => {
    // Otherwise opening a settled session would push it back into the list,
    // and reading a row would restart the very clock meant to shelve it.
    const { store } = readyStore();
    completed(store, "session_one", "run_one");
    const before = store.getSession("session_one").updatedAt;
    store.markSessionRead("session_one", "run_one");
    expect(store.getSession("session_one").updatedAt).toBe(before);
    // The change is still announced, so other surfaces stop calling it unread.
    expect(store.readEvents("session_one").at(-1)).toMatchObject({ type: "session.updated" });
  });

  test("a receipt for a turn that is not a result is refused", () => {
    const { store } = readyStore();
    store.submitTurn("session_one", { runId: "run_live", input: "work" });
    const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
    store.markRunning("session_one", "run_live", token);
    // Still running: nothing has been answered yet.
    expect(() => store.markSessionRead("session_one", "run_live")).toThrow(/completed, failed or stopped/);
    // A turn of ANOTHER session, and one that does not exist at all.
    store.createSession({ id: "session_two", projectId: "project_one" });
    completed(store, "session_two", "run_two");
    expect(() => store.markSessionRead("session_one", "run_two")).toThrow(/completed, failed or stopped/);
    expect(() => store.markSessionRead("session_one", "run_nope")).toThrow(/completed, failed or stopped/);
  });

  test("a LATE receipt cannot consume the answer that arrived after it", () => {
    // Two tabs, or a retry after a dropped response: the receipt names the
    // turn it was about, so the newer answer stays unread.
    const { store } = readyStore();
    completed(store, "session_one", "run_one");
    completed(store, "session_one", "run_two");
    store.markSessionRead("session_one", "run_two");
    const after = store.markSessionRead("session_one", "run_one");
    expect(after.lastReadTurnSequence).toBe(2);
    expect(after.lastTurnSequence).toBe(2);
  });

  test("a steered message and a discarded recovery are not results, so they never strand a session unread", () => {
    /**
     * THE FLAW THIS CLOSES: `lastTurnSequence` came off "the newest turn that
     * ENDED", and a message steered into a running turn ends the moment the
     * provider takes it. That sequence names a turn no client can mark read —
     * the transcript does not even draw it — so the session reported an unread
     * answer forever and could never be shelved by the clock again.
     */
    const { store } = readyStore();
    store.submitTurn("session_one", { runId: "run_one", input: "work" });
    const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
    store.markRunning("session_one", "run_one", token);
    store.submitTurn("session_one", { runId: "run_steer", input: "also this" });
    store.ackSteer("session_one", "run_steer", token);
    store.completeTurn("session_one", "run_one", token, { text: "done" });

    const steered = store.turns("session_one").find((turn) => turn.runId === "run_steer")!;
    expect(steered.state).toBe("steered");
    // The steered turn has the HIGHER sequence and the LATER end, and neither
    // makes it the answer.
    expect(steered.sequence).toBeGreaterThan(store.turns("session_one").find((turn) => turn.runId === "run_one")!.sequence);
    const session = store.getSession("session_one");
    expect(session.lastTurnSequence).toBe(1);
    // Which means the reader can actually clear it.
    expect(store.markSessionRead("session_one", "run_one").lastReadTurnSequence).toBe(1);
    expect(store.getSession("session_one").lastTurnSequence).toBe(1);
  });

  test("a failed or stopped turn is a result too — a failure is something to read", () => {
    const { store } = readyStore();
    store.submitTurn("session_one", { runId: "run_bad", input: "work" });
    const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
    store.markRunning("session_one", "run_bad", token);
    store.failTurn("session_one", "run_bad", token, { code: "driver_failed", message: "the CLI died" });
    expect(store.getSession("session_one").lastTurnSequence).toBe(1);
    expect(store.markSessionRead("session_one", "run_bad").lastReadTurnSequence).toBe(1);
  });

  test("new work after a receipt is unread again", () => {
    const { store } = readyStore();
    completed(store, "session_one", "run_one");
    store.markSessionRead("session_one", "run_one");
    completed(store, "session_one", "run_two");
    const session = store.getSession("session_one");
    expect(session.lastTurnSequence).toBe(2);
    expect(session.lastReadTurnSequence).toBe(1);
  });
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

describe("the journal head is read from disk once per store, then kept in memory", () => {
  /**
   * `appendEvent` used to parse the whole journal on every append to learn
   * the last id — 9 MB of JSON per event on a long session. The head is now
   * cached per session after the first append. What these pin: the cache is
   * seeded through the same validating, tail-repairing read as before (so a
   * restart behaves identically), and ordinary appends no longer read the
   * journal at all.
   */
  const journalOf = (stateRoot: string): string => path.join(stateRoot, "sessions", "session_one", "events.ndjson");
  const ids = (store: EngineStore): number[] => store.readEvents("session_one").map((event) => event.id);

  test("a restarted store continues the id sequence from the journal on disk", () => {
    const { store, root: stateRoot } = readyStore();
    store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
    store.stopTurn("session_one", "run_one");
    expect(ids(store)).toEqual([1, 2, 3]);

    const restarted = new EngineStore(stateRoot, () => 200);
    restarted.submitTurn("session_one", { runId: "run_two", input: "Again" });
    expect(ids(restarted)).toEqual([1, 2, 3, 4]);
    // The original instance's memory is stale after the other wrote — which
    // is why the daemon lock allows only one live writer. Not a supported
    // configuration; recorded here so the assumption is visible.
    expect(fs.readFileSync(journalOf(stateRoot), "utf8").split("\n").filter(Boolean)).toHaveLength(4);
  });

  test("a restart over a torn final record truncates it before the next append", () => {
    // The crash happened before the JSON finished reaching disk. The fragment
    // is not a record; a restart drops it and the next id follows the last
    // COMPLETE one rather than the torn one's claimed id.
    const { store, root: stateRoot } = readyStore();
    store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
    const journal = journalOf(stateRoot);
    const intact = fs.readFileSync(journal, "utf8");
    fs.appendFileSync(journal, '{"id":3,"at":100,"sessionId":"session_one","type":"turn.st');

    const restarted = new EngineStore(stateRoot, () => 200);
    restarted.stopTurn("session_one", "run_one");
    const after = fs.readFileSync(journal, "utf8");
    expect(after.startsWith(intact)).toBe(true);
    // Exactly one record follows the intact prefix — the fragment is gone, not
    // glued to the front of the new record.
    const appended = after.slice(intact.length).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(appended).toEqual([expect.objectContaining({ id: 3, type: "turn.stopped" })]);
    expect(ids(restarted)).toEqual([1, 2, 3]);
  });

  test("a restart over a valid unterminated record keeps it and restores the delimiter", () => {
    // The crash happened after the JSON bytes landed but before the newline.
    // That observation is real and must not be lost; the next append must
    // not be glued onto it either.
    const { store, root: stateRoot } = readyStore();
    store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
    const journal = journalOf(stateRoot);
    const unterminated = JSON.stringify({ id: 3, at: 100, sessionId: "session_one", type: "turn.started", runId: "run_one" });
    fs.appendFileSync(journal, unterminated);

    const restarted = new EngineStore(stateRoot, () => 200);
    restarted.stopTurn("session_one", "run_one");
    const lines = fs.readFileSync(journal, "utf8").split("\n");
    expect(lines.at(-1)).toBe("");
    expect(lines[2]).toBe(unterminated);
    expect(ids(restarted)).toEqual([1, 2, 3, 4]);
    expect(restarted.readEvents("session_one").map((event) => event.type)).toEqual([
      "session.created",
      "turn.accepted",
      "turn.started",
      "turn.stopped",
    ]);
  });

  test("ordinary appends do not read the journal", () => {
    // The whole point. `readJournal` goes through `fs.readFileSync`, and
    // after the head is seeded no append on this session may touch it —
    // counted per append so a regression to "read every time" is caught even
    // if some other read slips in once.
    const { store, root: stateRoot } = readyStore();
    const journal = journalOf(stateRoot);
    store.submitTurn("session_one", { runId: "warm", input: "seed the head" });
    store.stopTurn("session_one", "warm");

    const original = fs.readFileSync;
    let journalReads = 0;
    const spy = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === journal) journalReads += 1;
      return original.apply(fs, args);
    }) as typeof fs.readFileSync);
    try {
      for (let n = 0; n < 10; n += 1) {
        store.submitTurn("session_one", { runId: `run_${n}`, input: "x" });
        store.stopTurn("session_one", `run_${n}`);
      }
    } finally {
      spy.mockRestore();
    }
    expect(journalReads).toBe(0);
    expect(ids(store)).toEqual(Array.from({ length: 23 }, (_, index) => index + 1));
  });

  test("a deleted session's head is forgotten, so a recreated id starts a fresh journal", () => {
    const { store } = readyStore();
    store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
    store.stopTurn("session_one", "run_one");
    expect(store.deleteSession("session_one")).toBe(true);
    store.createSession({ id: "session_one", projectId: "project_one" });
    expect(ids(store)).toEqual([1]);
  });

  test("a failed append forgets the head so the next one re-reads and repairs", () => {
    const { store, root: stateRoot } = readyStore();
    const journal = journalOf(stateRoot);
    store.submitTurn("session_one", { runId: "run_one", input: "Hello" });

    // Simulate a write that tore mid-record and then failed: the bytes that
    // landed are a fragment, and the append threw.
    const original = fs.appendFileSync;
    const spy = spyOn(fs, "appendFileSync").mockImplementation(((...args: Parameters<typeof fs.appendFileSync>) => {
      if (args[0] === journal) {
        original.call(fs, journal, '{"id":3,"at":100,"sess', { mode: 0o600 });
        throw new Error("ENOSPC: simulated");
      }
      return original.apply(fs, args);
    }) as typeof fs.appendFileSync);
    try {
      expect(() => store.stopTurn("session_one", "run_one")).toThrow(/ENOSPC/);
    } finally {
      spy.mockRestore();
    }
    // The next append goes back through the repairing read: the fragment is
    // gone, and the id continues from the last complete record. (The queue
    // already recorded the stop before the append failed, so the follow-up
    // append is a fresh submission rather than a second stop.)
    store.submitTurn("session_one", { runId: "run_two", input: "Next" });
    expect(ids(store)).toEqual([1, 2, 3]);
    expect(fs.readFileSync(journal, "utf8")).not.toContain('"sess{');
  });
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
  // NORMALISED AT THE CLAIM: Telar publishes only the long-window row for
  // this family, so a bare id runs as the row the picker would have offered.
  expect(store.claimNextTurn("worker_one")?.model?.model).toBe("claude-opus-5[1m]");
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

test("a hand-started browser binds the session's project profile BEFORE opening, even with no worker turn and no mounted surface", async () => {
  const { store } = readyStore(); // creates session_one in project_one
  const calls: Array<{ op: string; scopeKey: string; profileKey?: string; start?: boolean }> = [];
  store.attachBrowser({
    bindProfile: async (scopeKey: string, profileKey: string) => { calls.push({ op: "bind", scopeKey, profileKey }); },
    state: async (scopeKey: string, options: { start?: boolean }) => { calls.push({ op: "state", scopeKey, start: options.start }); return { provider: "attached" as const, running: true, tabs: [] }; },
    release: async () => undefined,
  } as never);
  await store.browserState("session_one", { start: true });
  // Bind happened, with the session's project, BEFORE the state read that opens.
  expect(calls).toEqual([
    { op: "bind", scopeKey: "session_one", profileKey: "project_one" },
    { op: "state", scopeKey: "session_one", start: true },
  ]);
  // A plain read (no start) does not bind — nothing opens, so nothing to bind.
  calls.length = 0;
  await store.browserState("session_one");
  expect(calls.find((c) => c.op === "bind")).toBeUndefined();
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

test("a project whose git stalls or throws is still listed, without a branch, under a short bound", () => {
  // The registry is the source of truth for WHICH projects exist; git only
  // decorates them. Measured: one stalled `rev-parse` under ~/Documents made
  // the whole project list time out, and a thrown runner would have dropped
  // every project. Neither may cost the row.
  const projectRoot = fs.realpathSync.native(root());
  const calls: Array<{ args: string[]; timeoutMs?: number }> = [];
  const git: import("../src/worktree").GitRunner = (_cwd, args, options) => {
    calls.push({ args, ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
    if (args[0] === "rev-parse") return { status: 124, stdout: "", stderr: "git rev-parse ... did not finish within 5000ms and was killed", timedOut: true };
    throw new Error("runner exploded");
  };
  const store = new EngineStore(root(), () => 100, { git });
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  const [listed] = store.listProjects();
  expect(listed).toMatchObject({ id: "project_one", name: "One", root: projectRoot });
  expect(listed?.branch).toBeUndefined();
  // The poll-path bound is tighter than the runner's general default.
  expect(calls.find((call) => call.args[0] === "rev-parse")?.timeoutMs).toBe(5_000);

  const exploding = new EngineStore(root(), () => 100, {
    git: () => {
      throw new Error("runner exploded");
    },
  });
  exploding.registerProject({ id: "project_two", name: "Two", root: projectRoot });
  expect(exploding.listProjects().map((project) => project.id)).toEqual(["project_two"]);
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

/**
 * CLONE AND REGISTER, which the Sources palette makes one gesture.
 *
 * Git is stubbed: what is worth pinning is that the registration happens against
 * the folder the clone created and that a failed clone leaves no registration
 * behind, neither of which needs a network.
 */
describe("cloneProject", () => {
  /** A git that creates what it claims to have cloned, and records its argv. */
  const cloningGit = (calls: string[][] = []): import("../src/worktree").GitRunner => (_cwd, args) => {
    calls.push(args);
    if (args[0] === "clone") fs.mkdirSync(args[args.length - 1], { recursive: true });
    return { status: 0, stdout: "", stderr: "" };
  };

  test("what landed is what gets registered, named after the folder git chose", () => {
    const parent = fs.realpathSync.native(root());
    const calls: string[][] = [];
    const store = new EngineStore(root(), () => 100, { git: cloningGit(calls) });
    const project = store.cloneProject({ url: "https://github.com/owner/repo.git", parent });
    expect(project).toMatchObject({ name: "repo", root: path.join(parent, "repo") });
    // And it is in the registry, which is the half a two-call client could miss.
    expect(store.listProjects().map((entry) => entry.id)).toEqual([project.id]);
    expect(calls[0]).toEqual(["clone", "--", "https://github.com/owner/repo.git", path.join(parent, "repo")]);
  });

  test("a name can be given, and a blank one falls back to the folder", () => {
    const parent = fs.realpathSync.native(root());
    const store = new EngineStore(root(), () => 100, { git: cloningGit() });
    expect(store.cloneProject({ url: "https://x.test/a/one.git", parent, name: "Mine" }).name).toBe("Mine");
    expect(store.cloneProject({ url: "https://x.test/a/two.git", parent, name: "   " }).name).toBe("two");
  });

  test("a clone that failed registers nothing, and says why in git's own words", () => {
    const parent = fs.realpathSync.native(root());
    const store = new EngineStore(root(), () => 100, {
      git: () => ({ status: 128, stdout: "", stderr: "fatal: repository not found\n" }),
    });
    expect(() => store.cloneProject({ url: "https://x.test/a/gone.git", parent })).toThrow(/repository not found/);
    expect(store.listProjects()).toEqual([]);
  });

  test("a target that already exists is a conflict rather than a merge into it", () => {
    const parent = fs.realpathSync.native(root());
    fs.mkdirSync(path.join(parent, "repo"));
    const calls: string[][] = [];
    const store = new EngineStore(root(), () => 100, { git: cloningGit(calls) });
    expect(() => store.cloneProject({ url: "https://x.test/a/repo.git", parent })).toThrow(EngineStateError);
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

/** Whether a `gh` argv is the BOARD half of a read — the one asking for
 *  `projectItems`, which is separate precisely so it can fail alone. */
const isBoardCall = (args: string[]) => args.includes("number,projectItems");
/** The thread read (#814) — who wrote each comment. Like the board call it rides
 *  beside a detail read and fails alone, so a test counting "how many times was
 *  this issue fetched" must not count it. */
const isThreadCall = (args: string[]) => args[0] === "api" && args[1] === "graphql";

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
      // The board half and the thread half are not the subject: both are separate
      // calls by design, and both fail without failing the detail read.
      if (!isBoardCall(args) && !isThreadCall(args)) calls.push(args[1] ?? "");
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
  expect(store.updateSession("session_one", { title: "Renamed" }).model?.model).toBe("claude-opus-5[1m]");
});

test("fast mode survives a selection that names no model", () => {
  // A Claude-side switch the composer offers on the provider default, so it has
  // to survive a selection that names no model at all — and it now travels
  // beside the long-window default the claim supplies, because Telar publishes
  // no short Claude rows for a turn to fall back to.
  const { store } = readyStore();
  const session = store.getSession("session_one");
  store.updateSession("session_one", { model: { instanceId: session.providerInstanceId, fastMode: true } });
  store.submitTurn("session_one", { runId: "run_one", input: "hi" });
  expect(store.claimNextTurn("worker_one")?.model).toEqual({ instanceId: session.providerInstanceId, fastMode: true, model: "claude-opus-5[1m]" });
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

test("task reports between turns fold onto the rows they name, and open nothing", () => {
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Watch it" });
  const first = store.claimNextTurn("worker_one")!;
  const token = first.turn.claim!.token;
  store.markRunning("session_one", "run_one", token);
  store.ingestObservations("session_one", "run_one", token, [
    { kind: "task.started", task: { id: "task_toolu_bg", providerTaskId: "bg1", kind: "background", backgrounded: true, state: "running", title: "Wait for CI" } },
  ]);
  store.completeTurn("session_one", "run_one", token, { text: "Watching" });
  expect(store.getSession("session_one").activity).toBe("monitoring");

  // The shell ends while the session is idle: no claim, no turn.
  const accepted = store.reportSessionTasks("session_one", "worker_one", [
    { kind: "task.completed", task: { id: "task_toolu_bg", providerTaskId: "bg1", kind: "background", state: "completed", resultText: "green" } },
    // A row nobody opened is not minted here.
    { kind: "task.started", task: { id: "task_ghost", kind: "agent", state: "running" } },
  ]);
  expect(accepted).toEqual({ accepted: 1 });
  expect(store.tasks("session_one")).toHaveLength(1);
  expect(store.tasks("session_one")[0]).toMatchObject({ id: "task_toolu_bg", state: "completed", resultText: "green", runId: "run_one" });
  expect(store.getSession("session_one").activity).toBe("idle");
  expect(store.readEvents("session_one").at(-1)).toMatchObject({ type: "task.completed", runId: "run_one" });
});

test("a claim carries the session's live task rows, and only those, as seeds", () => {
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Watch it" });
  const first = store.claimNextTurn("worker_one")!;
  const token = first.turn.claim!.token;
  store.markRunning("session_one", "run_one", token);
  store.ingestObservations("session_one", "run_one", token, [
    { kind: "task.started", task: { id: "task_toolu_ci", providerTaskId: "b7ohaj89n", kind: "background", backgrounded: true, state: "running", title: "Wait for CI" } },
    { kind: "task.started", task: { id: "task_toolu_done", providerTaskId: "x1", kind: "agent", state: "completed", title: "Explore" } },
  ]);
  store.completeTurn("session_one", "run_one", token, { text: "Watching" });

  store.submitTurn("session_one", { runId: "run_two", input: "Next" });
  const second = store.claimNextTurn("worker_one")!;
  // The seed is a `TaskSeed`: the engine-minted fields are stripped.
  expect(second.tasks).toEqual([
    { id: "task_toolu_ci", providerTaskId: "b7ohaj89n", kind: "background", backgrounded: true, state: "running", title: "Wait for CI" },
  ]);
});

test("a settled task is not re-announced by a report that adds nothing", () => {
  /**
   * MEASURED: 58 tasks in one session with two or more `task.completed`
   * events, one of them closed a third time under a turn that had started
   * zero seconds earlier — the next turn's pump replayed the CLI's buffered
   * frames about a shell the cockpit had already stopped. The store already
   * kept the state; it still appended an event per report, and a tailing
   * client folded each as a fresh completion.
   */
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Watch it" });
  const first = store.claimNextTurn("worker_one")!;
  const token = first.turn.claim!.token;
  store.markRunning("session_one", "run_one", token);
  store.ingestObservations("session_one", "run_one", token, [
    { kind: "task.started", task: { id: "task_toolu_mon", providerTaskId: "b7ohaj89n", kind: "background", state: "running", title: "Tick" } },
  ]);
  store.completeTurn("session_one", "run_one", token, { text: "Watching" });
  expect(store.stopBackgroundTasks("session_one")).toBe(1);

  store.submitTurn("session_one", { runId: "run_two", input: "Next" });
  const second = store.claimNextTurn("worker_one")!;
  const token2 = second.turn.claim!.token;
  store.markRunning("session_one", "run_two", token2);
  // A bare restatement of the ending — the CLI's late `task_updated{killed}`.
  store.ingestObservations("session_one", "run_two", token2, [
    { kind: "task.completed", task: { id: "task_toolu_mon", providerTaskId: "b7ohaj89n", kind: "background", state: "stopped" } },
    { kind: "task.completed", task: { id: "task_b7ohaj89n", providerTaskId: "b7ohaj89n", kind: "agent", state: "completed" } },
  ]);
  const closes = () => store.readEvents("session_one").filter((event) => event.type === "task.completed");
  expect(closes()).toHaveLength(1);
  // The summary the notification carries IS new — it lands on the row, but
  // a summary arriving a frame after the close is not a second close.
  store.ingestObservations("session_one", "run_two", token2, [
    { kind: "task.completed", task: { id: "task_b7ohaj89n", providerTaskId: "b7ohaj89n", kind: "agent", state: "completed", resultText: "tick 2" } },
  ]);
  expect(closes()).toHaveLength(1);
  expect(store.tasks("session_one")).toHaveLength(1);
  expect(store.tasks("session_one")[0]).toMatchObject({ id: "task_toolu_mon", kind: "background", state: "stopped", resultText: "tick 2" });
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

test("a backgrounded agent outlives its turn, and a later report cannot resurrect what was closed", () => {
  /**
   * TWO HALVES OF ONE SCREENSHOT. Three Explore agents launched detached; the
   * turn ended; all three rows went red with "the turn ended before this agent
   * reported back" while they were still running. Then, worse: their progress
   * lines kept arriving through the NEXT turn, the fold spread the closed
   * record under a `running` seed, and each row read Failed AND spinning —
   * `state: "running"` with `failure` and `completedAt` both set.
   */
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Fan out" });
  const claim = store.claimNextTurn("worker_one")!;
  const token = claim.turn.claim!.token;
  store.markRunning("session_one", "run_one", token);
  store.ingestObservations("session_one", "run_one", token, [
    { kind: "task.started", task: { id: "task_detached", kind: "agent", backgrounded: true, state: "running", title: "Explore, detached" } },
    { kind: "task.started", task: { id: "task_attached", kind: "agent", state: "running", title: "Explore, attached" } },
  ]);
  store.completeTurn("session_one", "run_one", token, { text: "Launched them" });

  const after = new Map(store.tasks("session_one").map((task) => [task.id, task]));
  // The attached agent is swept — no process reports for it any more. The
  // detached one is spared exactly as a background shell would be, and it
  // keeps the session working, not merely monitoring.
  expect(after.get("task_attached")).toMatchObject({ state: "failed" });
  expect(after.get("task_detached")).toMatchObject({ state: "running", kind: "agent", backgrounded: true });
  expect(after.get("task_detached")?.failure).toBeUndefined();
  expect(store.getSession("session_one").activity).toBe("working");

  // The next turn's driver has never heard of the sweep and reports the
  // ATTACHED agent (now closed) as still running. The first ending is the
  // ending: the record stays failed, and a report that adds nothing to a
  // settled row is not announced at all — neither as progress on a corpse
  // nor as a second completion.
  store.submitTurn("session_one", { runId: "run_two", input: "Carry on" });
  const second = store.claimNextTurn("worker_one")!;
  const secondToken = second.turn.claim!.token;
  store.markRunning("session_one", "run_two", secondToken);
  store.ingestObservations("session_one", "run_two", secondToken, [
    { kind: "task.progress", task: { id: "task_attached", kind: "agent", state: "running" }, message: "Reading a file" },
    { kind: "task.progress", task: { id: "task_detached", kind: "agent", backgrounded: true, state: "running" }, message: "Reading a file" },
  ]);
  const later = new Map(store.tasks("session_one").map((task) => [task.id, task]));
  expect(later.get("task_attached")).toMatchObject({ state: "failed", failure: "the turn ended before this agent reported back" });
  expect(later.get("task_attached")?.completedAt).toBeDefined();
  const closes = store.readEvents("session_one").filter((event) => event.type === "task.completed");
  expect(closes).toHaveLength(1);
  expect(store.readEvents("session_one").at(-1)).toMatchObject({ type: "task.progress", task: { id: "task_detached" } });
  // The live one is live, still, with no failure riding along.
  expect(later.get("task_detached")).toMatchObject({ state: "running" });
  expect(later.get("task_detached")?.completedAt).toBeUndefined();
});

test("the inbox policy is one document, defaulted rather than absent", () => {
  // THE POLICY HALF OF SETTLING. The per-session pin says "not this one"; this
  // says how long anything stays in the list at all — and it is on the engine
  // so the desktop shell and a browser tab band the same sessions the same way.
  const { store } = readyStore();
  // The delegation grace rides the same document (#378) and defaults with it.
  const grace = { settleDelegatedAfterHours: 1 };
  expect(store.getInboxPolicy()).toEqual({ autoSettleAfterHours: 72, ...grace });

  expect(store.setInboxPolicy({ autoSettleAfterHours: 14 })).toEqual({ autoSettleAfterHours: 14, ...grace });
  expect(store.getInboxPolicy()).toEqual({ autoSettleAfterHours: 14, ...grace });

  // `null` IS THE OFF SWITCH, and it is a value rather than an omission:
  // "never" is an answer, not a very large duration.
  expect(store.setInboxPolicy({ autoSettleAfterHours: null })).toEqual({ autoSettleAfterHours: null, ...grace });
  // An empty patch changes nothing rather than resetting anything.
  expect(store.setInboxPolicy({})).toEqual({ autoSettleAfterHours: null, ...grace });

  for (const bad of [0, 90 * 24 + 1, 3.5, "7", Number.NaN]) {
    expect(() => store.setInboxPolicy({ autoSettleAfterHours: bad })).toThrow(EngineStateError);
  }
  // …and the refusal left the stored answer alone.
  expect(store.getInboxPolicy()).toEqual({ autoSettleAfterHours: null, ...grace });
});

test("a days-shaped inbox document from before the hours move still means what it said", () => {
  const { store, root: stateRoot } = readyStore();
  const grace = { settleDelegatedAfterHours: 1 };
  fs.writeFileSync(path.join(stateRoot, "inbox.json"), '{"version":2,"autoSettleAfterDays":2}');
  expect(store.getInboxPolicy()).toEqual({ autoSettleAfterHours: 48, ...grace });
  fs.writeFileSync(path.join(stateRoot, "inbox.json"), '{"version":2,"autoSettleAfterDays":null}');
  expect(store.getInboxPolicy()).toEqual({ autoSettleAfterHours: null, ...grace });
});

test("a policy written before the delegation grace keeps its own window — #378", () => {
  // THE FIELD IS DEFAULTED RATHER THAN REQUIRED FOR EXACTLY THIS. A required
  // one would fail the schema on every stored document, and a failed parse
  // here answers with the whole default — silently replacing the window
  // somebody chose with 72 hours.
  const { store, root: stateRoot } = readyStore();
  fs.writeFileSync(path.join(stateRoot, "inbox.json"), '{"version":2,"autoSettleAfterHours":6}');
  expect(store.getInboxPolicy()).toEqual({ autoSettleAfterHours: 6, settleDelegatedAfterHours: 1 });
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

test("the sidebar layout round-trips, dedupes, and refuses a shape that is not a list of keys", () => {
  // WHERE EACH PROJECT GROUP SITS. Empty by default — the rail reads that as
  // "alphabetical, nobody has moved anything" — and on the engine so the
  // desktop shell, a browser tab and a paired phone draw one arrangement.
  const { store } = readyStore();
  const blank = { projectOrder: [], sessionOrder: {}, pinnedOrder: [] };
  expect(store.getSidebarLayout()).toEqual(blank);

  expect(store.setSidebarLayout({ projectOrder: ["b", "h1:a", "a"] })).toEqual({ ...blank, projectOrder: ["b", "h1:a", "a"] });
  expect(store.getSidebarLayout()).toEqual({ ...blank, projectOrder: ["b", "h1:a", "a"] });
  // An empty patch changes nothing rather than resetting anything.
  expect(store.setSidebarLayout({})).toEqual({ ...blank, projectOrder: ["b", "h1:a", "a"] });
  // A key said twice is kept once, at its first position.
  expect(store.setSidebarLayout({ projectOrder: ["a", "b", "a"] })).toEqual({ ...blank, projectOrder: ["a", "b"] });

  for (const bad of ["a", null, [1], [""], [{ key: "a" }], Array.from({ length: 1001 }, (_, i) => `k${i}`)]) {
    expect(() => store.setSidebarLayout({ projectOrder: bad })).toThrow(EngineStateError);
  }
  // …and the refusal left the stored answer alone.
  expect(store.getSidebarLayout()).toEqual({ ...blank, projectOrder: ["a", "b"] });
});

test("the rows inside a group and inside pinned are arranged by their own fields", () => {
  // Each of the three is patched on its own: the rail writes ONE of them per
  // drop, and a write that also sent the other two would let a stale copy of
  // this document overwrite an arrangement another window had just made.
  const { store } = readyStore();
  store.setSidebarLayout({ projectOrder: ["p1"] });

  expect(store.setSidebarLayout({ sessionOrder: { p1: ["s2", "s1"] } })).toEqual({
    projectOrder: ["p1"],
    sessionOrder: { p1: ["s2", "s1"] },
    pinnedOrder: [],
  });
  // The pinned write leaves the group arrangement — and the project one — alone.
  expect(store.setSidebarLayout({ pinnedOrder: ["h1:s9", "s8", "s8"] })).toEqual({
    projectOrder: ["p1"],
    sessionOrder: { p1: ["s2", "s1"] },
    pinnedOrder: ["h1:s9", "s8"],
  });
  // A key said twice inside a group list is kept once too.
  expect(store.setSidebarLayout({ sessionOrder: { p1: ["s1", "s2", "s1"] } }).sessionOrder).toEqual({ p1: ["s1", "s2"] });

  for (const bad of ["a", null, { p1: "s1" }, { p1: [""] }, { "": ["s1"] }, { p1: Array.from({ length: 1001 }, (_, i) => `s${i}`) }]) {
    expect(() => store.setSidebarLayout({ sessionOrder: bad })).toThrow(EngineStateError);
  }
  for (const bad of ["a", [1], [""], Array.from({ length: 1001 }, (_, i) => `s${i}`)]) {
    expect(() => store.setSidebarLayout({ pinnedOrder: bad })).toThrow(EngineStateError);
  }
  expect(store.getSidebarLayout()).toEqual({ projectOrder: ["p1"], sessionOrder: { p1: ["s1", "s2"] }, pinnedOrder: ["h1:s9", "s8"] });
});

test("the live-session read carries the arrangement, so a drag on one device reaches the others", () => {
  // THE PROPAGATION PATH. Every rail — the desktop shell, a browser tab, the
  // phone — polls this one route on its own cadence already; carrying the
  // layout on it is what lets a second device learn about a drop without a new
  // request, a new timer or a new connection. A blank document rides along too:
  // "nobody has arranged anything" is an answer, and a client that got no key
  // could not tell it from an engine too old to have one.
  const { store } = readyStore();
  expect(store.liveSessions().layout).toEqual({ projectOrder: [], sessionOrder: {}, pinnedOrder: [] });

  store.setSidebarLayout({ projectOrder: ["p2", "p1"] });
  store.setSidebarLayout({ sessionOrder: { p1: ["s2", "s1"] } });
  store.setSidebarLayout({ pinnedOrder: ["s9"] });
  expect(store.liveSessions().layout).toEqual({
    projectOrder: ["p2", "p1"],
    sessionOrder: { p1: ["s2", "s1"] },
    pinnedOrder: ["s9"],
  });
});

test("a malformed sidebar-layout document costs the arrangement, never the list", () => {
  const { store, root: stateRoot } = readyStore();
  const blank = { projectOrder: [], sessionOrder: {}, pinnedOrder: [] };
  fs.writeFileSync(path.join(stateRoot, "sidebar-layout.json"), '{"version":2,"projectOrder":"b,a"}');
  expect(store.getSidebarLayout()).toEqual(blank);
  fs.writeFileSync(path.join(stateRoot, "sidebar-layout.json"), "not json at all");
  expect(store.getSidebarLayout()).toEqual(blank);
  // A document written before the row arrangements existed still parses — it
  // means "nobody has arranged any rows", not "this file is broken".
  fs.writeFileSync(path.join(stateRoot, "sidebar-layout.json"), '{"version":2,"projectOrder":["b","a"]}');
  expect(store.getSidebarLayout()).toEqual({ ...blank, projectOrder: ["b", "a"] });
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
  const whole = { autoSettleAfterHours: 72, settleDelegatedAfterHours: 1 };
  fs.writeFileSync(path.join(stateRoot, "inbox.json"), '{"version":1,"autoSettleAfterDays":"soon"}');
  expect(store.getInboxPolicy()).toEqual(whole);
  fs.writeFileSync(path.join(stateRoot, "inbox.json"), "not json at all");
  expect(store.getInboxPolicy()).toEqual(whole);
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

test("a compaction is a kind of turn, and only one may be in flight", () => {
  const { store } = readyStore();
  const first = store.submitTurn("session_one", { runId: "run_c1", input: "/compact", kind: "compact" });
  expect(first.turn.kind).toBe("compact");
  // A second press while the first is queued: refused, not queued behind it.
  expect(() => store.submitTurn("session_one", { runId: "run_c2", input: "/compact", kind: "compact" })).toThrow(
    "a compaction is already queued or running",
  );
  // An ordinary message is still welcome behind it.
  const message = store.submitTurn("session_one", { runId: "run_m1", input: "hello" });
  expect(message.turn.kind).toBeUndefined();
  // Once the compaction settles, another may be asked for.
  const claim = store.claimNextTurn("worker_one")!;
  store.markRunning("session_one", "run_c1", claim.turn.claim!.token);
  store.completeTurn("session_one", "run_c1", claim.turn.claim!.token, { text: "" });
  expect(store.submitTurn("session_one", { runId: "run_c3", input: "/compact", kind: "compact" }).turn.kind).toBe("compact");
});

test("a later turn's report on a task it knows only by provider id folds onto the existing row", () => {
  /**
   * MEASURED: monitor b7ohaj89n was announced under `task_toolu_01FD…`
   * (background) and, after the cockpit stopped it, the NEXT turn's driver saw
   * its `task_notification` — which carries `task_id` and no `tool_use_id` —
   * and minted `task_b7ohaj89n`, kind agent, state completed. Two rows for
   * one shell, the second on the Agents surface reading "Done".
   */
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Watch" });
  const first = store.claimNextTurn("worker_one")!;
  store.markRunning("session_one", "run_one", first.turn.claim!.token);
  store.ingestObservations("session_one", "run_one", first.turn.claim!.token, [
    { kind: "task.started", task: { id: "task_toolu_mon", kind: "background", state: "running", title: "Monitor", providerTaskId: "b7ohaj89n", backgrounded: true } },
  ]);
  store.completeTurn("session_one", "run_one", first.turn.claim!.token, { text: "armed" });
  expect(store.stopBackgroundTasks("session_one")).toBe(1);

  store.submitTurn("session_one", { runId: "run_two", input: "Next" });
  const second = store.claimNextTurn("worker_one")!;
  store.markRunning("session_one", "run_two", second.turn.claim!.token);
  store.ingestObservations("session_one", "run_two", second.turn.claim!.token, [
    { kind: "task.completed", task: { id: "task_b7ohaj89n", kind: "agent", state: "completed", providerTaskId: "b7ohaj89n", resultText: "stream ended" } },
  ]);
  const tasks = store.tasks("session_one");
  expect(tasks).toHaveLength(1);
  // The stopped ending stands; the kind stands; the summary still folds in.
  expect(tasks[0]).toMatchObject({ id: "task_toolu_mon", kind: "background", state: "stopped", resultText: "stream ended" });
});

// ── the claimed→running window (#209) ───────────────────────────────────────

describe("a message typed into a session that had already been claimed", () => {
  /**
   * The window: `steerIfRunning` needs a turn that is `running` with a claim,
   * because `claimed` is the engine's proof that no provider was spawned. A
   * message arriving between the claim and `markTurnRunning` could not steer,
   * and nothing reconsidered it — it ran later as a turn of its own, though
   * the person had typed it into a session the composer showed as live.
   *
   * THE BOUNDARY IS SUBMISSION ORDER, not time. Every test here runs on this
   * file's FROZEN clock, which is the point: an earlier attempt compared
   * `acceptedAt` against `claim.at` and could not separate a claim from a
   * message submitted in the same millisecond — the exact case a person
   * typing at a busy session produces.
   */
  test("the same-millisecond case: submitted after the claim, steered into that turn when it starts", () => {
    const { store } = readyStore();
    // Everything below happens at t=100. Order is all that distinguishes it.
    store.submitTurn("session_one", { runId: "run_live", input: "do the thing" });
    const claim = store.claimTurn("session_one", "worker_one")!;
    expect(claim.runId).toBe("run_live");
    // `run_live` took sequence 1, so the next message will be 2 — and that is
    // the watermark: at or above it means "written after this claim".
    expect(claim.claim!.sequence).toBe(2);

    store.submitTurn("session_one", { runId: "run_typed", input: "Hello?" });
    // Still no provider to steer into, exactly as before.
    expect(store.turns("session_one").find((turn) => turn.runId === "run_typed")!.state).toBe("queued");

    store.markRunning("session_one", "run_live", claim.claim!.token);
    expect(store.turns("session_one").find((turn) => turn.runId === "run_typed")).toMatchObject({
      state: "steering",
      steer: { intoRunId: "run_live" },
    });
    // A real delivery, not a state flip: the worker is told.
    expect(store.steerForWorker("worker_one").find((each) => each.steerRunId === "run_typed")).toMatchObject({
      runId: "run_live",
      text: "Hello?",
    });
    // And the journal says the turn began before anything was steered into it.
    const events = store.readEvents("session_one");
    const started = events.findIndex((event) => event.type === "turn.started" && event.runId === "run_live");
    const steering = events.findIndex((event) => event.type === "turn.steering" && event.runId === "run_typed");
    expect(started).toBeGreaterThan(-1);
    expect(steering).toBeGreaterThan(started);
  });

  test("a backlog written BEFORE the claim stays a backlog", () => {
    // Its author was not steering anything — the session was idle when they
    // wrote it. Sweeping it in would collapse a queued conversation into one
    // turn, which is a different bug in the opposite direction.
    const { store } = readyStore();
    store.submitTurn("session_one", { runId: "run_first", input: "do the thing" });
    store.submitTurn("session_one", { runId: "run_backlog", input: "then this" });
    const claim = store.claimTurn("session_one", "worker_one")!;
    store.markRunning("session_one", "run_first", claim.claim!.token);
    expect(store.turns("session_one").find((turn) => turn.runId === "run_backlog")!.state).toBe("queued");
    expect(store.steerForWorker("worker_one")).toEqual([]);
  });

  test("a STOP before the start ends the claim, so the start is refused and the late message is settled", () => {
    const { store } = readyStore();
    store.submitTurn("session_one", { runId: "run_live", input: "work" });
    const claim = store.claimTurn("session_one", "worker_one")!;
    store.submitTurn("session_one", { runId: "run_late", input: "typed late" });
    store.stopSession("session_one");

    // The claimed turn was stopped, so there is nothing left to start.
    expect(() => store.markRunning("session_one", "run_live", claim.claim!.token)).toThrow(EngineStateError);
    // And the message written into the window is settled with it — not held
    // for a decision, and not left to run by itself later.
    expect(store.turns("session_one").find((turn) => turn.runId === "run_late")).toMatchObject({ state: "stopped", stopReason: "user" });
    expect(store.claimTurn("session_one", "worker_two")).toBeUndefined();
  });

  test("a STOP after the start takes the steered message with it", () => {
    const { store } = readyStore();
    store.submitTurn("session_one", { runId: "run_live", input: "work" });
    const claim = store.claimTurn("session_one", "worker_one")!;
    store.submitTurn("session_one", { runId: "run_late", input: "typed late" });
    store.markRunning("session_one", "run_live", claim.claim!.token);
    expect(store.turns("session_one").find((turn) => turn.runId === "run_late")?.state).toBe("steering");

    store.stopSession("session_one");
    const late = store.turns("session_one").find((turn) => turn.runId === "run_late")!;
    // Undelivered, so it ends here rather than going back to the queue to be
    // claimed a heartbeat later — which is what made Stop start the next thing.
    expect(late).toMatchObject({ state: "stopped", stopReason: "user", input: "typed late" });
    expect(late.held).toBeUndefined();
  });

  test("a CLAIMED COMPACTION takes no message: there is no conversation to interrupt", () => {
    // The target being a compaction is the same refusal `promoteTurn` makes
    // from the other side, and Codex rejects steering a compact turn at the
    // protocol level.
    const { store } = readyStore();
    store.submitTurn("session_one", { runId: "run_squeeze", input: "/compact", kind: "compact" });
    const claim = store.claimTurn("session_one", "worker_one")!;
    expect(claim.runId).toBe("run_squeeze");
    store.submitTurn("session_one", { runId: "run_typed", input: "Hello?" });
    store.markRunning("session_one", "run_squeeze", claim.claim!.token);
    expect(store.turns("session_one").find((turn) => turn.runId === "run_typed")!.state).toBe("queued");
    expect(store.steerForWorker("worker_one")).toEqual([]);
  });

  test("a COMPACTION submitted into the window still waits its turn", () => {
    const { store } = readyStore();
    store.submitTurn("session_one", { runId: "run_live", input: "work" });
    const claim = store.claimTurn("session_one", "worker_one")!;
    store.submitTurn("session_one", { runId: "run_squeeze", input: "/compact", kind: "compact" });
    store.markRunning("session_one", "run_live", claim.claim!.token);
    expect(store.turns("session_one").find((turn) => turn.runId === "run_squeeze")!.state).toBe("queued");
  });

  test("a target REQUEUED and claimed again does not inherit the old window's messages", () => {
    /**
     * The watermark rides the claim, so a re-claim takes a new one. The turn
     * that eventually runs is a fresh attempt — it never saw the first one —
     * and a message written into the abandoned attempt is an ordinary queued
     * message again rather than being steered into a turn that has no memory
     * of the window it was written in.
     */
    const { store } = readyStore();
    store.submitTurn("session_one", { runId: "run_live", input: "work" });
    const first = store.claimTurn("session_one", "worker_one")!;
    expect(first.claim!.sequence).toBe(2);
    store.submitTurn("session_one", { runId: "run_typed", input: "Hello?" });

    /**
     * The worker vanishes before it ever marked the turn running. Its claim
     * ENDS with it: requeueing would replay work nobody asked to re-run, and
     * leaving it `claimed` would block the session for ever behind a worker
     * that no longer exists.
     */
    store.retireWorkerRegistration("worker_one");
    expect(store.turns("session_one").find((turn) => turn.runId === "run_live")).toMatchObject({
      state: "stopped",
      stopReason: "worker_unavailable",
    });
    // The message written into the abandoned attempt's window is NOT swept up
    // with it — it was never that worker's, and the person still means it.
    expect(store.turns("session_one").find((turn) => turn.runId === "run_typed")!.state).toBe("queued");
    // So it is what runs next, on its own terms rather than steered into a
    // turn that no longer exists.
    const second = store.claimTurn("session_one", "worker_two")!;
    expect(second.runId).toBe("run_typed");
    store.markRunning("session_one", "run_typed", second.claim!.token);
    expect(store.steerForWorker("worker_two")).toEqual([]);
  });

  test("a claim written before the watermark existed promotes nothing", () => {
    // Forward courtesy for a queue.json on disk from an older engine: absent
    // means "the behaviour this claim was written under", never "promote all".
    const { store, root: stateRoot } = readyStore();
    store.submitTurn("session_one", { runId: "run_live", input: "work" });
    const claim = store.claimTurn("session_one", "worker_one")!;
    store.submitTurn("session_one", { runId: "run_typed", input: "Hello?" });

    const queueFile = path.join(stateRoot, "sessions", "session_one", "queue.json");
    const queue = JSON.parse(fs.readFileSync(queueFile, "utf8"));
    for (const turn of queue.turns) if (turn.claim) delete turn.claim.sequence;
    fs.writeFileSync(queueFile, JSON.stringify(queue));

    store.markRunning("session_one", "run_live", claim.claim!.token);
    expect(store.turns("session_one").find((turn) => turn.runId === "run_typed")!.state).toBe("queued");
  });
});

// ── subscriptions — one session woken by another ────────────────────────────

describe("subscriptions", () => {
  /** A second session beside `session_one`, and a helper that runs one turn on
   *  a session to completion the way a worker would. */
  function pair(): { store: EngineStore } {
    const { store } = readyStore();
    store.createSession({ id: "session_two", projectId: "project_one", title: "the worker" });
    return { store };
  }
  function runTurn(store: EngineStore, sessionId: string, runId: string, end: "complete" | "fail" | "stop" | "park" = "complete"): void {
    store.submitTurn(sessionId, { runId, input: "work" });
    const token = store.claimTurn(sessionId, "worker_one")!.claim!.token;
    store.markRunning(sessionId, runId, token);
    if (end === "complete") store.completeTurn(sessionId, runId, token, { text: "all done: " + "x".repeat(3_000) });
    if (end === "fail") store.failTurn(sessionId, runId, token, { code: "driver_failed", message: "the CLI died" });
    if (end === "stop") store.stopTurn(sessionId, runId);
    if (end === "park") {
      store.updateSession(sessionId, { runtimeMode: "approval-required" });
      store.openRequest(sessionId, runId, token, {
        requestId: "req_q",
        kind: "user_input",
        detail: { kind: "user_input", prompt: "Which database?", fields: [{ key: "db", label: "Database", kind: "choice", choices: ["postgres", "sqlite"] }] },
      });
    }
  }
  const wakes = (store: EngineStore, sessionId: string) => store.turns(sessionId).filter((turn) => turn.origin === "session");
  /**
   * THE WAKE'S WORDS, WHEREVER THEY LIVE — #550 moved them off `input`.
   *
   * The engine writes a wake's prose, so it is no longer stored in the slot a
   * person's words occupy: `input` is a machine label and the notice is the
   * notification's `body`. Everything these tests assert about the notice — that
   * it is a ping, that it carries no result body, that it names the one fetch
   * call — is unchanged; only where to read it is.
   */
  const notice = (turn: Turn) => turn.notification?.body ?? turn.input;

  test("a wake landing on a RUNNING subscriber keeps its identity all the way to the worker, and through requeue and pause (#194)", () => {
    /**
     * THE REGRESSION. `submitTurn` steers whatever it accepts when a turn is
     * running, and a wake is accepted the same way — but `steerForWorker`
     * forwarded only `sender`, so the engine's own announcement about a peer
     * reached the driver as anonymous text and was rendered, and read by the
     * model, as the person typing. Idle delivery drew a wake row; running
     * delivery drew a human bubble. Same happening, same session, different
     * attribution — decided only by whether a turn was in flight.
     */
    const { store } = pair();
    // #550 MADE THE STEER THE OPT-IN. `settled_only` is the default now, so a
    // wake landing on a busy subscriber is held rather than steered — the case
    // below this one. `always` is what still reaches the worker mid-turn, and
    // the identity invariant this test pins is unchanged on that path.
    store.subscribe("session_one", { targetSessionId: "session_two", events: ["turn_completed"], completionWake: "always" });
    // session_one is BUSY when the wake arrives — the whole point.
    store.submitTurn("session_one", { runId: "run_busy", input: "thinking" });
    const busy = store.claimTurn("session_one", "worker_one")!;
    store.markRunning("session_one", "run_busy", busy.claim!.token);

    runTurn(store, "session_two", "run_w");

    const [wake] = wakes(store, "session_one");
    expect(wake).toMatchObject({ origin: "session", state: "steering", wakeReason: { kind: "turn_completed", sessionId: "session_two", runId: "run_w" } });

    // The delivery the worker actually receives is where it used to be lost.
    const delivery = store.steerForWorker("worker_one").find((each) => each.steerRunId === wake!.runId);
    expect(delivery).toBeDefined();
    expect(delivery!.wakeReason).toEqual({ kind: "turn_completed", sessionId: "session_two", runId: "run_w" });
    // A wake is nobody's message: it is not an agent's either.
    expect(delivery!.sender).toBeUndefined();
    // A person's steer beside it stays exactly as bare as it was.
    store.submitTurn("session_one", { runId: "run_typed", input: "and me" });
    const typed = store.steerForWorker("worker_one").find((each) => each.steerRunId === "run_typed")!;
    expect(typed.wakeReason).toBeUndefined();
    expect(typed.sender).toBeUndefined();

    // UNDELIVERED → REQUEUED, identity intact: the running turn settles before
    // the worker took either message, so both come back as ordinary queued
    // turns — and the wake must not come back as a human one.
    store.completeTurn("session_one", "run_busy", busy.claim!.token, { text: "done" });
    const requeued = store.turns("session_one").find((turn) => turn.runId === wake!.runId)!;
    expect(requeued).toMatchObject({ state: "queued", origin: "session", wakeReason: { kind: "turn_completed", sessionId: "session_two", runId: "run_w" } });

    // AND ACROSS A PAUSE. A held wake is still a wake when the human resumes.
    store.pauseSession("session_one");
    const held = store.turns("session_one").find((turn) => turn.runId === wake!.runId)!;
    expect(held.origin).toBe("session");
    expect(held.wakeReason).toMatchObject({ kind: "turn_completed", sessionId: "session_two" });
    // Read cold, from a second store instance over the same files.
    const cold = new EngineStore(store.paths.root, () => 100).turns("session_one").find((turn) => turn.runId === wake!.runId)!;
    expect(cold.origin).toBe("session");
    expect(cold.wakeReason).toMatchObject({ kind: "turn_completed", sessionId: "session_two", runId: "run_w" });
  });

  test("a completed turn queues a wake that PINGS: no result body, and the call that fetches one", () => {
    /**
     * A wake lands in the subscriber's context whether or not it needs the
     * answer, so it carries none. The child here answers with 3 000 characters;
     * the notice must contain neither them nor a clipped prefix of them — only
     * the size, and the run-scoped read that fetches the text on demand.
     */
    const { store } = pair();
    const subscription = store.subscribe("session_one", { targetSessionId: "session_two" });
    expect(subscription.events).toEqual(["turn_completed", "turn_failed", "turn_stopped", "request_opened"]);
    runTurn(store, "session_two", "run_w");

    const [wake] = wakes(store, "session_one");
    expect(wake).toMatchObject({ origin: "session", state: "queued", wakeReason: { kind: "turn_completed", sessionId: "session_two", runId: "run_w" } });
    expect(notice(wake!).startsWith("[wake: completed] Session session_two \"the worker\" — turn run_w completed.")).toBe(true);
    // Not one character of the answer, not even a prefix of it.
    expect(notice(wake!)).not.toContain("all done");
    expect(notice(wake!)).not.toContain("xxxxxxxxxx");
    expect(notice(wake!)).toContain("characters. The text is not in this notice.");
    // The whole notice stays small whatever the child wrote.
    expect(notice(wake!).length).toBeLessThan(600);
    expect(notice(wake!)).toContain('sessions_read(sessionId: "session_two", runId: "run_w")');
    // The accept, then the notification's own row — written at accept rather
    // than when a provider gets round to it, so a queued wake is visible in the
    // transcript while the session is still busy. See `writeNotificationItem`.
    expect(store.readEvents("session_one").filter((event) => event.type === "turn.accepted").at(-1)).toMatchObject({
      type: "turn.accepted",
      turn: { origin: "session" },
    });
    expect(store.readEvents("session_one").at(-1)).toMatchObject({ type: "item.completed", item: { detail: { type: "notification" } } });
    // The file is at the engine root and outlives the store instance.
    expect(new EngineStore(store.paths.root, () => 100).subscriptionsFor("session_one")).toHaveLength(1);
  });

  test("failed, stopped and parked each wake with their own reason; a policy-resolved request wakes nobody", () => {
    const { store } = pair();
    store.subscribe("session_one", { targetSessionId: "session_two" });
    runTurn(store, "session_two", "run_f", "fail");
    runTurn(store, "session_two", "run_s", "stop");
    runTurn(store, "session_two", "run_p", "park");

    const kinds = wakes(store, "session_one").map((turn) => turn.wakeReason!.kind);
    expect(kinds).toEqual(["turn_failed", "turn_stopped", "request_opened"]);
    const [failed, , parked] = wakes(store, "session_one");
    expect(notice(failed!)).toContain("FAILED (driver_failed)");
    expect(notice(failed!)).toContain("the CLI died");
    expect(parked!.wakeReason).toMatchObject({ requestId: "req_q", runId: "run_p" });
    // The short title says what it is; the fields are a read away, not here.
    expect(notice(parked!)).toContain("Which database?");
    expect(notice(parked!)).not.toContain("choices:");
    // A PARKED REQUEST IS ITS OWN NOTIFICATION KIND — it is the one a recipient
    // can act on, and answering is a different verb from reading an outcome.
    expect(parked!.notification!.kind).toBe("request");
    expect(parked!.notification!.requestId).toBe("req_q");
    expect(failed!.notification!.kind).toBe("wake");
    expect(notice(parked!)).not.toContain("- db (choice)");
    expect(notice(parked!)).toContain('sessions_read(sessionId: "session_two", runId: "run_p")');
    expect(notice(parked!)).toContain("sessions_resolve_request");

    // Under `auto`, a command resolves itself — nothing parked, nothing to wake for.
    store.updateSession("session_two", { runtimeMode: "auto" });
    const token = store.turns("session_two").find((turn) => turn.runId === "run_p")!.claim!.token;
    store.openRequest("session_two", "run_p", token, { requestId: "req_auto", kind: "file_read", detail: { kind: "file_read", read: { path: "/x" } } });
    expect(wakes(store, "session_one")).toHaveLength(3);
  });

  test("a parked request's notice carries NO fields — only what it is, and the two calls", () => {
    /**
     * A PING, INCLUDING WHEN SOMETHING IS WAITING. The fields used to ride the
     * notice so an answer could be composed without a second read, which made
     * this the one notice whose size followed its payload. A coordinator about
     * to answer a question can afford the read it needs to answer properly.
     */
    const { store } = pair();
    store.subscribe("session_one", { targetSessionId: "session_two" });
    store.updateSession("session_two", { runtimeMode: "approval-required" });
    store.submitTurn("session_two", { runId: "run_many", input: "work" });
    const token = store.claimTurn("session_two", "worker_one")!.claim!.token;
    store.markRunning("session_two", "run_many", token);
    store.openRequest("session_two", "run_many", token, {
      requestId: "req_many",
      kind: "user_input",
      detail: {
        kind: "user_input",
        prompt: `Pick: ${"p".repeat(4_000)}`,
        fields: Array.from({ length: 30 }, (_, index) => ({
          key: `field_${index}`,
          label: `Label ${index} ${"l".repeat(500)}`,
          kind: "choice" as const,
          choices: Array.from({ length: 30 }, (_, choice) => `choice_${choice}_${"c".repeat(200)}`),
        })),
      },
    });

    const [parked] = wakes(store, "session_one");
    expect(notice(parked!).startsWith("[wake: waiting]")).toBe(true);
    // What it is: the request, its kind, a clamped title.
    expect(notice(parked!)).toContain("request req_many");
    expect(notice(parked!)).toContain("kind user_input");
    // NO fields, no choices, no counts of either — none of it is here.
    expect(notice(parked!)).not.toContain("field_0");
    expect(notice(parked!)).not.toContain("choices:");
    expect(notice(parked!)).not.toContain("more fields");
    expect(notice(parked!)).not.toContain("l".repeat(300));
    expect(notice(parked!)).not.toContain("c".repeat(300));
    // Both calls, and a notice that stays one however big the request was.
    expect(notice(parked!)).toContain('sessions_read(sessionId: "session_two", runId: "run_many")');
    expect(notice(parked!)).toContain("sessions_resolve_request");
    expect(notice(parked!).length).toBeLessThan(800);

    /**
     * AND THE LENGTH DOES NOT FOLLOW THE PAYLOAD — the property, rather than a
     * magic number. Ten times the fields, ten times the choices, ten times the
     * padding: the same notice, to the character, because none of it is in
     * there. Only the title's clamp can vary, and it is the same title.
     */
    // Captured before the first turn ends: finishing it REWRITES that wake in
    // place (the coalescing rule), and the string under comparison is this one.
    const captured = notice(parked!);
    const first = store.turns("session_two").find((turn) => turn.runId === "run_many")!.claim!.token;
    store.resolveRequest("session_two", "req_many", { decision: "accept" });
    store.completeTurn("session_two", "run_many", first, { text: "" });

    store.submitTurn("session_two", { runId: "run_huge_req", input: "work" });
    const second = store.claimTurn("session_two", "worker_one")!.claim!.token;
    store.markRunning("session_two", "run_huge_req", second);
    store.openRequest("session_two", "run_huge_req", second, {
      requestId: "req_bigger",
      kind: "user_input",
      detail: {
        kind: "user_input",
        prompt: `Pick: ${"p".repeat(40_000)}`,
        fields: Array.from({ length: 300 }, (_, index) => ({
          key: `field_${index}`,
          label: `Label ${index} ${"l".repeat(5_000)}`,
          kind: "choice" as const,
          choices: Array.from({ length: 300 }, (_, choice) => `choice_${choice}_${"c".repeat(2_000)}`),
        })),
      },
    });
    const bigger = wakes(store, "session_one").find((turn) => turn.wakeReason?.runId === "run_huge_req");
    // Within a few characters — the ids differ in length and nothing else can.
    // The payload grew by two orders of magnitude; the notice did not grow.
    expect(Math.abs(notice(bigger!).length - captured.length)).toBeLessThan(20);
    expect(notice(bigger!)).not.toContain("l".repeat(300));
    expect(notice(bigger!)).not.toContain("c".repeat(300));
  });

  test("events narrows; once fires once; subscribing twice merges into one", () => {
    const { store } = pair();
    const first = store.subscribe("session_one", { targetSessionId: "session_two", events: ["turn_failed"] });
    const second = store.subscribe("session_one", { targetSessionId: "session_two", events: ["turn_completed"], once: true });
    expect(second.id).toBe(first.id);
    expect(second.events.sort()).toEqual(["turn_completed", "turn_failed"]);
    expect(store.subscriptionsFor("session_one")).toHaveLength(1);

    runTurn(store, "session_two", "run_1", "stop");
    expect(wakes(store, "session_one")).toHaveLength(0);
    runTurn(store, "session_two", "run_2");
    expect(wakes(store, "session_one")).toHaveLength(1);
    expect(store.subscriptionsFor("session_one")).toHaveLength(0);
    runTurn(store, "session_two", "run_3");
    expect(wakes(store, "session_one")).toHaveLength(1);
  });

  test("a second event from the same target REWRITES the waiting wake in place rather than queueing a twin", () => {
    const { store } = pair();
    store.subscribe("session_one", { targetSessionId: "session_two" });
    // Park → the first wake. Then the same turn's approval is answered and it finishes → the second event.
    runTurn(store, "session_two", "run_p", "park");
    const [parked] = wakes(store, "session_one");
    expect(notice(parked!).startsWith("[wake: waiting]")).toBe(true);
    expect(parked!.wakeReason).toMatchObject({ kind: "request_opened", requestId: "req_q" });

    store.resolveRequest("session_two", "req_q", { decision: "accept", answers: { db: "postgres" } });
    const token = store.turns("session_two").find((turn) => turn.runId === "run_p")!.claim!.token;
    store.completeTurn("session_two", "run_p", token, { text: "done" });

    const after = wakes(store, "session_one");
    expect(after).toHaveLength(1);
    expect(after[0]!.runId).toBe(parked!.runId);
    expect(notice(after[0]!).startsWith("[wake: completed]")).toBe(true);
    // The ROW moved with the turn: a transcript showing the superseded line
    // beside a turn that announces something else is the same lie, drawn.
    expect(after[0]!.notification!.wakeKind).toBe("turn_completed");
    const row = store.items("session_one").find((item) => item.runId === after[0]!.runId && item.detail.type === "notification")!;
    expect((row.detail as Extract<typeof row.detail, { type: "notification" }>).notification).toEqual(after[0]!.notification!);
    expect(after[0]!.wakeReason).toMatchObject({ kind: "turn_completed", runId: "run_p" });
    expect(after[0]!.wakeReason).not.toHaveProperty("requestId");
    // The rewrite is announced as a replay of the same run, so a client redraws the chip.
    const events = store.readEvents("session_one").filter((event) => event.type === "turn.accepted" && event.runId === parked!.runId);
    expect(events).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ replayed: true });

    // AND THE REWRITE IS STILL A PING. Coalescing must not smuggle a result
    // body in: the notice that replaced the parked one carries the size and the
    // run-scoped read, exactly as a first notice would.
    expect(notice(after[0]!)).not.toContain("done");
    expect(notice(after[0]!)).toContain('sessions_read(sessionId: "session_two", runId: "run_p")');
    expect(notice(after[0]!).length).toBeLessThan(600);

    // A wake the worker already CLAIMED is not rewritten — and under
    // `settled_only` (#550) a fresh one does not queue behind it either: the
    // subscriber is BUSY, so it is held until that turn settles.
    const claimed = store.claimTurn("session_one", "worker_one")!;
    store.markRunning("session_one", claimed.runId, claimed.claim!.token);
    runTurn(store, "session_two", "run_next");
    expect(wakes(store, "session_one")).toHaveLength(1);
    expect(store.pendingNotifications("session_one").map((each) => each.runId)).toEqual(["run_next"]);
    // And settling it delivers what was held, as its own turn.
    store.completeTurn("session_one", claimed.runId, claimed.claim!.token, { text: "read it" });
    const delivered = wakes(store, "session_one").find((turn) => turn.notification?.runId === "run_next");
    expect(delivered).toBeDefined();
    expect(store.pendingNotifications("session_one")).toHaveLength(0);
  });

  test("unsubscribe withdraws the wakes still waiting from that session, and leaves everything else", () => {
    const { store } = pair();
    store.createSession({ id: "session_three", projectId: "project_one", title: "another" });
    const two = store.subscribe("session_one", { targetSessionId: "session_two" });
    store.subscribe("session_one", { targetSessionId: "session_three" });
    store.submitTurn("session_one", { runId: "run_mine", input: "my own message" });
    runTurn(store, "session_two", "run_a");
    runTurn(store, "session_three", "run_b");
    expect(wakes(store, "session_one")).toHaveLength(2);

    expect(store.unsubscribe(two.id, "session_one")).toBe(true);
    const turns = store.turns("session_one");
    expect(turns.find((turn) => turn.wakeReason?.sessionId === "session_two")!.state).toBe("discarded");
    expect(turns.find((turn) => turn.wakeReason?.sessionId === "session_three")!.state).toBe("queued");
    expect(turns.find((turn) => turn.runId === "run_mine")!.state).toBe("queued");
    expect(store.readEvents("session_one").filter((event) => event.type === "turn.discarded")).toHaveLength(1);
  });

  test("a wake's own ending wakes nobody, so two sessions subscribed to each other cannot ping-pong", () => {
    const { store } = pair();
    store.subscribe("session_one", { targetSessionId: "session_two" });
    store.subscribe("session_two", { targetSessionId: "session_one" });
    runTurn(store, "session_two", "run_w");
    const [wake] = wakes(store, "session_one");
    expect(wake).toBeDefined();
    // Run the wake turn itself to completion: nothing comes back to two.
    const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
    store.markRunning("session_one", wake!.runId, token);
    store.completeTurn("session_one", wake!.runId, token, { text: "noted" });
    expect(wakes(store, "session_two")).toHaveLength(0);
  });

  test("an archived subscriber is dropped; a full backlog drops the wake with a warning; the target's transition still succeeds", () => {
    const { store } = pair();
    store.createSession({ id: "session_three", projectId: "project_one" });
    store.subscribe("session_one", { targetSessionId: "session_two" });
    store.subscribe("session_three", { targetSessionId: "session_two" });
    store.archiveSession("session_three");
    // Archiving takes the wish with it, in both directions.
    expect(store.subscriptionsFor("session_one")).toHaveLength(1);
    expect(new EngineStore(store.paths.root, () => 100).subscriptionsFor("session_one")).toHaveLength(1);

    for (let n = 0; n < 16; n++) store.submitTurn("session_one", { runId: `run_fill_${n}`, input: "queued" });
    runTurn(store, "session_two", "run_w");
    expect(store.turns("session_two").at(-1)!.state).toBe("completed");
    expect(wakes(store, "session_one")).toHaveLength(0);
    expect(store.readEvents("session_one").at(-1)).toMatchObject({ type: "runtime.warning" });
    expect(String((store.readEvents("session_one").at(-1) as { message: string }).message)).toContain("was dropped");
  });

  test("the rules: no self-subscribe, no archived target, a wake must carry its reason, and origin cannot be forged through submitTurn alone", () => {
    const { store } = pair();
    expect(() => store.subscribe("session_one", { targetSessionId: "session_one" })).toThrow(/cannot subscribe to itself/);
    store.archiveSession("session_two");
    expect(() => store.subscribe("session_one", { targetSessionId: "session_two" })).toThrow(/archived/);
    /**
     * THE GUARD IS EXACTLY-ONE-COMPANION, and #543 widened it from two
     * companions to three rather than dropping it to let a clock through. Both
     * directions are pinned here, because the half that refuses a bare origin
     * is satisfied by a guard that refuses everything.
     */
    expect(() => store.submitTurn("session_one", { runId: "run_x", input: "x", origin: "session" })).toThrow(/exactly one companion/);
    // A schedule origin with no `scheduleOrigin` is the same refusal…
    expect(() => store.submitTurn("session_one", { runId: "run_y", input: "y", origin: "schedule" })).toThrow(/exactly one companion/);
    // …and a companion with NO origin is refused from the other side, which is
    // what keeps `scheduleOrigin` from being smuggled onto an ordinary turn.
    expect(() =>
      store.submitTurn("session_one", { runId: "run_z", input: "z", scheduleOrigin: { scheduleId: "sched_1", dueAt: 1 } }),
    ).toThrow(/exactly one companion/);
    expect(() => store.unsubscribe("sub_nope")).not.toThrow();
    expect(store.unsubscribe("sub_nope")).toBe(false);
  });

  test("a request answered by a session is journaled as such", () => {
    const { store } = pair();
    runTurn(store, "session_two", "run_p", "park");
    const answered = store.resolveRequest("session_two", "req_q", { decision: "accept", resolvedBy: "session", answers: { db: "postgres" } });
    expect(answered.resolvedBy).toBe("session");
    expect(store.readEvents("session_two").at(-1)).toMatchObject({ type: "request.resolved", resolvedBy: "session" });
  });
});

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

test("browserOpen opens an http(s) page as the human on the session's browser and journals the tab set", async () => {
  const { store } = readyStore();
  const calls: Array<{ op: string; name?: string; args?: Record<string, unknown>; profileKey?: string }> = [];
  let tabs: { id: string; url: string; title: string; active: boolean }[] = [];
  store.attachBrowser({
    bindProfile: async (_scopeKey: string, profileKey: string) => { calls.push({ op: "bind", profileKey }); },
    call: async (_scopeKey: string, name: string, args: Record<string, unknown>) => {
      calls.push({ op: "call", name, args });
      tabs = [{ id: "0", url: String(args.url), title: "Docs", active: true }];
      return { content: [{ type: "text", text: "opened" }] };
    },
    state: async () => ({ provider: "attached" as const, running: true, tabs }),
    release: async () => undefined,
  } as never);
  const answer = await store.browserOpen("session_one", "https://example.test/docs");
  expect(answer.tabs.map((tab) => tab.url)).toEqual(["https://example.test/docs"]);
  expect(calls).toEqual([
    { op: "bind", profileKey: "project_one" },
    { op: "call", name: "browser_tabs", args: { action: "new", url: "https://example.test/docs" } },
    // browserState({start}) binds again before its read — idempotent, and the
    // one write that journals the tab set for the panel.
    { op: "bind", profileKey: "project_one" },
  ]);
  const events = store.readEvents("session_one").filter((event) => event.type === "browser.state.changed");
  expect(events).toHaveLength(1);
  await expect(store.browserOpen("session_one", "file:///etc/passwd")).rejects.toThrow(/only http and https/);
  await expect(store.browserOpen("session_one", "not a url")).rejects.toThrow(/not a URL/);
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
  const rebooted = new EngineStore(stateRoot, () => 200);
  rebooted.recover();

  /**
   * THE STATE GUARD RAN ONLY WHEN THE TURN WAS UNHELD, so a terminal turn that
   * still carried a stale `held` flag skipped it — and was reported as
   * "released", which is a lie about a turn that has already ended.
   */
  const queueFile = path.join(stateRoot, "sessions", "session_one", "queue.json");
  const queue = JSON.parse(fs.readFileSync(queueFile, "utf8"));
  const stale = queue.turns.find((turn: { runId: string }) => turn.runId === "run_held");
  stale.state = "stopped";
  stale.completedAt = 150;
  fs.writeFileSync(queueFile, JSON.stringify(queue), "utf8");
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
  const awayFile = path.join(awayRoot, "sessions", "session_one", "queue.json");
  const awayQueue = JSON.parse(fs.readFileSync(awayFile, "utf8"));
  awayQueue.turns[0].held = { at: 100, reason: "engine_restart" };
  fs.writeFileSync(awayFile, JSON.stringify(awayQueue), "utf8");
  const registryFile = path.join(awayRoot, "projects.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects[0].removedAt = 150;
  fs.writeFileSync(registryFile, JSON.stringify(registry), "utf8");

  const awayBoot = new EngineStore(awayRoot, () => 300);
  expect(() => awayBoot.releaseHeldTurn("session_one", "run_held")).toThrow(/removed from Telar/);
  // ...and it is still held afterwards, rather than half-released by a throw.
  expect(awayBoot.turns("session_one")[0]?.held).toBeDefined();
});

describe("an agent's message is attributed, never the person's", () => {
  const pair = () => {
    const { store } = readyStore();
    store.createSession({ id: "session_two", projectId: "project_one", title: "the worker" });
    return store;
  };

  test("sessions_send from inside a turn stamps the proven sender; a stale claim is refused", () => {
    const store = pair();
    store.submitTurn("session_one", { runId: "run_host", input: "orchestrate" });
    const claimed = store.claimTurn("session_one", "worker_one")!;
    const token = claimed.claim!.token;
    // Not yet running: the proof is not live, and a message cannot be
    // attributed to a turn that has not started.
    expect(() => store.submitAgentTurn("session_two", { intent: "task", runId: "run_early", input: "go" }, { sessionId: "session_one", runId: "run_host", claimToken: token })).toThrow(/not running/);
    store.markRunning("session_one", "run_host", token);

    const { turn } = store.submitAgentTurn("session_two", { intent: "task", runId: "run_sent", input: "please do X" }, { sessionId: "session_one", runId: "run_host", claimToken: token });
    expect(turn).toMatchObject({ origin: "session", sender: { sessionId: "session_one" }, state: "queued", input: "please do X" });
    expect(turn.wakeReason).toBeUndefined();
    expect(store.readEvents("session_two").filter((event) => event.type === "turn.accepted").at(-1)).toMatchObject({
      type: "turn.accepted",
      turn: { origin: "session", sender: { sessionId: "session_one" } },
    });

    // A forged proof — wrong token — is refused rather than attributed.
    expect(() => store.submitAgentTurn("session_two", { intent: "task", runId: "run_forged", input: "as you" }, { sessionId: "session_one", runId: "run_host", claimToken: "x".repeat(32) })).toThrow(EngineStateError);
    // And a proof naming a session that does not exist.
    expect(() => store.submitAgentTurn("session_two", { intent: "task", runId: "run_ghost", input: "boo" }, { sessionId: "session_nope", runId: "run_host", claimToken: token })).toThrow(EngineStateError);
  });

  test("a send from a turn that ENDED is refused with the session's live turn named, so a retry has somewhere to go (#297)", () => {
    /**
     * THE INCIDENT. A coordinator's `sessions_send` kept arriving with the
     * claim of a turn that had already completed — its capability object
     * outlives the turn it was assembled in, see `liveClaims` in worker.ts —
     * and every one came back "turn has already settled (completed)" and
     * nothing else. Eight peers got their tasks; the ninth could not be given
     * its brief at all, and the only workaround anybody found was to wait for
     * the coordinator's next turn.
     *
     * THE CLAIM IS STILL REFUSED. A settled claim does not prove a live
     * sender, and attributing a peer's message to a turn that is over would be
     * a lie in the record. What changes is that the refusal names the turn this
     * session IS running — which is the turn a retry is proven by, because the
     * worker reads its claim at call time.
     */
    const store = pair();
    store.submitTurn("session_one", { runId: "run_host", input: "orchestrate" });
    const first = store.claimTurn("session_one", "worker_one")!;
    const firstToken = first.claim!.token;
    store.markRunning("session_one", "run_host", firstToken);
    store.completeTurn("session_one", "run_host", firstToken, { text: "handed out eight tasks" });

    // NO LIVE TURN: retrying would be the same refusal, so it says so instead
    // of pointing at a turn that does not exist.
    const orphaned = () =>
      store.submitAgentTurn("session_two", { intent: "task", runId: "run_a", input: "your brief" }, { sessionId: "session_one", runId: "run_host", claimToken: firstToken });
    expect(orphaned).toThrow(/already settled \(completed\)/);
    expect(orphaned).toThrow(/no live turn to send from/);

    // A FOREIGN TOKEN AGAINST THE SAME SETTLED TURN keeps the flat refusal:
    // the longer answer is for a session's own stale claim, never a hint
    // offered to whoever guessed a runId.
    expect(() =>
      store.submitAgentTurn("session_two", { intent: "task", runId: "run_b", input: "as you" }, { sessionId: "session_one", runId: "run_host", claimToken: "x".repeat(32) }),
    ).toThrow(/not running under this worker claim/);

    // The CLI opens a turn of its own — now there is one to name.
    const provider = store.openProviderTurn("session_one", { workerId: "worker_one", input: "Background task completed.", reason: { kind: "unknown" } });
    expect(() =>
      store.submitAgentTurn("session_two", { intent: "task", runId: "run_c", input: "your brief" }, { sessionId: "session_one", runId: "run_host", claimToken: firstToken }),
    ).toThrow(new RegExp(`live turn is ${provider.runId}`));

    // And proven by THAT turn's claim the send lands, attributed to the
    // session and sourced to the turn that actually sent it.
    const { turn } = store.submitAgentTurn(
      "session_two",
      { intent: "task", runId: "run_d", input: "your brief" },
      { sessionId: "session_one", runId: provider.runId, claimToken: provider.claim!.token },
    );
    expect(turn).toMatchObject({ sender: { sessionId: "session_one" }, agentSourceRunId: provider.runId });
  });

  test("a restart retires the sender's claim, and the refusal says the turn was stopped rather than blaming the token (#297)", () => {
    /**
     * WHAT SETTLES A TURN ON RESTART: `recover()`, which stops everything that
     * was in flight AND deletes the claim — no worker registration survives a
     * boot, so the token identifies nobody. A worker that outlived the engine
     * therefore holds a token that matches nothing at all, and the generic
     * "not running under this worker claim" read as a claim mix-up when the
     * truth was a restart.
     */
    const stateRoot = root();
    const store = new EngineStore(stateRoot, () => 100);
    store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
    store.createSession({ id: "session_one", projectId: "project_one" });
    store.createSession({ id: "session_two", projectId: "project_one" });
    store.submitTurn("session_one", { runId: "run_host", input: "orchestrate" });
    const claimed = store.claimTurn("session_one", "worker_one")!;
    const token = claimed.claim!.token;
    store.markRunning("session_one", "run_host", token);

    const rebooted = new EngineStore(stateRoot, () => 200);
    expect(rebooted.recover().stopped).toContain("run_host");
    const host = rebooted.turns("session_one").find((turn) => turn.runId === "run_host")!;
    expect(host).toMatchObject({ state: "stopped", stopReason: "engine_restart" });
    expect(host.claim).toBeUndefined();

    const stale = () =>
      rebooted.submitAgentTurn("session_two", { intent: "task", runId: "run_late", input: "your brief" }, { sessionId: "session_one", runId: "run_host", claimToken: token });
    expect(stale).toThrow(/was stopped \(engine_restart\)/);
    expect(stale).toThrow(/no live turn to send from/);
  });

  test("without proof it is still an agent's — unattributed, never a human bubble", () => {
    const store = pair();
    const { turn } = store.submitAgentTurn("session_two", { intent: "task", runId: "run_socket", input: "from a chat client" });
    expect(turn.origin).toBe("session");
    expect(turn.sender).toEqual({});
    expect(turn.wakeReason).toBeUndefined();
  });

  test("the provenance rule: session origin needs exactly one of wakeReason or sender; a plain turn takes neither", () => {
    const store = pair();
    expect(() => store.submitTurn("session_two", { runId: "r1", input: "x", origin: "session" })).toThrow(/exactly one/);
    expect(() => store.submitTurn("session_two", { runId: "r2", input: "x", sender: { sessionId: "session_one" } })).toThrow(/exactly one/);
    expect(() =>
      store.submitTurn("session_two", { runId: "r3", input: "x", origin: "session", sender: {}, wakeReason: { kind: "turn_completed", sessionId: "session_one" } }),
    ).toThrow(/exactly one/);
    expect(store.submitTurn("session_two", { runId: "r4", input: "x" }).turn.origin).toBeUndefined();
  });

  test("an agent's message steered into a running turn carries its sender on the heartbeat; its turn's ending still wakes subscribers", () => {
    const store = pair();
    store.submitTurn("session_two", { runId: "run_live", input: "working" });
    const live = store.claimTurn("session_two", "worker_one")!;
    store.markRunning("session_two", "run_live", live.claim!.token);

    const steered = store.submitAgentTurn("session_two", { intent: "task", runId: "run_steer", input: "also this" });
    expect(steered.turn.state).toBe("steering");
    const [delivery] = store.steerForWorker("worker_one");
    expect(delivery).toMatchObject({ steerRunId: "run_steer", text: "also this", sender: {} });
    // A person's steer carries no sender at all.
    store.submitTurn("session_two", { runId: "run_human", input: "and me" });
    expect(store.steerForWorker("worker_one").find((each) => each.steerRunId === "run_human")?.sender).toBeUndefined();

    // A direct agent message is real work: when ITS turn ends, a subscriber
    // hears about it. Only a wake's own ending is silent.
    store.completeTurn("session_two", "run_live", live.claim!.token, { text: "done" });
    // The two undelivered steers went back to queued; drop them so the next
    // claim is the direct message below.
    store.stopTurn("session_two", "run_steer");
    store.stopTurn("session_two", "run_human");
    store.subscribe("session_one", { targetSessionId: "session_two", events: ["turn_completed"] });
    const direct = store.submitAgentTurn("session_two", { intent: "task", runId: "run_direct", input: "next job" });
    expect(direct.turn.state).toBe("queued");
    const claimedDirect = store.claimTurn("session_two", "worker_one")!;
    store.markRunning("session_two", "run_direct", claimedDirect.claim!.token);
    store.completeTurn("session_two", "run_direct", claimedDirect.claim!.token, { text: "finished the job" });
    const wake = store.turns("session_one").find((turn) => turn.wakeReason);
    expect(wake?.wakeReason).toMatchObject({ kind: "turn_completed", runId: "run_direct" });
  });
});

describe("a Claude model is stored and claimed in the spelling Telar offers", () => {
  test("a bare family id or alias becomes its default-window row at every door; a custom, dated or short-window id is left alone", () => {
    const { store } = readyStore();
    const session = store.getSession("session_one");
    const instanceId = session.providerInstanceId;
    // The session patch.
    expect(store.updateSession("session_one", { model: { instanceId, model: "opus", effort: "medium" } }).model).toEqual({ instanceId, model: "opus[1m]", effort: "medium" });
    expect(store.updateSession("session_one", { model: { instanceId, model: "claude-opus-5" } }).model?.model).toBe("claude-opus-5[1m]");
    // Already long: untouched, no double suffix.
    expect(store.updateSession("session_one", { model: { instanceId, model: "claude-fable-5-1[1m]" } }).model?.model).toBe("claude-fable-5-1[1m]");
    // Nothing is invented: a custom id, a dated build and Haiku stay as typed.
    expect(store.updateSession("session_one", { model: { instanceId, model: "claude-mystery-9" } }).model?.model).toBe("claude-mystery-9");
    expect(store.updateSession("session_one", { model: { instanceId, model: "claude-opus-5-20260101" } }).model?.model).toBe("claude-opus-5-20260101");
    expect(store.updateSession("session_one", { model: { instanceId, model: "haiku" } }).model?.model).toBe("haiku");
    // Sonnet's default window is 200k, so its bare alias already is it.
    expect(store.updateSession("session_one", { model: { instanceId, model: "sonnet" } }).model?.model).toBe("sonnet");
    // The per-turn choice.
    const { turn } = store.submitTurn("session_one", { runId: "run_one", input: "Hi", model: { model: "fable" } });
    expect(turn.model?.model).toBe("fable[1m]");
    expect(store.claimNextTurn("worker_one")?.model?.model).toBe("fable[1m]");
  });

  test("a record saved before the window was a control is corrected at the claim, without a patch", () => {
    const { store, root: stateRoot } = readyStore();
    const file = path.join(stateRoot, "sessions", "session_one", "session.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    saved.model = { instanceId: store.getSession("session_one").providerInstanceId, model: "opus", effort: "medium" };
    fs.writeFileSync(file, JSON.stringify(saved), "utf8");
    const booted = new EngineStore(stateRoot, () => 200);
    // The record still says what was saved…
    expect(booted.getSession("session_one").model?.model).toBe("opus");
    booted.submitTurn("session_one", { runId: "run_one", input: "Hi" });
    // …and the claim — what actually runs — says the row Telar offers.
    expect(booted.claimNextTurn("worker_one")?.model).toMatchObject({ model: "opus[1m]", effort: "medium" });
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
      expect(store.drainStopTasks()).toEqual([{ sessionId: "session_one", providerTaskId: "provider_bg" }]);
      store.reportSessionTasks("session_one", "worker_one", [
        { kind: "task.progress", task: { id: "task_bg", kind: "background", state: "running", title: "late report" } },
      ]);
      expect(store.tasks("session_one")[0]?.state).toBe("stopped");
      expect(store.tasks("session_other")[0]?.state).toBe("running");
      store.stopSession("session_one");
      expect(store.drainStopTasks()).toEqual([]);
      store.submitTurn("session_one", { runId: "run_after", input: "continue" });
      expect(store.claimTurn("session_one", "worker_one")?.runId).toBe("run_after");
    });
  }

  test("session Stop terminalizes legacy held work before clearing its pause latch", () => {
    const { store, root: directory } = readyStore();
    store.submitTurn("session_one", { runId: "run_held", input: "keep these words" });
    const queueFile = path.join(directory, "sessions", "session_one", "queue.json");
    const metadataFile = path.join(directory, "sessions", "session_one", "session.json");
    const queue = JSON.parse(fs.readFileSync(queueFile, "utf8"));
    queue.turns[0].held = { at: 100, reason: "session_paused" };
    fs.writeFileSync(queueFile, JSON.stringify(queue));
    const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
    metadata.paused = { at: 100, by: "human" };
    fs.writeFileSync(metadataFile, JSON.stringify(metadata));
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

describe("an open item's streamed prefix", () => {
  const streaming = (): { store: EngineStore; token: string } => {
    const { store } = readyStore();
    store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
    const claimed = store.claimTurn("session_one", "worker_one")!;
    const token = claimed.claim!.token;
    store.markRunning("session_one", "run_one", token);
    store.ingestObservations("session_one", "run_one", token, [
      { kind: "item.started", item: { id: "i1", detail: { type: "assistant_message", text: "" } } },
      { kind: "content.delta", itemId: "i1", stream: "assistant_text", text: "Once upon " },
    ]);
    return { store, token };
  };

  test("carries the text streamed so far, through the delta that last extended it", () => {
    const { store } = streaming();
    const cursor = store.eventCursor("session_one");
    const prefix = store.openItemPrefix("session_one", "i1", cursor)!;
    expect(prefix.streamed).toBe("Once upon ");
    expect(prefix.streamedThrough).toBeLessThanOrEqual(cursor);
  });

  test("REGRESSION: a delta appended after the cache was lost still yields the WHOLE prefix", () => {
    /**
     * THE TRUNCATION, MOVED INTO THE ENGINE. A restart empties the accumulator.
     * The next delta then built an entry holding only itself — and a cutoff at
     * or above it looked satisfiable, so the tail was served as if it were the
     * whole reply. Exactly the bug the field exists to prevent, one layer down.
     */
    const { store, token } = streaming();
    store.forgetOpenPrefixesForTest();
    store.ingestObservations("session_one", "run_one", token, [
      { kind: "content.delta", itemId: "i1", stream: "assistant_text", text: "a time" },
    ]);
    const prefix = store.openItemPrefix("session_one", "i1", store.eventCursor("session_one"))!;
    expect(prefix.streamed).toBe("Once upon a time");
  });

  test("a cutoff behind the cache rebuilds the prefix exactly to it", () => {
    const { store, token } = streaming();
    const behind = store.eventCursor("session_one");
    store.ingestObservations("session_one", "run_one", token, [
      { kind: "content.delta", itemId: "i1", stream: "assistant_text", text: "a time" },
    ]);
    // The cache now reaches further than the caller's cutoff, so the journal
    // decides — anything else would report text from the future.
    expect(store.openItemPrefix("session_one", "i1", behind)!.streamed).toBe("Once upon ");
    expect(store.openItemPrefix("session_one", "i1", store.eventCursor("session_one"))!.streamed).toBe("Once upon a time");
  });

  test("an item left open by a stop keeps its text, cache or no cache", () => {
    // Stop deliberately leaves items open, so the prefix is the only account of
    // what the reader was shown — and it must outlive the process that held it.
    const { store } = streaming();
    store.forgetOpenPrefixesForTest();
    expect(store.openItemPrefix("session_one", "i1", store.eventCursor("session_one"))!.streamed).toBe("Once upon ");
  });

  test("two sessions' items with the same id do not share a prefix", () => {
    const { store, token } = streaming();
    store.createSession({ id: "session_two", projectId: "project_one" });
    store.submitTurn("session_two", { runId: "run_two", input: "Hello" });
    const claimed = store.claimTurn("session_two", "worker_two")!;
    store.markRunning("session_two", "run_two", claimed.claim!.token);
    store.ingestObservations("session_two", "run_two", claimed.claim!.token, [
      { kind: "item.started", item: { id: "i1", detail: { type: "assistant_message", text: "" } } },
      { kind: "content.delta", itemId: "i1", stream: "assistant_text", text: "different" },
    ]);
    expect(store.openItemPrefix("session_one", "i1", store.eventCursor("session_one"))!.streamed).toBe("Once upon ");
    expect(store.openItemPrefix("session_two", "i1", store.eventCursor("session_two"))!.streamed).toBe("different");
    void token;
  });

  test("a closed item's stored text wins, even when it is SHORTER than the prefix", () => {
    // A provider that revises its answer on close must be able to shorten it,
    // which is why the client prefers `detail` once an item is no longer open.
    const { store, token } = streaming();
    store.ingestObservations("session_one", "run_one", token, [
      { kind: "item.completed", itemId: "i1", status: "completed", detail: { type: "assistant_message", text: "Short." } },
    ]);
    const item = store.items("session_one").find((row) => row.id === "i1")!;
    expect(item.status).toBe("completed");
    expect(item.detail).toMatchObject({ text: "Short." });
  });
});

test("#214 an item evicted from the prefix cache keeps streaming correctly", () => {
  /**
   * EVICTION MUST BE INVISIBLE IN THE TEXT. Opening enough items pushes the
   * first one out of the bound — including items that only ever OPENED, which
   * is the path that used to skip the trim entirely. The evicted item then
   * takes another delta, so its cache entry is rebuilt from a tail rather than
   * from the item's beginning: the unsealed case, and the one that must fall
   * back to the journal instead of reporting the tail as the whole reply.
   */
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const claimed = store.claimTurn("session_one", "worker_one")!;
  const token = claimed.claim!.token;
  store.markRunning("session_one", "run_one", token);
  store.ingestObservations("session_one", "run_one", token, [
    { kind: "item.started", item: { id: "i1", detail: { type: "assistant_message", text: "" } } },
    { kind: "content.delta", itemId: "i1", stream: "assistant_text", text: "Once upon " },
  ]);
  // Enough opens to evict i1, and opens alone — no deltas.
  for (let index = 0; index < 80; index += 1) {
    store.ingestObservations("session_one", "run_one", token, [
      { kind: "item.started", item: { id: `filler_${index}`, detail: { type: "assistant_message", text: "" } } },
    ]);
  }
  // THE BOUND ITSELF, asserted separately: the text above stays correct whether
  // or not eviction ran, so it cannot tell a held bound from a skipped one.
  // Opening is the path that used to insert without trimming.
  expect(store.openPrefixCountForTest()).toBeLessThanOrEqual(64);
  store.ingestObservations("session_one", "run_one", token, [
    { kind: "content.delta", itemId: "i1", stream: "assistant_text", text: "a time" },
  ]);
  expect(store.openItemPrefix("session_one", "i1", store.eventCursor("session_one"))!.streamed).toBe("Once upon a time");
  expect(store.openPrefixCountForTest()).toBeLessThanOrEqual(64);
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
