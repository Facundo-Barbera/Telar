const { VIEWPORT_PRESET_KEYS, orient, viewportPreset } = require("./viewport-presets");

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

const VIEWPORT_MIN = 200;
const VIEWPORT_MAX = 5_000;

const VIEWPORT_MAX_AREA = 5_000 * 3_000;

const PAGE_CANVAS = "#ffffff";
const NO_CANVAS = "#00000000";

function resolveViewport(input, current = DEFAULT_VIEWPORT) {
  const request = input && typeof input === "object" ? input : {};
  const given = (value) => value !== undefined && value !== null;
  let size;
  if (typeof request.preset === "string") {
    const preset = viewportPreset(request.preset);
    if (!preset) throw new Error(`Unknown viewport preset ${JSON.stringify(request.preset)}. Presets: ${VIEWPORT_PRESET_KEYS.join(", ")}.`);
    size = { width: preset.width, height: preset.height };
  } else {
    if (!given(request.width) && !given(request.height) && !given(request.orientation)) {
      throw new Error("A viewport needs a numeric width and height, or a preset.");
    }
    size = {
      width: Math.round(Number(given(request.width) ? request.width : current.width)),
      height: Math.round(Number(given(request.height) ? request.height : current.height)),
    };
    if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) throw new Error("A viewport needs a numeric width and height, or a preset.");
  }
  if (given(request.orientation)) size = orient(size, request.orientation);
  const clamp = (value) => Math.min(VIEWPORT_MAX, Math.max(VIEWPORT_MIN, value));
  let w = clamp(size.width);
  let h = clamp(size.height);
  if (w * h > VIEWPORT_MAX_AREA) h = Math.max(VIEWPORT_MIN, Math.floor(VIEWPORT_MAX_AREA / w));
  return { width: w, height: h };
}

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

function zoomStep(factor, direction) {
  if (direction === "reset") return 1;
  const current = Number.isFinite(factor) && factor > 0 ? factor : 1;
  if (direction === "in") return ZOOM_STEPS.find((step) => step > current + 1e-6) ?? ZOOM_STEPS.at(-1);
  if (direction === "out") return [...ZOOM_STEPS].reverse().find((step) => step < current - 1e-6) ?? ZOOM_STEPS[0];
  throw new Error(`Unknown zoom direction ${JSON.stringify(direction)}. Use in, out or reset.`);
}

function resolveColorScheme(value) {
  if (value === "light" || value === "dark" || value === "system") return value;
  throw new Error(`Unknown appearance ${JSON.stringify(value)}. Use light, dark or system.`);
}

function resolveZoom(value) {
  if (value === "fit") return "fit";
  const zoom = Number(value);
  if (Number.isFinite(zoom) && zoom >= 0.1 && zoom <= 1) return zoom;
  throw new Error(`Unknown zoom ${JSON.stringify(value)}. Use "fit" or a scale from 0.1 to 1.`);
}

function fitViewport(viewport, bounds, zoom = "fit") {
  const fit = Math.min(1, bounds.width / viewport.width, bounds.height / viewport.height);
  const scale = typeof zoom === "number" ? Math.min(fit, zoom) : fit;
  const width = Math.max(1, Math.round(viewport.width * scale));
  const height = Math.max(1, Math.round(viewport.height * scale));
  return {
    scale,
    rect: {
      x: bounds.x + Math.max(0, Math.floor((bounds.width - width) / 2)),
      y: bounds.y + Math.max(0, Math.floor((bounds.height - height) / 2)),
      width,
      height,
    },
  };
}

function emulationKey(target) {
  const ratio = target.deviceScaleFactor && target.deviceScaleFactor !== 1 ? `*${target.deviceScaleFactor}` : "";
  const key = `${target.width}x${target.height}@${target.scale}${ratio}`;
  return target.view ? `${key} in ${target.view.width}x${target.view.height}` : key;
}

module.exports = { DEFAULT_VIEWPORT, VIEWPORT_MIN, PAGE_CANVAS, NO_CANVAS, resolveViewport, ZOOM_STEPS, zoomStep, resolveColorScheme, resolveZoom, fitViewport, emulationKey };
