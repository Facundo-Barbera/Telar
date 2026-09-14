// @ts-expect-error Bun test types are provided by the test runner.
import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { installNavigationMarks, isMeasuredHref, markNavigation, navigationTimings, startNavigation } from "./perf-marks";

/**
 * The ring keeps module-level state on purpose — one clock per tab — so these
 * tests read the tail of it rather than expecting an empty one, and use their
 * own addresses so they cannot collide.
 */
function latest(href: string) {
  return navigationTimings().filter((timing) => timing.href === href).at(-1);
}

test("the two openings anybody has complained about are the two that are measured", () => {
  // Conversations and canvases, with and without a host prefix (#407).
  expect(isMeasuredHref("/projects/p1/sessions/s1")).toBe(true);
  expect(isMeasuredHref("/projects/p1/sessions/new")).toBe(true);
  expect(isMeasuredHref("/hosts/mac2/projects/p1/sessions/s1")).toBe(true);
  // Settings, cockpit-wide and per-project (#492) — the screen whose whole cost
  // is arriving, and which had no number on it until this.
  expect(isMeasuredHref("/settings")).toBe(true);
  expect(isMeasuredHref("/projects/p1/settings")).toBe(true);
  // ...and nothing else. A measurement of every route is a measurement of none.
  expect(isMeasuredHref("/")).toBe(false);
  expect(isMeasuredHref("/spool")).toBe(false);
  expect(isMeasuredHref("/projects")).toBe(false);
  expect(isMeasuredHref("/looms/l1")).toBe(false);
});

test("a settings opening records commit and idle, and no transcript", () => {
  const href = "/settings";
  startNavigation(href, "route");
  markNavigation("commit", href);
  markNavigation("idle", href);
  const timing = latest(href);
  expect(timing?.from).toBe("route");
  expect(typeof timing?.commit).toBe("number");
  expect(typeof timing?.idle).toBe("number");
  // There are no conversation rows on this screen, so the phase that means
  // "they landed" stays absent rather than being given a second meaning.
  expect(timing?.transcript).toBeUndefined();
});

test("a press that already started the clock keeps its own start stamp", () => {
  // The app shell starts a navigation for its own first pathname so that a cold
  // load is measured too — and that call must not restart a clock a click began,
  // or every measured opening would lose the part before the route committed.
  const href = "/projects/p-latch/sessions/s-latch";
  startNavigation(href, "click");
  startNavigation(href, "route");
  expect(latest(href)?.from).toBe("click");
  markNavigation("idle", href);
});

test("a phase nothing navigated to is not invented", () => {
  // A cockpit re-rendering for its own reasons must not create an opening —
  // the numbers would stop being about switching at all.
  const before = navigationTimings().length;
  markNavigation("commit", "/settings/never-navigated-to");
  expect(navigationTimings()).toHaveLength(before);
});

test("the reader is fitted for a packaged build, not just a development one", async () => {
  /**
   * THE WHOLE POINT OF #492's MEASUREMENT CLAUSE. The console line is stripped
   * in production on purpose, so `window.telarNavTimings()` is the only way a
   * packaged build can be read — if that is missing, a release can be measured
   * by opinion and nothing else.
   *
   * ITS OWN DOM, handed straight back: this workspace deliberately runs without
   * one (scripts/test-dom.mjs), and 109 tests depend on that.
   */
  await GlobalRegistrator.register({ url: "http://localhost/settings" });
  try {
    installNavigationMarks();
    const reader = (globalThis as { telarNavTimings?: () => unknown[] }).telarNavTimings;
    expect(typeof reader).toBe("function");
    expect(Array.isArray(reader!())).toBe(true);
  } finally {
    await GlobalRegistrator.unregister();
  }
});

test("the ring hands out copies, so a console cannot corrupt it", () => {
  const href = "/projects/p-copy/sessions/s-copy";
  startNavigation(href, "route");
  markNavigation("commit", href);
  const taken = latest(href)!;
  taken.commit = -1;
  expect(latest(href)?.commit).not.toBe(-1);
  markNavigation("idle", href);
});
