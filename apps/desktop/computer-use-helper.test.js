// THE BUNDLED COMPUTER-USE HELPER: how it is built, and what must be true of the
// package that carries it. The build is exercised end to end against a FAKE
// release archive (a stand-in binary, never cua's), so nothing here downloads
// or runs cua-driver.

const { describe, expect, test, beforeAll } = require("bun:test");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
const pin = JSON.parse(fs.readFileSync(path.join(__dirname, "computer-use-helper.json"), "utf8"));
const script = path.join(__dirname, "..", "..", "scripts", "computer-use-helper.mjs");
let helper;
beforeAll(async () => {
  helper = await import(script);
});

describe("the pin", () => {
  test("names a stable cua-driver release by tag, asset URL and sha256", () => {
    expect(pin.tag).toMatch(/^cua-driver-rs-v\d+\.\d+\.\d+$/);
    expect(pin.tag).toBe(`cua-driver-rs-v${pin.version}`);
    expect(pin.url).toBe(`https://github.com/trycua/cua/releases/download/${pin.tag}/${pin.asset}`);
    expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the helper's identity is Telar's, never cua's, and attributes cua in its display name", () => {
    // Changing it orphans every grant a person gave the helper; the engine's
    // tccutil reset names the same id.
    expect(pin.bundleId).toBe("com.telar.desktop.computer-use");
    expect(pin.bundleId.startsWith(`${manifest.build.appId}.`)).toBe(true);
    expect(pin.displayName).toContain("cua");
    const engine = fs.readFileSync(path.join(__dirname, "..", "engine", "src", "computer-use.ts"), "utf8");
    expect(engine).toContain(`"${pin.bundleId}"`);
  });
});

describe("electron-builder carries the helper without re-signing it", () => {
  test("vendor/computer-use lands in Contents/Helpers, and signing skips it", () => {
    expect(manifest.build.mac.extraFiles).toContainEqual({ from: "vendor/computer-use", to: "Helpers" });
    expect(manifest.build.mac.signIgnore).toContain("/Contents/Helpers/");
  });

  test("main.js reads the pin, so the pin ships", () => {
    expect(manifest.build.files).toContain("computer-use-helper.json");
  });

  test("the helper is signed with cua's two public entitlements and not Telar's inherit plist", () => {
    const plist = fs.readFileSync(path.join(__dirname, "build", "computer-use", "entitlements.plist"), "utf8");
    const keys = [...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]).sort();
    expect(keys).toEqual(["com.apple.security.automation.apple-events", "com.apple.security.device.screen-capture"]);
  });

  test("build-desktop.sh builds it before packaging and requires it in the artefact", () => {
    const build = fs.readFileSync(path.join(__dirname, "..", "..", "scripts", "build-desktop.sh"), "utf8");
    const helperAt = build.indexOf("scripts/computer-use-helper.mjs");
    expect(helperAt).toBeGreaterThan(0);
    expect(helperAt).toBeLessThan(build.indexOf("bunx electron-builder"));
    expect(build).toContain("export TELAR_REQUIRE_COMPUTER_USE_HELPER=1");
  });
});

describe("the pure pieces", () => {
  test("a checksum mismatch is refused", () => {
    const data = Buffer.from("not cua");
    expect(() => helper.assertChecksum(data, "0".repeat(64), "archive")).toThrow(/does not match the pinned/);
    expect(() => helper.assertChecksum(data, helper.sha256(data), "archive")).not.toThrow();
  });

  test("the plist rewrite sets Telar's id and name", () => {
    const edits = Object.fromEntries(helper.plistEdits(pin).map(([key, , value]) => [key, value]));
    expect(edits.CFBundleIdentifier).toBe(pin.bundleId);
    expect(edits.CFBundleName).toBe(pin.appName);
    expect(edits.CFBundleDisplayName).toBe(pin.displayName);
  });

  test("codesign: hardened runtime always, timestamp and keychain only with a real identity", () => {
    const real = helper.codesignArgs({ identity: "ABC", keychain: "/k", entitlements: "/e", target: "/t" });
    expect(real).toEqual(["--force", "--options", "runtime", "--timestamp", "--keychain", "/k", "--entitlements", "/e", "--sign", "ABC", "/t"]);
    const adhoc = helper.codesignArgs({ identity: "-", keychain: "/k", entitlements: "/e", target: "/t" });
    expect(adhoc).toEqual(["--force", "--options", "runtime", "--entitlements", "/e", "--sign", "-", "/t"]);
  });

  test("only a Developer ID Application identity is picked", () => {
    const out = [
      '  1) 1111111111111111111111111111111111111111 "Apple Development: someone (X)"',
      '  2) 2222222222222222222222222222222222222222 "Developer ID Application: Telar (TEAM123)"',
      "     2 valid identities found",
    ].join("\n");
    expect(helper.pickDeveloperId(out)).toBe("2222222222222222222222222222222222222222");
    expect(helper.pickDeveloperId("0 valid identities found")).toBeUndefined();
  });
});

