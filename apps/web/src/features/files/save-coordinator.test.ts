/**
 * The autosave timing rules.
 *
 * Every test here is a bug the first version of this class has. The timer is
 * injected so none of them wait in real time, and each one is stated as the
 * failure it prevents rather than as the mechanism it exercises.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { SaveCoordinator, type SaveOutcome } from "./save-coordinator";

/** A hand-cranked clock. `run()` fires whatever the coordinator scheduled, so a
 *  test says exactly when the debounce elapses. */
function clock() {
  let next = 1;
  const timers = new Map<number, () => void>();
  return {
    setTimer: (run: () => void) => {
      const handle = next++;
      timers.set(handle, run);
      return handle;
    },
    clearTimer: (handle: number) => void timers.delete(handle),
    /** Fire every pending timer, in the order they were set. */
    run() {
      const pending = [...timers.entries()];
      timers.clear();
      for (const [, run] of pending) run();
    },
    get scheduled() {
      return timers.size;
    },
  };
}

type Harness = {
  saver: SaveCoordinator;
  writes: string[];
  pending: boolean[];
  saved: string[];
  problems: string[];
  clock: ReturnType<typeof clock>;
};

function harness(persist: (text: string) => Promise<SaveOutcome> = async () => ({ status: "saved" })): Harness {
  const timers = clock();
  const writes: string[] = [];
  const pending: boolean[] = [];
  const saved: string[] = [];
  const problems: string[] = [];
  const saver = new SaveCoordinator({
    debounceMs: 500,
    persist: (text) => {
      writes.push(text);
      return persist(text);
    },
    onPending: (value) => pending.push(value),
    onSaved: (text) => saved.push(text),
    onProblem: (outcome) => problems.push(`${outcome.status}:${outcome.reason}`),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { saver, writes, pending, saved, problems, clock: timers };
}

describe("debouncing", () => {
  test("a burst of keystrokes is ONE write, of the last text", async () => {
    // Forty writes for forty characters is what the debounce exists to prevent.
    const h = harness();
    h.saver.change("a");
    h.saver.change("ab");
    h.saver.change("abc");
    expect(h.writes).toEqual([]);
    h.clock.run();
    await Promise.resolve();
    expect(h.writes).toEqual(["abc"]);
  });

  test("pending goes up on the first keystroke and down when the write lands", async () => {
    const h = harness();
    h.saver.change("a");
    expect(h.pending).toEqual([true]);
    h.clock.run();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.pending).toEqual([true, false]);
    expect(h.saved).toEqual(["a"]);
  });
});

describe("coalescing while a write is open", () => {
  test("text typed mid-write is not lost, and does not start a second write", async () => {
    // The bug this prevents: the write finishes, reports clean, and the three
    // characters typed while it was in flight never reach disk.
    let release: (() => void) | undefined;
    const h = harness(
      () =>
        new Promise<SaveOutcome>((resolve) => {
          release = () => resolve({ status: "saved" });
        }),
    );
    h.saver.change("one");
    h.clock.run();
    await Promise.resolve();
    expect(h.writes).toEqual(["one"]);

    // Mid-flight typing.
    h.saver.change("one two");
    expect(h.writes).toEqual(["one"]);

    release!();
    await Promise.resolve();
    await Promise.resolve();
    // Still dirty — and a follow-up write was scheduled rather than fired inside
    // the first one.
    expect(h.pending.at(-1)).toBe(true);
    h.clock.run();
    await Promise.resolve();
    expect(h.writes).toEqual(["one", "one two"]);
  });
});

describe("dispose", () => {
  test("FLUSHES the pending write rather than cancelling it", async () => {
    // Closing the tab 200ms after typing must not throw the edit away. This is
    // the one people notice, and always too late.
    const h = harness();
    h.saver.change("nearly lost");
    expect(h.writes).toEqual([]);
    h.saver.dispose();
    await Promise.resolve();
    expect(h.writes).toEqual(["nearly lost"]);
  });

  test("nothing unsaved means nothing written", async () => {
    const h = harness();
    h.saver.dispose();
    await Promise.resolve();
    expect(h.writes).toEqual([]);
  });

  test("a disposed coordinator ignores later keystrokes", () => {
    const h = harness();
    h.saver.dispose();
    h.saver.change("too late");
    expect(h.clock.scheduled).toBe(0);
  });
});

describe("flush", () => {
  test("saves now, without waiting out the debounce", async () => {
    const h = harness();
    h.saver.change("typed");
    await h.saver.flush();
    expect(h.writes).toEqual(["typed"]);
    // And the timer it cancelled cannot fire a second write.
    h.clock.run();
    await Promise.resolve();
    expect(h.writes).toEqual(["typed"]);
  });

  test("flushing a clean file writes nothing", async () => {
    const h = harness();
    await h.saver.flush();
    expect(h.writes).toEqual([]);
  });
});

describe("refusal", () => {
  test("STOPS — a conflict is never retried on a timer", async () => {
    // Retrying a conflict either spins forever or eventually wins, and winning
    // means overwriting whatever changed the file. Neither is acceptable next to
    // a running agent.
    const h = harness(async () => ({ status: "refused", reason: "conflict" }));
    h.saver.change("mine");
    h.clock.run();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.problems).toEqual(["refused:conflict"]);

    h.saver.change("mine again");
    h.clock.run();
    await Promise.resolve();
    expect(h.writes).toEqual(["mine"]);
  });

  test("resume takes a fresh baseline and starts saving again", async () => {
    const h = harness(async () => ({ status: "saved" }));
    h.saver.change("a");
    h.clock.run();
    await Promise.resolve();
    h.saver.resume("theirs");
    h.saver.change("theirs plus mine");
    h.clock.run();
    await Promise.resolve();
    expect(h.writes.at(-1)).toBe("theirs plus mine");
  });

  test("a transport failure leaves the text pending so the next keystroke retries", async () => {
    // Unlike a refusal: nothing about the file changed, the request simply did
    // not arrive.
    let attempts = 0;
    const h = harness(async () => {
      attempts += 1;
      return attempts === 1 ? { status: "failed", reason: "offline" } : { status: "saved" };
    });
    h.saver.change("draft");
    h.clock.run();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.problems).toEqual(["failed:offline"]);

    h.saver.change("draft more");
    h.clock.run();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.writes).toEqual(["draft", "draft more"]);
    expect(h.saved).toEqual(["draft more"]);
  });

  test("a persist that throws is a failure, not an unhandled rejection", async () => {
    const h = harness(async () => {
      throw new Error("boom");
    });
    h.saver.change("x");
    h.clock.run();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.problems).toEqual(["failed:boom"]);
  });
});
