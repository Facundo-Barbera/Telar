// Issue #35: links leave for the user's default browser, and the integrated
// browser keeps rendering in-app. The policy is pure and tested directly; the
// Electron wiring in main.js (which cannot be required without an Electron
// process) is held to source contracts, the same idiom as the other main.js
// tests in browser-manager.test.js.
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { describe, expect, test } = require("bun:test");

const { createExternalLinkPolicy, externalOpenTarget } = require("./browser-manager");

const APP_URL = "http://127.0.0.1:42731/";

function fixedClock(start = 1_000) {
  const clock = { at: start, now: () => clock.at };
  return clock;
}

describe("createExternalLinkPolicy", () => {
  test("keeps Telar's own UI in-app", () => {
    const policy = createExternalLinkPolicy({ appUrl: APP_URL });

    expect(policy.decide("http://127.0.0.1:42731/settings")).toEqual({
      action: "allow",
      openExternal: null,
    });
    // A blank surface the renderer navigates itself; the navigation that
    // follows comes back through the same policy.
    expect(policy.decide("about:blank")).toEqual({ action: "allow", openExternal: null });
  });

  test("sends every other web link to the system browser instead of an in-app window", () => {
    const policy = createExternalLinkPolicy({ appUrl: APP_URL });

    expect(policy.decide("https://github.com/login/oauth/authorize?client_id=x")).toEqual({
      action: "deny",
      openExternal: "https://github.com/login/oauth/authorize?client_id=x",
    });
    // A different port on loopback is a different origin, and is not Telar.
    expect(policy.decide("http://127.0.0.1:5173/")).toEqual({
      action: "deny",
      openExternal: "http://127.0.0.1:5173/",
    });
  });

  test("never hands a non-web scheme to the OS", () => {
    const policy = createExternalLinkPolicy({ appUrl: APP_URL });

    for (const target of [
      "file:///etc/passwd",
      "smb://fileserver/share",
      "javascript:alert(1)",
      "mailto:someone@example.com",
      "telar-not-a-scheme",
      "",
      undefined,
    ]) {
      expect(policy.decide(target)).toEqual({ action: "deny", openExternal: null });
    }
  });

  test("opens one browser tab when a denied popup falls back to same-window navigation", () => {
    const clock = fixedClock();
    const policy = createExternalLinkPolicy({ appUrl: APP_URL, now: clock.now, dedupeMs: 2_000 });
    const authorize = "https://accounts.example.com/authorize";

    // window.open -> denied, handed to the shell; the renderer sees null and
    // assigns location.href, which arrives as will-navigate.
    expect(policy.decide(authorize).openExternal).toBe(authorize);
    clock.at += 30;
    // Reported, not silently dropped — the caller logs this, because a
    // suppressed hand-off is otherwise indistinguishable from a dead link.
    expect(policy.decide(authorize)).toEqual({
      action: "deny",
      openExternal: null,
      duplicateOf: authorize,
    });

    // Suppression is a burst window, not a permanent block: a later click on
    // the same link still opens.
    clock.at += 2_000;
    expect(policy.decide(authorize).openExternal).toBe(authorize);
  });

  test("each surface gets its own dedupe window", () => {
    // Two windows share nothing: main.js builds a policy per webContents
    // precisely so one window's recent hand-off cannot swallow another's first.
    const clock = fixedClock();
    const build = () => createExternalLinkPolicy({ appUrl: APP_URL, now: clock.now });
    const authorize = "https://accounts.example.com/authorize";

    expect(build().decide(authorize).openExternal).toBe(authorize);
    clock.at += 30;
    expect(build().decide(authorize).openExternal).toBe(authorize);
  });

  test("refuses to build a policy that cannot recognise Telar's own UI", () => {
    // AD-11: with no usable origin the policy would send the app's own pages to
    // the system browser and render nothing. That has to fail the launch (it is
    // constructed inside whenReady's try/catch), not degrade into a redirector.
    for (const appUrl of ["not-a-url", "", undefined, null, "file:///Applications/Telar.app"]) {
      expect(() => createExternalLinkPolicy({ appUrl })).toThrow(/http\(s\) app URL/);
    }
    expect(() => createExternalLinkPolicy()).toThrow(/http\(s\) app URL/);
  });
});

