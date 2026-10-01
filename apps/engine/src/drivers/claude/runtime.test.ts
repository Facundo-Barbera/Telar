import { afterEach, expect, jest, test } from "bun:test";
import { ClaudeRuntimeStore, MessageFeed, type ClaudeSessionRuntime } from "./runtime";

afterEach(() => jest.useRealTimers());

const MINUTE = 60_000;

function runtime(sessionId: string, closed: string[], live = false): ClaudeSessionRuntime {
  const seeds = live ? [{ id: "task_one", providerTaskId: "sdk_one" }] : [];
  return {
    sessionId,
    fingerprint: "f",
    fingerprintDigests: {},
    feed: new MessageFeed(),
    query: { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }), stopTask: async () => {} },
    iterator: { next: async () => ({ done: true, value: undefined }) },
    bindings: { current: undefined },
    tasks: { bySdkId: new Map(), known: new Map(seeds.map((seed) => [seed.id, seed])), suppressed: new Set(), typesBySdkId: new Map(), lastWokenTaskId: undefined },
    pendingStep: undefined,
    parked: [],
    idlePump: undefined,
    streamEnded: false,
    destroy: () => closed.push(sessionId),
    model: undefined,
    costTotalUsd: undefined,
    echoesUserMessageUuid: false,
    reportsSessionState: false,
    busy: false,
    wakeActive: false,
    lastUsedAt: 0,
  };
}

function store() {
  jest.useFakeTimers();
  let now = 0;
  const runtimes = new ClaudeRuntimeStore({
    now: () => now,
    idleAfterMs: 30 * MINUTE,
    unattendedAfterMs: 60 * MINUTE,
    liveBackgroundWork: (seed) => seed.id === "task_one",
  });
  const advance = (ms: number) => {
    now += ms;
    jest.advanceTimersByTime(ms);
  };
  return { runtimes, advance };
}

test("an idle runtime is closed after 30 minutes unused, and not a moment before", () => {
  const closed: string[] = [];
  const { runtimes, advance } = store();
  runtimes.adopt(runtime("session_one", closed));
  runtimes.release("session_one");
  advance(30 * MINUTE - 1);
  expect(closed).toEqual([]);
  advance(1);
  expect(closed).toEqual(["session_one"]);
  expect(runtimes.size).toBe(0);
});

test("a runtime with a running turn is never closed, and its idle clock restarts on release", () => {
  const closed: string[] = [];
  const { runtimes, advance } = store();
  runtimes.adopt(runtime("session_one", closed));
  advance(2 * 60 * MINUTE);
  expect(closed).toEqual([]);
  runtimes.release("session_one");
  advance(29 * MINUTE);
  expect(runtimes.claim("session_one", "f")).toBeDefined();
  runtimes.release("session_one");
  advance(29 * MINUTE);
  expect(closed).toEqual([]);
  advance(MINUTE);
  expect(closed).toEqual(["session_one"]);
});

test("a runtime holding live background work keeps the longer unattended window", () => {
  const closed: string[] = [];
  const { runtimes, advance } = store();
  runtimes.adopt(runtime("session_one", closed, true));
  runtimes.release("session_one");
  advance(30 * MINUTE);
  expect(closed).toEqual([]);
  advance(30 * MINUTE);
  expect(closed).toEqual(["session_one"]);
});
