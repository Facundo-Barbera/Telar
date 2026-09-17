/**
 * THE TURN PROJECTION AND THE QUERY ROUTES ON IT — issue #516.
 *
 * Three claims, and the third is the one the issue actually bought:
 *
 *   1. A row exists for every turn — written when the turn is accepted, brought
 *      level when it ends, and backfilled for a store whose conversations
 *      predate this table.
 *   2. The routes are bounded, keyset-paged, and state what they left out.
 *   3. NONE OF IT FOLDS THE JOURNAL. The fixture holds a session of 60,000
 *      events beside 300 ordinary ones, and `outline` on the big one is asserted
 *      to cost what it costs on a small one — because if the answer were still
 *      being derived from events, that is the assertion that would fail.
 *
 * The before/after numbers in the PR come from `bench:outline` below, which is
 * this file's fixture measured both ways.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { stubModels } from "./stub-models";
import { summariseTurn, ANSWER_HEAD_CHARS, INPUT_LINE_CHARS, OUTLINE_ANSWER_CHARS } from "../src/turn-summary";

/** The ceiling one step may answer with: the 8,000-character default plus the
 *  scalar envelope that identifies it. */
const ITEM_BUDGET = 8_600;

const roots: string[] = [];
const stores: EngineStore[] = [];
const daemons: EngineDaemon[] = [];

const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-summary-"));
  roots.push(directory);
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
};

const open = (home: string): EngineStore => {
  const store = new EngineStore(home, () => Date.now(), { executionStorage: "sqlite" });
  stores.push(store);
  return store;
};

/** Close a store WITHOUT the afterEach double-closing it — used when a test
 *  reopens the same home to prove the backfill runs on open. */
const close = (store: EngineStore): void => {
  store.closeExecutionStore();
  const at = stores.indexOf(store);
  if (at >= 0) stores.splice(at, 1);
};

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const store of stores.splice(0)) store.closeExecutionStore();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** One completed turn, through the public path — a hand-written queue would
 *  price a store no engine ever wrote. */
function conversation(store: EngineStore, sessionId: string, runId: string, input: string, answer: string, items = 2): void {
  store.submitTurn(sessionId, { runId, input });
  const token = store.claimTurn(sessionId, "worker_one")!.claim!.token;
  store.markRunning(sessionId, runId, token);
  store.ingestObservations(sessionId, runId, token, Array.from({ length: items }, (_, step) => `${runId}_item_${step}`).flatMap((id, step) => [
    { kind: "item.started" as const, item: { id, title: `step ${step}`, detail: { type: "assistant_message" as const, text: "" } } },
    { kind: "item.completed" as const, itemId: id, status: "completed" as const, detail: { type: "assistant_message" as const, text: `body ${step}` } },
  ]));
  store.completeTurn(sessionId, runId, token, { text: answer });
}

function seeded(sessions = 1): { home: string; store: EngineStore } {
  const home = root();
  const store = open(home);
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  for (let index = 0; index < sessions; index += 1) store.createSession({ id: `session_${index}`, projectId: "project_one" });
  return { home, store };
}

test("a turn has a row when it is ACCEPTED, and the row is right when it ENDS", () => {
  const { store } = seeded();
  store.submitTurn("session_0", { runId: "run_1", input: "the appearance rework\nsecond line" });

  // Accepted: the input line is searchable from this instant, and nothing
  // pretends the turn has ended.
  const queued = store.turnOutline("session_0", { limit: 10 });
  expect(queued.turns).toHaveLength(1);
  expect(queued.turns[0]!.input).toBe("the appearance rework");
  expect(queued.turns[0]!.state).toBe("queued");
  expect(queued.turns[0]!.answerChars).toBe(0);
  expect(queued.turns[0]!.endedAt).toBeUndefined();

  const token = store.claimTurn("session_0", "worker_one")!.claim!.token;
  store.markRunning("session_0", "run_1", token);
  store.ingestObservations("session_0", "run_1", token, [
    { kind: "item.started", item: { id: "item_a", title: "Read state.ts", detail: { type: "file_read", read: { path: "state.ts" } } } },
    { kind: "item.completed", itemId: "item_a", status: "completed", detail: { type: "file_read", read: { path: "state.ts" } } },
  ]);
  store.completeTurn("session_0", "run_1", token, { text: "x".repeat(5_000) });

  const ended = store.turnOutline("session_0", { limit: 10 }).turns[0]!;
  expect(ended.state).toBe("completed");
  expect(ended.items).toBe(1);
  expect(ended.answerChars).toBe(5_000);
  // A page shows a LINE of the answer; the row remembers the head, and both say
  // they were cut rather than looking like short text. See `outlineRow`.
  expect(ended.answer).toHaveLength(OUTLINE_ANSWER_CHARS);
  expect(ended.answer.endsWith("…")).toBe(true);
  expect(ended.endedAt).toBeGreaterThan(0);

  // The stored row, which keeps what the page leaves behind.
  const stored = summariseTurn(store.turns("session_0")[0]!, store.items("session_0"));
  expect(stored.itemTitles).toEqual(["Read state.ts"]);
  expect(stored.answerHead).toHaveLength(ANSWER_HEAD_CHARS);
});

