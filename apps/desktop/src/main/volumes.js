const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { mountRootsFor } = require("./volume-watch");

function volumeUuid(mount) {
  const plist = execFileSync("diskutil", ["info", "-plist", mount], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
  });
  return /<key>VolumeUUID<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]?.trim();
}

function findVolumeMount(uuid) {
  if (process.platform !== "darwin") return undefined;
  for (const root of mountRootsFor(process.platform)) {
    let names;
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const mount = path.join(root, name);
      try {
        if (fs.statSync(mount).dev === fs.statSync(root).dev) continue;
        if (volumeUuid(mount) === uuid) return mount;
      } catch {
      }
    }
  }
  return undefined;
}

function volumeIdentityFor(target) {
  if (process.platform !== "darwin") return undefined;
  const prefix = "/Volumes/";
  if (!target.startsWith(prefix)) return undefined;
  const [name] = target.slice(prefix.length).split(path.sep);
  if (!name) return undefined;
  const mount = path.join("/Volumes", name);
  try {
    if (fs.statSync(mount).dev === fs.statSync("/Volumes").dev) return undefined;
    const uuid = volumeUuid(mount);
    return { mount, label: name, ...(uuid ? { uuid } : {}) };
  } catch {
    return { mount, label: name };
  }
}

module.exports = { findVolumeMount, volumeIdentityFor };
