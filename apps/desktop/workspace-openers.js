"use strict";
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const KNOWN_EDITORS = [
  { id: "vscode", label: "Visual Studio Code", icon: "vscode", bundles: ["Visual Studio Code.app"] },
  { id: "cursor", label: "Cursor", icon: "cursor", bundles: ["Cursor.app"] },
  { id: "windsurf", label: "Windsurf", icon: "windsurf", bundles: ["Windsurf.app"] },
  { id: "zed", label: "Zed", icon: "zed", bundles: ["Zed.app"] },
  { id: "sublime", label: "Sublime Text", icon: "sublime", bundles: ["Sublime Text.app"] },
  { id: "webstorm", label: "WebStorm", icon: "webstorm", bundles: ["WebStorm.app"] },
  { id: "intellij", label: "IntelliJ IDEA", icon: "intellij", bundles: ["IntelliJ IDEA.app", "IntelliJ IDEA CE.app"] },
  { id: "pycharm", label: "PyCharm", icon: "pycharm", bundles: ["PyCharm.app", "PyCharm CE.app"] },
  { id: "xcode", label: "Xcode", icon: "xcode", bundles: ["Xcode.app"] },
  { id: "nova", label: "Nova", bundles: ["Nova.app"] },
  { id: "textmate", label: "TextMate", bundles: ["TextMate.app"] },
  { id: "iterm", label: "iTerm", icon: "iterm", bundles: ["iTerm.app"] },

  { id: "ghostty", label: "Ghostty", bundles: ["Ghostty.app"] },
];

function searchRoots(home = os.homedir()) {
  return ["/Applications", path.join(home, "Applications"), "/System/Applications"];
}

function discoverOpeners({ roots = searchRoots(), exists = fs.existsSync } = {}) {
  const found = [];
  for (const editor of KNOWN_EDITORS) {
    for (const root of roots) {
      const bundle = editor.bundles.map((name) => path.join(root, name)).find((candidate) => exists(candidate));
      if (bundle) {
        found.push({ id: editor.id, label: editor.label, path: bundle, ...(editor.icon ? { icon: editor.icon } : {}) });
        break;
      }
    }
  }
  return found;
}

const FINDER_BUNDLE = "/System/Library/CoreServices/Finder.app";

const iconCache = new Map();

function openerIconDataUrl({ bundlePath, getFileIcon, cache = iconCache }) {
  const cached = cache.get(bundlePath);
  if (cached) return cached;
  const pending = Promise.resolve()
    .then(() => getFileIcon(bundlePath, { size: "normal" }))
    .then((image) => {
      if (image && typeof image.isEmpty === "function" && image.isEmpty()) return undefined;

      const png = typeof image?.toPNG === "function" ? image.toPNG() : undefined;
      return png && png.length > 0 ? `data:image/png;base64,${png.toString("base64")}` : undefined;
    })
    .catch(() => undefined);
  cache.set(bundlePath, pending);
  void pending.then((answer) => {
    if (answer === undefined && cache.get(bundlePath) === pending) cache.delete(bundlePath);
  });
  return pending;
}

async function openersWithIcons({ openers = discoverOpeners(), getFileIcon, cache = iconCache, exists = fs.existsSync } = {}) {
  if (typeof getFileIcon !== "function") return { openers };
  const [icons, reveal] = await Promise.all([
    Promise.all(openers.map((opener) => openerIconDataUrl({ bundlePath: opener.path, getFileIcon, cache }))),
    exists(FINDER_BUNDLE) ? openerIconDataUrl({ bundlePath: FINDER_BUNDLE, getFileIcon, cache }) : undefined,
  ]);
  return {
    openers: openers.map((opener, index) => (icons[index] ? { ...opener, iconDataUrl: icons[index] } : opener)),
    ...(reveal ? { revealIconDataUrl: reveal } : {}),
  };
}

function openWith({ target, appPath, run = execFile }) {
  return new Promise((resolve) => {
    const args = appPath ? ["-a", appPath, target] : [target];
    run("/usr/bin/open", args, { timeout: 10_000 }, (error) => {
      if (!error) return resolve({ ok: true });
      resolve({ ok: false, error: `That app could not open the folder (${error.message}).` });
    });
  });
}

function bundleIconFile(bundlePath, { run = execFile, exists = fs.existsSync } = {}) {
  const plist = path.join(bundlePath, "Contents", "Info.plist");
  if (!exists(plist)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    run("/usr/bin/plutil", ["-extract", "CFBundleIconFile", "raw", "-o", "-", plist], { timeout: 3000 }, (error, stdout) => {
      const name = error ? "" : String(stdout).trim();
      if (!name) return resolve(undefined);
      const base = name.endsWith(".icns") ? name.slice(0, -".icns".length) : name;
      const candidate = path.join(bundlePath, "Contents", "Resources", `${base}.icns`);
      resolve(exists(candidate) ? candidate : undefined);
    });
  });
}

function bundleIcon(bundlePath, { run = execFile, iconFile = bundleIconFile, size = 64, readFile = fs.promises.readFile, unlink = fs.promises.unlink, tmpDir = os.tmpdir } = {}) {
  return iconFile(bundlePath).then((icns) => {
    if (!icns) return undefined;
    const out = path.join(tmpDir(), `telar-icon-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
    return new Promise((resolve) => {
      run("/usr/bin/sips", ["-s", "format", "png", "-Z", String(size), icns, "--out", out], { timeout: 5000 }, (error) => {
        if (error) return resolve(undefined);
        readFile(out).then(
          (png) => resolve({ isEmpty: () => png.length === 0, toPNG: () => png }),
          () => resolve(undefined),
        );
      });
    }).finally(() => unlink(out).catch(() => undefined));
  });
}

module.exports = { discoverOpeners, openWith, openersWithIcons, openerIconDataUrl, bundleIconFile, bundleIcon, searchRoots, FINDER_BUNDLE, KNOWN_EDITORS };