test("a failed turn keeps its sentence, and a long input line is marked as cut", () => {
  const { store } = seeded();
  store.submitTurn("session_0", { runId: "run_1", input: "y".repeat(400) });
  const token = store.claimTurn("session_0", "worker_one")!.claim!.token;
  store.markRunning("session_0", "run_1", token);
  store.failTurn("session_0", "run_1", token, { code: "driver_failed", message: "the provider hung up" });

  const row = store.turnOutline("session_0", { limit: 10 }).turns[0]!;
  expect(row.state).toBe("failed");
  expect(row.input).toHaveLength(INPUT_LINE_CHARS);
  expect(row.input.endsWith("…")).toBe(true);
  expect(row.failure).toContain("the provider hung up");
});

test("the backfill folds a store whose turns predate the table, once", () => {
  const { home, store } = seeded();
  for (let index = 0; index < 4; index += 1) conversation(store, "session_0", `run_${index}`, `message ${index}`, `answer ${index}`);
  close(store);

  // Drop the projection the way a binary without it would have left the store:
  // the documents are all still there, the rows are not.
  const sqlite = new (require("bun:sqlite").Database)(path.join(home, "execution.sqlite"));
  sqlite.exec("DELETE FROM turn_summaries");
  sqlite.close();

  const reopened = open(home);
  expect(reopened.turnSummaryBackfill).toEqual({ sessions: 1, turns: 4 });
  expect(reopened.turnOutline("session_0", { limit: 10 }).turns).toHaveLength(4);
  close(reopened);

  // IDEMPOTENT, and silent on every open after the first: the gaps read finds
  // nothing, so nothing is folded and the daemon prints no line.
  const again = open(home);
  expect(again.turnSummaryBackfill).toEqual({ sessions: 0, turns: 0 });
});

test("the outline pages newest first, by sequence, and states what is left", () => {
  const { store } = seeded();
  for (let index = 0; index < 25; index += 1) conversation(store, "session_0", `run_${index}`, `message ${index}`, `answer ${index}`);

  const first = store.turnOutline("session_0", { limit: 10 });
  expect(first.turns.map((turn) => turn.input)).toEqual(
    Array.from({ length: 10 }, (_, step) => `message ${24 - step}`),
  );
  expect(first.total).toBe(25);
  expect(first.more).toBe(true);
  expect(first.next).toBe(first.turns.at(-1)!.sequence);

  const second = store.turnOutline("session_0", { limit: 10, before: first.next });
  expect(second.turns[0]!.input).toBe("message 14");
  const last = store.turnOutline("session_0", { limit: 10, before: second.next });
  expect(last.turns).toHaveLength(5);
  expect(last.more).toBe(false);
  expect(last.next).toBeUndefined();
});

