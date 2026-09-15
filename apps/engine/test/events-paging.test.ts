/**
 * THE JOURNAL, A PAGE AT A TIME — issue #494.
 *
 * `GET /v2/sessions/:id/events` used to answer with the whole tail above
 * `after` and report `more: false` whatever it had done. The #490 audit priced
 * that on the biggest dogfood session: 36.5 MB serialised in 2.48 s, against
 * 185 KB / 106 ms for a 200-row page of the same journal.
 *
 * WHAT IS ACTUALLY UNDER TEST is not "the route returns fewer rows" — it is
 * that a client walking the pages sees EXACTLY the journal, once, in order. A
 * page size is easy; a keyset that neither skips nor repeats while the session
 * is still appending is the part that breaks. So the cases below assert the
 * reassembled walk against the unpaged read, on BOTH document backends, and
 * with unflushed deltas deliberately straddling a page boundary.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, type EngineClientError } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { EngineStore } from "../src/state";
import { stubModels } from "./stub-models";

const roots: string[] = [];
const stores: EngineStore[] = [];
const daemons: EngineDaemon[] = [];

const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-events-paging-"));
  roots.push(directory);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
};

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const store of stores.splice(0)) store.closeExecutionStore();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

type Storage = "json" | "sqlite";
const BACKENDS: Storage[] = ["json", "sqlite"];

/**
 * A session carrying `deltas` streamed chunks, seeded through the PUBLIC path.
 *
 * Deltas rather than turns because they are what a long journal is actually
 * made of — one per token — and because they are the rows the sqlite backend
 * HOLDS unflushed, which is the case a naive `LIMIT` gets wrong.
 */
function streaming(storage: Storage, deltas: number, home = root()) {
  const store = new EngineStore(home, Date.now, { executionStorage: storage });
  stores.push(store);
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  store.createSession({ id: "session_one", projectId: "project_one" });
  store.submitTurn("session_one", { runId: "run_one", input: "stream" });
  const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
  store.markRunning("session_one", "run_one", token);
  store.ingestObservations("session_one", "run_one", token, [
    { kind: "item.started", item: { id: "item_one", detail: { type: "assistant_message", text: "" } } },
  ]);
  for (let index = 0; index < deltas; index += 1) {
    store.ingestObservations("session_one", "run_one", token, [
      { kind: "content.delta", itemId: "item_one", stream: "assistant_text", text: `chunk-${index} ` },
    ]);
  }
  return { store, home, token };
}

for (const storage of BACKENDS) {
  test(`a bounded read answers with the first page and nothing else (${storage})`, () => {
    const { store } = streaming(storage, 40);
    const whole = store.readEvents("session_one");
    expect(whole.length).toBeGreaterThan(20);

    const page = store.readEvents("session_one", 0, 20);
    expect(page).toHaveLength(20);
    // THE SAME ROWS, not merely the same count: a page is a prefix of the tail.
    expect(page).toEqual(whole.slice(0, 20));
  });

  test(`paging from the last id seen reassembles the journal exactly (${storage})`, () => {
    const { store } = streaming(storage, 97);
    const whole = store.readEvents("session_one");

    const walked = [];
    let cursor = 0;
    for (let page = 0; page < 200; page += 1) {
      const read = store.readEvents("session_one", cursor, 7);
      if (!read.length) break;
      walked.push(...read);
      cursor = read.at(-1)!.id;
    }
    // NEITHER SKIPPED NOR REPEATED. An offset-based window would fail exactly
    // here if anything were appended mid-walk, which is why the cursor is an id.
    expect(walked.map((event) => event.id)).toEqual(whole.map((event) => event.id));
    expect(new Set(walked.map((event) => event.id)).size).toBe(walked.length);
  });

  test(`a page that begins mid-journal starts at the row after the cursor (${storage})`, () => {
    const { store } = streaming(storage, 30);
    const whole = store.readEvents("session_one");
    const from = whole[9]!.id;
    expect(store.readEvents("session_one", from, 5)).toEqual(whole.slice(10, 15));
  });

  test(`an absent limit still answers with the whole tail (${storage})`, () => {
    // The export and the in-process folds ask without one, and #494 must not
    // have quietly truncated them.
    const { store } = streaming(storage, 25);
    expect(store.readEvents("session_one", 0, undefined).length).toBe(store.readEvents("session_one").length);
  });

  test(`a limit that is not a positive integer is refused, not defaulted (${storage})`, () => {
    const { store } = streaming(storage, 3);
    expect(() => store.readEvents("session_one", 0, 0)).toThrow(/limit/);
    expect(() => store.readEvents("session_one", 0, -5)).toThrow(/limit/);
    expect(() => store.readEvents("session_one", 0, 1.5)).toThrow(/limit/);
  });
}

/** What has actually been COMMITTED, on a second connection — the only way to
 *  separate "the reader saw it" from "the disk has it". Same idiom as
 *  `execution-store.test.ts`. */
function committed(home: string): number {
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(path.join(home, "execution.sqlite"), { readonly: true });
  try { return Number(db.query("SELECT COUNT(*) AS n FROM events WHERE session_id='session_one'").get()!.n); }
  finally { db.close(); }
}

