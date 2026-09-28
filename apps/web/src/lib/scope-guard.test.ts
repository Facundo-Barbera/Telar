// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { makeScopeGuard } from "./scope-guard";

describe("makeScopeGuard", () => {
  test("a generation captured before a bump is stale; the current one is not", () => {
    const guard = makeScopeGuard();
    const first = guard.capture();
    expect(guard.isCurrent(first)).toBe(true);
    guard.bump();
    expect(guard.isCurrent(first)).toBe(false);
    const second = guard.capture();
    expect(guard.isCurrent(second)).toBe(true);
  });

  test("an old-session async result is DROPPED, the current one is APPLIED", async () => {
    const guard = makeScopeGuard();
    const applied: string[] = [];
    // Simulate two overlapping reads with the guard's exact usage. The old
    // one resolves AFTER the scope changed (a bump), so it must not apply.
    const read = async (label: string, delayMs: number) => {
      const gen = guard.capture();
      await new Promise((r) => setTimeout(r, delayMs));
      if (guard.isCurrent(gen)) applied.push(label);
    };
    const slowOld = read("old-session", 30); // started under scope A
    guard.bump(); // user navigates to scope B
    const fastNew = read("new-session", 5); // started under scope B
    await Promise.all([slowOld, fastNew]);
    // The slow old-session read resolved last but is discarded; only the
    // current scope's result was delivered.
    expect(applied).toEqual(["new-session"]);
  });

  test("a bind that resolves after a scope change signals stale (throw pattern)", async () => {
    const guard = makeScopeGuard();
    const bindNow = async (gen: number) => {
      await new Promise((r) => setTimeout(r, 10));
      if (!guard.isCurrent(gen)) throw new Error("stale");
      return "bound";
    };
    const gen = guard.capture();
    const pending = bindNow(gen);
    guard.bump(); // scope changed mid-bind
    await expect(pending).rejects.toThrow("stale");
    // A bind fully within one scope resolves normally.
    const gen2 = guard.capture();
    await expect(bindNow(gen2)).resolves.toBe("bound");
  });
});