test("a run's items are a list to choose from, and one step is clamped with its marker", () => {
  const { store } = seeded();
  store.submitTurn("session_0", { runId: "run_1", input: "go" });
  const token = store.claimTurn("session_0", "worker_one")!.claim!.token;
  store.markRunning("session_0", "run_1", token);
  store.ingestObservations("session_0", "run_1", token, [
    { kind: "item.started", item: { id: "item_a", title: "small", detail: { type: "assistant_message", text: "" } } },
    { kind: "item.completed", itemId: "item_a", status: "completed", detail: { type: "assistant_message", text: "tiny" } },
    { kind: "item.started", item: { id: "item_b", title: "big", detail: { type: "assistant_message", text: "" } } },
    { kind: "item.completed", itemId: "item_b", status: "completed", detail: { type: "assistant_message", text: "z".repeat(20_000) } },
  ]);
  store.completeTurn("session_0", "run_1", token, { text: "done" });

  const listed = store.runItems("session_0", "run_1");
  expect(listed.map((item) => item.title)).toEqual(["small", "big"]);
  expect(listed[0]!.index).toBe(0);
  // `bytes` is the whole point: an agent must be able to see the expensive one.
  expect(listed[1]!.bytes).toBeGreaterThan(listed[0]!.bytes * 100);

  const step = store.runItem("session_0", "run_1", 1, 500);
  expect(step.more).toBe(true);
  expect(step.title).toBe("big");
  // The envelope is scalars: the detail rides in `text`, bounded, and nowhere
  // else — a second unbounded copy is what made this route unpredictable.
  expect(Buffer.byteLength(JSON.stringify(step), "utf8")).toBeLessThan(1_000);
  expect(step.totalChars).toBeGreaterThan(20_000);
  expect(step.text).toContain(`[… ${step.totalChars - 500} more characters]`);
  // Addressed by id as well as by position — a caller holding one from a
  // journal page must not have to translate it first.
  expect(store.runItem("session_0", "run_1", "item_b", 500).index).toBe(1);
  expect(() => store.runItem("session_0", "run_1", 9, 500)).toThrow();
});

test("the answer is sliced, states its true length, and defaults to the last turn that spoke", () => {
  const { store } = seeded();
  conversation(store, "session_0", "run_1", "first", "a".repeat(10_000));
  // A later turn that completed having said NOTHING: the default must not land
  // on it and answer the empty string.
  store.submitTurn("session_0", { runId: "run_2", input: "second" });
  const token = store.claimTurn("session_0", "worker_one")!.claim!.token;
  store.markRunning("session_0", "run_2", token);
  store.completeTurn("session_0", "run_2", token, { text: "" });

  const head = store.turnAnswer("session_0", { from: 0, limit: 4_000 });
  expect(head.runId).toBe("run_1");
  expect(head.totalChars).toBe(10_000);
  expect(head.text).toHaveLength(4_000);
  expect(head.more).toBe(true);
  expect(head.next).toBe(4_000);

  const tail = store.turnAnswer("session_0", { runId: "run_1", from: 8_000, limit: 4_000 });
  expect(tail.text).toHaveLength(2_000);
  expect(tail.more).toBe(false);
});

test("grep finds a phrase in the journal, newest first, with context around it", () => {
  const { store } = seeded();
  conversation(store, "session_0", "run_1", "try the build", "it failed on index.lock");
  conversation(store, "session_0", "run_2", "and again", "index.lock again, sorry");

  const found = store.grepSession("session_0", "index.lock", { limit: 10 });
  expect(found.matches.length).toBeGreaterThan(0);
  expect(found.matches[0]!.context).toContain("index.lock");
  // Newest first, so ids descend.
  const ids = found.matches.map((match) => match.id);
  expect([...ids].sort((a, b) => b - a)).toEqual(ids);

  const paged = store.grepSession("session_0", "index.lock", { limit: 1 });
  expect(paged.matches).toHaveLength(1);
  expect(paged.more).toBe(true);
  expect(store.grepSession("session_0", "index.lock", { limit: 1, before: paged.next }).matches[0]!.id).toBeLessThan(paged.next!);
  // A wildcard a person typed is text, not a `LIKE` operator.
  expect(store.grepSession("session_0", "%", { limit: 5 }).matches).toHaveLength(0);
});