describe("desktop external-link wiring", () => {
  const mainSource = readFileSync(path.join(__dirname, "main.js"), "utf8");
  const managerSource = readFileSync(path.join(__dirname, "browser-manager.js"), "utf8");
  // Both files EXPLAIN the shapes ruled out below, so the guards read code only.
  const codeOf = (source) =>
    source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
  const mainCode = codeOf(mainSource);
  const managerCode = codeOf(managerSource);

  test("routes the app window's link navigations through the policy", () => {
    // mainCode, not mainSource: every string below is ordinary prose that the
    // comment block above the wiring already uses, so asserting against raw
    // source would stay green with the wiring commented out.
    expect(mainCode).toContain(
      "applyExternalLinkPolicy(win.webContents, () => createExternalLinkPolicy({ appUrl: url }))",
    );
    expect(mainCode).toContain("webContents.setWindowOpenHandler");
    expect(mainCode).toContain('webContents.on("will-navigate"');
    // Through the Links claim (link-routing.js), which falls back to the OS.
    expect(mainCode).toContain("linkRouting.handOff(webContents, decision.openExternal, openInSystemBrowser)");
    expect(mainCode).toContain("shell.openExternal(url).catch(");
    // The suppressed hand-off has to reach the log, not just the return value.
    expect(mainCode).toContain("decision.duplicateOf");
  });

  test("leaves the integrated browser's WebContentsView tabs in-app", () => {
    // THE GUARD, not a style rule: app.on("web-contents-created") is the
    // catch-all shape this feature invites, and it would also capture the
    // browser manager's views — the surface agents drive. The manager does
    // intercept target=_blank/window.open now, but only to create another
    // managed in-app tab; it still must never hand a page target to the OS.
    expect(mainCode).not.toContain("web-contents-created");
    expect(managerCode).not.toContain("openExternal(");
    expect(managerCode).toContain("setWindowOpenHandler");
    // #615: the popup is now Chromium's own, adopted into a managed tab —
    // still in-app, and now with `window.opener` intact.
    expect(managerCode).toContain("this.decidePopup(tab, details");
    expect(managerCode).toContain("createWindow: (options) => this.adoptPopupTab(");
    // And the refusal is still a refusal: a non-web scheme opens nothing.
    expect(managerCode).toContain('return { action: "deny" }');
  });
});

describe("loopback aliases are the same server", () => {
  // localhost and 127.0.0.1 ARE the same machine, and comparing origins as
  // strings says otherwise. The shell loads the cockpit as 127.0.0.1, so a
  // navigation spelling it `localhost` was cancelled and handed to the system
  // browser — one browser window per attempt, while the app sat on "This page
  // couldn't load". Found by driving the real window, ten Firefox windows later.
  test("the app's own UI under another loopback name stays in-app", () => {
    const policy = createExternalLinkPolicy({ appUrl: APP_URL });
    for (const target of [
      "http://localhost:42731/settings",
      "http://127.0.0.1:42731/settings",
      "http://[::1]:42731/settings",
    ]) {
      expect(policy.decide(target)).toEqual({ action: "allow", openExternal: null });
    }
  });

  test("but only at the same port, and only over the same scheme", () => {
    const policy = createExternalLinkPolicy({ appUrl: APP_URL });
    // A different port on loopback is a DIFFERENT SERVER — someone's Vite, a
    // second Telar — and must keep leaving. This is the line the widening
    // above must not cross.
    expect(policy.decide("http://localhost:5173/").openExternal).toBe("http://localhost:5173/");
    expect(policy.decide("https://localhost:42731/").openExternal).toBe("https://localhost:42731/");
    // And a real host that merely CONTAINS a loopback name is not loopback.
    expect(policy.decide("http://localhost.evil.com:42731/").openExternal).toBe("http://localhost.evil.com:42731/");
  });
});

