// The PRODUCTION discovery and launch path — no mock of the module under
// test. `exists` and `run` are injected so the suite neither depends on which
// editors this machine has nor actually launches one.
const { describe, expect, test } = require("bun:test");
const { discoverOpeners, openWith, openersWithIcons, openerIconDataUrl, bundleIconFile, bundleIcon, searchRoots, FINDER_BUNDLE, KNOWN_EDITORS } = require("./workspace-openers");

const roots = ["/Applications", "/Users/x/Applications", "/System/Applications"];

describe("discovering installed openers", () => {
  test("lists only what exists, in the curated order", () => {
    const installed = new Set(["/Applications/Zed.app", "/Applications/Visual Studio Code.app"]);
    const found = discoverOpeners({ roots, exists: (candidate) => installed.has(candidate) });
    expect(found.map((entry) => entry.id)).toEqual(["vscode", "zed"]);
    expect(found[0]).toEqual({ id: "vscode", label: "Visual Studio Code", icon: "vscode", path: "/Applications/Visual Studio Code.app" });
  });

  test("a machine with none installed answers an empty list, not an error", () => {
    expect(discoverOpeners({ roots, exists: () => false })).toEqual([]);
  });

  test("a user-local install is found too", () => {
    const found = discoverOpeners({ roots, exists: (candidate) => candidate === "/Users/x/Applications/Cursor.app" });
    expect(found).toEqual([{ id: "cursor", label: "Cursor", icon: "cursor", path: "/Users/x/Applications/Cursor.app" }]);
  });

  test("an app we carry no mark for reports NO icon key rather than an empty one", () => {
    // The renderer's fallback is keyed on absence. A `icon: ""` or `icon: null`
    // would be a second way to say the same thing, and the two drift.
    const found = discoverOpeners({ roots, exists: (candidate) => candidate === "/Applications/TextMate.app" });
    expect(found).toEqual([{ id: "textmate", label: "TextMate", path: "/Applications/TextMate.app" }]);
    expect("icon" in found[0]).toBe(false);
  });

  test("every icon id names a real app in the table, and none is blank", () => {
    for (const editor of KNOWN_EDITORS) {
      if (!("icon" in editor)) continue;
      expect(typeof editor.icon).toBe("string");
      expect(editor.icon.length).toBeGreaterThan(0);
    }
  });

  test("an app is listed once even when several bundle names match", () => {
    const found = discoverOpeners({ roots, exists: (candidate) => candidate.includes("IntelliJ IDEA") });
    expect(found.filter((entry) => entry.id === "intellij")).toHaveLength(1);
  });

  test("every known editor has a distinct id and at least one bundle", () => {
    const ids = KNOWN_EDITORS.map((editor) => editor.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const editor of KNOWN_EDITORS) expect(editor.bundles.length).toBeGreaterThan(0);
  });

  test("the default roots are the standard install locations", () => {
    expect(searchRoots("/Users/x")).toEqual(["/Applications", "/Users/x/Applications", "/System/Applications"]);
  });
});

