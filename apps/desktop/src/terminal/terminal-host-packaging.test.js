const { describe, expect, test } = require("bun:test");
const path = require("node:path");
const { TerminalHost, ensureSpawnHelper, spawnHelperCandidates } = require("./terminal-host");
const { verifyPackagedPty, UNPACKED } = require("../../scripts/after-pack");

describe("node-pty's spawn-helper, which the package ships un-executable", () => {
  const libDir = "/app/node_modules/node-pty/lib";

  test("searches the same places node-pty's own loader does", () => {
    const found = spawnHelperCandidates(libDir, "darwin", "arm64");
    expect(found).toContain("/app/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper");
    expect(found).toContain("/app/node_modules/node-pty/build/Release/spawn-helper");

    expect(found).toContain("/app/node_modules/node-pty/lib/prebuilds/darwin-arm64/spawn-helper");
  });

  test("rewrites an asar path the way node-pty does", () => {
    const found = spawnHelperCandidates("/A/Contents/Resources/app.asar/node_modules/node-pty/lib", "darwin", "arm64");
    expect(found.every((candidate) => !candidate.includes("app.asar/"))).toBe(true);
    expect(found[4]).toContain("app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper");
  });

  test("adds the executable bit and leaves the rest of the mode alone", () => {
    const chmods = [];
    const result = ensureSpawnHelper({
      platform: "darwin",
      arch: "arm64",
      libDir,
      fs: {
        existsSync: (target) => target.endsWith("prebuilds/darwin-arm64/spawn-helper"),
        statSync: () => ({ mode: 0o100644 }),
        chmodSync: (target, mode) => chmods.push([target, mode]),
      },
    });
    expect(result.changed).toBe(true);
    expect(chmods).toHaveLength(1);
    expect(chmods[0][1]).toBe(0o755);
  });

  test("does nothing when the bit is already there", () => {
    const chmods = [];
    const result = ensureSpawnHelper({
      platform: "darwin",
      arch: "arm64",
      libDir,
      fs: {
        existsSync: () => true,
        statSync: () => ({ mode: 0o100755 }),
        chmodSync: (target, mode) => chmods.push([target, mode]),
      },
    });
    expect(result.changed).toBe(false);
    expect(chmods).toEqual([]);
  });

  test("a helper that is not there at all names every place it looked", () => {
    expect(() =>
      ensureSpawnHelper({ platform: "darwin", arch: "arm64", libDir, fs: { existsSync: () => false } }),
    ).toThrow(/posix_spawnp/);
  });

  test("a chmod that cannot be made says what the consequence is", () => {
    expect(() =>
      ensureSpawnHelper({
        platform: "darwin",
        arch: "arm64",
        libDir,
        fs: {
          existsSync: () => true,
          statSync: () => ({ mode: 0o100644 }),
          chmodSync: () => {
            throw new Error("EROFS: read-only file system");
          },
        },
      }),
    ).toThrow(/spawn-helper executable/);
  });

  test("win32 has no helper and is not asked for one", () => {
    expect(ensureSpawnHelper({ platform: "win32" })).toEqual({ path: null, changed: false });
  });
});

describe("what a packaged .app has to contain before a terminal can run", () => {
  const app = "/out/Telar.app";
  const root = path.join(app, UNPACKED, "node_modules", "node-pty");
  const prebuilds = path.join(root, "prebuilds", "darwin-arm64");
  const release = path.join(root, "build", "Release");
  const both = (dir) => [path.join(dir, "pty.node"), path.join(dir, "spawn-helper")];

  const fakeFs = (present, mode = 0o100755, chmods = []) => ({
    existsSync: (target) => present.includes(target),
    statSync: () => ({ mode }),
    chmodSync: (target, next) => chmods.push([target, next]),
  });

  test("refuses an app whose addon is sealed inside the asar", () => {
    expect(() => verifyPackagedPty(app, { platform: "darwin", arch: "arm64", fs: fakeFs([]) })).toThrow(/asarUnpack/);
  });

  test("refuses an app with the addon but no spawn-helper beside it", () => {
    const fs = fakeFs([path.join(prebuilds, "pty.node")]);
    expect(() => verifyPackagedPty(app, { platform: "darwin", arch: "arm64", fs })).toThrow(/spawn-helper/);
  });

  test("sets the executable bit on the packaged helper", () => {
    const chmods = [];
    const fs = fakeFs(both(prebuilds), 0o100644, chmods);
    const found = verifyPackagedPty(app, { platform: "darwin", arch: "arm64", fs });
    expect(found.chmodded).toBe(true);
    expect(chmods[0][0]).toBe(path.join(prebuilds, "spawn-helper"));
    expect(chmods[0][1]).toBe(0o755);
  });

  test("passes a well-formed app without touching it", () => {
    const chmods = [];
    const fs = fakeFs(both(prebuilds), 0o100755, chmods);
    expect(verifyPackagedPty(app, { platform: "darwin", arch: "arm64", fs }).chmodded).toBe(false);
    expect(chmods).toEqual([]);
  });

  test("checks build/Release first, because that is what node-pty loads first", () => {
    const chmods = [];
    const fs = fakeFs([...both(release), ...both(prebuilds)], 0o100644, chmods);
    const found = verifyPackagedPty(app, { platform: "darwin", arch: "arm64", fs });
    expect(found.from).toBe("build/Release");
    expect(found.addon).toBe(path.join(release, "pty.node"));

    expect(chmods).toHaveLength(1);
    expect(chmods[0][0]).toBe(path.join(release, "spawn-helper"));
  });

  test("falls back to the shipped prebuild when nothing was rebuilt", () => {
    const found = verifyPackagedPty(app, { platform: "darwin", arch: "arm64", fs: fakeFs(both(prebuilds)) });
    expect(found.from).toBe("prebuilds/darwin-arm64");
  });
});

describe("the module keeps itself loadable where the native one is not", () => {
  test("requiring the host did not pull in a native addon", () => {
    expect(typeof TerminalHost).toBe("function");
    expect(Object.keys(require.cache).some((key) => key.includes(`${path.sep}node-pty${path.sep}`))).toBe(false);
  });

  test("constructing a host does not load one either — only spawning would", () => {
    const host = new TerminalHost({ platform: "linux", version: "1.0.0" });
    expect(host.list()).toEqual([]);
    expect(Object.keys(require.cache).some((key) => key.includes(`${path.sep}node-pty${path.sep}`))).toBe(false);
  });
});
