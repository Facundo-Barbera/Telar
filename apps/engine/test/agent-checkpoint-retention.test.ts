/**
 * THE AGENT'S STORE, BOUNDED — checkpoint retention (#599).
 *
 * The store was 1.53 GB for a 1.9 MB conversation: 993 full snapshots of the
 * same message list, because `SqliteSaver` writes one per superstep and nothing
 * ever deleted one. `src/agent/retention.ts` deletes all but the newest.
 *
 * What must not drift:
 *
 *   - a thread keeps the NEWEST checkpoint and nothing older, per thread and per
 *     namespace, so one conversation cannot prune another's;
 *   - A PARKED `interrupt()` STILL RESUMES AFTERWARDS, across a close and a
 *     reopen — which is what a restart is, and the one failure a prune could
 *     cause that would cost somebody their work;
 *   - pruning is idempotent and safe to run on open, including on a store whose
 *     saver has never created a table;
 *   - `writes` follow their checkpoint, and the newest checkpoint's own pending
 *     writes are never among them;
 *   - the store's size after a long conversation is bounded rather than growing
 *     with laps.
 *
 * NO FIXTURE IS TAKEN FROM A REAL MACHINE. Every database here is built in a
 * temp directory by this file; the live store at
 * `~/Library/Application Support/Telar/engine/agent/threads.sqlite` is never
 * opened.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Annotation, Command, END, MessagesAnnotation, START, StateGraph, interrupt } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { openAgentCheckpointer, type NativeDatabase } from "../src/agent/checkpointer";
import { CHECKPOINTS_KEPT, pruneCheckpoints, reclaimFreeSpace } from "../src/agent/retention";

function root(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "telar-retention-"));
}

function file(): string {
  return path.join(root(), "threads.sqlite");
}

const config = (threadId: string) => ({ configurable: { thread_id: threadId, checkpoint_ns: "" } });

/** A checkpoint big enough that a hundred of them is a measurable file, in the
 *  saver's own v4 shape. `id` is a UUIDv6, which is what makes
 *  `ORDER BY checkpoint_id DESC` mean "newest". */
const checkpoint = (id: string, bytes = 0) => ({
  v: 4 as const,
  id,
  ts: new Date().toISOString(),
  channel_values: { messages: ["hello", "x".repeat(bytes)] },
  channel_versions: { messages: 1 },
  versions_seen: {},
});

/** Ids that sort in the order they were minted, as real ones do. */
const nthId = (n: number) => `1ef4f797-8335-6428-8001-${String(n).padStart(12, "0")}`;

const metadata = (step: number) => ({ source: "loop", step, parents: {} });

function countCheckpoints(db: NativeDatabase, threadId?: string): number {
  const row = (
    threadId === undefined
      ? db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get()
      : db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE thread_id = ?").get(threadId)
  ) as { n: number | bigint };
  return Number(row.n);
}

function countWrites(db: NativeDatabase): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM writes").get() as { n: number | bigint };
  return Number(row.n);
}

/* ------------------------------------------------------------------ *
 * The prune itself.
 * ------------------------------------------------------------------ */

test("a thread with many checkpoints keeps only the newest, and a second thread is untouched", async () => {
  const opened = openAgentCheckpointer(file());
  for (let n = 1; n <= 8; n += 1) {
    await opened.saver.put(config("thread_one"), checkpoint(nthId(n)) as never, metadata(n) as never, {});
    await opened.saver.put(config("thread_two"), checkpoint(nthId(100 + n)) as never, metadata(n) as never, {});
  }

  // The saver prunes as it writes, so both threads are already at one — and the
  // row each kept is its OWN newest rather than the store's.
  expect(countCheckpoints(opened.db, "thread_one")).toBe(CHECKPOINTS_KEPT);
  expect(countCheckpoints(opened.db, "thread_two")).toBe(CHECKPOINTS_KEPT);
  expect((await opened.saver.getTuple(config("thread_one")))?.checkpoint.id).toBe(nthId(8));
  expect((await opened.saver.getTuple(config("thread_two")))?.checkpoint.id).toBe(nthId(108));
  opened.close();
});

test("a wider window keeps exactly that many, newest first", async () => {
  const opened = openAgentCheckpointer(file(), { keep: 3 });
  for (let n = 1; n <= 9; n += 1) {
    await opened.saver.put(config("thread_one"), checkpoint(nthId(n)) as never, metadata(n) as never, {});
  }
  const kept = opened.db.prepare("SELECT checkpoint_id FROM checkpoints ORDER BY checkpoint_id DESC").all() as Array<{ checkpoint_id: string }>;
  expect(kept.map((row) => row.checkpoint_id)).toEqual([nthId(9), nthId(8), nthId(7)]);
  opened.close();
});

test("pruning is idempotent, and says nothing was there on a store the saver has never set up", () => {
  const opened = openAgentCheckpointer(file());
  // Nothing has written, so `setup()` has not run and there is no table. This
  // is what every prune-on-open does on a fresh machine.
  expect(pruneCheckpoints(opened.db)).toEqual({ checkpoints: 0, writes: 0 });
  expect(pruneCheckpoints(opened.db)).toEqual({ checkpoints: 0, writes: 0 });
  opened.close();
});