describe.skipIf(process.platform !== "darwin")("building from a (fake) release archive", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "telar-cu-test-"));

  const fakeRelease = () => {
    const root = path.join(scratch, "release", "cua-driver-rs-9.9.9-darwin-universal");
    const contents = path.join(root, "CuaDriver.app", "Contents");
    fs.mkdirSync(path.join(contents, "MacOS"), { recursive: true });
    fs.mkdirSync(path.join(contents, "_CodeSignature"), { recursive: true });
    for (const name of ["cua-driver", "cua-cursor-theme"]) fs.copyFileSync("/usr/bin/true", path.join(contents, "MacOS", name));
    fs.writeFileSync(path.join(contents, "embedded.provisionprofile"), "cua's");
    fs.writeFileSync(
      path.join(contents, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.trycua.driver</string>
<key>CFBundleName</key><string>Cua Driver</string>
<key>CFBundleExecutable</key><string>cua-driver</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`,
    );
    const archive = path.join(scratch, "fake.tar.gz");
    expect(spawnSync("tar", ["-czf", archive, "-C", path.join(scratch, "release"), "."]).status).toBe(0);
    const sha = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
    const pinFile = path.join(scratch, "pin.json");
    fs.writeFileSync(pinFile, JSON.stringify({ ...pin, sha256: sha }));
    return { archive, pinFile };
  };

  test("produces the rebranded, re-signed helper with cua's notice and none of cua's signing leftovers", async () => {
    const { archive, pinFile } = fakeRelease();
    const out = path.join(scratch, "out");
    const built = await helper.buildHelper({ pinFile, out, sign: "adhoc", tarball: archive });
    const app = path.join(out, `${pin.appName}.app`);
    expect(built.app).toBe(app);

    const plist = (key) => spawnSync("plutil", ["-extract", key, "raw", "-o", "-", path.join(app, "Contents", "Info.plist")], { encoding: "utf8" }).stdout.trim();
    expect(plist("CFBundleIdentifier")).toBe(pin.bundleId);
    expect(plist("CFBundleName")).toBe(pin.appName);
    expect(fs.existsSync(path.join(app, "Contents", "embedded.provisionprofile"))).toBe(false);
    expect(fs.existsSync(path.join(app, "Contents", "Resources", "LICENSE-cua.txt"))).toBe(true);

    const sig = spawnSync("codesign", ["-dv", "--entitlements", "-", app], { encoding: "utf8" });
    const described = sig.stdout + sig.stderr;
    expect(described).toContain(`Identifier=${pin.bundleId}`);
    expect(described).toMatch(/flags=0x[0-9a-f]+\([^)]*runtime/);
    expect(described).toContain("com.apple.security.device.screen-capture");
    expect(spawnSync("codesign", ["--verify", "--strict", app]).status).toBe(0);

    // And the after-pack check accepts it where electron-builder puts it.
    const { verifyPackagedComputerUse } = require("./after-pack.js");
    const telar = path.join(scratch, "Telar.app");
    fs.mkdirSync(path.join(telar, "Contents", "Helpers"), { recursive: true });
    expect(spawnSync("ditto", [app, path.join(telar, "Contents", "Helpers", `${pin.appName}.app`)]).status).toBe(0);
    expect(verifyPackagedComputerUse(telar, pin, { required: true })?.binary).toContain("/MacOS/cua-driver");
  });

  test("an archive that does not match the pinned sha256 builds nothing", async () => {
    const { archive } = fakeRelease();
    const out = path.join(scratch, "refused");
    await expect(helper.buildHelper({ out, sign: "adhoc", tarball: archive })).rejects.toThrow(/does not match the pinned/);
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe("after-pack: the helper is required in a release and optional in a local package", () => {
  const { verifyPackagedComputerUse } = require("./after-pack.js");
  const empty = () => fs.mkdtempSync(path.join(os.tmpdir(), "telar-no-helper-"));

  test("absent and required fails the package; absent and optional passes quietly", () => {
    expect(() => verifyPackagedComputerUse(empty(), pin, { required: true })).toThrow(/no computer-use helper/);
    expect(verifyPackagedComputerUse(empty(), pin, { required: false })).toBeNull();
  });

  test("a helper under any other bundle id is refused", () => {
    const app = empty();
    const contents = path.join(app, "Contents", "Helpers", `${pin.appName}.app`, "Contents");
    fs.mkdirSync(contents, { recursive: true });
    fs.writeFileSync(path.join(contents, "Info.plist"), "<key>CFBundleIdentifier</key><string>com.trycua.driver</string>");
    expect(() => verifyPackagedComputerUse(app, pin)).toThrow(/com\.trycua\.driver/);
  });
});
