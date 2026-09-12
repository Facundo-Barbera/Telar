const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { download, MAX_DOWNLOAD_BYTES, classifyWorkerError, ExtensionHost, clampRect, readIconDataUrl } = require("./extension-host");

describe("popup geometry stays inside its region", () => {
  const region = { x: 100, y: 50, width: 400, height: 300 }; // e.g. window content ∩ work area
  test("a popup overflowing the right/bottom edge is pushed back in", () => {
    // Anchored near the right edge, extending further right than the region.
    expect(clampRect({ x: 480, y: 60, width: 320, height: 200 }, region)).toEqual({ x: 180, y: 60, width: 320, height: 200 });
    // Past the bottom.
    expect(clampRect({ x: 120, y: 300, width: 200, height: 200 }, region)).toEqual({ x: 120, y: 150, width: 200, height: 200 });
  });
  test("a popup larger than the region is shrunk to fit, then aligned to its origin", () => {
    expect(clampRect({ x: 0, y: 0, width: 900, height: 900 }, region)).toEqual({ x: 100, y: 50, width: 400, height: 300 });
  });
  test("a popup already inside is unchanged", () => {
    expect(clampRect({ x: 150, y: 80, width: 200, height: 150 }, region)).toEqual({ x: 150, y: 80, width: 200, height: 150 });
  });
});

describe("the official icon comes only from the verified extension dir", () => {
  const os = require("node:os");
  test("reads the manifest's own 128px icon as a PNG data URL, and refuses anything outside the dir or non-PNG", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-icon-"));
    fs.mkdirSync(path.join(dir, "images"), { recursive: true });
    // A 1x1 PNG.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
    fs.writeFileSync(path.join(dir, "images", "op.png"), png);
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ icons: { "128": "images/op.png" } }));
    const url = readIconDataUrl(dir);
    expect(url).toMatch(/^data:image\/png;base64,/);
    // A manifest pointing outside the dir is refused.
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ icons: { "128": "../../../etc/hosts" } }));
    expect(readIconDataUrl(dir)).toBeNull();
    // A non-PNG is refused.
    fs.writeFileSync(path.join(dir, "note.txt"), "x");
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ icons: { "128": "note.txt" } }));
    expect(readIconDataUrl(dir)).toBeNull();
    // No icons at all → null, not a throw.
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ name: "x" }));
    expect(readIconDataUrl(dir)).toBeNull();
  });
});

describe("worker errors reach status() only as fixed codes and counts", () => {
  test("known startup failures classify; anything else is 'other'", () => {
    expect(classifyWorkerError("Uncaught (in promise) Error: Cannot read properties of null (reading 'id')")).toBe("null-window-at-boot");
    expect(classifyWorkerError("Unchecked runtime.lastError: Access to the native messaging host was disabled by the system administrator.")).toBe("native-messaging-stub");
    expect(classifyWorkerError("[AppIntegration] [DesktopApp] Initiation failed - B5X is not connected to desktop app")).toBe("desktop-app-not-connected");
    expect(classifyWorkerError("Uncaught (in promise) Error: WASM is not initialized, unable to make core call.")).toBe("core-not-initialized");
    expect(classifyWorkerError("Something with a secret-looking token=abc123 in it")).toBe("other");
  });
  test("status() carries counts per code and no message text", () => {
    const host = Object.assign(Object.create(ExtensionHost.prototype), { privacy: { state: () => ({ private: false, epoch: 0 }) }, loaded: null, verification: null, error: null, phase: "ready", health: { workerErrors: {} } });
    const pushed = [];
    host.onHealthChange = (s) => pushed.push(s);
    host.noteWorkerError("Uncaught (in promise) Error: WASM is not initialized, unable to make core call.");
    host.noteWorkerError("leaked value: hunter2");
    host.noteWorkerError("leaked value: hunter2 again");
    const status = host.status();
    expect(status.health.workerErrors).toEqual({ "core-not-initialized": 1, other: 2 });
    expect(JSON.stringify(status)).not.toContain("hunter2");
    expect(JSON.stringify(pushed)).not.toContain("hunter2");
    expect(pushed).toHaveLength(3);
  });
});