test("a second prune over an already-pruned thread deletes nothing and leaves the conversation readable", async () => {
  const opened = openAgentCheckpointer(file());
  for (let n = 1; n <= 4; n += 1) {
    await opened.saver.put(config("thread_one"), checkpoint(nthId(n)) as never, metadata(n) as never, {});
  }
  expect(pruneCheckpoints(opened.db)).toEqual({ checkpoints: 0, writes: 0 });
  expect((await opened.saver.getTuple(config("thread_one")))?.checkpoint.id).toBe(nthId(4));
  opened.close();
});

test("pending writes go with their checkpoint, and the newest checkpoint keeps its own", async () => {
  const opened = openAgentCheckpointer(file(), { keep: 9 });
  const first = await opened.saver.put(config("thread_one"), checkpoint(nthId(1)) as never, metadata(1) as never, {});
  await opened.saver.putWrites(first, [["messages", "answered the lap before"]], "task_1");
  const second = await opened.saver.put(config("thread_one"), checkpoint(nthId(2)) as never, metadata(2) as never, {});
  await opened.saver.putWrites(second, [["messages", "the parked call"]], "task_2");
  expect(countWrites(opened.db)).toBe(2);

  const report = pruneCheckpoints(opened.db, { keep: 1 });
  expect(report).toEqual({ checkpoints: 1, writes: 1 });
  // The survivor is the newest checkpoint's own pending write, which is where a
  // parked `interrupt()` lives.
  const tuple = await opened.saver.getTuple(config("thread_one"));
  expect(tuple?.checkpoint.id).toBe(nthId(2));
  expect(tuple?.pendingWrites?.map(([, , value]) => value)).toEqual(["the parked call"]);
  opened.close();
});

test("the free list is given back once it is worth a rewrite, and left alone when it is not", async () => {
  const location = file();
  const opened = openAgentCheckpointer(location, { keep: 500 });
  // ~96 MB of checkpoint blob, then a prune, so the free list is over the mark
  // a real upgrading machine crosses.
  for (let n = 1; n <= 96; n += 1) {
    await opened.saver.put(config("thread_one"), checkpoint(nthId(n), 1_000_000) as never, metadata(n) as never, {});
  }
  const grown = fs.statSync(location).size;
  expect(grown).toBeGreaterThan(64 * 1024 * 1024);

  pruneCheckpoints(opened.db);
  // THE DELETE ALONE DOES NOT SHRINK THE FILE — this is the half `reclaimFreeSpace`
  // exists for, and asserting it is what stops somebody removing the vacuum.
  expect(fs.statSync(location).size).toBeGreaterThan(64 * 1024 * 1024);

  const reclaimed = reclaimFreeSpace(opened.db);
  expect(reclaimed.vacuumed).toBe(true);
  expect(fs.statSync(location).size).toBeLessThan(16 * 1024 * 1024);

  // And the store that has just been rewritten does not pay for a second one.
  expect(reclaimFreeSpace(opened.db).vacuumed).toBe(false);
  expect((await opened.saver.getTuple(config("thread_one")))?.checkpoint.id).toBe(nthId(96));
  opened.close();
});

test("a store carrying free pages from an older build is reclaimed by opening it", async () => {
  const location = file();
  const before = openAgentCheckpointer(location, { keep: 500 });
  for (let n = 1; n <= 96; n += 1) {
    await before.saver.put(config("thread_one"), checkpoint(nthId(n), 1_000_000) as never, metadata(n) as never, {});
  }
  before.close();
  expect(fs.statSync(location).size).toBeGreaterThan(64 * 1024 * 1024);

  // The next daemon start, on the build that prunes. Nobody has said anything
  // to the Agent yet.
  const after = openAgentCheckpointer(location);
  expect(countCheckpoints(after.db, "thread_one")).toBe(CHECKPOINTS_KEPT);
  expect((await after.saver.getTuple(config("thread_one")))?.checkpoint.id).toBe(nthId(96));
  after.close();
  expect(fs.statSync(location).size).toBeLessThan(16 * 1024 * 1024);
});

/* ------------------------------------------------------------------ *
 * The thing a prune could break: a parked approval.
 * ------------------------------------------------------------------ */

