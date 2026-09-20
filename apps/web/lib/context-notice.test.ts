/**
 * BOTH WINDOWS, BOTH DIRECTIONS — issue #587, step 1.
 *
 * The bug this fixes is invisible to a test that only checks one window: the
 * old `contextShare >= 0.75` was right on 200k and silently wrong on 1M, and
 * the line never changed. So every assertion here names the window it is about,
 * and the 200k cases exist to prove the fix changed NOTHING there — a notice
 * that started nagging short conversations would be a worse bug than the one
 * being fixed.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";

import {
  CONTEXT_NOTICE_SHARE,
  CONTEXT_NOTICE_TOKENS,
  contextNoticeDue,
  contextNoticeReason,
  contextShareOf,
} from "./context-notice";

const SMALL = 200_000;
const LARGE = 1_000_000;

describe("a 200k window is untouched", () => {
  test("75% still fires, and it fires before the band could", () => {
    // 150,000 — below the 250k band, so the proportion is the only arm that
    // can fire here. This is the case that must not regress.
    expect(contextNoticeDue({ contextUsed: SMALL * CONTEXT_NOTICE_SHARE, contextMax: SMALL })).toBe(true);
    expect(contextNoticeReason({ contextUsed: SMALL * CONTEXT_NOTICE_SHARE, contextMax: SMALL })).toBe("share");
    expect(SMALL * CONTEXT_NOTICE_SHARE).toBeLessThan(CONTEXT_NOTICE_TOKENS);
  });

  test("under 75% stays quiet", () => {
    expect(contextNoticeDue({ contextUsed: 149_000, contextMax: SMALL })).toBe(false);
    expect(contextNoticeDue({ contextUsed: 100_000, contextMax: SMALL })).toBe(false);
  });

  test("the band can never fire first on a small window", () => {
    /**
     * 250,000 is above the whole window, so on a 200k session the band is
     * unreachable and the behaviour is exactly what it was. An account with no
     * 1M entitlement compacts near 167k on its own, well before either arm.
     */
    expect(CONTEXT_NOTICE_TOKENS).toBeGreaterThan(SMALL);
  });
});

describe("a 1M window is the case this exists for", () => {
  test("the band fires at 250k, where the proportion would have waited for 750k", () => {
    const at250k = { contextUsed: CONTEXT_NOTICE_TOKENS, contextMax: LARGE };
    expect(contextNoticeDue(at250k)).toBe(true);
    expect(contextNoticeReason(at250k)).toBe("band");
    // The old rule, stated as an assertion rather than as a comment: at 250k of
    // a million, the share arm alone says nothing.
    expect(contextShareOf(at250k)).toBeLessThan(CONTEXT_NOTICE_SHARE);
  });

  test("#587's measured sawtooth peak would have fired under the old rule — barely", () => {
    /**
     * 700–740k is where the issue's sessions actually peaked, and the old
     * notice sat at 750,000. That is the whole finding: the only compaction
     * pressure in the product was just above the band the problem lived in.
     */
    for (const peak of [700_000, 740_000]) {
      expect(peak / LARGE).toBeLessThan(CONTEXT_NOTICE_SHARE);
      // Silent before; told now, half a million tokens earlier.
      expect(contextNoticeDue({ contextUsed: peak, contextMax: LARGE })).toBe(true);
      expect(contextNoticeReason({ contextUsed: peak, contextMax: LARGE })).toBe("band");
    }
  });

  test("a short conversation on a big window is still left alone", () => {
    expect(contextNoticeDue({ contextUsed: 12_000, contextMax: LARGE })).toBe(false);
    expect(contextNoticeDue({ contextUsed: 249_999, contextMax: LARGE })).toBe(false);
  });

  test("past 75% the share is the reason named, because running out is the worse fact", () => {
    const at800k = { contextUsed: 800_000, contextMax: LARGE };
    expect(contextNoticeDue(at800k)).toBe(true);
    expect(contextNoticeReason(at800k)).toBe("share");
  });
});

describe("an unknown reading is not a full one, and not an empty one", () => {
  test("no usage at all fires nothing", () => {
    expect(contextNoticeDue(undefined)).toBe(false);
    expect(contextNoticeDue({})).toBe(false);
    expect(contextNoticeReason({})).toBeUndefined();
  });

  test("a used count with no window still reaches the band", () => {
    /**
     * THE ARM THAT SURVIVES A MISSING `contextMax`, and the reason the band is
     * worth having beyond the 1M case: a session whose Mac reports usage but no
     * window used to fire NOTHING, because the only rule was a fraction and the
     * denominator was absent. An absolute count needs no denominator.
     */
    expect(contextShareOf({ contextUsed: 400_000 })).toBe(0);
    expect(contextNoticeDue({ contextUsed: 400_000 })).toBe(true);
    expect(contextNoticeReason({ contextUsed: 400_000 })).toBe("band");
  });

  test("a zero or negative window is not a division", () => {
    expect(contextShareOf({ contextUsed: 10, contextMax: 0 })).toBe(0);
    expect(contextShareOf({ contextUsed: 10, contextMax: -1 })).toBe(0);
    expect(Number.isFinite(contextShareOf({ contextUsed: 10, contextMax: 0 }))).toBe(true);
    expect(contextNoticeDue({ contextUsed: 10, contextMax: 0 })).toBe(false);
  });

  test("null readings behave as absent rather than as zero", () => {
    expect(contextNoticeDue({ contextUsed: null, contextMax: null })).toBe(false);
    expect(contextNoticeDue({ contextUsed: 0, contextMax: LARGE })).toBe(false);
  });
});

test("the band is where the file says it is", () => {
  // Pinned so that moving it is a deliberate edit with a red test in between,
  // not a number somebody tunes. #587's argument for 250k is in the header.
  expect(CONTEXT_NOTICE_TOKENS).toBe(250_000);
  expect(CONTEXT_NOTICE_SHARE).toBe(0.75);
});
