"use strict";

const { execFile } = require("node:child_process");
const path = require("node:path");

const SOUND = /^telar-(hilo|armonico|felt)-(done|needs|error)$/;
const DEV_SOUNDS = path.join(__dirname, "..", "..", "..", "web", "public", "sounds");

function createChime({ bundled, dir = DEV_SOUNDS, play = (file) => execFile("afplay", [file], () => {}) }) {
  return {
    options: (sound) => (sound && bundled ? { sound: `${sound}.wav` } : { silent: true }),
    shown(sound) {
      if (sound && !bundled) play(path.join(dir, `${sound}.wav`));
    },
  };
}

module.exports = { SOUND, DEV_SOUNDS, createChime };
