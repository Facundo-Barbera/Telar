// @ts-expect-error bun:test is provided by the test runtime; this workspace does not install @types/bun
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  enqueueSessionTurn,
  readSessionQueue,
} from "@telar/core";
import { endChatRun, registerChatRun } from "@/lib/chat-runs";
import {
  assertQueuedTurnSucceeded,
  kickSessionQueue,
  registerSessionTurnExecutor,
} from "./session-engine";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-session-engine-"));
const originalHome = process.env.TELAR_HOME;
process.env.TELAR_HOME = root;

beforeEach(() => {
  process.env.TELAR_HOME = root;
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.TELAR_HOME;
  else process.env.TELAR_HOME = originalHome;
  fs.rmSync(root, { recursive: true, force: true });
});

const session = (label: string) => `engine-${label}-${crypto.randomUUID()}`;

describe("server session queue dispatcher", () => {
  test("rejects an HTTP 200 stream whose terminal event says it was aborted", async () => {
    const body = [
      'event: done\ndata: {"subtype":"aborted"}\n\n',
      'event: closed\ndata: {}\n\n',
    ].join("");
    await expect(assertQueuedTurnSucceeded(new Response(body))).rejects.toThrow(
      "queued turn was aborted",
    );
  });

  test("accepts a successful terminal stream", async () => {
    const body = [
      'event: done\ndata: {"subtype":"success"}\n\n',
      'event: closed\ndata: {}\n\n',
    ].join("");
    await expect(assertQueuedTurnSucceeded(new Response(body))).resolves.toBeUndefined();
  });

  test("runs accepted turns FIFO without a renderer and commits each item", async () => {
    const id = session("fifo");
    const seen: string[] = [];
    registerSessionTurnExecutor(async (payload) => {
      seen.push((payload as { message: string }).message);
    });
    enqueueSessionTurn(id, { idempotencyKey: "one", payload: { message: "one" } });
    enqueueSessionTurn(id, { idempotencyKey: "two", payload: { message: "two" } });

    await kickSessionQueue(id);

    expect(seen).toEqual(["one", "two"]);
    expect(readSessionQueue(id).items.map((item) => item.state)).toEqual([
      "committed",
      "committed",
    ]);
  });

  test("waits behind an already-active direct turn", async () => {
    const id = session("active");
    const runId = `run-${crypto.randomUUID()}`;
    const seen: string[] = [];
    registerSessionTurnExecutor(async (payload) => {
      seen.push((payload as { message: string }).message);
    });
    enqueueSessionTurn(id, { idempotencyKey: "later", payload: { message: "later" } });
    expect(registerChatRun(runId, new AbortController(), id)).toBe(true);

    await kickSessionQueue(id);
    expect(seen).toEqual([]);
    expect(readSessionQueue(id).items[0]?.state).toBe("queued");

    endChatRun(runId);
    await kickSessionQueue(id);
    expect(seen).toEqual(["later"]);
  });

  test("records a failed item and pauses later work", async () => {
    const id = session("failure");
    registerSessionTurnExecutor(async () => {
      throw new Error("profile rejected");
    });
    enqueueSessionTurn(id, { idempotencyKey: "bad", payload: { message: "bad" } });
    enqueueSessionTurn(id, { idempotencyKey: "held", payload: { message: "held" } });

    await kickSessionQueue(id);

    const queue = readSessionQueue(id);
    expect(queue.paused).toBe(true);
    expect(queue.items[0]?.state).toBe("failed");
    expect(queue.items[0]?.error).toBe("profile rejected");
    expect(queue.items[1]?.state).toBe("queued");
  });
});