// The REAL icons (#398). `getFileIcon` is injected — the suite neither needs an
// Electron app object nor cares which editors this machine has.
describe("reading each app's own icon", () => {
  /** A NativeImage stand-in: the only shape the module uses is `toPNG()`. */
  const image = (bytes) => ({ toPNG: () => Buffer.from(bytes) });
  const stub = (answer = (bundlePath) => image([bundlePath.length])) => {
    const asked = [];
    return {
      asked,
      getFileIcon: (bundlePath, options) => {
        asked.push({ bundlePath, options });
        return Promise.resolve(answer(bundlePath));
      },
    };
  };
  const openers = [
    { id: "zed", label: "Zed", icon: "zed", path: "/Applications/Zed.app" },
    { id: "textmate", label: "TextMate", path: "/Applications/TextMate.app" },
  ];

  test("each opener gains a PNG data URL, and the 32px size is what is asked for", async () => {
    const { asked, getFileIcon } = stub(() => image([137, 80, 78, 71]));
    const answer = await openersWithIcons({ openers, getFileIcon, cache: new Map(), exists: () => false });
    expect(answer.openers.map((entry) => entry.iconDataUrl)).toEqual(["data:image/png;base64,iVBORw==", "data:image/png;base64,iVBORw=="]);
    expect(asked.map((call) => call.options)).toEqual([{ size: "normal" }, { size: "normal" }]);
  });

  test("the bitmap is ADDED to the row rather than replacing what discovery found", async () => {
    const { getFileIcon } = stub();
    const answer = await openersWithIcons({ openers, getFileIcon, cache: new Map(), exists: () => false });
    expect(answer.openers[0]).toMatchObject({ id: "zed", label: "Zed", icon: "zed", path: "/Applications/Zed.app" });
    // An app we carry no vector mark for still reports no `icon` key — the
    // bitmap is a second answer to the same question, not a replacement for it.
    expect("icon" in answer.openers[1]).toBe(false);
    expect(answer.openers[1].iconDataUrl).toStartWith("data:image/png;base64,");
  });

  test("Finder's own icon rides along for the reveal row the renderer draws", async () => {
    const { asked, getFileIcon } = stub();
    const answer = await openersWithIcons({ openers: [], getFileIcon, cache: new Map(), exists: (path) => path === FINDER_BUNDLE });
    expect(asked.map((call) => call.bundlePath)).toEqual([FINDER_BUNDLE]);
    expect(answer.revealIconDataUrl).toStartWith("data:image/png;base64,");
  });

  test("a Mac without that bundle simply reports no reveal icon", async () => {
    const { getFileIcon } = stub();
    const answer = await openersWithIcons({ openers: [], getFileIcon, cache: new Map(), exists: () => false });
    expect("revealIconDataUrl" in answer).toBe(false);
  });

  test("one ask per bundle, however many times the menu is opened", async () => {
    const cache = new Map();
    const { asked, getFileIcon } = stub();
    await openersWithIcons({ openers, getFileIcon, cache, exists: () => false });
    await openersWithIcons({ openers, getFileIcon, cache, exists: () => false });
    await openersWithIcons({ openers, getFileIcon, cache, exists: () => false });
    expect(asked).toHaveLength(openers.length);
  });

  test("an unreadable icon costs that ONE row its bitmap, never the whole menu", async () => {
    const { getFileIcon } = stub((bundlePath) => (bundlePath.includes("Zed") ? Promise.reject(new Error("gone")) : image([1])));
    const answer = await openersWithIcons({ openers, getFileIcon, cache: new Map(), exists: () => false });
    expect(answer.openers[0].iconDataUrl).toBeUndefined();
    expect(answer.openers[0].icon).toBe("zed");
    expect(answer.openers[1].iconDataUrl).toStartWith("data:image/png;base64,");
  });

  test("an empty buffer is a MISS, not a zero-byte data URL", async () => {
    const { getFileIcon } = stub(() => image([]));
    const answer = await openersWithIcons({ openers: [openers[0]], getFileIcon, cache: new Map(), exists: () => false });
    expect(answer.openers[0].iconDataUrl).toBeUndefined();
  });

  test("an image that decoded nothing is a MISS, so the vector mark stays", async () => {
    const { getFileIcon } = stub(() => ({ isEmpty: () => true, toPNG: () => Buffer.from([1, 2, 3]) }));
    const answer = await openersWithIcons({ openers: [openers[0]], getFileIcon, cache: new Map(), exists: () => false });
    expect(answer.openers[0].iconDataUrl).toBeUndefined();
  });

  test("a miss is NOT remembered — the next open asks again", async () => {
    const cache = new Map();
    let fail = true;
    const asked = [];
    const getFileIcon = (bundlePath) => {
      asked.push(bundlePath);
      return fail ? Promise.reject(new Error("gone")) : Promise.resolve(image([1]));
    };
    expect(await openerIconDataUrl({ bundlePath: "/Applications/Zed.app", getFileIcon, cache })).toBeUndefined();
    fail = false;
    expect(await openerIconDataUrl({ bundlePath: "/Applications/Zed.app", getFileIcon, cache })).toStartWith("data:image/png;base64,");
    expect(asked).toHaveLength(2);
  });

  test("a shell that cannot produce bitmaps answers the plain list, not an error", async () => {
    expect(await openersWithIcons({ openers, exists: () => false })).toEqual({ openers });
  });
});

describe("launching", () => {
  const capture = () => {
    const calls = [];
    const run = (file, args, _options, done) => {
      calls.push({ file, args });
      done(null);
    };
    return { calls, run };
  };

  test("a named app goes through /usr/bin/open with an ARGV ARRAY — never a command string", async () => {
    const { calls, run } = capture();
    const result = await openWith({ target: "/Users/x/my code", appPath: "/Applications/Zed.app", run });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([{ file: "/usr/bin/open", args: ["-a", "/Applications/Zed.app", "/Users/x/my code"] }]);
  });

  test("a folder name with shell metacharacters stays ONE argument", async () => {
    const nasty = '/Users/x/we;rm -rf ~/"quoted" $(whoami)';
    const { calls, run } = capture();
    await openWith({ target: nasty, appPath: "/Applications/Cursor.app", run });
    // Exactly three argv entries, the last one the path verbatim.
    expect(calls[0].args).toHaveLength(3);
    expect(calls[0].args[2]).toBe(nasty);
  });

  test("no app named means the system default, and the path is still an argument", async () => {
    const { calls, run } = capture();
    await openWith({ target: "/Users/x/code", run });
    expect(calls).toEqual([{ file: "/usr/bin/open", args: ["/Users/x/code"] }]);
  });

  test("a launch failure resolves as an answer rather than throwing", async () => {
    const run = (_file, _args, _options, done) => done(new Error("no such app"));
    const result = await openWith({ target: "/Users/x/code", appPath: "/Applications/Gone.app", run });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no such app");
  });
});

