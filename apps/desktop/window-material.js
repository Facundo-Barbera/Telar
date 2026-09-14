"use strict";

// WHICH VIBRANCY MATERIAL GOES UNDER THE PAGE — one decision, in one place.
//
// Plain CommonJS with no dependencies, for the same reason window-chrome.js is:
// Electron's real main process requires it at runtime, with no TypeScript and
// no bundler. It is a separate file from main.js only so the decision can be
// tested without booting Electron.
//
// THE MATERIAL IS A PROPERTY OF THE SCHEME, NOT OF THE PREFERENCE. The window
// was built with "hud" whatever the cockpit was wearing, and "hud" is a DARK
// material: NSVisualEffectView tints it toward black, so a light canvas washed
// to ~70% opacity sat on grey and the whole page read muddy. That is issue #399
// — translucent light was never a lighter version of translucent dark, it was a
// dark frost with a pale sheet over it.
//
// WHY "sidebar" FOR THE LIGHT HALF. macOS offers three materials that take a
// light appearance cleanly: "popover", "sidebar" and "under-window". The last
// is the milkiest — that is why "hud" was chosen for dark in the first place
// (main.js says so) — and "popover" is tuned for a small floating box rather
// than a window-sized ground. "sidebar" is the material the system itself puts
// behind a full-height light surface that still has to be read against, which
// is exactly this window. The two constants are named so swapping one is a
// one-line change if the nightly says otherwise.
//
// NOT A DARK/LIGHT PAIR OF THE SAME MATERIAL, because macOS does not offer one:
// the materials are distinct recipes, and the scheme is what selects between
// them rather than a parameter to one of them.

/** The clearest material macOS offers for a dark canvas. */
const DARK_MATERIAL = "hud";

/** The light-appearance material a full-height ground reads cleanest on. */
const LIGHT_MATERIAL = "sidebar";

/**
 * The material this window should wear, or `null` for no vibrancy layer at all.
 *
 * `null` is the value `BrowserWindow.setVibrancy` takes to REMOVE the effect
 * view, which is why it is the answer for both "translucency is off" and the
 * "clear" frost — clear means a crisp desktop behind the page, tinted only by
 * the page's own wash.
 *
 * @param {{ translucent?: boolean, frost?: string, dark?: boolean }} state
 * @returns {"hud" | "sidebar" | null}
 */
function vibrancyMaterial({ translucent, frost, dark } = {}) {
  if (translucent !== true) return null;
  if (frost === "clear") return null;
  return dark === true ? DARK_MATERIAL : LIGHT_MATERIAL;
}

/**
 * The same decision as BrowserWindow construction options.
 *
 * `active`, NOT `followWindow`: followWindow deactivates the material when the
 * window loses focus — alt-tab away and the glass turns opaque, come back and
 * it flickers through the state transition. A window whose look changes with
 * focus reads as a bug, so the material stays active.
 *
 * An empty object when there is no material, so the caller can spread it into
 * the options without `vibrancy: null` ever reaching Electron.
 *
 * @param {{ translucent?: boolean, frost?: string, dark?: boolean }} state
 */
function vibrancyWindowOptions(state) {
  const material = vibrancyMaterial(state);
  return material === null ? {} : { vibrancy: material, visualEffectState: "active" };
}

module.exports = {
  DARK_MATERIAL,
  LIGHT_MATERIAL,
  vibrancyMaterial,
  vibrancyWindowOptions,
};
