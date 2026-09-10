/**
 * WHICH APPS ON THIS MAC CAN OPEN A FOLDER.
 *
 * Discovery is a bundle-existence probe at the standard install locations
 * (/Applications, /Applications/Utilities, ~/Applications, /System/…) — the
 * same mechanism `list_apps` uses, and the same one macOS itself installs to.
 * No subprocess is spawned to find anything, so an empty list means "not
 * installed here" rather than "a helper failed".
 *
 * Launching goes through `/usr/bin/open -a <bundle> <folder>` with execFile
 * and an ARGV ARRAY: no shell, so a folder or app path containing a space,
 * quote or semicolon is one argument rather than somebody else's command.
 *
 * The list is CURATED, not exhaustive, and is only ever a filter over what is
 * actually installed. Finder is always offered because it always exists.
 */
"use strict";
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** id → what to call it, and the bundle names to look for. */
const KNOWN_EDITORS = [
  { id: "vscode", label: "Visual Studio Code", bundles: ["Visual Studio Code.app"] },
  { id: "cursor", label: "Cursor", bundles: ["Cursor.app"] },
  { id: "windsurf", label: "Windsurf", bundles: ["Windsurf.app"] },
  { id: "zed", label: "Zed", bundles: ["Zed.app"] },
  { id: "sublime", label: "Sublime Text", bundles: ["Sublime Text.app"] },
  { id: "webstorm", label: "WebStorm", bundles: ["WebStorm.app"] },
  { id: "intellij", label: "IntelliJ IDEA", bundles: ["IntelliJ IDEA.app", "IntelliJ IDEA CE.app"] },
  { id: "pycharm", label: "PyCharm", bundles: ["PyCharm.app", "PyCharm CE.app"] },
  { id: "xcode", label: "Xcode", bundles: ["Xcode.app"] },
  { id: "nova", label: "Nova", bundles: ["Nova.app"] },
  { id: "textmate", label: "TextMate", bundles: ["TextMate.app"] },
  { id: "iterm", label: "iTerm", bundles: ["iTerm.app"] },
  { id: "terminal", label: "Terminal", bundles: ["Utilities/Terminal.app"] },
  { id: "ghostty", label: "Ghostty", bundles: ["Ghostty.app"] },
];

function searchRoots(home = os.homedir()) {
  return ["/Applications", path.join(home, "Applications"), "/System/Applications"];
}

/**
 * The installed openers, in the curated order. `{ id, label, path }`.
 * `roots`/`exists` are injected by tests; production probes the real disk.
 */
function discoverOpeners({ roots = searchRoots(), exists = fs.existsSync } = {}) {
  const found = [];
  for (const editor of KNOWN_EDITORS) {
    for (const root of roots) {
      const bundle = editor.bundles.map((name) => path.join(root, name)).find((candidate) => exists(candidate));
      if (bundle) {
        found.push({ id: editor.id, label: editor.label, path: bundle });
        break;
      }
    }
  }
  return found;
}

/**
 * Open `target` with the app at `appPath`, or with the system default when no
 * app is named. Resolves `{ ok }` or `{ ok: false, error }`; never throws, and
 * never builds a command string.
 */
function openWith({ target, appPath, run = execFile }) {
  return new Promise((resolve) => {
    const args = appPath ? ["-a", appPath, target] : [target];
    run("/usr/bin/open", args, { timeout: 10_000 }, (error) => {
      if (!error) return resolve({ ok: true });
      resolve({ ok: false, error: `That app could not open the folder (${error.message}).` });
    });
  });
}

module.exports = { discoverOpeners, openWith, searchRoots, KNOWN_EDITORS };
