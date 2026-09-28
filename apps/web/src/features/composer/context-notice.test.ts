import { describe, expect, test } from "bun:test";

import {
  CONTEXT_NOTICE_DEFAULT_PERCENT,
  contextNoticeDue,
  contextShareOf,
  normaliseContextNoticePercent,
} from "./context-notice";

const SMALL = 256_000;
const LARGE = 1_000_000;

describe("a 1M window fires at 70%, and not a token earlier", () => {
  test("700,000 is due; 699,999 is not", () => {
    expect(contextNoticeDue({ contextUsed: 700_000, contextMax: LARGE })).toBe(true);
    expect(contextNoticeDue({ contextUsed: 699_999, contextMax: LARGE })).toBe(false);
  });

  test("250,000 is ordinary use here, which is the whole complaint", () => {
    expect(contextNoticeDue({ contextUsed: 250_000, contextMax: LARGE })).toBe(false);
    expect(contextNoticeDue({ contextUsed: 12_000, contextMax: LARGE })).toBe(false);
  });
});

describe("a 256k window gets the same rule, not a different one", () => {
  test("70% of 256,000 is 179,200", () => {
    expect(contextNoticeDue({ contextUsed: 179_200, contextMax: SMALL })).toBe(true);
    expect(contextNoticeDue({ contextUsed: 179_199, contextMax: SMALL })).toBe(false);
  });

  test("250,000 is due here BECAUSE it is 97% of the window, not because it is 250,000", () => {
    expect(contextNoticeDue({ contextUsed: 250_000, contextMax: SMALL })).toBe(true);
    expect(contextShareOf({ contextUsed: 250_000, contextMax: SMALL })).toBeGreaterThan(0.9);
  });
});

describe("a login can move it", () => {
  test("50% on a 256k window is 128,000", () => {
    expect(contextNoticeDue({ contextUsed: 128_000, contextMax: SMALL }, 50)).toBe(true);
    expect(contextNoticeDue({ contextUsed: 127_999, contextMax: SMALL }, 50)).toBe(false);
    expect(contextNoticeDue({ contextUsed: 128_000, contextMax: SMALL })).toBe(false);
  });

  test("an omitted percentage is the default, spelled once", () => {
    expect(CONTEXT_NOTICE_DEFAULT_PERCENT).toBe(70);
    const at70 = { contextUsed: LARGE * 0.7, contextMax: LARGE };
    expect(contextNoticeDue(at70)).toBe(contextNoticeDue(at70, CONTEXT_NOTICE_DEFAULT_PERCENT));
  });
});

describe("an unknown reading is not a full one, and not an empty one", () => {
  test("no usage at all fires nothing", () => {
    expect(contextNoticeDue(undefined)).toBe(false);
    expect(contextNoticeDue({})).toBe(false);
    expect(contextNoticeDue({ contextUsed: null, contextMax: null })).toBe(false);
  });

  test("a used count with NO WINDOW cannot fire, at any percentage", () => {
    // A share needs a denominator; no window means unknown, not heavy.
    expect(contextShareOf({ contextUsed: 400_000 })).toBe(0);
    expect(contextNoticeDue({ contextUsed: 400_000 })).toBe(false);
    expect(contextNoticeDue({ contextUsed: 400_000 }, 1)).toBe(false);
  });

  test("a zero or negative window is not a division", () => {
    expect(contextShareOf({ contextUsed: 10, contextMax: 0 })).toBe(0);
    expect(contextShareOf({ contextUsed: 10, contextMax: -1 })).toBe(0);
    expect(Number.isFinite(contextShareOf({ contextUsed: 10, contextMax: 0 }))).toBe(true);
    expect(contextNoticeDue({ contextUsed: 10, contextMax: 0 })).toBe(false);
  });
});

describe("normalising what a login stored", () => {
  test("absent or unusable is the default", () => {
    for (const value of [undefined, null, "70", NaN, Infinity, {}]) {
      expect(normaliseContextNoticePercent(value)).toBe(CONTEXT_NOTICE_DEFAULT_PERCENT);
    }
  });

  test("out of range clamps rather than disabling the notice", () => {
    expect(normaliseContextNoticePercent(0)).toBe(1);
    expect(normaliseContextNoticePercent(-40)).toBe(1);
    expect(normaliseContextNoticePercent(101)).toBe(100);
    expect(normaliseContextNoticePercent(1_000)).toBe(100);
  });

  test("a whole percentage passes through, and a fraction rounds", () => {
    expect(normaliseContextNoticePercent(70)).toBe(70);
    expect(normaliseContextNoticePercent(1)).toBe(1);
    expect(normaliseContextNoticePercent(100)).toBe(100);
    // The engine refuses fractions on the way in; rounding keeps the notice reachable.
    expect(normaliseContextNoticePercent(70.5)).toBe(71);
  });
});
