"use strict";

const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SOUND = /^telar-(hilo|armonico|felt)-(done|needs|error)$/;
const DEV_SOUNDS = path.join(__dirname, "..", "..", "..", "web", "public", "sounds");

function installSounds({ from, to, log = () => {} }) {
  const installed = new Map();
  try {
    fs.mkdirSync(to, { recursive: true });
    for (const file of fs.readdirSync(from)) {
      const sound = path.basename(file, ".caf");
      if (!file.endsWith(".caf") || !SOUND.test(sound)) continue;
      try {
        const bytes = fs.readFileSync(path.join(from, file));
        const name = `${sound}-${createHash("sha256").update(bytes).digest("hex").slice(0, 8)}.caf`;
        const target = path.join(to, name);
        if (fs.statSync(target, { throwIfNoEntry: false })?.size !== bytes.length) {
          const temp = path.join(to, `.${name}.${process.pid}.tmp`);
          fs.writeFileSync(temp, bytes);
          fs.renameSync(temp, target);
        }
        installed.set(sound, name);
      } catch (error) {
        log(`installing ${file} into ${to} failed: ${error?.message || error}`);
      }
    }
  } catch (error) {
    log(`installing notification sounds into ${to} failed: ${error?.message || error}`);
  }
  return installed;
}

function createChime({ packaged, dir = DEV_SOUNDS, play = (file) => execFile("afplay", [file], () => {}) }) {
  let installed = new Map();
  return {
    install(locations) {
      if (packaged) installed = installSounds(locations);
    },
    options: (sound) => (packaged && SOUND.test(sound) ? { sound: installed.get(sound) ?? `${sound}.caf` } : { silent: true }),
    shown(sound) {
      if (!packaged && SOUND.test(sound)) play(path.join(dir, `${sound}.wav`));
    },
  };
}

module.exports = { SOUND, DEV_SOUNDS, createChime };
