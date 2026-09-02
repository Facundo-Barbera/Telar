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
