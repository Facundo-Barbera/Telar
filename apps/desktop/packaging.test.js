const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));

describe("every local module main.js requires is packaged with it", () => {
  test("build.files lists every relative require reachable from main.js", () => {
    const required = new Set();
    const visit = (file) => {
      if (required.has(file)) return;
      required.add(file);
      if (!file.endsWith(".js")) return;
      const source = fs.readFileSync(path.join(__dirname, file), "utf8");
      for (const match of source.matchAll(/require\("(\.\.?\/[^"]+)"\)/g)) {
        const spec = path.extname(match[1]) ? match[1] : `${match[1]}.js`;
        visit(path.relative(__dirname, path.resolve(path.dirname(path.join(__dirname, file)), spec)));
      }
    };
    visit("main.js");

    const main = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
    for (const match of main.matchAll(/path\.join\(__dirname, "([^"]+\.js)"\)/g)) required.add(match[1]);

    expect(required.size).toBeGreaterThan(1);
    const packaged = (file) =>
      manifest.build.files.some((entry) => entry === file || (entry.endsWith("/*.js") && path.dirname(file) === entry.slice(0, -5) && file.endsWith(".js")));
    expect([...required].filter((file) => !packaged(file))).toEqual([]);
  });
});

describe("extraResources carries the node_modules its trees need", () => {
  const entries = manifest.build.extraResources;
  const destinations = new Set(entries.map((entry) => entry.to));

  test("the standalone tree gets its .bun store named explicitly", () => {
    expect(destinations).toContain("standalone");
    expect(destinations).toContain("standalone/node_modules/.bun");
  });

  test("the engine bundle gets its node_modules named explicitly", () => {
    expect(destinations).toContain("engine");
    expect(destinations).toContain("engine/node_modules");
  });

  test("the shell's PNG icons are copied where the web tier can serve them", () => {
    const branding = entries.find((entry) => entry.to === "branding");
    expect(branding).toBeDefined();
    expect(branding.from).toBe("build");
    expect(branding.filter).toEqual(["*.png"]);
    expect(fs.existsSync(path.join(__dirname, "build", "icon.png"))).toBe(true);
  });

  test("every companion entry names a real subpath of the tree it repairs", () => {
    const roots = [...destinations].filter((to) => !to.includes("/"));
    for (const to of destinations) {
      if (!to.includes("/")) continue;
      expect(roots.some((root) => to.startsWith(`${root}/`))).toBe(true);
    }
  });
});

describe("engine children run from the LSUIElement helper, whatever the product is named", () => {
  const { resolveHelperExec } = require("./helper-exec.js");
  const os = require("node:os");

  const layout = (helpers) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-frameworks-"));
    for (const name of helpers) {
      const bin = path.join(dir, `${name}.app`, "Contents", "MacOS");
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, name), "");
    }
    return dir;
  };
  const helpers = (product) => [
    `${product} Helper`,
    `${product} Helper (GPU)`,
    `${product} Helper (Renderer)`,
    `${product} Helper (Plugin)`,
  ];

  test("a shipping layout resolves Telar Helper", () => {
    const dir = layout(helpers("Telar"));
    expect(resolveHelperExec(dir, "Telar")).toBe(path.join(dir, "Telar Helper.app", "Contents", "MacOS", "Telar Helper"));
  });

  test("a --dev layout resolves Telar Dev Helper", () => {
    const dir = layout(helpers("Telar Dev"));
    expect(resolveHelperExec(dir, "Telar Dev")).toBe(
      path.join(dir, "Telar Dev Helper.app", "Contents", "MacOS", "Telar Dev Helper"),
    );
  });

  test("a product name that disagrees with the bundle still finds the plain helper by scanning", () => {
    const dir = layout(helpers("Telar Dev"));
    expect(resolveHelperExec(dir, "Renamed Product")).toBe(
      path.join(dir, "Telar Dev Helper.app", "Contents", "MacOS", "Telar Dev Helper"),
    );
  });

  test("role-pinned helpers are never picked, and no helper at all means null (caller falls back)", () => {
    const dir = layout(["Telar Dev Helper (GPU)", "Telar Dev Helper (Renderer)"]);
    expect(resolveHelperExec(dir, "Telar Dev")).toBeNull();
    expect(resolveHelperExec(path.join(dir, "no-such-dir"), "Telar Dev")).toBeNull();
  });
});