test("find matches an input line, an answer and a title, and says which index answered", () => {
  const { store } = seeded(2);
  conversation(store, "session_0", "run_1", "rework the appearance sheet", "done, the sheet is narrower");
  conversation(store, "session_1", "run_1", "something unrelated", "nothing to see");
  store.updateSession("session_1", { title: "Narrower rail" });

  const hits = store.findSessions({ q: "appearance", limit: 10 });
  expect(hits.sessions.map((row) => row.id)).toEqual(["session_0"]);
  expect(hits.sessions[0]!.why).toContain("appearance");
  expect(["fts5", "like"]).toContain(hits.index);

  expect(store.findSessions({ q: "narrower", limit: 10 }).sessions.map((row) => row.id).sort())
    .toEqual(["session_0", "session_1"]);
  expect(store.findSessions({ q: "appearance", projectId: "project_other", limit: 10 }).sessions).toHaveLength(0);
  expect(store.findSessions({ q: "appearance", since: Date.now() + 60_000, limit: 10 }).sessions).toHaveLength(0);
});

/**
 * THE CLAIM THE ISSUE IS ACTUALLY BUYING.
 *
 * A session of 60,000 journal events beside one of a handful, and `outline`
 * asked of both. If the answer were still folded from events the big one would
 * be three orders of magnitude slower; it is the same read either way, so the
 * assertion is that its cost does not track the journal.
 *
 * ASSERTED AS A RATIO AND A CEILING, not as a wall-clock number — a loaded CI
 * runner must not be able to fail this for being busy. The ceiling is generous
 * (100 ms against a measured 1–2 ms) and the fold it rules out is 1.2 s.
 */
test("outline does not fold the journal: a 60,000-event session costs what a small one costs", () => {
  const { store } = seeded(2);
  conversation(store, "session_1", "run_1", "small", "small answer");

  store.submitTurn("session_0", { runId: "run_big", input: "the long one" });
  const token = store.claimTurn("session_0", "worker_one")!.claim!.token;
  store.markRunning("session_0", "run_big", token);
  store.ingestObservations("session_0", "run_big", token, [
    { kind: "item.started", item: { id: "item_big", detail: { type: "assistant_message", text: "" } } },
  ]);
  // 60,000 deltas is 60,000 journal rows — the shape of the dogfood store's
  // largest session (61,977), built the only way an engine ever builds one.
  for (let batch = 0; batch < 60; batch += 1) {
    store.ingestObservations("session_0", "run_big", token, Array.from({ length: 1_000 }, () => ({
      kind: "content.delta" as const, itemId: "item_big", stream: "assistant_text" as const, text: "tok ",
    })));
  }
  store.ingestObservations("session_0", "run_big", token, [
    { kind: "item.completed", itemId: "item_big", status: "completed", detail: { type: "assistant_message", text: "big" } },
  ]);
  store.completeTurn("session_0", "run_big", token, { text: "the big answer" });

  expect(store.eventCursor("session_0")).toBeGreaterThan(60_000);

  const big = Bun.nanoseconds();
  const outline = store.turnOutline("session_0", { limit: 20 });
  const bigMs = (Bun.nanoseconds() - big) / 1e6;
  const small = Bun.nanoseconds();
  store.turnOutline("session_1", { limit: 20 });
  const smallMs = (Bun.nanoseconds() - small) / 1e6;

  expect(outline.turns).toHaveLength(1);
  expect(outline.turns[0]!.answer).toBe("the big answer");
  expect(bigMs).toBeLessThan(100);
  expect(bigMs).toBeLessThan(smallMs + 50);
});

/**
 * THE ROUTES OVER THE REAL WIRE, on an engine of 300 sessions — the size the
 * issue names, because the byte budgets are claims about a real engine and a
 * three-session fixture cannot falsify one.
 */
