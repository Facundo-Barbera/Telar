import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../../state";
import { ExecutionStore } from "./execution-store";

const homes: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) { try { close(); } catch { /* already closed */ } }
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

const START = Date.parse("2026-01-01T00:00:00Z");
const NEEDLE = "only-in-the-completed-item";

function build(turns = 3): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-slim-"));
  homes.push(home);
  const engine = new EngineStore(home, () => START);
  engine.registerProject({ id: "project_one", name: "one", root: "/tmp" });
  engine.createSession({ id: "session_one", projectId: "project_one" });
  for (let turn = 0; turn < turns; turn += 1) {
    const runId = `run_${turn}`;
    engine.submitTurn("session_one", { runId, input: `ask ${turn}` });
    const token = engine.claimTurn("session_one", "worker_one")!.claim!.token;
    engine.markRunning("session_one", runId, token);
    engine.ingestObservations("session_one", runId, token, [
      { kind: "item.started", item: { id: `cmd_${turn}`, title: "bash", detail: { type: "command_execution", command: { command: "ls" } } } },
      { kind: "item.completed", itemId: `cmd_${turn}`, status: "completed", detail: { type: "command_execution", command: { command: "ls", exitCode: 0, outputPreview: `${NEEDLE} ${turn} ${"x".repeat(2000)}` } } },
      { kind: "item.started", item: { id: `item_${turn}`, title: "answering", detail: { type: "assistant_message", text: "" } } },
      { kind: "content.delta", itemId: `item_${turn}`, stream: "assistant_text", text: "part one " },
      { kind: "item.completed", itemId: `item_${turn}`, status: "completed", detail: { type: "assistant_message", text: "part one" } },
    ]);
    engine.completeTurn("session_one", runId, token, { text: `answer ${turn}` });
  }
  engine.closeExecutionStore();
  return home;
}

function reopen(home: string): ExecutionStore {
  const store = new ExecutionStore(home, { compactAfterOpenMs: 60 * 60 * 1000 });
  closers.push(() => store.close());
  return store;
}

/** The rows as stored, read beside the open store — never through `events()`,
 *  which is the thing under test. */
function raw(home: string): { stubs: number; needle: number; bytes: number } {
  const db = new Database(path.join(home, "execution.sqlite"), { readonly: true });
  try {
    const row = db.query(
      `SELECT SUM(json_extract(value,'$.itemRow') IS NOT NULL) AS stubs,
              SUM(value LIKE '%${NEEDLE}%') AS needle,
              SUM(LENGTH(CAST(value AS BLOB))) AS bytes
         FROM events WHERE session_id='session_one'`,
    ).get() as { stubs: number; needle: number; bytes: number };
    return { stubs: Number(row.stubs), needle: Number(row.needle), bytes: Number(row.bytes) };
  } finally { db.close(); }
}

test("a slimmed journal reads back exactly as it was written", () => {
  const home = build();
  const store = reopen(home);
  store.sweep(["compact"]);
  const before = store.events("session_one");
  const stored = raw(home);

  expect(store.sweep(["slim"]).slimmed).toEqual({ rows: 6, sessions: 1 });
  // The sweep did something: every completed item is a stub, and no stored
  // row holds the command output any more.
  expect(raw(home).stubs).toBe(6);
  expect(raw(home).needle).toBe(0);
  expect(raw(home).bytes).toBeLessThan(stored.bytes - 6000);
  // …and nothing a reader sees moved, paged or whole.
  expect(store.events("session_one")).toEqual(before);
  expect(store.events("session_one", 0, 3)).toEqual(before.slice(0, 3));
});

test("it runs once: a second sweep changes nothing", () => {
  const home = build();
  const store = reopen(home);
  store.sweep(["compact"]);
  store.sweep(["slim"]);
  const once = store.events("session_one");
  const bytes = raw(home).bytes;
  expect(store.sweep(["slim"]).slimmed).toEqual({ rows: 0, sessions: 0 });
  expect(raw(home).bytes).toBe(bytes);
  expect(store.events("session_one")).toEqual(once);
});

test("nothing the compaction has not read is slimmed", () => {
  const home = build();
  const store = reopen(home);
  // No compaction yet: its watermark is 0, so the slimming must not start.
  expect(store.sweep(["slim"]).slimmed).toEqual({ rows: 0, sessions: 0 });
  expect(raw(home).stubs).toBe(0);
});

test("grep finds text that now lives only in the items row, and answers it whole", () => {
  const home = build();
  const store = reopen(home);
  store.sweep(["compact"]);
  const before = store.grepEvents("session_one", NEEDLE, undefined, 50);
  expect(before).toHaveLength(3);

  store.sweep(["slim"]);
  expect(raw(home).needle).toBe(0);
  const after = store.grepEvents("session_one", NEEDLE, undefined, 50);
  expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
  expect(after.map((row) => JSON.parse(row.value))).toEqual(before.map((row) => JSON.parse(row.value)));
  // Keyset paging still walks the same rows.
  expect(store.grepEvents("session_one", NEEDLE, before[0]!.id, 50).map((row) => row.id)).toEqual(before.slice(1).map((row) => row.id));
});

test("a row that differs from its event is not slimmed", () => {
  const home = build(1);
  const store = reopen(home);
  store.sweep(["compact"]);
  const before = store.events("session_one");
  // The item row moves on, so the event is no longer a copy of it.
  store.upsertItems("session_one", [{ id: "cmd_0", runId: "run_0", value: JSON.stringify({ id: "cmd_0", runId: "run_0", status: "completed", changed: true }) }]);
  expect(store.sweep(["slim"]).slimmed).toEqual({ rows: 1, sessions: 1 });
  expect(store.events("session_one")).toEqual(before);
});

test("a row that changes after it was slimmed gives the stub its item back first", () => {
  const home = build(1);
  const store = reopen(home);
  store.sweep(["compact"]);
  const before = store.events("session_one");
  store.sweep(["slim"]);
  expect(raw(home).stubs).toBe(2);

  store.upsertItems("session_one", [{ id: "cmd_0", runId: "run_9", value: JSON.stringify({ id: "cmd_0", runId: "run_9", status: "inProgress" }) }]);
  expect(raw(home).stubs).toBe(1);
  expect(store.events("session_one")).toEqual(before);
});

test("retention's guards and export are unchanged by a slimmed journal", () => {
  const home = build();
  const store = reopen(home);
  store.sweep(["compact"]);
  const before = store.events("session_one");
  store.sweep(["slim"]);

  const exportTo = path.join(home, "exports");
  expect(store.retireSession("session_one", { exportTo })).toEqual({ retired: true, events: before.length });
  const lines = fs.readFileSync(path.join(exportTo, "session_one", "sessions", "session_one", "events.ndjson"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  // The export is the full journal, not the stubs.
  expect(lines).toEqual(before);
  expect(lines.some((line) => "itemRow" in line)).toBe(false);
});
