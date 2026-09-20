/**
 * THE KEYS A TERMINAL TAKES BACK — and the test asserts BYTES, not intent.
 *
 * "The handler decided to keep this key" is satisfied by a handler that fires
 * and swallows the press, which is precisely the bug these keys exist to stop.
 * So every case below names the octet: `^W` is 0x17 and nothing else is.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { claimChords, claimedCommandIds, defaultKeymap, normalizeChord, resolveCommandForEvent } from "@/lib/commands";
import { ptyBytesForKey, TERMINAL_CHORD_CLAIMS } from "@/lib/terminal-keys";

describe("ptyBytesForKey", () => {
  test("^W is 0x17 — zsh's backward-kill-word", () => {
    const bytes = ptyBytesForKey({ key: "w", ctrlKey: true });
    expect(bytes).toBe("\u0017");
    expect(bytes?.charCodeAt(0)).toBe(0x17);
  });

  test("^R is 0x12 — zsh's history search", () => {
    const bytes = ptyBytesForKey({ key: "r", ctrlKey: true });
    expect(bytes).toBe("\u0012");
    expect(bytes?.charCodeAt(0)).toBe(0x12);
  });

  test("Escape is 0x1b, which is what `bindkey -v` leaves insert mode with", () => {
    const bytes = ptyBytesForKey({ key: "Escape" });
    expect(bytes).toBe("\u001b");
    expect(bytes?.charCodeAt(0)).toBe(0x1b);
  });

  test("the letter alone still types the letter", () => {
    // If this ever answered a byte, typing "we" into a shell would kill a word.
    expect(ptyBytesForKey({ key: "w" })).toBeUndefined();
    expect(ptyBytesForKey({ key: "r" })).toBeUndefined();
  });

  test("Command keeps its chords — ⌘W is still the cockpit's", () => {
    expect(ptyBytesForKey({ key: "w", metaKey: true })).toBeUndefined();
    expect(ptyBytesForKey({ key: "r", metaKey: true })).toBeUndefined();
    // Both modifiers at once is a cockpit chord too, not a control code.
    expect(ptyBytesForKey({ key: "w", metaKey: true, ctrlKey: true })).toBeUndefined();
  });

  test("Option is the system's and Escape-with-a-modifier is not the shell's", () => {
    expect(ptyBytesForKey({ key: "w", ctrlKey: true, altKey: true })).toBeUndefined();
    expect(ptyBytesForKey({ key: "Escape", metaKey: true })).toBeUndefined();
    expect(ptyBytesForKey({ key: "Escape", shiftKey: true })).toBeUndefined();
  });

  test("only these two control letters — ^C and ^D are xterm's own job", () => {
    // xterm already encodes every other `^<letter>` correctly. Taking one over
    // here would mean taking that chord away from the cockpit for no measured
    // reason, so the table is deliberately two entries long.
    for (const key of ["c", "d", "a", "l", "z"]) {
      expect(ptyBytesForKey({ key, ctrlKey: true })).toBeUndefined();
    }
  });

  test("a layout that reports only `code` still answers", () => {
    expect(ptyBytesForKey({ code: "KeyW", ctrlKey: true })).toBe("\u0017");
  });
});

describe("TERMINAL_CHORD_CLAIMS", () => {
  test("every claim is already canonical, so `claimedChords` cannot drop one", () => {
    // A claim that normalises to something else is a claim the shell's menu
    // rebuild never matches — it would look present and suppress nothing.
    for (const chord of TERMINAL_CHORD_CLAIMS) expect(normalizeChord(chord)).toBe(chord);
  });

  /**
   * BOTH DIRECTIONS OF THE GUARD, which is the only way this claim is worth
   * anything. The shipped keymap binds nothing to these chords — so a test that
   * only checked "nothing is suppressed today" would pass with the claim list
   * empty, and would go on passing the day somebody deleted it.
   */
  test("a command REBOUND to one of them is suppressed while a terminal is up", () => {
    const rebound = { ...defaultKeymap(), "toggle-panel": "CommandOrControl+R" };
    // The rebinding really is live: without a claim, ^R runs it.
    expect(resolveCommandForEvent(rebound, { key: "r", ctrlKey: true })).toBe("toggle-panel");
    expect(claimedCommandIds(rebound)).toEqual([]);

    const release = claimChords(TERMINAL_CHORD_CLAIMS);
    try {
      expect(claimedCommandIds(rebound)).toContain("toggle-panel");
      // ...and the claim is THREE CHORDS, not a mute: everything at its shipped
      // chord is still live under the same claim.
      expect(claimedCommandIds(defaultKeymap())).toEqual([]);
    } finally {
      release();
    }
    // Released with the surface: the shortcut comes back.
    expect(claimedCommandIds(rebound)).toEqual([]);
  });
});