test("unflushed deltas are paged with the stored rows, not appended past the limit", () => {
  // SQLITE ONLY, because holding a delta in memory is what that backend does
  // (see FLUSH_COUNT): a page has to be filled from the disk first and topped
  // up from the buffer, or a bounded read would either overrun its limit or
  // step over rows that had not been written yet.
  const { store, home } = streaming("sqlite", 40);
  const whole = store.readEvents("session_one");

  // THE PREMISE OF THE TEST, asserted rather than assumed: some of that tail is
  // still in memory, so the page boundary below genuinely lands inside it.
  const onDisk = committed(home);
  expect(onDisk).toBeLessThan(whole.length);

  // A window that straddles the flush line: it starts among stored rows and
  // ends among held ones.
  const from = whole[onDisk - 2]!.id;
  const page = store.readEvents("session_one", from, 6);
  expect(page).toHaveLength(6);
  expect(page).toEqual(whole.slice(onDisk - 1, onDisk + 5));

  // And a page that begins ENTIRELY inside the buffer is still a page, not the
  // whole remaining tail.
  const held = store.readEvents("session_one", whole[onDisk]!.id, 3);
  expect(held).toEqual(whole.slice(onDisk + 1, onDisk + 4));
});

async function daemon() {
  const engine = await startEngine({ models: stubModels, engineRoot: root() });
  daemons.push(engine);
  const client = new EngineClient(engine.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: root() });
  await client.createSession({ id: "session_one", projectId: "project_one" });
  await client.registerWorker("worker_one");
  return { engine, client };
}

/** `count` streamed deltas through the HTTP surface, so the journal under the
 *  route is one a real turn would have written. */
async function stream(client: EngineClient, count: number) {
  await client.submitTurn("session_one", { runId: "run_one", input: "stream" });
  const token = (await client.claimTurn("worker_one", 1)).claim!.turn.claim!.token;
  await client.markTurnRunning("session_one", "run_one", token);
  await client.reportObservations("session_one", "run_one", token, [
    { kind: "item.started", item: { id: "item_one", detail: { type: "assistant_message", text: "" } } },
  ]);
  // BATCHED, unlike the store-level seeding above: what is under test here is
  // the route's window over the journal, not the ingest's batching, and one
  // request per delta is the slowest thing this file could do.
  for (let index = 0; index < count; index += 10) {
    await client.reportObservations(
      "session_one",
      "run_one",
      token,
      Array.from({ length: Math.min(10, count - index) }, (_, step) => ({
        kind: "content.delta" as const,
        itemId: "item_one",
        stream: "assistant_text" as const,
        text: `chunk-${index + step} `,
      })),
    );
  }
}

test("the route pages on a keyset cursor and says so, and the last page says it is the last", async () => {
  const { client } = await daemon();
  await stream(client, 30);

  const first = await client.events("session_one", 0, 10);
  expect(first.events).toHaveLength(10);
  expect(first.more).toBe(true);
  // `next` IS PRESENT EXACTLY WHEN `more` IS, and it is where to ask from.
  expect(first.next).toBe(first.cursor);
  expect(first.cursor).toBe(first.events.at(-1)!.id);

  const walked = [...first.events];
  let page = first;
  while (page.more) {
    page = await client.events("session_one", page.next!, 10);
    walked.push(...page.events);
  }
  // The walk ENDS, and the end is honest: no `next` to follow, nothing left.
  expect(page.next).toBeUndefined();
  expect((await client.events("session_one", page.cursor, 10)).events).toEqual([]);

  const whole = await client.drainEvents("session_one", 0, { limit: 1000 });
  expect(walked.map((event) => event.id)).toEqual(whole.events.map((event) => event.id));
});

test("an exactly-full last page reports more: false rather than costing a round trip to find out", async () => {
  // The cheap implementation — "the page came back full, so say more" — would
  // report true here and make every complete walk pay one empty request.
  const { client } = await daemon();
  await stream(client, 30);
  const whole = await client.events("session_one", 0, 1000);
  const exact = await client.events("session_one", 0, whole.events.length);
  expect(exact.events).toHaveLength(whole.events.length);
  expect(exact.more).toBe(false);
  expect(exact.next).toBeUndefined();
});

test("the route defaults to 200 rows and refuses to serve more than 1000", async () => {
  const { client } = await daemon();
  await stream(client, 260);

  const defaulted = await client.events("session_one");
  expect(defaulted.events).toHaveLength(200);
  expect(defaulted.more).toBe(true);

  // Over the cap is CLAMPED, not refused: a client asking for the run back gets
  // a page, which is the whole point of having a cap at all.
  const capped = await client.events("session_one", 0, 5000);
  expect(capped.events.length).toBeLessThanOrEqual(1000);
  expect(capped.events.length).toBe((await client.events("session_one", 0, 1000)).events.length);
});

test("a limit that is not a positive integer is a 400, not a whole journal", async () => {
  const { client, engine } = await daemon();
  await stream(client, 5);
  const refused = await client.events("session_one", 0, 0).catch((error: EngineClientError) => error);
  expect((refused as EngineClientError).status).toBe(400);
  expect((refused as EngineClientError).message).toMatch(/limit/i);

  // …and a garbage string on the wire is refused the same way, rather than
  // falling through `Number("nonsense")` into the default.
  const raw = await fetch(
    `http://127.0.0.1:${engine.discovery.port}/v2/sessions/session_one/events?limit=nonsense`,
    { headers: { authorization: `Bearer ${engine.discovery.token}` } },
  );
  expect(raw.status).toBe(400);
});

test("drainEvents walks every page and hands back one journal", async () => {
  const { client } = await daemon();
  await stream(client, 120);
  const drained = await client.drainEvents("session_one", 0, { limit: 25 });
  expect(drained.more).toBe(false);
  const whole = await client.events("session_one", 0, 1000);
  expect(drained.events.map((event) => event.id)).toEqual(whole.events.map((event) => event.id));
  expect(drained.cursor).toBe(whole.cursor);
});
