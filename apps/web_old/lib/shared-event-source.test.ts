// The shared-EventSource registry (issue #82): one socket per URL, refcounted,
// terminal "end" closed centrally. Tested against a stub — bun's test runtime
// has no EventSource, which is why the factory is injectable at all.
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { afterEach, describe, expect, test } from "bun:test";
import {
  _setEventSourceFactoryForTests,
  acquireSharedEventSource,
} from "./shared-event-source";

class StubSource {
  static created: StubSource[] = [];
  url: string;
  readyState = 1; // OPEN
  listeners = new Map<string, Set<(e: unknown) => void>>();
  constructor(url: string) {
    this.url = url;
    StubSource.created.push(this);
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(fn);
  }
  removeEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  close() {
    this.readyState = 2; // CLOSED
  }
  emit(type: string, e: unknown = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
}

const install = () => {
  StubSource.created = [];
  _setEventSourceFactoryForTests(((url: string) => new StubSource(url)) as never);
};

afterEach(() => _setEventSourceFactoryForTests(null));

describe("acquireSharedEventSource — one socket per URL", () => {
  test("two acquires of one URL share one socket; the duplicate the audit measured is gone", () => {
    install();
    const a = acquireSharedEventSource("/api/looms/l1/events");
    const b = acquireSharedEventSource("/api/looms/l1/events");
    expect(StubSource.created.length).toBe(1);
    expect(a.source).toBe(b.source);
  });

  test("the socket survives the first release and closes on the last", () => {
    install();
    const a = acquireSharedEventSource("/u");
    const b = acquireSharedEventSource("/u");
    const stub = StubSource.created[0]!;
    a.release();
    expect(stub.readyState).toBe(1); // b still holds it
    b.release();
    expect(stub.readyState).toBe(2);
    // A fresh acquire after full release gets a NEW socket, not the corpse.
    acquireSharedEventSource("/u");
    expect(StubSource.created.length).toBe(2);
  });

  test("release is idempotent — a strict-mode double cleanup cannot close a sibling's socket", () => {
    install();
    const a = acquireSharedEventSource("/u");
    const b = acquireSharedEventSource("/u");
    const stub = StubSource.created[0]!;
    a.release();
    a.release(); // double-invoked cleanup
    expect(stub.readyState).toBe(1); // b's hold survives
    b.release();
    expect(stub.readyState).toBe(2);
  });

  test("terminal `end` closes centrally and evicts — a later acquire starts fresh", () => {
    install();
    const a = acquireSharedEventSource("/u");
    const stub = StubSource.created[0]!;
    stub.emit("end");
    expect(stub.readyState).toBe(2); // the registry's own close — no reconnect churn
    const b = acquireSharedEventSource("/u");
    expect(StubSource.created.length).toBe(2); // fresh socket, correct for a new stream
    expect(b.source).not.toBe(a.source);
    a.release(); // stale release of the evicted entry must not touch b's socket
    expect((b.source as unknown as StubSource).readyState).toBe(1);
  });

  test("distinct URLs get distinct sockets", () => {
    install();
    acquireSharedEventSource("/a");
    acquireSharedEventSource("/b");
    expect(StubSource.created.length).toBe(2);
  });
});
