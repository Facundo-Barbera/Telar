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
