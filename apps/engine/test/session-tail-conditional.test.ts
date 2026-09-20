/**
 * THE SESSION TAIL, ASKED CONDITIONALLY — issue #586, step 0.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE LARGEST LOOP IN THE COCKPIT. The rail's tick was made nearly free by
 * #459/#462/#493; nothing equivalent was ever done for the tail, which runs at
 * 1 s against the rail's 10 — ~86,400 requests a day for one open conversation,
 * almost every one of them answering `events: []` after folding a page and
 * serialising a body.
 *
 * THE NEGATIVE CASE IS ASSERTED FIRST IN EVERY TEST HERE, on the
 * investigation's own instruction: a 304 that is really "this route always
 * answers 304" would pass a positive-only suite for ever, and would blank a
 * transcript once a second in front of a reader.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startEngine } from "../src/daemon";
import { EngineClient } from "@telar/engine-client";
import { stubModels } from "./stub-models";

const roots: string[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-586-"));
  roots.push(directory);
  return directory;
};

test("an unchanged tail answers 304 with no body, and a moved one answers 200 (#586)", async () => {
  const engineRoot = root();
  const daemon = await startEngine({ models: stubModels, engineRoot });
  const ask = (query: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${daemon.discovery.port}/v2/sessions/session_one/events${query}`, {
      headers: { authorization: `Bearer ${daemon.discovery.token}`, ...headers },
    });
  try {
    const client = new EngineClient(daemon.discovery);
    await client.registerProject({ id: "project_one", name: "One", root: engineRoot });
    await client.registerWorker("worker_one");
    await client.createSession({ id: "session_one", projectId: "project_one" });

    // THE FULL ANSWER, and the tag a client would spend next tick.
    const first = await ask("?after=0");
    expect(first.status).toBe(200);
    const tag = first.headers.get("etag");
    expect(tag).toBeTruthy();
    const firstBody = (await first.json()) as { events: unknown[]; cursor: number };
    const cursor = firstBody.cursor;

    /**
     * THE NEGATIVE FIRST. Something IS appended, and the same tag must NOT be
     * honoured — otherwise "304" would mean "this route always says 304" and the
     * saving would be a transcript that stops updating.
     */
    await client.submitTurn("session_one", { runId: "run_1", input: "hello" });
    const moved = await ask("?after=0", { "if-none-match": tag! });
    expect(moved.status).toBe(200);
    const movedTag = moved.headers.get("etag");
    expect(movedTag).toBeTruthy();
    expect(movedTag).not.toBe(tag!);
    const movedBody = (await moved.json()) as { events: unknown[] };
    expect(movedBody.events.length).toBeGreaterThan(0);

    // ...and NOW the idle tick: nothing written since, no body at all.
    const idle = await ask("?after=0", { "if-none-match": movedTag! });
    expect(idle.status).toBe(304);
    expect(idle.headers.get("etag")).toBe(movedTag!);
    expect(await idle.text()).toBe("");

    /**
     * A TAG IS NOT TRANSFERABLE BETWEEN WINDOWS, which is why `after` is inside
     * it. The cursor has not moved, so a cursor-only tag would answer a page
     * this client has never seen with "unchanged" — and a reader paging back
     * through a transcript would be handed nothing and keep the wrong rows.
     */
    const elsewhere = await ask(`?after=${cursor}`, { "if-none-match": movedTag! });
    expect(elsewhere.status).toBe(200);
    expect(elsewhere.headers.get("etag")).not.toBe(movedTag!);
  } finally {
    await daemon.close();
    for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the client's conditional read says `unchanged` rather than an empty page (#586)", async () => {
  /**
   * THE HALF THAT FAILS IN A READER'S FACE. `unchanged` means KEEP WHAT YOU
   * HAVE — the same word and the same rule `liveSessionsSince` uses. A caller
   * that read it as "no events" would blank a transcript once a second, so the
   * two arms are different SHAPES rather than one shape with an empty list.
   */
  const engineRoot = root();
  const daemon = await startEngine({ models: stubModels, engineRoot });
  try {
    const client = new EngineClient(daemon.discovery);
    await client.registerProject({ id: "project_one", name: "One", root: engineRoot });
    await client.registerWorker("worker_one");
    await client.createSession({ id: "session_one", projectId: "project_one" });
    await client.submitTurn("session_one", { runId: "run_1", input: "hello" });

    const first = await client.eventsIfChanged("session_one", 0);
    expect(first.unchanged).toBe(false);
    if (first.unchanged) throw new Error("expected a page");
    expect(first.payload.events.length).toBeGreaterThan(0);
    expect(first.etag).toBeTruthy();

    // Spent against an unmoved journal: the second arm, carrying no page at all.
    const again = await client.eventsIfChanged("session_one", 0, undefined, first.etag);
    expect(again.unchanged).toBe(true);
    // There is no `payload` to read — which is the point, and what stops a
    // caller treating "unchanged" as "empty".
    expect("payload" in again).toBe(false);

    // And the negative: no tag means no condition, so the page comes back whole.
    const unconditional = await client.eventsIfChanged("session_one", 0);
    expect(unconditional.unchanged).toBe(false);
  } finally {
    await daemon.close();
    for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  }
});
