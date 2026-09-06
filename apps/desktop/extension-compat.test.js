const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { verifyCrx, mainWorldShims, sanitizePreloadSource, sanitizedPreloadPath, disableLibraryDebug } = require("./extension-compat");

describe("the library preload is sanitized before it runs", () => {
  const upstream = fs.readFileSync(require.resolve("electron-chrome-extensions/preload"), "utf8");
  test("upstream ships exactly three unconditional payload logs, and the sanitized copy has none", () => {
    expect(upstream.match(/if \(true\)/g)).toHaveLength(3);
    expect(upstream.match(/console\.log\(/g)).toHaveLength(3);
    const clean = sanitizePreloadSource(upstream);
    expect(clean).not.toMatch(/if \(true\)/);
    expect(clean).not.toMatch(/console\.(log|info|debug)\(/);
    // Only the three blocks were removed; the rest is byte-identical.
    expect(upstream.length - clean.length).toBe(3 * "      if (true) {\n      }\n".length + "        console.log(name, \"(result)\", ...args);\n".length + "        console.log(fnName, args);\n".length + "        console.log(fnName, \"(result)\", result);\n".length);
    expect(clean).toContain("crx-msg"); // the API bridge itself is intact
    expect(clean).toContain("console.error(e)"); // errors, not payloads, still surface
  });
  test("a changed upstream fails loudly instead of being redacted by guess", () => {
    expect(() => sanitizePreloadSource(upstream.replace("console.log(fnName, args)", "console.log(fnName, args, 1)"))).toThrow(/not found/);
    expect(() => sanitizePreloadSource(upstream + "\nif (true) { x(); }")).toThrow(/if \(true\)/);
    expect(() => sanitizePreloadSource(upstream + "\nconsole.info(1)")).toThrow(/console\.log\/info\/debug/);
  });
  test("the file written for registration is the sanitized one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-preload-"));
    const file = sanitizedPreloadPath(dir);
    expect(fs.readFileSync(file, "utf8")).toBe(sanitizePreloadSource(upstream));
  });
  test("the library's debug namespaces are off even when DEBUG asks for everything", () => {
    const { createRequire } = require("node:module");
    const debug = createRequire(require.resolve("electron-chrome-extensions"))("debug");
    debug.enable("*");
    expect(debug("electron-chrome-extensions:nativeMessaging").enabled).toBe(true);
    disableLibraryDebug();
    expect(debug("electron-chrome-extensions:nativeMessaging").enabled).toBe(false);
    expect(debug("electron-chrome-extensions:router").enabled).toBe(false);
    expect(debug("something-else").enabled).toBe(true); // nothing else touched
    debug.disable();
  });
});

const CRX = "/tmp/telar-work-surface/1password-8.12.34.34.crx";
const ID = "aeblfdkhhhdcdjpifhhbdiojplfjncoa";
const have = fs.existsSync(CRX);

describe("CRX3 verification", () => {
  test.skipIf(!have)("the official package verifies against the pinned id and yields the publisher key", () => {
    const r = verifyCrx(fs.readFileSync(CRX), ID);
    expect(r.id).toBe(ID);
    expect(r.proofs.some((p) => p.id === ID && p.algorithm === "sha256_with_rsa")).toBe(true);
    expect(typeof r.publisherKey).toBe("string");
  });
  test.skipIf(!have)("a package signed for another id is refused even when its proofs are valid", () => {
    expect(() => verifyCrx(fs.readFileSync(CRX), "lfoeajgcchlidpicbabpmckkejpckcfb")).toThrow(/signed for/);
  });
  test.skipIf(!have)("a single flipped byte in the zip fails the proof", () => {
    const buf = Buffer.from(fs.readFileSync(CRX));
    buf[buf.length - 100] ^= 0xff;
    expect(() => verifyCrx(buf, ID)).toThrow(/failed to verify/);
  });
  test("malformed input is refused, never parsed past its bounds", () => {
    expect(() => verifyCrx(Buffer.from("Cr24"), ID)).toThrow(/bad magic/);
    const bad = Buffer.alloc(12);
    bad.write("Cr24", 0, "ascii");
    bad.writeUInt32LE(3, 4);
    bad.writeUInt32LE(0xffffffff, 8);
    expect(() => verifyCrx(bad, ID)).toThrow(/runs past/);
    // A varint that never terminates.
    const ten = Buffer.concat([bad.subarray(0, 8), Buffer.from([11, 0, 0, 0]), Buffer.alloc(11, 0xff)]);
    expect(() => verifyCrx(ten, ID)).toThrow(/varint/);
  });
});

describe("main-world shims", () => {
  function world(runtimeId) {
    const chrome = { runtime: { id: runtimeId }, tabs: { query() {} }, storage: { local: { get() {} } }, downloads: { download() {} } };
    const g = { chrome, browser: { commands: {} } };
    return { g, chrome };
  }
  const run = (g) => {
    const saved = { chrome: globalThis.chrome, browser: globalThis.browser, flag: globalThis.__telarCrxShims };
    Object.assign(globalThis, { chrome: g.chrome, browser: g.browser, __telarCrxShims: undefined });
    try {
      mainWorldShims([ID]);
      return { chrome: globalThis.chrome, browser: globalThis.browser, flag: globalThis.__telarCrxShims };
    } finally {
      Object.assign(globalThis, saved);
    }
  };
  test("apply only for the pinned extension id", () => {
    const { g } = world("someotherextensionidxxxxxxxxxxxx");
    expect(run(g).flag).toBeUndefined();
    const { g: mine } = world(ID);
    expect(run(mine).flag).toBe(true);
  });
  test("privacy settings are not-controllable and writes are refused, not faked", async () => {
    const { g } = world(ID);
    const { chrome } = run(g);
    const setting = chrome.privacy.services.passwordSavingEnabled;
    await expect(setting.get({})).resolves.toEqual({ value: false, levelOfControl: "not_controllable" });
    await expect(setting.set({ value: true })).rejects.toThrow(/not controllable/);
    await expect(chrome.offscreen.createDocument({})).rejects.toThrow(/not supported/);
    await expect(chrome.tabs.captureVisibleTab({})).rejects.toThrow(/not available/);
  });
  test("event surfaces register listeners; browser alias falls through per member", () => {
    const { g } = world(ID);
    const { chrome, browser } = run(g);
    const fn = () => {};
    chrome.webRequest.onBeforeRedirect.addListener(fn);
    expect(chrome.webRequest.onBeforeRedirect.hasListener(fn)).toBe(true);
    expect(typeof browser.commands.onCommand).toBe("undefined"); // the library adds this; we do not invent it
    expect(browser.tabs).toBe(chrome.tabs);
    expect(typeof browser.storage.local.onChanged.addListener).toBe("function");
  });
});
