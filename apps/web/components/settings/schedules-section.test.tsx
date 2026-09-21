/**
 * WHAT A SCHEDULE ROW SAYS ABOUT ITSELF — issue #543.
 *
 * THE SKIPPED SENTENCE IS THE ONLY REASON THIS SURFACE EXISTS. A scheduled task
 * cannot fire while Telar is closed — the engine is an Electron child and the
 * app quits with its last window — and that boundary is invisible unless the
 * row says so. An invisible boundary is indistinguishable from a broken
 * scheduler, which is the way this feature ships wrong.
 *
 * THE ROW IS RENDERED STATICALLY AND THE PANE IS MOUNTED. `ScheduleRowView` is
 * two numbers in and markup out, so it needs no engine; the pane's one claim
 * that needs a DOM is that it reads ONCE, which is a count of requests rather
 * than a string on screen.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { Schedule } from "@telar/engine-client";
import { inZone, lastRunSentence, ruleLabel, ScheduleRowView, SchedulesSection } from "./schedules-section";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const row = (over: Partial<Schedule> = {}): Schedule => ({
  id: "sched_1",
  sessionId: "session_one",
  prompt: "daily digest",
  rule: { kind: "fixed", hour: 9, minute: 0, weekdays: [] },
  zone: "Europe/Madrid",
  enabled: true,
  createdAt: Date.UTC(2026, 4, 1, 0, 0, 0),
  nextRunAt: Date.UTC(2026, 5, 2, 7, 0, 0),
  ...over,
});

describe("the row's own zone (#543)", () => {
  test("an instant is rendered in the ROW's zone, not this machine's", () => {
    /**
     * A row made in Madrid keeps firing at 09:00 Madrid from anywhere, so
     * rendering it at the reader's local time would make a correct row look
     * wrong. Read under two `TZ` values; the assertion is that they AGREE —
     * which `toLocaleString()` with no zone could not satisfy.
     */
    const at = Date.UTC(2026, 5, 2, 7, 0, 0);
    const original = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      const fromLA = inZone(at, "Europe/Madrid");
      process.env.TZ = "Asia/Tokyo";
      const fromTokyo = inZone(at, "Europe/Madrid");
      expect(fromLA).toBe(fromTokyo);
      // 07:00 UTC is 09:00 in Madrid in June — the number a person would check.
      expect(fromLA).toContain("09:00");
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  test("a zone this machine does not know renders something rather than blanking", () => {
    // The engine made the same choice when it stored the row; a surface that
    // threw here would hide every schedule because one was odd.
    expect(() => inZone(Date.UTC(2026, 5, 2, 7, 0, 0), "Mars/Olympus")).not.toThrow();
    expect(inZone(Date.UTC(2026, 5, 2, 7, 0, 0), "Mars/Olympus").length).toBeGreaterThan(0);
  });

  test("THE IANA NAME IS ON THE ROW, beside the time", () => {
    // Without it "09:00" is the start of an argument about whose nine o'clock.
    expect(renderToStaticMarkup(<ScheduleRowView row={row()} />)).toContain("Europe/Madrid");
  });
});

describe("what the row says about its last run (#543)", () => {
  test("a SKIPPED run names the instant that was missed, and says why", () => {
    const sentence = lastRunSentence(row({ lastRunStatus: "skipped", lastSkippedAt: Date.UTC(2026, 5, 1, 7, 0, 0) }))!;
    expect(sentence).toContain("Skipped");
    // THE INSTANT, in the row's zone — what lets a reader recognise it as the
    // morning the laptop was shut rather than a bug.
    expect(sentence).toContain("09:00");
    expect(sentence).toContain("Telar was not running");
    // ...and that it was re-aimed rather than owed, so nobody waits for a late
    // run that is never coming.
    expect(sentence).toContain("re-aimed");
  });

  test("a row that has never run says NOTHING, so the warning means something", () => {
    // The anti-vacuity half: a sentence under every row is a sentence nobody
    // reads, and this one has to be noticed exactly once.
    expect(lastRunSentence(row())).toBeUndefined();
    expect(lastRunSentence(row({ lastRunStatus: "fired", lastRunAt: Date.UTC(2026, 5, 1, 7, 0, 0) }))).toContain("Last ran");
  });

  test("the skipped row is drawn as a warning and an ordinary one is not", () => {
    const skipped = renderToStaticMarkup(<ScheduleRowView row={row({ lastRunStatus: "skipped", lastSkippedAt: Date.UTC(2026, 5, 1, 7, 0, 0) })} />);
    expect(skipped).toContain("Telar was not running");
    expect(skipped).toContain("text-warning");

    const ordinary = renderToStaticMarkup(<ScheduleRowView row={row({ lastRunStatus: "fired", lastRunAt: Date.UTC(2026, 5, 1, 7, 0, 0) })} />);
    expect(ordinary).not.toContain("Telar was not running");
    expect(ordinary).not.toContain("text-warning");
  });

  test("a paused row says so instead of naming a next run it will not make", () => {
    const markup = renderToStaticMarkup(<ScheduleRowView row={row({ enabled: false })} />);
    expect(markup).toContain("paused");
    expect(markup).not.toContain("next ");
  });
});

describe("what the row fires on, in words (#543)", () => {
  test("an interval reads in the largest unit that divides it", () => {
    expect(ruleLabel({ kind: "interval", everyMs: 60_000 })).toBe("Every 1 minute");
    expect(ruleLabel({ kind: "interval", everyMs: 90 * 60_000 })).toBe("Every 90 minutes");
    expect(ruleLabel({ kind: "interval", everyMs: 3_600_000 })).toBe("Every 1 hour");
    expect(ruleLabel({ kind: "interval", everyMs: 86_400_000 })).toBe("Every 1 day");
  });

  test("an empty weekday set is EVERY DAY, and the five are 'every weekday'", () => {
    // Empty means every day — said by omission rather than by listing seven,
    // which is the engine's convention and has to read the same here.
    expect(ruleLabel({ kind: "fixed", hour: 9, minute: 0, weekdays: [] })).toBe("Every day at 09:00");
    expect(ruleLabel({ kind: "fixed", hour: 9, minute: 5, weekdays: [1, 2, 3, 4, 5] })).toBe("Every weekday at 09:05");
    expect(ruleLabel({ kind: "fixed", hour: 18, minute: 30, weekdays: [1, 4] })).toBe("Mon, Thu at 18:30");
  });
});

describe("the pane itself (#543)", () => {
  let calls: string[] = [];
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    calls = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      return Response.json({ schedules: [row({ lastRunStatus: "skipped", lastSkippedAt: Date.UTC(2026, 5, 1, 7, 0, 0) })] });
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

  test("IT READS ONCE AND NEVER ON A TIMER, and shows the skipped sentence", async () => {
    /**
     * The count is the claim — #629 is open because four timers in the rail
     * cost ~97,000 requests a day. Counting REQUESTS rather than grepping the
     * source for `setInterval` means what must not happen is a second request,
     * however it got made.
     */
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<SchedulesSection />);
      await settle();
    });
    // A SECOND `act`, because the first one's passive effects flush as it
    // exits — the read's own timer has had no wall clock until here.
    await act(async () => {
      await settle();
    });
    expect(calls).toHaveLength(1);
    expect(host.textContent).toContain("Telar was not running");

    // Far longer than any poll worth writing would wait: still one.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(calls).toHaveLength(1);

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});
