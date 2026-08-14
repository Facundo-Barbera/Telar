"use strict";

// TELAR OWNS THE TOP OF ITS OWN WINDOW — the numbers, in one place.
//
// Plain CommonJS with no dependencies, for the same reason command-keys.js is:
// Electron's real main process requires it at runtime, with no TypeScript and
// no bundler. It is a separate file from main.js only so the platform rule and
// the two offsets can be tested without booting Electron.
//
// THE HEADER HEIGHT IS THE CONTRACT. The renderer's sidebar header is 56px
// (`h-14`), and the traffic lights have to sit on its centreline rather than in
// a strip above it — otherwise the whole point is lost and the window simply
// gains a shorter grey bar. Both offsets below derive from that one number, and
// apps/vnext-web/app/globals.css derives `--titlebar-inset` from the same
// geometry to reserve the width. If the header height changes, all three move.

/** The renderer's sidebar header height, in CSS pixels (`h-14`). */
const APP_HEADER_HEIGHT = 56;

/** macOS draws the three lights 12px tall. */
const TRAFFIC_LIGHT_DIAMETER = 12;

/**
 * Where the light group's top-left corner goes.
 *
 * `x` is the standard macOS left margin; `y` centres the group in the app's own
 * header rather than leaving it at the top of the window.
 */
const TRAFFIC_LIGHT_POSITION = {
  x: 13,
  y: Math.round((APP_HEADER_HEIGHT - TRAFFIC_LIGHT_DIAMETER) / 2),
};

/**
 * The BrowserWindow options that hand the titlebar to the app, or nothing.
 *
 * MACOS ONLY, AND THAT IS NOT A HEDGE. On Windows and Linux, Electron treats
 * `hiddenInset` as `hidden`: the minimise/maximise/close buttons disappear
 * entirely and the app is expected to draw its own, which this cockpit does
 * not. A platform that would lose its window controls keeps its system
 * titlebar — an app you cannot close is a worse outcome than a grey strip.
 */
function macWindowChrome(platform = process.platform) {
  if (platform !== "darwin") return {};
  return {
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { ...TRAFFIC_LIGHT_POSITION },
  };
}

module.exports = {
  APP_HEADER_HEIGHT,
  TRAFFIC_LIGHT_DIAMETER,
  TRAFFIC_LIGHT_POSITION,
  macWindowChrome,
};
