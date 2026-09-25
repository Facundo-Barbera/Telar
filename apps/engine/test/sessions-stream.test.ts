/**
 * EVERY SESSION'S EVENTS, ON ONE CONNECTION — issue #586, step 2.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * EVERY TEST HERE CLOSES ITS STREAM IN THE SAME TEST THAT OPENS IT. An SSE
 * response never ends by itself, so a reader left open holds the daemon's
 * `close()` for ever and the failure lands on whichever test runs next.
 *
 * THE FRAME IS THIN ON PURPOSE and the assertions say so: which session, which
 * event id, what kind. A frame is never the record — it names a fact the reader
 * re-derives from `/events` — so asserting the event BODY arrived would be
 * pinning a design this feed deliberately does not have.
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-586-stream-"));
  roots.push(directory);
  return directory;
};

/** Read SSE `data:` frames off a live response until `wanted` have arrived or
 *  the bound passes. THE READER IS ALWAYS CANCELLED by the caller's `finally`. */
async function frames(body: ReadableStream<Uint8Array>, wanted: number, budgetMs = 4_000): Promise<Record<string, unknown>[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const seen: Record<string, unknown>[] = [];
  const deadline = Date.now() + budgetMs;
  let buffered = "";
  try {
    while (seen.length < wanted && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) seen.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return seen;
}

test("a session event reaches a watcher as a thin frame, and the daemon still closes (#586)", async () => {
  const engineRoot = root();
  const daemon = await startEngine({ models: stubModels, engineRoot });
  let stream: Response | undefined;
  try {
    const client = new EngineClient(daemon.discovery);
    await client.registerWorker("worker_one");
    await client.registerProject({ id: "project_one", name: "One", root: engineRoot });
    await client.createSession({ id: "session_one", projectId: "project_one" });

    stream = await fetch(`http://127.0.0.1:${daemon.discovery.port}/v2/sessions/stream`, {
      headers: { authorization: `Bearer ${daemon.discovery.token}` },
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");

    // Something happens AFTER the subscription, which is the only thing a
    // live-only feed promises to carry.
    const collected = frames(stream.body!, 1);
    await client.submitTurn("session_one", { runId: "run_1", input: "hello" });
    const seen = await collected;

    expect(seen.length).toBeGreaterThan(0);
    const first = seen[0]!;
    expect(first.sessionId).toBe("session_one");
    expect(typeof first.id).toBe("number");
    expect(typeof first.type).toBe("string");
    // THE FRAME IS NOT THE RECORD: no event body rides it, by design.
    expect("item" in first).toBe(false);
    expect("turn" in first).toBe(false);
  } finally {
    // CANCELLED BEFORE `close()`, or the daemon waits on a connection that by
    // design never ends — the case `openStreams` exists for, asserted by this
    // test simply completing.
    await stream?.body?.cancel().catch(() => {});
    await daemon.close();
    for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a watcher whose socket has gone does not take down the write that found it (#586)", async () => {
  /**
   * `publish` SWALLOWS A THROWING WATCHER: the socket on the other end is
   * allowed to have gone, and its own route unsubscribes when it notices. The way this fails
   * without that is the worst kind — a turn that cannot be journalled because
   * somebody closed a tab.
   *
   * Driven through `store.watch` directly rather than through a socket, because
   * the claim is about the EMITTER and a real socket cannot be made to throw on
   * demand.
   */
  const engineRoot = root();
  const daemon = await startEngine({ models: stubModels, engineRoot });
  try {
    const client = new EngineClient(daemon.discovery);
    await client.registerWorker("worker_one");
    await client.registerProject({ id: "project_one", name: "One", root: engineRoot });
    await client.createSession({ id: "session_one", projectId: "project_one" });

    let reached = 0;
    const stopAngry = daemon.store.watch(() => {
      throw new Error("this watcher's socket has gone");
    });
    const stopCounting = daemon.store.watch(() => {
      reached += 1;
    });
    try {
      // The write must succeed, and the SECOND watcher must still be reached —
      // a `for` loop that aborted on the first throw would leave every later
      // listener silently unserved.
      await client.submitTurn("session_one", { runId: "run_1", input: "hello" });
      expect(reached).toBeGreaterThan(0);
      // ...and the journal really did get the event, which is the half that
      // matters: the feed is not allowed to cost a write.
      const page = await client.events("session_one", 0);
      expect(page.events.length).toBeGreaterThan(0);
    } finally {
      stopAngry();
      stopCounting();
    }
  } finally {
    await daemon.close();
    for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("unsubscribing stops the frames, so a closed reader costs nothing (#586)", async () => {
  const engineRoot = root();
  const daemon = await startEngine({ models: stubModels, engineRoot });
  try {
    const client = new EngineClient(daemon.discovery);
    await client.registerWorker("worker_one");
    await client.registerProject({ id: "project_one", name: "One", root: engineRoot });
    await client.createSession({ id: "session_one", projectId: "project_one" });

    let reached = 0;
    const stop = daemon.store.watch(() => {
      reached += 1;
    });
    await client.submitTurn("session_one", { runId: "run_1", input: "one" });
    const whileWatching = reached;
    expect(whileWatching).toBeGreaterThan(0);

    // THE NEGATIVE, and the anti-vacuity half: after `stop()` the same write
    // must move nothing, or `watch` would be a subscription nobody can end.
    stop();
    await client.submitTurn("session_one", { runId: "run_2", input: "two" });
    expect(reached).toBe(whileWatching);
  } finally {
    await daemon.close();
    for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  }
});