// The bundle's OWN .icns, not `app.getFileIcon` (which answers a generic glyph
// for every .app on macOS — the blank grey squares of the first #398 build).
describe("reading the bundle's own icon file", () => {
  const run = (answers) => (_bin, args, _opts, cb) => {
    const plist = args[args.length - 1];
    const answer = answers[plist];
    if (answer === undefined) return cb(new Error("no such key"), "");
    cb(null, answer + "\n");
  };

  test("CFBundleIconFile with and without the extension both resolve to Contents/Resources", async () => {
    const files = new Set([
      "/Applications/Xcode.app/Contents/Info.plist",
      "/Applications/Xcode.app/Contents/Resources/Xcode.icns",
      "/Applications/Code.app/Contents/Info.plist",
      "/Applications/Code.app/Contents/Resources/Code.icns",
    ]);
    const exists = (candidate) => files.has(candidate);
    const answers = { "/Applications/Xcode.app/Contents/Info.plist": "Xcode", "/Applications/Code.app/Contents/Info.plist": "Code.icns" };
    expect(await bundleIconFile("/Applications/Xcode.app", { run: run(answers), exists })).toBe("/Applications/Xcode.app/Contents/Resources/Xcode.icns");
    expect(await bundleIconFile("/Applications/Code.app", { run: run(answers), exists })).toBe("/Applications/Code.app/Contents/Resources/Code.icns");
  });

  test("a bundle that names no icon, or whose file is missing, answers undefined", async () => {
    const exists = (candidate) => candidate.endsWith("Info.plist");
    expect(await bundleIconFile("/Applications/Bare.app", { run: run({}), exists })).toBeUndefined();
    expect(await bundleIconFile("/Applications/Lost.app", { run: run({ "/Applications/Lost.app/Contents/Info.plist": "Lost" }), exists })).toBeUndefined();
    expect(await bundleIconFile("/Applications/Gone.app", { run: run({}), exists: () => false })).toBeUndefined();
  });

  test("bundleIcon converts the file with sips at the requested square and cleans up", async () => {
    const calls = [];
    const removed = [];
    const run = (bin, args, _opts, cb) => { calls.push({ bin, args }); cb(null); };
    const image = await bundleIcon("/Applications/Xcode.app", {
      run,
      iconFile: async () => "/Applications/Xcode.app/Contents/Resources/Xcode.icns",
      readFile: async () => Buffer.from([137, 80, 78, 71]),
      unlink: async (file) => { removed.push(file); },
      tmpDir: () => "/tmp",
    });
    expect(image.isEmpty()).toBe(false);
    expect(image.toPNG().length).toBe(4);
    expect(calls).toHaveLength(1);
    expect(calls[0].bin).toBe("/usr/bin/sips");
    expect(calls[0].args.slice(0, 5)).toEqual(["-s", "format", "png", "-Z", "64"]);
    expect(calls[0].args[5]).toBe("/Applications/Xcode.app/Contents/Resources/Xcode.icns");
    expect(calls[0].args[6]).toBe("--out");
    expect(calls[0].args[7]).toStartWith("/tmp/telar-icon-");
    expect(removed).toEqual([calls[0].args[7]]);
  });

  test("a sips failure, an unreadable output, or no icon file is undefined — and the temp file still goes", async () => {
    const removed = [];
    const unlink = async (file) => { removed.push(file); };
    const failing = (_b, _a, _o, cb) => cb(new Error("sips: no such file"));
    expect(await bundleIcon("/Applications/X.app", { run: failing, iconFile: async () => "/x.icns", unlink, tmpDir: () => "/tmp" })).toBeUndefined();
    const ok = (_b, _a, _o, cb) => cb(null);
    expect(await bundleIcon("/Applications/X.app", { run: ok, iconFile: async () => "/x.icns", readFile: async () => { throw new Error("gone"); }, unlink, tmpDir: () => "/tmp" })).toBeUndefined();
    expect(await bundleIcon("/Applications/X.app", { run: ok, iconFile: async () => undefined, unlink })).toBeUndefined();
    expect(removed).toHaveLength(2);
  });
});
