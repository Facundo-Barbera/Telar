/**
 * READING THE AGENT'S TRANSCRIPT FROM THE END — issue #580.
 *
 * The screen that opens a conversation wants its LAST page. The route only
 * paged forward, so it read the whole thing oldest-first to get there: on the
 * owner's thread that was a dozen sequential requests and most of a megabyte
 * before the first line was drawn.
 *
 * What must not drift:
 *
 *   - a tail window is the LAST rows, ascending, with the thread's TIP as
 *     `cursor` — so the reader polls forward from the end, not from the top of
 *     the window it just read;
 *   - `before` is EXCLUSIVE and walks back one page at a time, and consecutive
 *     windows join up with no gap and no row seen twice;
 *   - `more` means OLDER rows are waiting, and goes false at the beginning;
 *   - the byte budget drops the OLDEST rows of a window, never the newest, and
 *     says `more` when it does;
 *   - `after=` is untouched, and a bare read still starts at the beginning —
 *     backward is asked for, never inferred.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { stubModels } from "./stub-models";
import { AgentThreadLog } from "../src/agent/thread-log";
import { openAgentCheckpointer } from "../src/agent/checkpointer";
import { agentPaths } from "../src/agent/store";

/* ------------------------------------------------------------------ *
 * The store.
 * ------------------------------------------------------------------ */

/** `count` user messages on one thread, ids 1..count. `filler` pads the row so
 *  a test can spend the byte budget on purpose. */
function fill(log: AgentThreadLog, threadId: string, count: number, filler = ""): void {
  for (let index = 1; index <= count; index += 1) {
    log.append({ threadId, runId: `run_${index}`, at: index, kind: "user_message", detail: { text: `message ${index}${filler}` } });
  }
}

test("a tail window is the last rows, ascending, with the thread's tip as the cursor", () => {
  const opened = openAgentCheckpointer(":memory:");
  const log = new AgentThreadLog(opened.db);
  fill(log, "thread_a", 120);

  const tail = log.window("thread_a", { limit: 50 });
  expect(tail.rows).toHaveLength(50);
  // ASCENDING, so a client prepends a block rather than reversing one.
  expect(tail.rows.map((row) => row.id)).toEqual(Array.from({ length: 50 }, (_, index) => 71 + index));
  expect(tail.oldest).toBe(71);
  // THE TIP, not the top of this window — what a forward poll resumes from.
  expect(tail.cursor).toBe(120);
  expect(tail.more).toBe(true);
  opened.close();
});

test("before walks back, joins up with no gap, and stops at the beginning", () => {
  const opened = openAgentCheckpointer(":memory:");
  const log = new AgentThreadLog(opened.db);
  fill(log, "thread_a", 120);

  const tail = log.window("thread_a", { limit: 50 });
  const second = log.window("thread_a", { before: tail.oldest!, limit: 50 });
  const third = log.window("thread_a", { before: second.oldest!, limit: 50 });

  expect(second.rows.map((row) => row.id)).toEqual(Array.from({ length: 50 }, (_, index) => 21 + index));
  expect(second.more).toBe(true);
  // `before` IS EXCLUSIVE: the two windows meet, and neither carries a row the
  // other does.
  expect(second.rows.at(-1)!.id + 1).toBe(tail.rows[0]!.id);

  expect(third.rows.map((row) => row.id)).toEqual(Array.from({ length: 20 }, (_, index) => 1 + index));
  // NOTHING OLDER — the top of the conversation, said as a fact rather than as
  // an empty page the reader has to ask for to discover.
  expect(third.more).toBe(false);
  expect(third.oldest).toBe(1);

  // Every row, once, across the three windows.
  const seen = [...third.rows, ...second.rows, ...tail.rows].map((row) => row.id);
  expect(seen).toEqual(Array.from({ length: 120 }, (_, index) => index + 1));
  expect(new Set(seen).size).toBe(120);
  opened.close();
});

test("a window past the beginning is empty and offers no further cursor", () => {
  const opened = openAgentCheckpointer(":memory:");
  const log = new AgentThreadLog(opened.db);
  fill(log, "thread_a", 3);

  const top = log.window("thread_a", { before: 1, limit: 50 });
  expect(top.rows).toEqual([]);
  expect(top.more).toBe(false);
  // NO `oldest` ON AN EMPTY WINDOW, so a puller cannot loop on the same read.
  expect(top.oldest).toBeUndefined();
  // The tip is still the tip: the poll is unaffected by how far back somebody
  // scrolled.
  expect(top.cursor).toBe(3);
  opened.close();
});

test("the byte budget drops the oldest rows of a window, and says so", () => {
  const opened = openAgentCheckpointer(":memory:");
  const log = new AgentThreadLog(opened.db);
  // 40 rows of ~10k each: far past the 64k page budget, well inside the count.
  fill(log, "thread_a", 40, "x".repeat(10_000));

  const tail = log.window("thread_a", { limit: 50 });
  expect(tail.rows.length).toBeGreaterThan(0);
  expect(tail.rows.length).toBeLessThan(40);
  // THE NEWEST SURVIVED. A budget that kept the oldest would hand a reader
  // opening the conversation the part of it they were not looking at.
  expect(tail.rows.at(-1)!.id).toBe(40);
  expect(tail.more).toBe(true);
  // And the window is contiguous down from the tip.
  expect(tail.rows.map((row) => row.id)).toEqual(
    Array.from({ length: tail.rows.length }, (_, index) => 41 - tail.rows.length + index),
  );
  opened.close();
});

