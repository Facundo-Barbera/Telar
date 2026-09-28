import { afterEach, expect, jest, test } from "bun:test";
import { startSweepers } from "./sweepers";

afterEach(() => jest.useRealTimers());

test("intervals repeat, a once runs once, null is skipped, and stop() clears every one", () => {
  jest.useFakeTimers();
  const seen: string[] = [];
  const sweepers = startSweepers([
    { every: 100, run: () => seen.push("every") },
    { once: 150, run: () => seen.push("once") },
    { once: null, run: () => seen.push("never") },
  ]);
  jest.advanceTimersByTime(250);
  expect(seen).toEqual(["every", "once", "every"]);
  sweepers.stop();
  jest.advanceTimersByTime(1_000);
  expect(seen).toEqual(["every", "once", "every"]);
});

test("a throwing or rejecting sweep does not stop the next tick", async () => {
  jest.useFakeTimers();
  let calls = 0;
  const sweepers = startSweepers([
    {
      every: 10,
      run: () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return Promise.reject(new Error("later"));
      },
    },
  ]);
  jest.advanceTimersByTime(30);
  await Promise.resolve();
  expect(calls).toBe(3);
  sweepers.stop();
});
