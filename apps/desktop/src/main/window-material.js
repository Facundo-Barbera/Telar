"use strict";

const DARK_MATERIAL = "hud";

const LIGHT_MATERIAL = "fullscreen-ui";

function vibrancyMaterial({ translucent, frost, dark } = {}) {
  if (translucent !== true) return null;
  if (frost === "clear") return null;
  return dark === true ? DARK_MATERIAL : LIGHT_MATERIAL;
}

function vibrancyWindowOptions(state) {
  const material = vibrancyMaterial(state);
  return material === null ? {} : { vibrancy: material, visualEffectState: "active" };
}

const OPAQUE_LIGHT = "#f6f6f8";

const OPAQUE_DARK = "#0a0a0a";

const TRANSLUCENT_BACKGROUND = "#00000000";

function windowBackgroundColor({ translucent, dark } = {}) {
  if (translucent === true) return TRANSLUCENT_BACKGROUND;

  return dark === true ? OPAQUE_DARK : OPAQUE_LIGHT;
}

function backdropWindowOptions(state = {}) {
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
