"use strict";

// WHAT GOES UNDER THE PAGE — one decision, in one place.
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
// WHY "fullscreen-ui" FOR THE LIGHT HALF. The first pick was "sidebar", and
// the nightly said otherwise: side by side with dark at the same slider, light
// read as a near-solid pane — "sidebar" is one of the MOST opaque materials
// macOS offers (it is built to keep a source list readable over anything), so
// almost no desktop came through. "fullscreen-ui" is the clearest material that
// still takes a light appearance ("hud" is dark by construction), which is the
// same reason "hud" won for dark. "popover" is tuned for a small floating box,
// "under-window" is the milkiest. The two constants are named so swapping one
// is a one-line change if the next nightly says otherwise.
//
// NOT A DARK/LIGHT PAIR OF THE SAME MATERIAL, because macOS does not offer one:
// the materials are distinct recipes, and the scheme is what selects between
// them rather than a parameter to one of them.

/** The clearest material macOS offers for a dark canvas. */
const DARK_MATERIAL = "hud";

/** The light-appearance material a full-height ground reads cleanest on. */
const LIGHT_MATERIAL = "fullscreen-ui";

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

// --- The colour under the page when there is no glass -------------------------
//
// EVERY WINDOW IS BORN TRANSPARENT (#243), so the backdrop's opaque half is a
// COLOUR rather than a different kind of window. The three constants below are
// the whole of "translucency off": a window marked non-opaque whose own
// background is painted solid, which is a retint away from glass and back.
//
// THE TWO OPAQUE COLOURS ARE THE COCKPIT'S `--background` TOKEN, per scheme,
// converted to sRGB from apps/web/app/globals.css:
//   light  oklch(0.975 0.002 286) -> #f6f6f8
//   dark   oklch(0.145 0 0)       -> #0a0a0a  (Tailwind neutral-950)
// They are duplicated here rather than read, because Electron needs the colour
// BEFORE a renderer exists to be asked: this is the colour of the window in the
// moment between construction and the first paint, and on every resize the
// compositor has to fill. Wearing the wrong one is a flash of the other scheme,
// which is the whole reason the dark constant used to be worn in light mode.

/** `--background` in the light scheme. */
const OPAQUE_LIGHT = "#f6f6f8";

/** `--background` in the dark scheme. */
const OPAQUE_DARK = "#0a0a0a";

/** Fully clear: the page's own wash and whatever is behind the window. */
const TRANSLUCENT_BACKGROUND = "#00000000";

/**
 * The window's own background colour, under the page.
 *
 * @param {{ translucent?: boolean, dark?: boolean }} state
 */
function windowBackgroundColor({ translucent, dark } = {}) {
  if (translucent === true) return TRANSLUCENT_BACKGROUND;
  // A missing `dark` is LIGHT, for the same reason the material's is: the
  // wrong-scheme flash is more visible against a pale canvas.
  return dark === true ? OPAQUE_DARK : OPAQUE_LIGHT;
}

/**
 * THE WHOLE BACKDROP AS BROWSERWINDOW OPTIONS — the fix for #243.
 *
 * Translucency used to be a creation-time fact: a window born opaque could not
 * be turned to glass live (`setBackgroundColor("#00000000")` does not re-plumb
 * a compositor that was never told to blend alpha — the page paints into a
 * buffer nothing clears and every old frame ghosts through), so the toggle
 * REBUILT the window and the cockpit flashed and lost its scroll position.
 *
 * So every window is now born translucent-CAPABLE and only the tint moves:
 * `transparent: true` and the same options whichever way the preference sits,
 * differing in exactly two values — the vibrancy material, and the background
 * colour. Both have live setters (`setVibrancy`, `setBackgroundColor`), which
 * is what makes the toggle a retint instead of a teardown.
 *
 * `hasShadow: false` IS PART OF THE PRICE, not a preference. macOS does not
 * draw its native shadow on a non-opaque window at all, and recomputing one
 * from a transparent window's alpha is the native repaint that visibly blinked
 * on every alt-tab back in (proved with a CDP screencast: the renderer paints
 * nothing during the flicker, and the shadow is the only native layer that
 * changes with key status). Since the flag cannot differ between on and off
 * without making the toggle a rebuild again, it is off for both — an opaque
 * Telar window has no drop shadow, and that is the cost of a toggle that does
 * not throw the page away.
 *
 * `roundedCorners` IS DELIBERATELY LEFT ALONE at Electron's default `true`:
 * the window keeps its frame (`titleBarStyle: hiddenInset`), so macOS masks the
 * corners itself, and `false` would both square them and — per Electron's own
 * option docs — make the window unfullscreenable.
 *
 * `supported` is the platform half: vibrancy is NSVisualEffectView, and a
 * transparent window buys real trouble elsewhere (no shadow and, depending on
 * the compositor, no resize) for a feature that platform cannot show. Off
 * macOS the window is an ordinary opaque one.
 *
 * @param {{ translucent?: boolean, frost?: string, dark?: boolean, supported?: boolean }} state
 */
function backdropWindowOptions(state = {}) {
  // An unsupported platform is OPAQUE whatever the stored preference says, so
  // a pref carried over from a Mac cannot hand Linux a clear background colour
  // on a window that was never marked non-opaque — a window with no visible
  // ground at all.
  if (state.supported !== true) return { backgroundColor: windowBackgroundColor({ ...state, translucent: false }) };
  return {
    backgroundColor: windowBackgroundColor(state),
    transparent: true,
    hasShadow: false,
    ...vibrancyWindowOptions(state),
  };
}

module.exports = {
  DARK_MATERIAL,
  LIGHT_MATERIAL,
  OPAQUE_DARK,
  OPAQUE_LIGHT,
  TRANSLUCENT_BACKGROUND,
  backdropWindowOptions,
  vibrancyMaterial,
  vibrancyWindowOptions,
  windowBackgroundColor,
};
