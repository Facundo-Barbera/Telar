/**
 * THE AGENT'S OWN STATE — enable, disable, reset (#531).
 *
 * What must not drift:
 *
 *   - enabling mints a thread ONCE, so enable/disable/re-enable/restart can
 *     never leave two conversations;
 *   - disabling keeps the thread file AND the id, because re-enabling has to
 *     return to the same conversation;
 *   - reset ARCHIVES rather than deletes, takes the WAL and the shm with it,
 *     and is the only verb that moves `generation`;
 *   - the saver is closed BEFORE the file moves, because a rename under an open
 *     handle is how a WAL loses its tail;
 *   - a thread written by the saver in one process is readable by another —
 *     which is what "durable" has to mean.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentPaths, archiveThreadFile, ensureThreadId, patchAgentSettings, readAgentSettings } from "../src/agent/store";
import { openAgentCheckpointer } from "../src/agent/checkpointer";

function root(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "telar-agent-"));
}

test("a machine that never switched the Agent on has no document and no thread", () => {
  const paths = agentPaths(root());
  expect(readAgentSettings(paths)).toEqual({ enabled: false });
  expect(fs.existsSync(paths.settings)).toBe(false);
  expect(ensureThreadId(paths)).toBeUndefined();
});

test("enabling mints one thread, and enabling again reuses it", () => {
  const paths = agentPaths(root());
  const first = patchAgentSettings(paths, { enabled: true }).settings;
  expect(first.enabled).toBe(true);
  expect(first.threadId).toMatch(/^thread_[0-9a-f]{32}$/);
  const again = patchAgentSettings(paths, { enabled: true }).settings;
  expect(again.threadId).toBe(first.threadId!);
  expect(again.generation).toBeUndefined();
});

test("disabling keeps the thread id, and re-enabling returns to the same conversation", () => {
  const paths = agentPaths(root());
  const on = patchAgentSettings(paths, { enabled: true }).settings;
  const off = patchAgentSettings(paths, { enabled: false }).settings;
  expect(off.enabled).toBe(false);
  expect(off.threadId).toBe(on.threadId!);
  expect(patchAgentSettings(paths, { enabled: true }).settings.threadId).toBe(on.threadId!);
});

test("disabling keeps the thread FILE — the conversation is still there to resume", () => {
  const paths = agentPaths(root());
  patchAgentSettings(paths, { enabled: true });
  fs.writeFileSync(paths.threads, "not really sqlite, but a file the reset must not delete");
  patchAgentSettings(paths, { enabled: false });
  expect(fs.existsSync(paths.threads)).toBe(true);
});

test("the model is a setting of its own: empty clears it, and it never moves the generation", () => {
  const paths = agentPaths(root());
  patchAgentSettings(paths, { enabled: true });
  expect(patchAgentSettings(paths, { model: "kimi-k3" }).settings.model).toBe("kimi-k3");
  expect(patchAgentSettings(paths, { model: "  " }).settings.model).toBeUndefined();
  expect(readAgentSettings(paths).generation).toBeUndefined();
});

test("reset archives the thread with a timestamp, mints a new id, and bumps the generation", () => {
  const paths = agentPaths(root());
  const before = patchAgentSettings(paths, { enabled: true }).settings;
  fs.writeFileSync(paths.threads, "thread one");
  fs.writeFileSync(`${paths.threads}-wal`, "wal one");
  fs.writeFileSync(`${paths.threads}-shm`, "shm one");

  const at = Date.UTC(2026, 8, 15, 22, 46, 0);
  const result = patchAgentSettings(paths, { reset: true }, { now: () => at });

  expect(result.archived).toBe(path.join(paths.dir, "threads-20260915T224600.sqlite"));
  expect(fs.readFileSync(result.archived!, "utf8")).toBe("thread one");
  // The WAL and the shm travel with the database they belong to.
  expect(fs.readFileSync(`${result.archived!}-wal`, "utf8")).toBe("wal one");
  expect(fs.readFileSync(`${result.archived!}-shm`, "utf8")).toBe("shm one");
  expect(fs.existsSync(paths.threads)).toBe(false);

  expect(result.settings.threadId).not.toBe(before.threadId!);
  expect(result.settings.generation).toBe(1);
  expect(result.settings.enabled).toBe(true);
});

test("reset closes the saver before it moves the file", () => {
  const paths = agentPaths(root());
  patchAgentSettings(paths, { enabled: true });
  fs.writeFileSync(paths.threads, "thread one");
  const order: string[] = [];
  patchAgentSettings(paths, { reset: true }, {
    beforeArchive: () => order.push(fs.existsSync(paths.threads) ? "closed-while-present" : "closed-after-move"),
  });
  expect(order).toEqual(["closed-while-present"]);
});

test("two resets in the same second do not overwrite each other", () => {
  const paths = agentPaths(root());
  const at = Date.UTC(2026, 8, 15, 22, 46, 0);
  patchAgentSettings(paths, { enabled: true });
  fs.writeFileSync(paths.threads, "one");
  const first = patchAgentSettings(paths, { reset: true }, { now: () => at }).archived!;
  fs.writeFileSync(paths.threads, "two");
  const second = patchAgentSettings(paths, { reset: true }, { now: () => at }).archived!;
  expect(second).not.toBe(first);
  expect(fs.readFileSync(first, "utf8")).toBe("one");
  expect(fs.readFileSync(second, "utf8")).toBe("two");
});

test("resetting a machine that never had a conversation changes nothing and does not bump", () => {
  const paths = agentPaths(root());
  const result = patchAgentSettings(paths, { reset: true });
  expect(result.archived).toBeUndefined();
  expect(result.settings.generation).toBeUndefined();
  expect(result.settings.threadId).toBeUndefined();
});

test("reset and switch off in one call archives and leaves no new thread behind", () => {
  const paths = agentPaths(root());
  patchAgentSettings(paths, { enabled: true });
  fs.writeFileSync(paths.threads, "thread one");
  const result = patchAgentSettings(paths, { reset: true, enabled: false });
  expect(result.archived).toBeDefined();
  expect(result.settings.enabled).toBe(false);
  expect(result.settings.threadId).toBeUndefined();
  // Switching back on is a NEW conversation, which is what reset asked for.
  expect(patchAgentSettings(paths, { enabled: true }).settings.threadId).toMatch(/^thread_/);
});

test("a hand-mangled document costs the Agent rather than every read on the machine", () => {
  const paths = agentPaths(root());
  patchAgentSettings(paths, { enabled: true });
  fs.writeFileSync(paths.settings, "{ not json");
  expect(readAgentSettings(paths)).toEqual({ enabled: false });
});

test("archiveThreadFile answers undefined when there is nothing to retire", () => {
  expect(archiveThreadFile(agentPaths(root()), Date.now())).toBeUndefined();
});

/* ------------------------------------------------------------------ *
 * The checkpointer.
 * ------------------------------------------------------------------ */

