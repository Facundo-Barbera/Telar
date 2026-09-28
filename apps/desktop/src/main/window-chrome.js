"use strict";

const APP_HEADER_HEIGHT = 56;

const TRAFFIC_LIGHT_DIAMETER = 12;

const TRAFFIC_LIGHT_INSET = Math.round((APP_HEADER_HEIGHT - TRAFFIC_LIGHT_DIAMETER) / 2);
const TRAFFIC_LIGHT_POSITION = {
  x: TRAFFIC_LIGHT_INSET,
  y: TRAFFIC_LIGHT_INSET,
};

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
