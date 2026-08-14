// The window chrome: which platforms hand their titlebar to the app, and where
// the traffic lights land when they do.
//
// WHAT THIS IS ACTUALLY GUARDING is the platform rule. `hiddenInset` is treated
// as `hidden` off macOS — minimise, maximise and close disappear and the app is
// expected to draw its own, which this cockpit does not. Shipping that would be
// a window you cannot close, from a one-word change nobody would think to
// re-test on a platform they were not running.

const { describe, expect, test } = require("bun:test");
const {
  APP_HEADER_HEIGHT,
  TRAFFIC_LIGHT_DIAMETER,
  TRAFFIC_LIGHT_POSITION,
  macWindowChrome,
} = require("./window-chrome.js");

describe("macWindowChrome", () => {
  test("hands the titlebar to the app on macOS", () => {
    expect(macWindowChrome("darwin")).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: TRAFFIC_LIGHT_POSITION,
    });
  });

  test("leaves every other platform its system titlebar", () => {
    // An app whose close button vanished is a worse outcome than a grey strip.
    for (const platform of ["win32", "linux", "freebsd"]) expect(macWindowChrome(platform)).toEqual({});
  });

  test("hands back a COPY, so a caller cannot mutate the shared position", () => {
    const first = macWindowChrome("darwin");
    first.trafficLightPosition.x = 999;
    expect(macWindowChrome("darwin").trafficLightPosition.x).toBe(TRAFFIC_LIGHT_POSITION.x);
  });
});

describe("the lights sit on the app header's centreline", () => {
  test("y centres the group in the renderer's own header, rather than topping the window", () => {
    // The whole point of `hiddenInset` here: the app's header BECOMES the
    // titlebar. Lights parked at the top of the window instead would just give
    // the app a shorter grey bar with a wordmark below it.
    expect(TRAFFIC_LIGHT_POSITION.y).toBe((APP_HEADER_HEIGHT - TRAFFIC_LIGHT_DIAMETER) / 2);
  });

  test("the group fits inside the header with room to spare", () => {
    expect(TRAFFIC_LIGHT_POSITION.y + TRAFFIC_LIGHT_DIAMETER).toBeLessThan(APP_HEADER_HEIGHT);
    expect(TRAFFIC_LIGHT_POSITION.y).toBeGreaterThan(0);
  });

  test("the renderer reserves at least as much width as the lights occupy", () => {
    // `--titlebar-inset` in apps/vnext-web/app/globals.css is the other half of
    // this contract, and the two live in different apps — so the number is read
    // from the stylesheet rather than restated here, where it could drift.
    const css = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "..", "vnext-web", "app", "globals.css"),
      "utf8",
    );
    const declared = /\[data-telar-shell="macos"\]\s*\{\s*--titlebar-inset:\s*([\d.]+)rem/.exec(css);
    expect(declared).not.toBeNull();
    const insetPx = Number(declared[1]) * 16;
    // Three lights plus the two gaps between them, starting at x.
    const occupied = TRAFFIC_LIGHT_POSITION.x + TRAFFIC_LIGHT_DIAMETER * 3 + 8 * 2;
    expect(insetPx).toBeGreaterThanOrEqual(occupied);
  });
});
