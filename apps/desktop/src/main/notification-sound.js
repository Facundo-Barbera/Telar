"use strict";

const { execFile } = require("node:child_process");
const path = require("node:path");

const SOUND = /^telar-(hilo|armonico|felt)-(done|needs|error)$/;
const DEV_SOUNDS = path.join(__dirname, "..", "..", "..", "web", "public", "sounds");

function createChime({ dir, play = (file) => execFile("afplay", [file], () => {}) }) {
  return (sound) => {
    if (SOUND.test(sound)) play(path.join(dir, `${sound}.wav`));
  };
}

module.exports = { SOUND, DEV_SOUNDS, createChime };
