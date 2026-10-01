import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type http from "node:http";
import { useTempStores } from "../../../test/temp-store";
import { holdEventStream, type OpenStream } from "./stream";

const { readyStore } = useTempStores();

test("the event cursor is the last journal id", () => {
  const { store } = readyStore();
  expect(store.queries.eventCursor("session_one")).toBe(1); // session.created
  store.intake.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  store.turnLifecycle.stopTurn("session_one", "run_one");
  expect(store.queries.eventCursor("session_one")).toBe(store.queries.readEvents("session_one").at(-1)!.id);
});

function stalledClient() {
  const response = Object.assign(new EventEmitter(), {
    writableLength: 0,
    ended: false,
    writes: 0,
    writeHead() {},
    write(chunk: string) {
      this.writes += 1;
      this.writableLength += chunk.length;
      return false;
    },
    end() {
      this.ended = true;
    },
  });
  return { request: new EventEmitter() as http.IncomingMessage, response };
}

test("a client that stops reading is cut off once 1 MB is buffered, and unsubscribed", () => {
  const { request, response } = stalledClient();
  const openStreams = new Set<OpenStream>();
  let send: (data: unknown) => void = () => {};
  let unsubscribed = false;
  holdEventStream(request, response as unknown as http.ServerResponse, openStreams, (next) => {
    send = next;
    return () => {
      unsubscribed = true;
    };
  });
  const frame = { text: "x".repeat(10_000) };
  for (let n = 0; n < 99; n += 1) send(frame);
  expect(response.ended).toBe(false);
  expect(openStreams.size).toBe(1);

  for (let n = 0; n < 10; n += 1) send(frame);
  expect(response.ended).toBe(true);
  expect(unsubscribed).toBe(true);
  expect(openStreams.size).toBe(0);
  const writes = response.writes;
  send(frame);
  expect(response.writes).toBe(writes);
});
