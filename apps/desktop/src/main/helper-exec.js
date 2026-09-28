"use strict";
const path = require("node:path");
const nodeFs = require("node:fs");

function resolveHelperExec(frameworksDir, productName, fs = nodeFs) {
  const helperBin = (name) => path.join(frameworksDir, `${name}.app`, "Contents", "MacOS", name);
  const candidates = [`${productName} Helper`];
  try {
    for (const entry of fs.readdirSync(frameworksDir)) {
      const plain = /^(.+ Helper)\.app$/.exec(entry);
      if (plain && !candidates.includes(plain[1])) candidates.push(plain[1]);
    }
  } catch {
  }
  for (const name of candidates) {
    const bin = helperBin(name);
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

module.exports = { resolveHelperExec };
