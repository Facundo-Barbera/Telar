"use strict";

// THE BROWSER'S NAMED VIEWPORT SIZES — one table for the three places that
// speak them: the desktop host (browser-manager.js resolves `{preset}` into a
// size), the cockpit's device menu (apps/web/lib/browser-viewport.ts), and the
// engine's `browser_resize` schema (apps/engine/src/browser/tools.ts). They
// used to keep three copies, held together only by a test that compared two.
//
// Plain CommonJS, zero dependencies, for the same reason as command-keys.js:
// Electron's real main process requires it with no build step, and the web and
// the engine import it by relative path (docs/command-keys-web-port.md).
//
// SIZES ARE CSS PIXELS, PORTRAIT for phones and tablets, from Chrome DevTools'
// device list. Device names appear ONLY as labels; nothing else here names a
// product.

/**
 * @typedef {"phones"|"tablets"|"desktop"|"foldables"} ViewportPresetGroup
 * @typedef {{ key: string, label: string, group: ViewportPresetGroup, width: number, height: number }} ViewportPreset
 */

/** The groups, in the order a menu draws them. */
const VIEWPORT_PRESET_GROUPS = [
  { key: "phones", label: "Phones" },
  { key: "tablets", label: "Tablets" },
  { key: "desktop", label: "Desktop" },
  { key: "foldables", label: "Foldables" },
];

/**
 * ONE ROW PER SIZE. Two devices of one size would make `presetOf` pick between
 * them by array order, so the second is folded into the first's label and kept
 * reachable as an alias instead (Galaxy S20 Ultra is a Pixel 7's 412×915).
 * @type {ViewportPreset[]}
 */
const VIEWPORT_PRESETS = [
  { key: "iphone-se", label: "iPhone SE", group: "phones", width: 375, height: 667 },
  { key: "iphone-12-pro", label: "iPhone 12/13 Pro", group: "phones", width: 390, height: 844 },
  { key: "iphone-14-pro-max", label: "iPhone 14 Pro Max", group: "phones", width: 430, height: 932 },
  { key: "pixel-7", label: "Pixel 7 / Galaxy S20 Ultra", group: "phones", width: 412, height: 915 },
  { key: "galaxy-s8-plus", label: "Galaxy S8+", group: "phones", width: 360, height: 740 },
  { key: "ipad-mini", label: "iPad Mini", group: "tablets", width: 768, height: 1024 },
  { key: "ipad-air", label: "iPad Air", group: "tablets", width: 820, height: 1180 },
  { key: "ipad-pro", label: "iPad Pro", group: "tablets", width: 1024, height: 1366 },
  { key: "surface-pro-7", label: "Surface Pro 7", group: "tablets", width: 912, height: 1368 },
  { key: "default", label: "Default", group: "desktop", width: 1280, height: 800 },
  { key: "small-laptop", label: "Small laptop", group: "desktop", width: 1366, height: 768 },
  { key: "laptop", label: "Laptop", group: "desktop", width: 1440, height: 900 },
  { key: "full-hd", label: "Full HD", group: "desktop", width: 1920, height: 1080 },
  { key: "galaxy-z-fold-5", label: "Galaxy Z Fold 5", group: "foldables", width: 344, height: 882 },
  { key: "surface-duo", label: "Surface Duo", group: "foldables", width: 540, height: 720 },
];

/**
 * OLDER NAMES, STILL ACCEPTED. `phone` and `tablet` were the whole table
 * before it grew; persisted tabs and agents' habits still say them. An alias
 * resolves to its entry and is never what `presetOf` answers.
 */
const VIEWPORT_PRESET_ALIASES = {
  phone: "iphone-12-pro",
  tablet: "ipad-mini",
  "galaxy-s20-ultra": "pixel-7",
};

/** Every name `{preset}` accepts: the entries, then the aliases. */
const VIEWPORT_PRESET_KEYS = [...VIEWPORT_PRESETS.map((preset) => preset.key), ...Object.keys(VIEWPORT_PRESET_ALIASES)];

/** The entry a key (or an alias) names, or undefined. */
function viewportPreset(key) {
  if (typeof key !== "string") return undefined;
  const canonical = Object.prototype.hasOwnProperty.call(VIEWPORT_PRESET_ALIASES, key) ? VIEWPORT_PRESET_ALIASES[key] : key;
  return VIEWPORT_PRESETS.find((preset) => preset.key === canonical);
}

/** Which preset a size is, exactly as given (a rotated phone is custom), or null. */
function presetOf(size) {
  if (!size) return null;
  return VIEWPORT_PRESETS.find((preset) => preset.width === size.width && preset.height === size.height)?.key ?? null;
}

/** A square counts as portrait: there is nothing to turn. */
function orientationOf(size) {
  return size.width > size.height ? "landscape" : "portrait";
}

/** The size turned to `orientation` — the two numbers swapped, or unchanged. */
function orient(size, orientation) {
  if (orientation !== "portrait" && orientation !== "landscape") {
    throw new Error(`Unknown orientation ${JSON.stringify(orientation)}. Use portrait or landscape.`);
  }
  if (size.width === size.height || orientationOf(size) === orientation) return { width: size.width, height: size.height };
  return { width: size.height, height: size.width };
}

module.exports = {
  VIEWPORT_PRESETS,
  VIEWPORT_PRESET_GROUPS,
  VIEWPORT_PRESET_ALIASES,
  VIEWPORT_PRESET_KEYS,
  viewportPreset,
  presetOf,
  orientationOf,
  orient,
};
