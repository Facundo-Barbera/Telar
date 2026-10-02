const { describe, expect, test } = require("bun:test");
const { createPasswordManagerPrefs } = require("./password-manager-prefs");

function prefs({ installed, saved = { enabled: null } }) {
  const store = { read: () => ({ ...saved }), write: (value) => (saved = { ...value }) };
  return createPasswordManagerPrefs(store, () => installed);
}

describe("the password manager setting", () => {
  test("is on by default only where the app is installed", () => {
    expect(prefs({ installed: true }).enabled()).toBe(true);
    expect(prefs({ installed: false }).enabled()).toBe(false);
  });

  test("a choice beats the default either way, and is read back", () => {
    const off = prefs({ installed: true });
    off.set(false);
    expect(off.enabled()).toBe(false);
    const on = prefs({ installed: false });
    on.set(true);
    expect(on.enabled()).toBe(true);
  });
});
