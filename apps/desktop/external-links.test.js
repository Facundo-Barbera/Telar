// Issue #35: links leave for the user's default browser, and the integrated
// browser keeps rendering in-app. The policy is pure and tested directly; the
// Electron wiring in main.js (which cannot be required without an Electron
// process) is held to source contracts, the same idiom as the other main.js
// tests in browser-manager.test.js.
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { describe, expect, test } = require("bun:test");

const { createExternalLinkPolicy } = require("./browser-manager");

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
    expect(mainCode).toContain("openInSystemBrowser(decision.openExternal)");
    expect(mainCode).toContain("shell.openExternal(url).catch(");
    // The suppressed hand-off has to reach the log, not just the return value.
    expect(mainCode).toContain("decision.duplicateOf");
  });

  test("leaves the integrated browser's WebContentsView tabs in-app", () => {
    // THE GUARD, not a style rule: app.on("web-contents-created") is the
    // catch-all shape this feature invites, and it would also capture the
    // browser manager's views — the surface agents drive. Same for the manager
    // opening the shell itself. If either becomes necessary, the in-app
    // browser has to be excluded explicitly first.
    expect(mainCode).not.toContain("web-contents-created");
    expect(managerCode).not.toContain("openExternal(");
    expect(managerCode).not.toContain("setWindowOpenHandler");
  });
});