describe("a --dev package is a separate app that cannot collide with the installed Telar", () => {
  const { spawnSync } = require("node:child_process");
  const script = path.join(__dirname, "..", "..", "scripts", "package-desktop.sh");
  const devApp = path.join(__dirname, "release", "dev", "mac-arm64", "Telar Dev.app");

  test("--dev --install may not be aimed at Telar.app, and is refused before anything is built", () => {
    const result = spawnSync(
      "bash",
      [script, "--dev", "--install", "--destination", "/Applications/Telar.app"],
      { encoding: "utf8", timeout: 15_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("may not target Telar.app");
    expect(result.stdout).not.toContain("==> build standalone web app");
  });

  test.skipIf(process.platform !== "darwin")("install-app.sh installs a dev bundle beside Telar.app, named after the source", () => {
    const os = require("node:os");
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "telar-install-name-"));
    try {
      const fake = path.join(scratch, "Telar Dev.app");
      fs.mkdirSync(path.join(fake, "Contents", "MacOS"), { recursive: true });
      fs.writeFileSync(path.join(fake, "Contents", "MacOS", "Telar Dev"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const dest = path.join(scratch, "dest");
      const result = spawnSync(
        "bash",
        [path.join(__dirname, "install-app.sh"), "--app", fake, "--verified", "--destination", path.join(dest, "Telar Dev.app")],
        { encoding: "utf8", timeout: 15_000 },
      );
      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(dest, "Telar Dev.app", "Contents", "MacOS", "Telar Dev"))).toBe(true);
      expect(fs.existsSync(path.join(dest, "Telar.app"))).toBe(false);

      const home = path.join(scratch, "home");
      fs.mkdirSync(home, { recursive: true });
      const byDefault = spawnSync(
        "bash",
        [path.join(__dirname, "install-app.sh"), "--app", fake, "--verified"],
        { encoding: "utf8", timeout: 15_000, env: { ...process.env, HOME: home } },
      );
      expect(byDefault.status).toBe(0);
      expect(fs.existsSync(path.join(home, "Applications", "Telar Dev.app"))).toBe(true);
      expect(fs.existsSync(path.join(home, "Applications", "Telar.app"))).toBe(false);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("the shipping identity in package.json is untouched by the dev option", () => {
    expect(manifest.build.appId).toBe("io.github.novarix.telar");
    expect(manifest.build.productName).toBe("Telar");
    expect(manifest.productName).toBe("Telar");
    expect(manifest.telarDev).toBeUndefined();
  });

  test("the new bundle id keeps the product name, the dev id and the helper's id", () => {
    expect(manifest.productName).toBe(manifest.build.productName);
    expect(require("./dev-update-core").DEV_BUNDLE_ID).toBe("io.github.novarix.telar.dev");
    expect(require("./computer-use-helper.json").bundleId).toBe("com.telar.desktop.computer-use");
  });

  const built = fs.existsSync(path.join(devApp, "Contents", "Info.plist"));
  const when = built ? test : test.skip;

  when("the built Telar Dev.app carries its own bundle id, name and executable", () => {
    const plist = (key) =>
      spawnSync("plutil", ["-extract", key, "raw", "-o", "-", path.join(devApp, "Contents", "Info.plist")], { encoding: "utf8" }).stdout.trim();
    expect(plist("CFBundleIdentifier")).toBe("io.github.novarix.telar.dev");
    expect(plist("CFBundleName")).toBe("Telar Dev");
    expect(fs.existsSync(path.join(devApp, "Contents", "MacOS", "Telar Dev"))).toBe(true);

    const stamp = JSON.parse(fs.readFileSync(path.join(devApp, "Contents", "Resources", "standalone", "build-info.json"), "utf8"));
    expect(stamp.channel).toBe("dev");
    expect(typeof stamp.dirty).toBe("boolean");
  });

  when("the built Telar Dev.app bundles the helper the engine child resolves to", () => {
    const { resolveHelperExec } = require("./helper-exec.js");
    const helper = resolveHelperExec(path.join(devApp, "Contents", "Frameworks"), "Telar Dev");
    expect(helper).toBe(
      path.join(devApp, "Contents", "Frameworks", "Telar Dev Helper.app", "Contents", "MacOS", "Telar Dev Helper"),
    );
  });

  when("the built app's packaged metadata carries telarDev as a boolean, which is what main.js keys on", () => {
    const scratch = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "telar-dev-meta-"));
    try {
      const extracted = spawnSync(
        "bunx",
        ["--bun", "@electron/asar", "extract-file", path.join(devApp, "Contents", "Resources", "app.asar"), "package.json"],
        { cwd: scratch, encoding: "utf8", timeout: 60_000, env: { ...process.env, NODE_OPTIONS: "" } },
      );
      expect(extracted.status).toBe(0);
      const packaged = JSON.parse(fs.readFileSync(path.join(scratch, "package.json"), "utf8"));
      expect(packaged.telarDev).toBe(true);
      expect(packaged.productName).toBe("Telar Dev");
      expect(packaged.updateProxyKey).toBeUndefined();

      expect(typeof packaged.telarDevRepo).toBe("string");
      expect(path.isAbsolute(packaged.telarDevRepo)).toBe(true);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("the packaged app can be granted the camera and the microphone", () => {
  const plist = (name) => fs.readFileSync(path.join(__dirname, "build", name), "utf8");
  const info = manifest.build.mac.extendInfo;

  test("Info.plist carries a usage string for each device, in words a person is asked to agree to", () => {
    for (const key of ["NSCameraUsageDescription", "NSMicrophoneUsageDescription"]) {
      expect(typeof info[key]).toBe("string");

      expect(info[key].length).toBeGreaterThan(40);
      expect(info[key]).toContain("Telar");
    }

    expect(info.NSAppleEventsUsageDescription).toContain("Computer Use");
  });

  test("the hardened runtime is entitled to both devices, and so are the helpers that open them", () => {
    for (const key of ["com.apple.security.device.camera", "com.apple.security.device.audio-input"]) {
      expect(plist("entitlements.mac.plist")).toContain(`<key>${key}</key>`);

      expect(plist("entitlements.mac.inherit.plist")).toContain(`<key>${key}</key>`);
    }
  });

  test("the store the decisions live in is packaged with the module that reads it", () => {
    expect(manifest.build.files).toContain("site-permissions.js");
    const manager = fs.readFileSync(path.join(__dirname, "browser-manager.js"), "utf8");
    expect(manager).toContain('require("./site-permissions")');
  });
});

describe("the password-manager extension ships with what it needs", () => {
  test("the compat modules main.js requires are in build.files, and the library is a runtime dependency", () => {
    for (const file of ["extension-host.js", "extension-compat.js", "protected-urls.js"]) expect(manifest.build.files).toContain(file);

    expect(manifest.dependencies["electron-chrome-extensions"]).toBeDefined();
    expect(manifest.devDependencies["electron-chrome-extensions"]).toBeUndefined();
  });
  test("the library's preload is resolvable from the desktop package (it is registered by path at runtime)", () => {
    const preload = require.resolve("electron-chrome-extensions/preload");
    expect(fs.existsSync(preload)).toBe(true);
  });
  test("the host attaches the library with a directory for the sanitized preload (the noisy upstream never registers alone)", () => {
    const host = fs.readFileSync(path.join(__dirname, "extension-host.js"), "utf8");
    expect(host).toMatch(/attachExtensionSupport\([^)]*preloadDir: this\.rootDir/);
    const compat = fs.readFileSync(path.join(__dirname, "extension-compat.js"), "utf8");
    expect(compat).toContain('if (!options.preloadDir) throw new Error');
  });
  test("no debug logging of native messages is enabled by the app", () => {
    for (const file of ["main.js", "extension-host.js"]) {
      const source = fs.readFileSync(path.join(__dirname, file), "utf8");
      expect(source).not.toMatch(/debug\.enable\(|DEBUG\s*=|process\.env\.DEBUG\s*=/);
    }

    const compat = fs.readFileSync(path.join(__dirname, "extension-compat.js"), "utf8");
    expect(compat.match(/debug\.enable\(/g)).toHaveLength(1);
    expect(compat).toContain('"-electron-chrome-extensions:*"');
    expect(compat).not.toMatch(/DEBUG\s*=|process\.env\.DEBUG\s*=/);
  });
});
