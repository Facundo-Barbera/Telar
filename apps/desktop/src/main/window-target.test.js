const { describe, expect, test } = require("bun:test");

const { windowTargetUrl } = require("./window-target");

const APP_URL = "http://127.0.0.1:42731/projects/p1/sessions/s1";

describe("windowTargetUrl", () => {
  test("a path inside the app becomes an absolute URL on the asking window's origin", () => {
    expect(windowTargetUrl(APP_URL, "/projects/p2/sessions/s2")).toBe("http://127.0.0.1:42731/projects/p2/sessions/s2");

    expect(windowTargetUrl(APP_URL, "/hosts/host_mini/projects/p2/sessions/s2")).toBe(
      "http://127.0.0.1:42731/hosts/host_mini/projects/p2/sessions/s2",
    );

    expect(windowTargetUrl(APP_URL, "/projects/p1/sessions/new?base=telar%2Fx")).toBe(
      "http://127.0.0.1:42731/projects/p1/sessions/new?base=telar%2Fx",
    );
  });

  test("the base is the ADDRESS, not its directory — a path is absolute, not relative to the current page", () => {
    expect(windowTargetUrl("http://127.0.0.1:42731/deep/page", "/spool")).toBe("http://127.0.0.1:42731/spool");
  });

  test("nothing that leaves the origin is a window this shell will open", () => {
    for (const target of [
      "https://evil.example.com/",
      "http://127.0.0.1:5173/",
      "//evil.example.com/",
      "/\\evil.example.com/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "about:blank",

      "evil.example.com",
      "projects/p2",
      "",
      undefined,
      null,
      42,
      { path: "/projects/p1" },
    ]) {
      expect(windowTargetUrl(APP_URL, target), `${String(target)} is refused`).toBeNull();
    }
  });

  test("no asking address means no window, rather than a guess at one", () => {
    expect(windowTargetUrl(null, "/spool")).toBeNull();
    expect(windowTargetUrl("", "/spool")).toBeNull();
    expect(windowTargetUrl("not a url", "/spool")).toBeNull();
  });
});
