// The proof for Codex's rate-limit classification, and for the plan-window
// helpers the meters render through.
//
// THIS FILE EXISTS BECAUSE OF A LIVE BUG. `codex-usage.ts` used to map Codex's
// `primary` slot to the 5-hour window and `secondary` to the weekly one, by
// POSITION. Codex removed its 5-hour limit in July 2026 and moved the weekly
// window into `primary`, leaving `secondary` null — so the app rendered a
// weekly figure under a 5-hour label. Not a missing meter, a wrong one. The
// payloads below are transcribed from real rollouts in ~/.codex on the machine
// this was written on, both regimes, so the classifier is asserted against what
// Codex actually emitted rather than what its field names suggest.
//
// NO DOM, NO DISK, NO NETWORK — the classifier and the label/ring helpers are
// pure, which is why they were factored out of the fs walk and the SVG.

// bun provides "bun:test" at runtime; @types/bun isn't a dependency of this Next
// app, so the web tsconfig can't resolve it — suppress just the import, exactly
// as `spend-readout.test.ts` and `ultra-wake.test.ts` do.
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { classifyCodexWindows } from "@/lib/codex-usage";
import { formatResetIn, planRings, RING_RADII, usedWindows, windowLabel, windowLabelShort } from "@/lib/plan-window";

// Real payload, 2026-04-18 and 2026-07-08: both windows present, 5h in primary.
const BOTH_WINDOWS = {
  primary: { used_percent: 27, window_minutes: 300, resets_at: 1_776_000_000 },
  secondary: { used_percent: 4, window_minutes: 10_080, resets_at: 1_776_500_000 },
  plan_type: "plus",
};

// Real payload, 2026-07-20 onward: the 5-hour window is GONE and the weekly one
// has moved into the primary slot.
const WEEKLY_ONLY = {
  primary: { used_percent: 47, window_minutes: 10_080, resets_at: 1_785_903_935 },
  secondary: null,
  plan_type: "prolite",
};

describe("classifyCodexWindows", () => {
  test("places both windows by duration when both are reported", () => {
    const { fiveHour, sevenDay } = classifyCodexWindows(BOTH_WINDOWS);
    expect(fiveHour?.utilization).toBe(27);
    expect(fiveHour?.windowMinutes).toBe(300);
    expect(sevenDay?.utilization).toBe(4);
    expect(sevenDay?.windowMinutes).toBe(10_080);
  });

  test("a weekly window in the PRIMARY slot lands in sevenDay, not fiveHour", () => {
    // The regression this whole module was rewritten for.
    const { fiveHour, sevenDay } = classifyCodexWindows(WEEKLY_ONLY);
    expect(fiveHour).toBeNull();
    expect(sevenDay?.utilization).toBe(47);
    expect(sevenDay?.windowMinutes).toBe(10_080);
  });

  test("a restored 5-hour limit needs no code change to reappear", () => {
    // Whatever order the provider sends them in, duration decides the slot.
    const swapped = classifyCodexWindows({
      primary: { used_percent: 9, window_minutes: 10_080 },
      secondary: { used_percent: 61, window_minutes: 300 },
    });
    expect(swapped.fiveHour?.utilization).toBe(61);
    expect(swapped.sevenDay?.utilization).toBe(9);
  });

  test("windows with no declared duration fall back to their historical slots", () => {
    const legacy = classifyCodexWindows({
      primary: { used_percent: 12 },
      secondary: { used_percent: 34 },
    });
    expect(legacy.fiveHour?.utilization).toBe(12);
    expect(legacy.sevenDay?.utilization).toBe(34);
  });

  test("a window with no percentage is absent, not zero", () => {
    const { fiveHour, sevenDay } = classifyCodexWindows({ primary: {}, secondary: null });
    expect(fiveHour).toBeNull();
    expect(sevenDay).toBeNull();
  });

  test("resets_at converts from epoch seconds to ISO", () => {
    const { sevenDay } = classifyCodexWindows(WEEKLY_ONLY);
    expect(sevenDay?.resets_at).toBe(new Date(1_785_903_935 * 1000).toISOString());
  });
});

