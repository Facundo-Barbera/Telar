/**
 * WHAT A DISMISS SURVIVES, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * Two claims, and they pull in opposite directions: a dismiss has to outlive a
 * reload (it used to outlive nothing), and it has to NOT outlive the compaction
 * that answered it. Both are about the same key, so they are tested against the
 * same fake store — a Map, the way composer-draft.test.ts does it, so nothing
 * here needs a browser.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  clearContextNoticeDismissed,
  contextNoticeDismissal,
  readContextNoticeDismissed,
  writeContextNoticeDismissed,
  type DismissalStorage,
} from "./context-notice-dismissal";

function storage(initial: Record<string, string> = {}) {
  const slots = new Map(Object.entries(initial));
  return {
    getItem: (name: string) => slots.get(name) ?? null,
    setItem: (name: string, value: string) => void slots.set(name, value),
    removeItem: (name: string) => void slots.delete(name),
    slots,
  } satisfies DismissalStorage & { slots: Map<string, string> };
}

const KEY = "telar:context-notice-dismissed:session_7";

describe("the key", () => {
  test("a dismiss writes one, keyed by session", () => {
    const store = storage();
    writeContextNoticeDismissed("session_7", store);
    expect([...store.slots.keys()]).toEqual([KEY]);
    expect(readContextNoticeDismissed("session_7", store)).toBe(true);
    // Another conversation is another decision.
    expect(readContextNoticeDismissed("session_8", store)).toBe(false);
  });

  test("clearing removes it rather than blanking it", () => {
    const store = storage({ [KEY]: "1" });
    clearContextNoticeDismissed("session_7", store);
    expect(store.slots.size).toBe(0);
  });

  test("a store that throws is answered, not propagated", () => {
    // A browser with storage disabled must not take the composer down with it.
    const hostile: DismissalStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(readContextNoticeDismissed("session_7", hostile)).toBe(false);
    expect(() => writeContextNoticeDismissed("session_7", hostile)).not.toThrow();
    expect(() => clearContextNoticeDismissed("session_7", hostile)).not.toThrow();
  });
});

describe("the whole rule, as the composer memoises it", () => {
  test("a fresh mount with the key already present shows no banner", () => {
    // The reload case — the one the old `useState` could not express at all.
    const store = storage({ [KEY]: "1" });
    expect(contextNoticeDismissal({ sessionId: "session_7", heavy: true }, store)).toBe(true);
  });

  test("dropping back under the threshold clears the key", () => {
    // Which is what compacting does. A dismiss is "not this one", not "never
    // for this session".
    const store = storage({ [KEY]: "1" });
    expect(contextNoticeDismissal({ sessionId: "session_7", heavy: false }, store)).toBe(false);
    expect(store.slots.size).toBe(0);
  });

  test("and the climb back up shows it once more", () => {
    const store = storage();
    writeContextNoticeDismissed("session_7", store);
    expect(contextNoticeDismissal({ sessionId: "session_7", heavy: true }, store)).toBe(true);
    contextNoticeDismissal({ sessionId: "session_7", heavy: false }, store);
    expect(contextNoticeDismissal({ sessionId: "session_7", heavy: true }, store)).toBe(false);
  });

  test("the click that storage has not been re-read for still hides it", () => {
    // `justDismissed` is what makes the banner leave on the same commit as the
    // press, before the memo has any reason to re-read the store.
    const store = storage();
    expect(contextNoticeDismissal({ sessionId: "session_7", heavy: true, justDismissed: "session_7" }, store)).toBe(true);
    // And it is not a blanket suppression: another session's press says nothing
    // about this one.
    expect(contextNoticeDismissal({ sessionId: "session_7", heavy: true, justDismissed: "session_8" }, store)).toBe(false);
  });

  test("a composer with no session has nothing to dismiss", () => {
    const store = storage();
    expect(contextNoticeDismissal({ sessionId: undefined, heavy: true }, store)).toBe(false);
  });
});