/**
 * "OPEN IN SYSTEM BROWSER" — the tab strip's own verb (#274), and the second
 * route from Telar to `shell.openExternal`. It gets the same allowlist the
 * clicked-link policy applies, for the same reason: that call hands whatever
 * it is given to the operating system.
 */
describe("externalOpenTarget", () => {
  test("http and https pass, and what comes back is the PARSED href", () => {
    expect(externalOpenTarget("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
    expect(externalOpenTarget("http://example.com")).toBe("http://example.com/");
    // Normalised on the way through, so the OS receives exactly what was
    // validated rather than the caller's original string.
    expect(externalOpenTarget("HTTPS://Example.COM/Path")).toBe("https://example.com/Path");
  });

  test("every other scheme is refused — openExternal would hand it to the OS", () => {
    for (const url of [
      "file:///etc/passwd",
      "file://localhost/Users/someone/.ssh/id_rsa",
      "smb://server/share",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vscode://file/etc/passwd",
      "ms-msdt:/id",
      "chrome://settings",
      "about:blank",
      "mailto:someone@example.com",
      "ftp://example.com/x",
    ]) {
      expect(externalOpenTarget(url), `${url} does not reach the OS`).toBeNull();
    }
  });

  test("a string that is not a URL, or is not a string, is refused rather than guessed at", () => {
    for (const value of ["", "   ", "example.com", "//example.com", null, undefined, 42, {}]) {
      expect(externalOpenTarget(value), `${JSON.stringify(value)} is refused`).toBeNull();
    }
  });

  test("a sloppy but genuinely-http(s) string is NORMALISED, not refused — and the OS gets the normal form", () => {
    // WHATWG parsing is what decides, and it accepts both of these as http(s).
    // That is the right answer: what comes back is an ordinary web request to
    // an ordinary host, and the caller is handed the canonical spelling rather
    // than the one somebody typed. A prefix test would pass the raw string
    // through instead, which is the failure mode this function exists to avoid.
    expect(externalOpenTarget("https:/evil")).toBe("https://evil/");
    expect(externalOpenTarget(" https://example.com")).toBe("https://example.com/");
  });
});

/**
 * The main-process wiring, held to source contracts — main.js cannot be
 * required outside an Electron process, which is the same idiom the other
 * main.js assertions in this suite and in browser-manager.test.js use.
 */
describe("the open-external IPC handler", () => {
  const main = readFileSync(path.join(__dirname, "main.js"), "utf8");

  test("it decides with externalOpenTarget rather than a test of its own", () => {
    expect(main).toContain('ipcMain.handle("telar:browser:open-external"');
    expect(main).toContain("const target = externalOpenTarget(input?.url);");
    expect(main).toContain("if (!target) return { ok: false, error:");
  });

  test("only the cockpit window's own top frame may ask — not a tab, a subframe, or anything an agent reaches", () => {
    const handler = main.slice(
      main.indexOf('ipcMain.handle("telar:browser:open-external"'),
      main.indexOf('ipcMain.handle("telar:browser:tool"'),
    );
    expect(handler).toContain("event.sender !== cockpit.webContents");
    expect(handler).toContain("event.senderFrame !== cockpit.webContents.mainFrame");
    // And the refusal is a throw, not a quiet no-op.
    expect(handler).toContain("throw new Error(\"Only the Telar window may open a page in the system browser.\")");
  });

  test("the refusal comes BEFORE the hand-off, so no unvalidated string reaches shell.openExternal", () => {
    const handler = main.slice(
      main.indexOf('ipcMain.handle("telar:browser:open-external"'),
      main.indexOf('ipcMain.handle("telar:browser:tool"'),
    );
    expect(handler.indexOf("if (!target)")).toBeLessThan(handler.indexOf("openInSystemBrowser(target)"));
    // It hands on the VALIDATED target, never `input.url`.
    expect(handler).not.toContain("openInSystemBrowser(input");
  });
});
