#!/usr/bin/env node
// Bump apps/desktop/package.json's version to the next prerelease for a
// channel. electron-builder derives the update channel straight from the
// version's prerelease tag (x.y.z-nightly.N -> channel "nightly"), so this is
// the single place channel/version scheme logic lives — both the manual beta
// workflow and the scheduled nightly workflow call it instead of duplicating
// date/version math in YAML.
//
// Usage:
//   node scripts/set-desktop-version.mjs --channel nightly
//   node scripts/set-desktop-version.mjs --channel beta
//
// Prints the resulting version (e.g. "0.1.0-nightly.20260805.1") to stdout.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const channel = arg("channel");
if (channel !== "beta" && channel !== "nightly") {
  console.error("usage: set-desktop-version.mjs --channel beta|nightly [--version X.Y.Z-channel.N]");
  process.exit(2);
}

// AN EXPLICIT VERSION WINS, and it exists because the tag-triggered workflows
// need it. The derivation below picks the NEXT version by counting existing
// tags — correct when a build is what MINTS the version, and wrong when a tag
// already named it: a build triggered by `v0.1.0-beta.2` would count that very
// tag and produce beta.3, then publish and create a release under a name
// nobody asked for. When the tag is the trigger, the tag is the answer.
const explicit = arg("version");

const pkgPath = new URL("../apps/desktop/package.json", import.meta.url);
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const base = pkg.version.split("-")[0]; // strip any existing prerelease tag

function existingTags(pattern) {
  try {
    return execFileSync("git", ["tag", "-l", pattern], { encoding: "utf8" })
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

let version;
if (explicit) {
  // Validated against the channel it claims, because a version whose
  // prerelease tag disagrees with --channel would publish the artifacts to one
  // feed while electron-builder derived the channel from the other — the two
  // would silently diverge, and the symptom is an update that never arrives.
  if (!new RegExp(`-${channel}\\.`).test(explicit)) {
    console.error(`version "${explicit}" is not a ${channel} version`);
    process.exit(2);
  }
  version = explicit;
} else if (channel === "nightly") {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const prefix = `v${base}-nightly.${date}.`;
  const nums = existingTags(`${prefix}*`).map((t) => Number(t.slice(prefix.length)) || 0);
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  version = `${base}-nightly.${date}.${next}`;
} else {
  const prefix = `v${base}-beta.`;
  const nums = existingTags(`${prefix}*`).map((t) => Number(t.slice(prefix.length)) || 0);
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  version = `${base}-beta.${next}`;
}

pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(version);
