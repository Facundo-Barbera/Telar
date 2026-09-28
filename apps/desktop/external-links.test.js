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

    expect(policy.decide("about:blank")).toEqual({ action: "allow", openExternal: null });
  });

  test("sends every other web link to the system browser instead of an in-app window", () => {
    const policy = createExternalLinkPolicy({ appUrl: APP_URL });

    expect(policy.decide("https://github.com/login/oauth/authorize?client_id=x")).toEqual({
      action: "deny",
      openExternal: "https://github.com/login/oauth/authorize?client_id=x",
    });

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

    expect(policy.decide(authorize).openExternal).toBe(authorize);
    clock.at += 30;

    expect(policy.decide(authorize)).toEqual({
      action: "deny",
      openExternal: null,
      duplicateOf: authorize,
    });

    clock.at += 2_000;
    expect(policy.decide(authorize).openExternal).toBe(authorize);
  });

  test("each surface gets its own dedupe window", () => {
    const clock = fixedClock();
    const build = () => createExternalLinkPolicy({ appUrl: APP_URL, now: clock.now });
    const authorize = "https://accounts.example.com/authorize";

    expect(build().decide(authorize).openExternal).toBe(authorize);
    clock.at += 30;
    expect(build().decide(authorize).openExternal).toBe(authorize);
  });

  test("refuses to build a policy that cannot recognise Telar's own UI", () => {
    for (const appUrl of ["not-a-url", "", undefined, null, "file:///Applications/Telar.app"]) {
      expect(() => createExternalLinkPolicy({ appUrl })).toThrow(/http\(s\) app URL/);
    }
    expect(() => createExternalLinkPolicy()).toThrow(/http\(s\) app URL/);
  });
});

describe("desktop external-link wiring", () => {
  const mainSource = readFileSync(path.join(__dirname, "main.js"), "utf8");
  const managerSource = ["browser-manager.js", ...require("node:fs").readdirSync(path.join(__dirname, "browser")).map((f) => path.join("browser", f))].map((f) => readFileSync(path.join(__dirname, f), "utf8")).join("\n");

  const codeOf = (source) =>
    source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
  const mainCode = codeOf(mainSource);
  const managerCode = codeOf(managerSource);

  test("routes the app window's link navigations through the policy", () => {
    expect(mainCode).toContain(
      "applyExternalLinkPolicy(win.webContents, () => createExternalLinkPolicy({ appUrl: url }))",
    );
    expect(mainCode).toContain("webContents.setWindowOpenHandler");
    expect(mainCode).toContain('webContents.on("will-navigate"');

    expect(mainCode).toContain("linkRouting.handOff(webContents, decision.openExternal, openInSystemBrowser)");
    expect(mainCode).toContain("shell.openExternal(url).catch(");

    expect(mainCode).toContain("decision.duplicateOf");
  });

  test("leaves the integrated browser's WebContentsView tabs in-app", () => {
    expect(mainCode).not.toContain("web-contents-created");
    expect(managerCode).not.toContain("openExternal(");
    expect(managerCode).toContain("setWindowOpenHandler");

    expect(managerCode).toContain("this.decidePopup(tab, details");
    expect(managerCode).toContain("createWindow: (options) => this.adoptPopupTab(");

    expect(managerCode).toContain('return { action: "deny" }');
  });
});

describe("loopback aliases are the same server", () => {
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

    expect(policy.decide("http://localhost:5173/").openExternal).toBe("http://localhost:5173/");
    expect(policy.decide("https://localhost:42731/").openExternal).toBe("https://localhost:42731/");

    expect(policy.decide("http://localhost.evil.com:42731/").openExternal).toBe("http://localhost.evil.com:42731/");
  });
});

describe("externalOpenTarget", () => {
  test("http and https pass, and what comes back is the PARSED href", () => {
    expect(externalOpenTarget("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
    expect(externalOpenTarget("http://example.com")).toBe("http://example.com/");

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
    expect(externalOpenTarget("https:/evil")).toBe("https://evil/");
    expect(externalOpenTarget(" https://example.com")).toBe("https://example.com/");
  });
});

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

    expect(handler).toContain("throw new Error(\"Only the Telar window may open a page in the system browser.\")");
  });

  test("the refusal comes BEFORE the hand-off, so no unvalidated string reaches shell.openExternal", () => {
    const handler = main.slice(
      main.indexOf('ipcMain.handle("telar:browser:open-external"'),
      main.indexOf('ipcMain.handle("telar:browser:tool"'),
    );
    expect(handler.indexOf("if (!target)")).toBeLessThan(handler.indexOf("openInSystemBrowser(target)"));

    expect(handler).not.toContain("openInSystemBrowser(input");
  });
});