test("one huge row still goes through, so a cursor can never fail to advance", () => {
  const opened = openAgentCheckpointer(":memory:");
  const log = new AgentThreadLog(opened.db);
  fill(log, "thread_a", 1, "x".repeat(200_000));

  const tail = log.window("thread_a", { limit: 50 });
  expect(tail.rows).toHaveLength(1);
  expect(tail.more).toBe(false);
  opened.close();
});

test("a window is scoped to its thread", () => {
  const opened = openAgentCheckpointer(":memory:");
  const log = new AgentThreadLog(opened.db);
  fill(log, "thread_a", 5);
  fill(log, "thread_b", 5);

  const tail = log.window("thread_b", { limit: 50 });
  expect(tail.rows.every((row) => row.threadId === "thread_b")).toBe(true);
  expect(tail.rows).toHaveLength(5);
  opened.close();
});

/* ------------------------------------------------------------------ *
 * The route.
 * ------------------------------------------------------------------ */

/** A model that answers one fixed sentence and never leaves the machine — the
 *  key ladder would otherwise reach a real credential. */
class Quiet extends BaseChatModel {
  _llmType(): string {
    return "quiet";
  }
  override bindTools(): this {
    return this;
  }
  async _generate(): Promise<ChatResult> {
    const message = new AIMessage({ content: "noted." });
    return { generations: [{ text: "noted.", message }] };
  }
}

const roots: string[] = [];
const daemons: EngineDaemon[] = [];

/**
 * ROWS WRITTEN STRAIGHT INTO THE THREAD FILE the daemon is serving.
 *
 * A HUNDRED SCRIPTED TURNS WOULD BE A TEST ABOUT THE RUNTIME that happened to
 * leave rows behind, and a slow one. This is a test about the window, so the
 * rows are put there the way the runtime puts them — same table, same append —
 * on a second handle to the same file, which sqlite is happy to give and which
 * the daemon's own reads see immediately.
 */
function seed(engineRoot: string, threadId: string, count: number): void {
  const opened = openAgentCheckpointer(agentPaths(engineRoot).threads);
  try {
    fill(new AgentThreadLog(opened.db), threadId, count);
  } finally {
    opened.close();
  }
}

async function engine(): Promise<{ daemon: EngineDaemon; client: EngineClient }> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-agent-window-"));
  roots.push(directory);
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  const daemon = await startEngine({ models: stubModels, engineRoot: directory, agentModel: () => new Quiet() });
  daemons.push(daemon);
  return { daemon, client: new EngineClient(daemon.discovery) };
}

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test("the route opens on the tail and walks back, and after= is untouched", async () => {
  const { daemon, client } = await engine();
  await client.setAgent({ enabled: true });
  const threadId = (await client.agent()).agent.threadId!;
  seed(daemon.store.paths.root, threadId, 130);

  const tail = await client.agentThread({ tail: true, limit: 50 });
  expect(tail.rows).toHaveLength(50);
  expect(tail.rows[0]!.id).toBe(81);
  expect(tail.rows.at(-1)!.id).toBe(130);
  expect(tail.cursor).toBe(130);
  expect(tail.oldest).toBe(81);
  expect(tail.more).toBe(true);
  expect(tail.threadId).toBe(threadId);

  const older = await client.agentThread({ before: tail.oldest!, limit: 50 });
  expect(older.rows[0]!.id).toBe(31);
  expect(older.rows.at(-1)!.id).toBe(80);
  expect(older.cursor).toBe(130);

  // FORWARD IS UNCHANGED, which is the promise that lets an older client keep
  // working: `after` still means "what is new", and a bare read still starts at
  // the beginning rather than silently landing at the end.
  const forward = await client.agentThread({ after: 128 });
  expect(forward.rows.map((row) => row.id)).toEqual([129, 130]);
  expect(forward.more).toBe(false);

  const bare = await client.agentThread({ limit: 10 });
  expect(bare.rows[0]!.id).toBe(1);
  expect(bare.more).toBe(true);
});

test("the tail of a thread shorter than one page is the whole of it, with nothing older", async () => {
  const { daemon, client } = await engine();
  await client.setAgent({ enabled: true });
  const threadId = (await client.agent()).agent.threadId!;
  seed(daemon.store.paths.root, threadId, 4);

  const tail = await client.agentThread({ tail: true, limit: 50 });
  expect(tail.rows.map((row) => row.id)).toEqual([1, 2, 3, 4]);
  expect(tail.more).toBe(false);
  expect(tail.oldest).toBe(1);
});

test("a switched-off Agent answers an empty window rather than failing", async () => {
  const { client } = await engine();
  const tail = await client.agentThread({ tail: true, limit: 50 });
  expect(tail.rows).toEqual([]);
  expect(tail.cursor).toBe(0);
  expect(tail.more).toBe(false);
  expect(tail.oldest).toBeUndefined();
});

test("before must be a non-negative integer, and the refusal says which parameter", async () => {
  const { client } = await engine();
  await client.setAgent({ enabled: true });
  await expect(client.agentThread({ before: -1 })).rejects.toThrow(/before/);
});
