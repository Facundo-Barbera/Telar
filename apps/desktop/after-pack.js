/**
 * THE FIRST NATIVE MODULE THIS APP SHIPS, CHECKED ON THE ARTEFACT (#198).
 *
 * Two things have to be true of a packaged Telar before its terminal can start
 * a shell, and BOTH of them fail at runtime rather than at build time — which
 * is the shape this repository keeps getting caught by. So they are asserted
 * here, against the .app that was just written, where a failure stops a package
 * instead of shipping one.
 *
 *   1. node-pty IS OUTSIDE THE ASAR. `build.asar` is true and a `.node` cannot
 *      be loaded from inside an archive; node-pty's own loader rewrites
 *      `app.asar` to `app.asar.unpacked` when it resolves `spawn-helper`, which
 *      is the package telling us what it expects. `asarUnpack` in package.json
 *      puts it there; this proves it landed.
 *
 *   2. `spawn-helper` IS EXECUTABLE. node-pty's npm tarball records it mode
 *      0644 and nothing in the package ever chmods it — the `install` script
 *      only decides whether to rebuild and `postinstall` only tidies Windows
 *      artefacts. Without the bit, every terminal fails with `posix_spawnp
 *      failed`, an error that names neither the file nor the mode. Setting it
 *      at build time also means a Telar installed on a read-only volume never
 *      needs to write into its own bundle to work.
 *
 * The core is a plain function over a directory so it can be unit-tested
 * against a fake bundle layout, the way helper-exec.js's resolver is.
 */
const fs = require("node:fs");
const path = require("node:path");

/** Where electron-builder puts everything `asarUnpack` matched. */
const UNPACKED = path.join("Contents", "Resources", "app.asar.unpacked");

/**
 * Repair and verify one packaged app's node-pty. Returns what it found so a
 * caller can log it; throws when the app could not run a terminal.
 *
 * @param {string} appPath absolute path to the `.app` bundle
 * @param {{platform?: NodeJS.Platform, arch?: string, fs?: typeof fs}} [deps]
 */
function verifyPackagedPty(appPath, deps = {}) {
  const io = deps.fs ?? fs;
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const root = path.join(appPath, UNPACKED, "node_modules", "node-pty");

  /**
   * THE DIRECTORY THE LOADER WILL ACTUALLY PICK, IN ITS ORDER — not the one we
   * expect it to use. node-pty's `loadNativeModule` (lib/utils.js) tries
   * `build/Release`, then `build/Debug`, then `prebuilds/<platform>-<arch>`,
   * and reads `spawn-helper` as a sibling of whichever answered.
   *
   * THIS MATTERS BECAUSE ELECTRON-BUILDER REBUILDS. Its "installing native
   * dependencies" step compiles node-pty against Electron's headers and writes
   * `build/Release/` into the packaged tree — so a packaged app has BOTH that
   * and the shipped `prebuilds/`, and the loader takes `build/Release`. A check
   * pinned to `prebuilds/` would inspect a directory the app never opens and
   * pass while the one it does open was broken. Measured on a real package.
   */
  const searched = [];
  for (const build of ["build/Release", "build/Debug", `prebuilds/${platform}-${arch}`]) {
    const dir = path.join(root, build);
    searched.push(dir);
    if (!io.existsSync(path.join(dir, "pty.node"))) continue;
    const addon = path.join(dir, "pty.node");
    if (platform === "win32") return { addon, helper: null, chmodded: false, from: build };

    const helper = path.join(dir, "spawn-helper");
    if (!io.existsSync(helper)) {
      throw new Error(`packaged app has node-pty's addon at ${addon} but no spawn-helper beside it — every terminal would fail with posix_spawnp.`);
    }
    const mode = io.statSync(helper).mode;
    if ((mode & 0o111) !== 0) return { addon, helper, chmodded: false, from: build };
    io.chmodSync(helper, (mode & 0o7777) | 0o755);
    return { addon, helper, chmodded: true, from: build };
  }

  throw new Error(
    `packaged app has no loadable PTY addon. Looked in: ${searched.join(", ")}. ` +
      "node-pty was packed INSIDE app.asar, where a .node cannot be loaded — check build.asarUnpack in apps/desktop/package.json.",
  );
}

/**
 * electron-builder's `Arch` enum, as the names node's `process.arch` uses —
 * which is what node-pty names its prebuild directories after. Spelled out
 * rather than imported so this file stays requireable by a unit test that has
 * no electron-builder.
 */
const ARCH_NAMES = ["ia32", "x64", "armv7l", "arm64", "universal"];

/** electron-builder's hook. `context.appOutDir` holds exactly one `.app`. */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  const arch = ARCH_NAMES[context.arch] ?? process.arch;
  const found = verifyPackagedPty(appPath, { arch });
  console.log(`  • node-pty unpacked and runnable from ${found.from}${found.chmodded ? " (spawn-helper made executable)" : ""}`);
};

exports.verifyPackagedPty = verifyPackagedPty;
exports.UNPACKED = UNPACKED;