describe("windowLabel", () => {
  test("names a window after its real duration", () => {
    expect(windowLabel(300, "fallback")).toBe("5h");
    expect(windowLabel(10_080, "fallback")).toBe("Weekly");
    expect(windowLabel(1_440, "fallback")).toBe("1d");
    expect(windowLabel(45, "fallback")).toBe("45m");
  });

  test("falls back when the provider reports no duration (Claude's windows)", () => {
    expect(windowLabel(null, "5-hour")).toBe("5-hour");
    expect(windowLabel(undefined, "Weekly")).toBe("Weekly");
    expect(windowLabel(0, "Weekly")).toBe("Weekly");
  });

  test("the short form compacts only the weekly label", () => {
    expect(windowLabelShort(10_080, "wk")).toBe("wk");
    expect(windowLabelShort(300, "5h")).toBe("5h");
  });
});

describe("usedWindows", () => {
  test("lists only windows carrying a utilization", () => {
    const rows = usedWindows({
      fiveHour: { utilization: 27, resets_at: null, windowMinutes: 300 },
      sevenDay: { utilization: null, resets_at: null },
    });
    expect(rows.map((r) => r.key)).toEqual(["fiveHour"]);
    expect(rows[0].label).toBe("5h");
  });

  test("a weekly-only Codex snapshot yields exactly one row, named Weekly", () => {
    const { fiveHour, sevenDay } = classifyCodexWindows(WEEKLY_ONLY);
    const rows = usedWindows({ fiveHour, sevenDay });
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("Weekly");
    expect(rows[0].short).toBe("wk");
  });

  test("model-scoped weekly windows keep their suffix", () => {
    const rows = usedWindows({
      sevenDayOpus: { utilization: 10, resets_at: null },
      sevenDaySonnet: { utilization: 20, resets_at: null },
    });
    expect(rows.map((r) => r.label)).toEqual(["Weekly · Opus", "Weekly · Sonnet"]);
  });

  test("an absent snapshot is no rows, not a row of nulls", () => {
    expect(usedWindows(null)).toEqual([]);
    expect(usedWindows(undefined)).toEqual([]);
  });
});

describe("planRings", () => {
  test("two windows keep the original anatomy: session outside, weekly inside", () => {
    const rings = planRings(30, 60);
    expect(rings.map((r) => r.key)).toEqual(["fiveHour", "sevenDay"]);
    expect(rings.map((r) => r.radius)).toEqual([RING_RADII[0], RING_RADII[1]]);
  });

  test("ONE window draws on the OUTER circle — no inner ring at all", () => {
    // The weekly-only case. Drawing it inside would leave an empty outer circle
    // that reads as a second window sitting at 0%.
    const rings = planRings(null, 47);
    expect(rings).toHaveLength(1);
    expect(rings[0].key).toBe("sevenDay");
    expect(rings[0].radius).toBe(RING_RADII[0]);
  });

  test("a lone 5-hour window also takes the outer circle", () => {
    const rings = planRings(12, null);
    expect(rings).toHaveLength(1);
    expect(rings[0].radius).toBe(RING_RADII[0]);
  });

  test("no windows means no rings — the caller draws the bare track", () => {
    expect(planRings(null, null)).toEqual([]);
  });
});

describe("formatResetIn", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + h * 3_600_000).toISOString();
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);

  test("rolls past 24h into days — the reason this exists", () => {
    // "96h 57m" and "66h 31m" were the real renderings; neither reads as
    // "four days" or "under three days" without doing arithmetic.
    expect(formatResetIn(at(96.95), now)).toBe("4d"); // was "96h 57m"
    expect(formatResetIn(at(66.5), now)).toBe("2d 18h"); // was "66h 31m"
  });

  test("drops the trailing unit once it stops mattering", () => {
    expect(formatResetIn(at(96), now)).toBe("4d");
    expect(formatResetIn(at(2), now)).toBe("2h");
  });

  test("under a day stays in hours and minutes", () => {
    expect(formatResetIn(at(13.5), now)).toBe("13h 30m");
    expect(formatResetIn(at(0.75), now)).toBe("45m");
  });

  test("a past or absent instant is stated, not negative", () => {
    expect(formatResetIn(at(-5), now)).toBe("now");
    expect(formatResetIn(null, now)).toBe("—");
    expect(formatResetIn("not-a-date", now)).toBe("—");
  });
});
