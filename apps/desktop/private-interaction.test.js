const { describe, expect, test } = require("bun:test");
const { PrivateInteraction, isProtectedUrl } = require("./private-interaction");

describe("PrivateInteraction", () => {
  test("begin/end move the epoch and announce; a second begin extends, never nests", () => {
    const changes = [];
    const p = new PrivateInteraction({ now: () => 1000, onChange: (s) => changes.push(s.private) });
    expect(p.isActive()).toBe(false);
    p.begin("1Password", "s1");
    p.begin("still 1Password");
    expect(p.state()).toMatchObject({ private: true, epoch: 1, reason: "still 1Password", scopeKey: "s1" });
    p.end();
    expect(p.state()).toEqual({ private: false, epoch: 2 });
    expect(changes).toEqual([true, false]);
  });

  test("a result from before privacy began is discarded on return; after it ends, a stale epoch is discarded too", () => {
    const p = new PrivateInteraction();
    const ok = { content: [{ type: "text", text: "page" }] };
    const e0 = p.epoch;
    expect(p.admit(ok, e0)).toBe(ok);
    p.begin("x");
    expect(p.admit(ok, e0)).toMatchObject({ isError: true, discarded: true });
    p.end();
    expect(p.admit(ok, e0)).toMatchObject({ isError: true, discarded: true });
    expect(p.admit(ok, p.epoch)).toBe(ok);
  });

  test("extension and browser-internal pages are protected targets", () => {
    expect(isProtectedUrl("chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/popup/index.html")).toBe(true);
    expect(isProtectedUrl("chrome://extensions")).toBe(true);
    expect(isProtectedUrl("https://example.com/chrome-extension://x")).toBe(false);
    expect(isProtectedUrl("about:blank")).toBe(false);
    expect(isProtectedUrl("")).toBe(false);
  });
});
