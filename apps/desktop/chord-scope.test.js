const { describe, expect, test } = require("bun:test");

const { ChordScopes } = require("./chord-scope");

const NINE = Array.from({ length: 9 }, (_, index) => `CommandOrControl+${index + 1}`);

describe("two owners claim chords and both can be live (#660)", () => {
  test("nothing is claimed until somebody claims something", () => {
    const scopes = new ChordScopes();
    expect(scopes.empty).toBe(true);
    expect(scopes.all()).toEqual([]);
  });

  /**
   * THE BUG THIS MODULE EXISTS TO PREVENT. Before the union, a page's claim was
   * written into the same slot the renderer's stack was mirrored into — so a
   * palette opened over a focused browser tab lost its own ⌘1..⌘9.
   */
  test("a page's claim does not erase the renderer's, and neither erases the other on release", () => {
    const scopes = new ChordScopes();
    const browser = {};
    scopes.setRenderer(["CommandOrControl+K"]);
    scopes.setOwner(browser, NINE);
    expect(scopes.all()).toEqual(["CommandOrControl+K", ...NINE]);

    // The page gives the keys back; the palette still holds ⌘K.
    scopes.setOwner(browser, []);
    expect(scopes.all()).toEqual(["CommandOrControl+K"]);

    // And the other way round: the renderer reloads, the page keeps its nine.
    scopes.setOwner(browser, NINE);
    scopes.setRenderer([]);
    expect(scopes.all()).toEqual(NINE);
    expect(scopes.empty).toBe(false);
  });

  test("two windows keep separate answers, and forgetting one leaves the other", () => {
    const scopes = new ChordScopes();
    const first = {};
    const second = {};
    scopes.setOwner(first, ["CommandOrControl+1"]);
    scopes.setOwner(second, ["CommandOrControl+2"]);
    expect(scopes.all()).toEqual(["CommandOrControl+1", "CommandOrControl+2"]);

    expect(scopes.forget(first)).toBe(true);
    expect(scopes.all()).toEqual(["CommandOrControl+2"]);
    // Idempotent: a window closing twice is not an error.
    expect(scopes.forget(first)).toBe(false);
  });

  test("setOwner reports whether anything changed — a focus move between two tabs must not rebuild the menu", () => {
    const scopes = new ChordScopes();
    const browser = {};
    expect(scopes.setOwner(browser, NINE)).toBe(true);
    // Tab 1 blurs and tab 2 focuses: same nine, still claimed, no menu rebuild.
    expect(scopes.setOwner(browser, NINE)).toBe(false);
    expect(scopes.setOwner(browser, [])).toBe(true);
    // Releasing what was never held is not a change either.
    expect(scopes.setOwner(browser, [])).toBe(false);
  });

  test("duplicates across owners are reported once", () => {
    const scopes = new ChordScopes();
    scopes.setRenderer(["CommandOrControl+1"]);
    scopes.setOwner({}, ["CommandOrControl+1", "CommandOrControl+2"]);
    expect(scopes.all()).toEqual(["CommandOrControl+1", "CommandOrControl+2"]);
  });

  /** A renderer can send anything over IPC. Junk reads as "nothing is claimed",
   *  which is the state that leaves every accelerator live — never the state
   *  that strips one forever. */
  test("junk over IPC reads as nothing claimed, from either owner", () => {
    const scopes = new ChordScopes();
    expect(scopes.setRenderer(undefined)).toEqual([]);
    expect(scopes.setRenderer("CommandOrControl+1")).toEqual([]);
    expect(scopes.setRenderer(["CommandOrControl+1", 7, null])).toEqual(["CommandOrControl+1"]);
    scopes.setOwner({}, { nine: true });
    expect(scopes.all()).toEqual(["CommandOrControl+1"]);
  });
});