const config = (threadId: string) => ({ configurable: { thread_id: threadId, checkpoint_ns: "" } });

const checkpoint = (id: string) => ({
  v: 4 as const,
  id,
  ts: new Date().toISOString(),
  channel_values: { messages: ["hello"] },
  channel_versions: { messages: 1 },
  versions_seen: {},
});

test("a checkpoint written by one saver is read by a saver opened afterwards", async () => {
  const paths = agentPaths(root());
  fs.mkdirSync(paths.dir, { recursive: true });

  const first = openAgentCheckpointer(paths.threads);
  await first.saver.put(config("thread_one"), checkpoint("1ef4f797-8335-6428-8001-8a1503f9b875") as never, { source: "input", step: 1, parents: {} } as never);
  first.close();

  const second = openAgentCheckpointer(paths.threads);
  const tuple = await second.saver.getTuple(config("thread_one"));
  second.close();

  expect(tuple?.checkpoint.id).toBe("1ef4f797-8335-6428-8001-8a1503f9b875");
  expect(tuple?.checkpoint.channel_values.messages).toEqual(["hello"]);
});

test("a thread nobody wrote to answers nothing rather than throwing", async () => {
  const paths = agentPaths(root());
  fs.mkdirSync(paths.dir, { recursive: true });
  const opened = openAgentCheckpointer(paths.threads);
  expect(await opened.saver.getTuple(config("thread_absent"))).toBeUndefined();
  opened.close();
});

test("pending writes commit through the adapter's own transaction, and deleteThread rolls the thread away", async () => {
  const paths = agentPaths(root());
  fs.mkdirSync(paths.dir, { recursive: true });
  const opened = openAgentCheckpointer(paths.threads);

  const written = await opened.saver.put(config("thread_two"), checkpoint("1ef4f797-8335-6428-8001-8a1503f9b876") as never, { source: "input", step: 1, parents: {} } as never);
  await opened.saver.putWrites(written, [["messages", "a pending write"]], "task_1");
  expect((await opened.saver.getTuple(config("thread_two")))?.pendingWrites?.length).toBe(1);

  await opened.saver.deleteThread("thread_two");
  expect(await opened.saver.getTuple(config("thread_two"))).toBeUndefined();
  opened.close();
});

test("close is idempotent — the reset path calls it without knowing whether the runtime already did", () => {
  const paths = agentPaths(root());
  fs.mkdirSync(paths.dir, { recursive: true });
  const opened = openAgentCheckpointer(paths.threads);
  opened.close();
  opened.close();
});
