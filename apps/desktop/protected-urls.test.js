const { describe, expect, test } = require("bun:test");
const { isProtectedUrl } = require("./protected-urls");

describe("protected URLs", () => {
  test("extension and browser-internal pages are protected targets", () => {
    expect(isProtectedUrl("chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/popup/index.html")).toBe(true);
    expect(isProtectedUrl("chrome://extensions")).toBe(true);
    expect(isProtectedUrl("https://example.com/chrome-extension://x")).toBe(false);
    expect(isProtectedUrl("about:blank")).toBe(false);
    expect(isProtectedUrl("")).toBe(false);
  });
});