test("every query route answers under its budget on a 300-session engine", async () => {
  const daemon = await startEngine({ models: stubModels, engineRoot: root(), executionStorage: "sqlite" });
  daemons.push(daemon);
  const store = daemon.store;
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  for (let index = 0; index < 300; index += 1) {
    store.createSession({ id: `session_${index}`, projectId: "project_one" });
    conversation(store, `session_${index}`, "run_1", `message ${index} about the rail`, `answer ${index}`);
  }
  for (let index = 0; index < 30; index += 1) {
    conversation(store, "session_0", `run_extra_${index}`, `extra ${index}`, "z".repeat(4_000));
  }

  const { host, port, token } = daemon.discovery;
  const get = async (route: string): Promise<{ status: number; bytes: number; body: Record<string, unknown> }> => {
    const answer = await fetch(`http://${host}:${port}${route}`, { headers: { authorization: `Bearer ${token}` } });
    const text = await answer.text();
    return { status: answer.status, bytes: Buffer.byteLength(text, "utf8"), body: JSON.parse(text) as Record<string, unknown> };
  };

  // THE TWO-NUMBER BOUND, on data chosen to make the byte half bite: every
  // answer here is 4,000 characters, so each row carries a full 200-character
  // line and the page stops short of twenty rows rather than over 6 KB.
  const outline = await get("/v2/sessions/session_0/outline");
  expect(outline.status).toBe(200);
  expect((outline.body.turns as unknown[]).length).toBeLessThan(20);
  expect(outline.body.more).toBe(true);
  expect(outline.bytes).toBeLessThan(6_500);
  // And a page of ordinary one-line turns reaches the row limit instead.
  const roomy = await get("/v2/sessions/session_5/outline");
  expect((roomy.body.turns as unknown[]).length).toBe(1);
  expect(roomy.bytes).toBeLessThan(1_000);

  const found = await get("/v2/sessions/find?q=rail");
  expect(found.status).toBe(200);
  expect((found.body.sessions as unknown[]).length).toBe(10);
  expect(found.bytes).toBeLessThan(3_000);

  const items = await get("/v2/sessions/session_0/runs/run_1/items");
  expect((items.body.items as unknown[]).length).toBe(2);
  expect(items.bytes).toBeLessThan(2_000);

  const step = await get("/v2/sessions/session_0/runs/run_1/items/0");
  expect(step.status).toBe(200);
  expect(step.body.index).toBe(0);
  expect(step.bytes).toBeLessThan(ITEM_BUDGET);

  const answer = await get("/v2/sessions/session_0/answer");
  expect(answer.status).toBe(200);
  expect(answer.body.totalChars).toBe(4_000);
  expect(answer.body.more).toBe(false);

  const grep = await get("/v2/sessions/session_0/grep?pattern=rail");
  expect(grep.status).toBe(200);
  expect(grep.bytes).toBeLessThan(12_000);

  // A bad bound is a bug in the caller, refused rather than defaulted — the
  // rule `/events` already follows.
  expect((await get("/v2/sessions/session_0/outline?limit=all")).status).toBe(400);
  expect((await get("/v2/sessions/find")).status).toBe(400);
  expect((await get("/v2/sessions/session_0/grep")).status).toBe(400);
  // And a ceiling is a ceiling: asking past it is clamped, never served.
  expect(((await get("/v2/sessions/session_0/outline?limit=9999")).body.turns as unknown[]).length).toBeLessThanOrEqual(100);
});

/**
 * #550 — A NOTIFICATION TURN'S ROW SHOWS THE NOTIFICATION'S LINE.
 *
 * `input` on such a turn is either a machine label or a peer's whole message,
 * and neither is what an orchestrator scanning twenty rows is asking for.
 */
test("a wake's outline row is its summary line, not the machine label on `input`", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-summary-notify-"));
  roots.push(home);
  const store = new EngineStore(home, Date.now, { executionStorage: "sqlite" });
  stores.push(store);
  store.registerProject({ id: "project_one", name: "test", root: "/tmp" });
  for (const id of ["session_host", "session_child"]) store.createSession({ id, projectId: "project_one", title: id });
  store.subscribe("session_host", { targetSessionId: "session_child" });

  store.submitTurn("session_child", { runId: "run_child", input: "work" });
  const token = store.claimTurn("session_child", "worker_one")!.claim!.token;
  store.markRunning("session_child", "run_child", token);
  store.completeTurn("session_child", "run_child", token, { text: "all done" });

  const wake = store.turns("session_host")[0]!;
  const row = summariseTurn(wake, store.items("session_host"));
  expect(row.input).toStartWith("[wake: completed]");
  expect(row.input).not.toContain("[notification:");
  expect(row.input.length).toBeLessThanOrEqual(INPUT_LINE_CHARS);

  // The same line the transcript row shows, because it is the same string.
  expect(row.input).toBe(wake.notification!.summary.slice(0, row.input.length));
});
