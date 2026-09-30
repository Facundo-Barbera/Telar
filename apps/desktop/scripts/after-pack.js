const fs = require("node:fs");
const path = require("node:path");

const UNPACKED = path.join("Contents", "Resources", "app.asar.unpacked");

function verifyPackagedPty(appPath, deps = {}) {
  const io = deps.fs ?? fs;
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const root = path.join(appPath, UNPACKED, "node_modules", "node-pty");

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

function verifyPackagedComputerUse(appPath, pin, deps = {}) {
  const io = deps.fs ?? fs;
  const helper = path.join(appPath, "Contents", "Helpers", `${pin.appName}.app`);
  const plist = path.join(helper, "Contents", "Info.plist");
  if (!io.existsSync(plist)) {
    if (deps.required) throw new Error(`packaged app has no computer-use helper at ${helper} — build-desktop.sh must build it before packaging.`);
    return null;
  }
  const info = io.readFileSync(plist, "utf8");
  const id = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(info)?.[1];
  if (id !== pin.bundleId) throw new Error(`computer-use helper answers to ${id ?? "no bundle id"}, not ${pin.bundleId}`);
  const executable = /<key>CFBundleExecutable<\/key>\s*<string>([^<]*)<\/string>/.exec(info)?.[1] ?? "";
  const binary = path.join(helper, "Contents", "MacOS", executable);
  if (!executable || !io.existsSync(binary) || (io.statSync(binary).mode & 0o111) === 0) {
    throw new Error(`computer-use helper's executable ${binary} is missing or not executable`);
  }
  if (!io.existsSync(path.join(helper, "Contents", "Resources", "LICENSE-cua.txt"))) {
    throw new Error("computer-use helper is missing cua's MIT notice (Contents/Resources/LICENSE-cua.txt)");
  }
  return { helper, binary };
}

const SOUND_NAMES = ["hilo", "armonico", "felt"].flatMap((set) => ["done", "needs", "error"].map((kind) => `telar-${set}-${kind}.caf`));

function verifyPackagedSounds(appPath) {
  const dir = path.join(appPath, "Contents", "Resources");
  const missing = SOUND_NAMES.filter((name) => !fs.existsSync(path.join(dir, name)));
  if (missing.length) throw new Error(`packaged app is missing notification sounds in ${dir}: ${missing.join(", ")} — macOS would play its default sound instead.`);
  return SOUND_NAMES.length;
}

const ARCH_NAMES = ["ia32", "x64", "armv7l", "arm64", "universal"];

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  const arch = ARCH_NAMES[context.arch] ?? process.arch;
  const found = verifyPackagedPty(appPath, { arch });
  console.log(`  • node-pty unpacked and runnable from ${found.from}${found.chmodded ? " (spawn-helper made executable)" : ""}`);
  console.log(`  • ${verifyPackagedSounds(appPath)} notification sounds in Contents/Resources`);
  const pin = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "src", "main", "computer-use-helper.json"), "utf8"));
  const helper = verifyPackagedComputerUse(appPath, pin, { required: process.env.TELAR_REQUIRE_COMPUTER_USE_HELPER === "1" });
  console.log(helper ? `  • computer-use helper ${pin.bundleId} (cua-driver ${pin.version}) packaged` : "  • no computer-use helper in this build (not required)");
};

exports.verifyPackagedPty = verifyPackagedPty;
exports.verifyPackagedComputerUse = verifyPackagedComputerUse;
exports.verifyPackagedSounds = verifyPackagedSounds;
exports.UNPACKED = UNPACKED;
