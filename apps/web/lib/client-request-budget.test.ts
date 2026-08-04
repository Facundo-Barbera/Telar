// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { IdleRequestCoordinator } from "./client-request-budget";

function harness(maxPerWindow = 2, windowMs = 100) {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const coordinator = new IdleRequestCoordinator({
    now: () => now,
    setTimer: (callback, delayMs) => {
      const id = ++nextId;
      timers.set(id, { at: now + delayMs, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => timers.delete(timer as unknown as number),
  }, maxPerWindow, windowMs);
  const advance = async (ms = 0) => {
    now += ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      due[1].callback();
      await Promise.resolve();
      await Promise.resolve();
    }
  };
  return { coordinator, advance };
}

describe("idle request coordinator", () => {
  test("caps recovery requests globally and drains deferred work fairly", async () => {
    const { coordinator, advance } = harness();
    const ran: string[] = [];
    coordinator.enqueue("a", () => { ran.push("a"); });
    coordinator.enqueue("b", () => { ran.push("b"); });
    coordinator.enqueue("c", () => { ran.push("c"); });

    await advance();
    expect(ran).toEqual(["a", "b"]);
    expect(coordinator.snapshot().queued).toBe(1);

    await advance(100);
    expect(ran).toEqual(["a", "b", "c"]);
    expect(coordinator.snapshot().queued).toBe(0);
  });

  test("coalesces one observer key and supports cleanup before execution", async () => {
    const { coordinator, advance } = harness(1);
    const ran: string[] = [];
    coordinator.enqueue("blocker", () => { ran.push("blocker"); });
    await advance();

    coordinator.enqueue("session", () => { ran.push("stale"); });
    const cancel = coordinator.enqueue("session", () => { ran.push("latest"); });
    cancel();
    await advance(100);

    expect(ran).toEqual(["blocker"]);
    expect(coordinator.snapshot().queued).toBe(0);
  });

  test("never overlaps the same key", async () => {
    const { coordinator, advance } = harness(4);
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const ran: string[] = [];
    coordinator.enqueue("session", async () => {
      ran.push("first");
      await first;
    });
    await advance();
    coordinator.enqueue("session", () => { ran.push("second"); });
    await advance();
    expect(ran).toEqual(["first"]);
    release();
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    await advance();
    expect(ran).toEqual(["first", "second"]);
  });
});