const ApprovalState = Annotation.Root({
  ...MessagesAnnotation.spec,
  /** What the gated node did once it was allowed to. Checkpointed, so it proves
   *  the resumed node ran in the RESUMED process rather than the parked one. */
  did: Annotation<string[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
});

/**
 * A GRAPH SHAPED LIKE THE AGENT'S, down to where the interrupt is.
 *
 * `runtime.ts` interrupts inside the TOOLS node, before any effect in the same
 * node runs, and resumes with `new Command({ resume: decision })`. This is the
 * same seam with the model and the wall taken out, so what is being tested is
 * LangGraph's parked-interrupt durability over a pruned store and nothing else.
 */
function approvalGraph(saver: ReturnType<typeof openAgentCheckpointer>["saver"]) {
  return new StateGraph(ApprovalState)
    .addNode("think", (state) => ({ messages: [], did: [`thought about ${state.messages.length} messages`] }))
    .addNode("act", () => {
      const decision = interrupt<{ tool: string }, string>({ tool: "sessions_send" });
      return { did: [`acted: ${decision}`] };
    })
    .addEdge(START, "think")
    .addEdge("think", "act")
    .addEdge("act", END)
    .compile({ checkpointer: saver });
}

test("a parked interrupt survives the prune, is found again after a reopen, and resumes", async () => {
  const location = file();
  const threadId = "thread_parked";

  // ── The process that parks it.
  const first = openAgentCheckpointer(location);
  const parkedRun = { configurable: { thread_id: threadId } };
  await approvalGraph(first.saver).invoke({ messages: [new HumanMessage("send it")] }, parkedRun);
  const parkedHere = await approvalGraph(first.saver).getState(parkedRun);
  expect(parkedHere.tasks[0]?.interrupts?.[0]?.value).toEqual({ tool: "sessions_send" });
  // The saver pruned on every put, so what is parked is parked on the ONE row
  // that is left.
  expect(countCheckpoints(first.db, threadId)).toBe(CHECKPOINTS_KEPT);
  first.close();

  // ── A new process, which has never seen the thread. This is `restore`.
  const second = openAgentCheckpointer(location);
  const graph = approvalGraph(second.saver);
  const restored = await graph.getState(parkedRun);
  expect(restored.tasks[0]?.interrupts?.[0]?.value).toEqual({ tool: "sessions_send" });

  // ── And the person answers.
  const resumed = await graph.invoke(new Command({ resume: "approve" }), parkedRun);
  expect(resumed.did).toEqual(["thought about 1 messages", "acted: approve"]);
  const settled = await graph.getState(parkedRun);
  expect(settled.tasks.flatMap((task) => task.interrupts ?? [])).toEqual([]);
  expect(countCheckpoints(second.db, threadId)).toBe(CHECKPOINTS_KEPT);
  second.close();
});

test("an explicit prune while the approval is parked still leaves it resumable", async () => {
  const location = file();
  const threadId = "thread_parked_pruned";
  const opened = openAgentCheckpointer(location);
  const run = { configurable: { thread_id: threadId } };
  const graph = approvalGraph(opened.saver);
  await graph.invoke({ messages: [new HumanMessage("send it")] }, run);

  // Pruning again on top of a parked interrupt — the case "prune on open" hits
  // when a daemon restarts while somebody's approval is waiting.
  expect(pruneCheckpoints(opened.db)).toEqual({ checkpoints: 0, writes: 0 });
  reclaimFreeSpace(opened.db, { minBytes: 0 });

  expect((await graph.getState(run)).tasks[0]?.interrupts?.[0]?.value).toEqual({ tool: "sessions_send" });
  const resumed = await graph.invoke(new Command({ resume: "decline" }), run);
  expect(resumed.did).toEqual(["thought about 1 messages", "acted: decline"]);
  opened.close();
});

/* ------------------------------------------------------------------ *
 * The bound the issue asks for.
 * ------------------------------------------------------------------ */

/** A graph that laps, so one `invoke` is many supersteps and therefore many
 *  checkpoints — which is what made the store quadratic. */
const LapState = Annotation.Root({
  ...MessagesAnnotation.spec,
  laps: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
});

test("the store's size after a long conversation is bounded rather than growing with laps", async () => {
  const location = file();
  const opened = openAgentCheckpointer(location);
  const LAPS = 40;
  const graph = new StateGraph(LapState)
    .addNode("lap", (state) => ({
      // Each lap appends to the message list, so every checkpoint is a snapshot
      // of a conversation that only gets longer — the shape of the bug.
      messages: [new HumanMessage("x".repeat(20_000))],
      laps: state.laps + 1,
    }))
    .addEdge(START, "lap")
    .addConditionalEdges("lap", (state) => (state.laps >= LAPS ? END : "lap"))
    .compile({ checkpointer: opened.saver });

  const run = { configurable: { thread_id: "thread_long" }, recursionLimit: LAPS * 2 + 2 };
  const answer = await graph.invoke({ messages: [new HumanMessage("start")] }, run);
  expect(answer.laps).toBe(LAPS);
  // 41 messages × 20k is ~800 KB of conversation. Unpruned that is one snapshot
  // per lap — the 990 copies the issue measured, in miniature.
  expect(countCheckpoints(opened.db, "thread_long")).toBe(CHECKPOINTS_KEPT);
  opened.close();

  const size = fs.statSync(location).size;
  const conversation = 41 * 20_000;
  // A few copies' worth of slack for page churn and the WAL, and nowhere near
  // the LAPS × conversation the unpruned store would be.
  expect(size).toBeLessThan(conversation * 6);
});
