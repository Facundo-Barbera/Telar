"use strict";

const { execFile } = require("node:child_process");
const path = require("node:path");

const SOUND = /^telar-(hilo|armonico|felt)-(done|needs|error)$/;
const DEV_SOUNDS = path.join(__dirname, "..", "..", "..", "web", "public", "sounds");

function createChime({ packaged, dir = DEV_SOUNDS, play = (file) => execFile("afplay", [file], () => {}) }) {
  return {
    options: (sound) => (packaged && SOUND.test(sound) ? { sound: `${sound}.caf` } : { silent: true }),
    shown(sound) {
      if (!packaged && SOUND.test(sound)) play(path.join(dir, `${sound}.wav`));
    },
  };
}

module.exports = { SOUND, DEV_SOUNDS, createChime };
