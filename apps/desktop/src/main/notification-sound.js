"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SOUND = /^telar-(hilo|armonico|felt)-(done|needs|error)$/;
const DEV_SOUNDS = path.join(__dirname, "..", "..", "..", "web", "public", "sounds");

function unchanged(file, bytes) {
  try {
    return fs.readFileSync(file).equals(bytes);
  } catch {
    return false;
  }
}

function installSounds({ from, home, log = () => {} }) {
  const to = path.join(home, "Library", "Sounds");
  try {
    fs.mkdirSync(to, { recursive: true });
    for (const file of fs.readdirSync(from)) {
      if (!file.endsWith(".caf") || !SOUND.test(path.basename(file, ".caf"))) continue;
      try {
        const bytes = fs.readFileSync(path.join(from, file));
        const target = path.join(to, file);
        if (unchanged(target, bytes)) continue;
        const temp = path.join(to, `.${file}.${process.pid}.tmp`);
        fs.writeFileSync(temp, bytes);
        fs.renameSync(temp, target);
      } catch (error) {
        log(`installing ${file} into ${to} failed: ${error?.message || error}`);
      }
    }
  } catch (error) {
    log(`installing notification sounds into ${to} failed: ${error?.message || error}`);
  }
}

function createChime({ packaged, dir = DEV_SOUNDS, play = (file) => execFile("afplay", [file], () => {}) }) {
  return {
    install(locations) {
      if (packaged) installSounds(locations);
    },
    options: (sound) => (packaged && SOUND.test(sound) ? { sound: `${sound}.caf` } : { silent: true }),
    shown(sound) {
      if (!packaged && SOUND.test(sound)) play(path.join(dir, `${sound}.wav`));
    },
  };
}

module.exports = { SOUND, DEV_SOUNDS, createChime };