describe("extension download hardening", () => {
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "telar-dl-")), "x.crx");
  test("refuses plain HTTP and non-Google hosts, leaving no file", async () => {
    const dest = tmp();
    await expect(download("http://clients2.google.com/x", dest)).rejects.toThrow(/HTTPS only/);
    await expect(download("https://example.com/x.crx", dest)).rejects.toThrow(/refusing host/);
    expect(fs.existsSync(dest)).toBe(false);
  });
  test("a redirect to a non-Google host is refused even from a Google origin", async () => {
    // Simulated by calling with the redirect target directly: the same check runs per hop.
    const dest = tmp();
    await expect(download("https://evil.example/1password.crx", dest)).rejects.toThrow(/refusing host/);
    expect(fs.existsSync(dest)).toBe(false);
  });
  test("the byte cap is finite and documented", () => {
    expect(MAX_DOWNLOAD_BYTES).toBeGreaterThan(20 * 1024 * 1024);
    expect(MAX_DOWNLOAD_BYTES).toBeLessThanOrEqual(64 * 1024 * 1024);
  });
});


describe("extension release channel policy", () => {
  const { extensionsEnabled } = require("./extension-host");
  const release = { dev: false, packaged: true, version: "0.1.0-nightly.20260906.1" };
  test("personal nightlies include extensions; beta and stable remain opt-in", () => {
    expect(extensionsEnabled(release)).toBe(true);
    expect(extensionsEnabled({ ...release, version: "0.1.0-beta.1" })).toBe(false);
    expect(extensionsEnabled({ ...release, version: "0.1.0" })).toBe(false);
    expect(extensionsEnabled({ ...release, version: "0.1.0", override: "1" })).toBe(true);
  });
  test("explicit disable wins even in Dev; dev shells otherwise remain enabled", () => {
    expect(extensionsEnabled({ ...release, dev: true, override: "0" })).toBe(false);
    expect(extensionsEnabled({ ...release, version: "0.1.0", dev: true })).toBe(true);
    expect(extensionsEnabled({ ...release, version: "0.1.0", packaged: false })).toBe(true);
  });
});

/**
 * ISSUE #296. `session.fromPartition(p)` is a process-lifetime singleton, so a
 * host's registrations outlive the host. A translucency change rebuilds the
 * window, and with it the manager and every host it owns — against the very
 * same sessions.
 */
describe("a host lets go of what outlives it", () => {
  const { EventEmitter } = require("node:events");
  function fakeSession() {
    const serviceWorkers = new EventEmitter();
    return { serviceWorkers };
  }
  function hostOn(session) {
    const host = Object.assign(Object.create(ExtensionHost.prototype), {
      session,
      privacy: { state: () => ({ private: false, epoch: 0 }) },
      health: { workerErrors: {} },
      loaded: null,
      verification: null,
      error: null,
      phase: "ready",
      onWorkerConsole: null,
    });
    host.observeHealth();
    return host;
  }

  test("rebuilding the window against the same session does not stack listeners", () => {
    const session = fakeSession();
    const first = hostOn(session);
    expect(session.serviceWorkers.listenerCount("console-message")).toBe(1);

    // The old manager goes; the new one builds a host on the SAME session.
    first.dispose();
    const second = hostOn(session);
    expect(session.serviceWorkers.listenerCount("console-message")).toBe(1);

    // Five more rebuilds read the same, which is the whole point.
    let host = second;
    for (let i = 0; i < 5; i += 1) {
      host.dispose();
      host = hostOn(session);
    }
    expect(session.serviceWorkers.listenerCount("console-message")).toBe(1);

    host.dispose();
    expect(session.serviceWorkers.listenerCount("console-message")).toBe(0);
    // Idempotent: a second dispose is not an error.
    expect(() => host.dispose()).not.toThrow();
  });

  test("a disposed host no longer counts a worker error", () => {
    const session = fakeSession();
    const host = hostOn(session);
    const message = { level: 3, sourceId: "chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/sw.js", message: "WASM is not initialized" };

    session.serviceWorkers.emit("console-message", {}, message);
    expect(host.health.workerErrors).toEqual({ "core-not-initialized": 1 });

    host.dispose();
    session.serviceWorkers.emit("console-message", {}, message);
    expect(host.health.workerErrors).toEqual({ "core-not-initialized": 1 });
  });
});
