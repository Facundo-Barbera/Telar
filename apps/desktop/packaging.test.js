// WHAT ACTUALLY ENDS UP INSIDE THE .app.
//
// Both invariants here are transcriptions of failures that happened, and both
// share a shape: the packaged app is missing a file, and the symptom names
// something else entirely.
//
// These are cheap structural checks, not a substitute for `--smoke`, which
// boots the real thing. They exist because smoke runs at the END of a ten-minute
// package, and because its failure output ("server did not answer within
// 30000ms") does not say which file was left out.

const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));

describe("every local module main.js requires is packaged with it", () => {
  /**
   * THE FAILURE THIS PREVENTS ALREADY SHIPPED. `window-chrome.js` was added to
   * main.js and never added to `build.files`, so the packaged app threw
   * MODULE_NOT_FOUND on its first line — while the dev checkout, which reads the
   * file straight off disk, worked perfectly. A file list is exactly the kind of
   * thing that stays right for months and then silently stops.
   */
  test("build.files lists every ./relative require in main.js", () => {
    const main = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
    const required = new Set();
    for (const match of main.matchAll(/require\("\.\/([^"]+)"\)/g)) {
      // Extensionless specifiers are the node resolver's `.js` shorthand;
      // `./package.json` is already a filename and must not grow a second one.
      required.add(path.extname(match[1]) ? match[1] : `${match[1]}.js`);
    }
    // The preload is loaded by path rather than required, so it is named here
    // the way main.js names it: through `path.join(__dirname, ...)`.
    for (const match of main.matchAll(/path\.join\(__dirname, "([^"]+\.js)"\)/g)) required.add(match[1]);

    expect(required.size).toBeGreaterThan(0);
    const packaged = new Set(manifest.build.files);
    expect([...required].filter((file) => !packaged.has(file))).toEqual([]);
  });
});

describe("extraResources carries the node_modules its trees need", () => {
  /**
   * ELECTRON-BUILDER DROPS A TOP-LEVEL `node_modules` from an extraResources
   * copy, and says nothing about it. Both trees this app ships have one:
   *
   *   - the Next standalone tree, whose `node_modules/.bun` holds `next` itself;
   *   - the engine bundle, whose `node_modules` holds the Agent SDK, kept
   *     external so `cli-resolution.ts` can read the version it pairs with.
   *
   * The symptom is not "a file is missing". It is `Cannot find module 'next'`
   * from a server.js that is plainly there, or a Claude session that fails at
   * the first turn in an app whose every other surface works. A NESTED
   * node_modules copies fine (engine/dist/playwright-mcp/node_modules did),
   * which is what makes the rule easy to believe you have already satisfied.
   */
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

  /**
   * THE ICON, AS A PNG, WHICH A PACKAGED APP OTHERWISE DOES NOT HAVE.
   * electron-builder CONSUMES build/icon.png to produce Contents/Resources/
   * icon.icns and copies no PNG of its own, so `/api/about/icon` — which is how
   * a paired phone draws the instance it is talking to — had nothing to serve
   * from inside the .app while working perfectly in a dev checkout, where
   * apps/desktop/build is simply a sibling directory. Exactly the shape of the
   * window-chrome.js failure above.
   *
   * `filter` is part of the invariant: this directory also holds the
   * entitlements plists, which have no business in Resources.
   */
  test("the shell's PNG icons are copied where the web tier can serve them", () => {
    const branding = entries.find((entry) => entry.to === "branding");
    expect(branding).toBeDefined();
    expect(branding.from).toBe("build");
    expect(branding.filter).toEqual(["*.png"]);
    expect(fs.existsSync(path.join(__dirname, "build", "icon.png"))).toBe(true);
  });

  test("every companion entry names a real subpath of the tree it repairs", () => {
    // A companion whose `to` does not sit under a tree that is also copied would
    // be a directory nothing looks in — the mistake this rule invites.
    const roots = [...destinations].filter((to) => !to.includes("/"));
    for (const to of destinations) {
      if (!to.includes("/")) continue;
      expect(roots.some((root) => to.startsWith(`${root}/`))).toBe(true);
    }
  });
});

describe("engine children run from the LSUIElement helper, whatever the product is named", () => {
  /**
   * THE DUPLICATE DOCK ICONS SHIPPED. nodeExecPath() hardcoded
   * "Telar Helper.app", but a --dev package names its helper
   * "Telar Dev Helper.app" — so the lookup missed, every child fell back to
   * the Foreground main binary, and each engine child put another dead
   * "Telar Dev" in the Dock. Resolution is now derived from the product name,
   * with a scan fallback; both identities are pinned here against a fake
   * Frameworks layout.
   */
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

  /**
   * BEHAVIOUR, NOT SOURCE. The script is actually spawned: the refusal has to
   * happen before any build step runs. `install-app.sh` now names the
   * destination after the SOURCE bundle, so `--dev --install` lands at
   * "Telar Dev.app" beside the installed Telar; the one remaining way to
   * collide is an explicit --destination that names Telar.app, and that is
   * what must be refused up front.
   */
  test("--dev --install may not be aimed at Telar.app, and is refused before anything is built", () => {
    // 15 s, the bound the engine suite's wait helpers carry, under the 20 s
    // bunfig ceiling. The refusal is immediate on a healthy machine; the budget
    // only bites when the CI Mac mini is loaded, and killing the script then
    // reads as a failed assertion about argument handling (#458).
    const result = spawnSync(
      "bash",
      [script, "--dev", "--install", "--destination", "/Applications/Telar.app"],
      { encoding: "utf8", timeout: 15_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("may not target Telar.app");
    expect(result.stdout).not.toContain("==> build standalone web app");
  });

  /**
   * THE INSTALLER'S HALF OF THE SAME RULE, without a build: install-app.sh
   * derives the destination from the source bundle's name. A fake "Telar
   * Dev.app" with the right executable must resolve to "<dir>/Telar Dev.app",
   * never "<dir>/Telar.app". Spawned with --verified so no smoke runs, against
   * a destination directory that cannot be written, so the script fails at
   * mkdir AFTER printing the resolved path in its own error.
   */
  // The script copies with `ditto`, which only macOS has; the ubuntu unit job
  // skips it the same way dev-update.test.js skips the swap helper.
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
      // And with no --destination at all, the default is named after the source.
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
    // Overrides at package time, never edits: the nightly/beta pipelines read
    // this file and must see the same app they always did.
    expect(manifest.build.appId).toBe("com.telar.desktop");
    expect(manifest.build.productName).toBe("Telar");
    expect(manifest.productName).toBe("Telar");
    expect(manifest.telarDev).toBeUndefined();
  });

  /**
   * THE ARTEFACT, WHEN THERE IS ONE. `package-desktop.sh --dev` takes minutes
   * and needs Electron, so the unit layer does not build it — but once it has
   * been built, the unit layer reads the identity off the real bundle rather
   * than off the script that claims to produce it.
   */
  const built = fs.existsSync(path.join(devApp, "Contents", "Info.plist"));
  const when = built ? test : test.skip;

  when("the built Telar Dev.app carries its own bundle id, name and executable", () => {
    const plist = (key) =>
      spawnSync("plutil", ["-extract", key, "raw", "-o", "-", path.join(devApp, "Contents", "Info.plist")], { encoding: "utf8" }).stdout.trim();
    expect(plist("CFBundleIdentifier")).toBe("com.telar.desktop.dev");
    expect(plist("CFBundleName")).toBe("Telar Dev");
    expect(fs.existsSync(path.join(devApp, "Contents", "MacOS", "Telar Dev"))).toBe(true);
    // Stamped as a dev build, with the dirtiness of its sources recorded.
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
      // Where "Update from Local Checkout" rebuilds from (DEV-005): the
      // checkout that produced this bundle, baked in at package time.
      expect(typeof packaged.telarDevRepo).toBe("string");
      expect(path.isAbsolute(packaged.telarDevRepo)).toBe(true);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("the packaged app can be granted the camera and the microphone", () => {
  /**
   * THE FAILURE THIS PREVENTS IS INVISIBLE IN A DEV CHECKOUT, which is what
   * makes it this file's kind of invariant. A page in Telar's browser asks for
   * the camera; the shell calls `systemPreferences.askForMediaAccess`; on a
   * SIGNED build with no usage string and no device entitlement macOS refuses
   * before any dialog can appear, `askForMediaAccess` answers false, and the
   * page reports NotAllowedError — indistinguishable from a person saying no.
   * That was #422's whole first bullet.
   *
   * BOTH HALVES, OR NEITHER WORKS. The entitlement is what lets a hardened
   * process ask; the Info.plist string is what the dialog says, and macOS
   * refuses to show a dialog it has no sentence for.
   */
  const plist = (name) => fs.readFileSync(path.join(__dirname, "build", name), "utf8");
  const info = manifest.build.mac.extendInfo;

  test("Info.plist carries a usage string for each device, in words a person is asked to agree to", () => {
    for (const key of ["NSCameraUsageDescription", "NSMicrophoneUsageDescription"]) {
      expect(typeof info[key]).toBe("string");
      // Not a placeholder: this string IS the consent dialog's body.
      expect(info[key].length).toBeGreaterThan(40);
      expect(info[key]).toContain("Telar");
    }
    // The one that was already there is untouched — computer use still prompts.
    expect(info.NSAppleEventsUsageDescription).toContain("Computer Use");
  });

  test("the hardened runtime is entitled to both devices, and so are the helpers that open them", () => {
    for (const key of ["com.apple.security.device.camera", "com.apple.security.device.audio-input"]) {
      expect(plist("entitlements.mac.plist")).toContain(`<key>${key}</key>`);
      // The renderer helper is what actually captures; a grant that stops at
      // the main process is a grant the capture never sees.
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
    // A devDependency is pruned from the packaged app; the library must be a
    // real dependency, like electron-updater.
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
    // extension-compat's single debug.enable call is the NEGATION that turns
    // the library's namespaces off; nothing there sets DEBUG.
    const compat = fs.readFileSync(path.join(__dirname, "extension-compat.js"), "utf8");
    expect(compat.match(/debug\.enable\(/g)).toHaveLength(1);
    expect(compat).toContain('"-electron-chrome-extensions:*"');
    expect(compat).not.toMatch(/DEBUG\s*=|process\.env\.DEBUG\s*=/);
  });
});
