// WHICH PACKAGED BINARY MAY ACT AS A CHILD "node".
//
// electron-builder names the plain helper "<productName> Helper.app" —
// "Telar Helper" in the shipping app, "Telar Dev Helper" in a --dev package.
// main.js used to hardcode "Telar Helper", so in a dev package the lookup
// missed and every child fell back to the MAIN binary, which registers with
// LaunchServices as a Foreground app: one extra dead "Telar Dev" in the Dock
// per child. The helper is LSUIElement — same runtime, no Dock entry.
"use strict";
const path = require("node:path");
const nodeFs = require("node:fs");

/**
 * Resolve the plain helper's executable inside a Frameworks directory, or null
 * when there is none (the caller falls back to process.execPath).
 *
 * "<productName> Helper" is tried first; a scan for any other "* Helper.app"
 * covers a product name and bundle disagreeing. The role-pinned
 * "(Renderer)/(GPU)/(Plugin)" helpers never match the pattern — their names
 * end in the parenthesised role, not in "Helper".
 */
function resolveHelperExec(frameworksDir, productName, fs = nodeFs) {
  const helperBin = (name) => path.join(frameworksDir, `${name}.app`, "Contents", "MacOS", name);
  const candidates = [`${productName} Helper`];
  try {
    for (const entry of fs.readdirSync(frameworksDir)) {
      const plain = /^(.+ Helper)\.app$/.exec(entry);
      if (plain && !candidates.includes(plain[1])) candidates.push(plain[1]);
    }
  } catch {
    // No Frameworks dir (unpackaged checkout) — the explicit candidate below
    // still gets its existsSync chance, which also fails, returning null.
  }
  for (const name of candidates) {
    const bin = helperBin(name);
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

module.exports = { resolveHelperExec };
