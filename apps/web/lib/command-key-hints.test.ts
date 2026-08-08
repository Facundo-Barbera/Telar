// Pins the hold-to-reveal command-key hints (issue #46's discoverability
// follow-up): the gesture state machine, the platform-facing label, and the
// id-keyed jump-number map. The DOM half (use-command-key-hints.ts) is
// deliberately too thin to hold behavior — command-keys-wiring.test.ts pins
// that the sidebar actually mounts it.
//
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  commandKeyJumpNumbers,
  formatCommandKeyHint,
  HINT_HOLD_MS,
  isHintModifierKey,
  isMacPlatformString,
  nextHintState,
  type HintState,
} from "./command-key-hints";
import { recentSessionsForCommandKeys, type SidebarSession } from "./session-list";

describe("nextHintState — the hold-to-reveal gesture", () => {
  test("the happy path: hold the modifier alone past the delay and hints show", () => {
    let state: HintState = "idle";
    state = nextHintState(state, "modifier-down");
    expect(state).toBe("arming");
    state = nextHintState(state, "hold-elapsed");
    expect(state).toBe("showing");
  });

  test("a chord mid-hold cancels — ⌘C on the way to copy must never flash the sidebar", () => {
    expect(nextHintState("arming", "other-key")).toBe("idle");
    expect(nextHintState("showing", "other-key")).toBe("idle");
  });

  test("releasing the modifier ends the gesture from either live state", () => {
    expect(nextHintState("arming", "modifier-up")).toBe("idle");
    expect(nextHintState("showing", "modifier-up")).toBe("idle");
  });

  test("⌘Tab away ends it — the matching keyup lands in another app, never here", () => {
    expect(nextHintState("arming", "window-away")).toBe("idle");
    expect(nextHintState("showing", "window-away")).toBe("idle");
  });

  test("repeat keydowns of a held modifier do not restart or regress the gesture", () => {
    expect(nextHintState("arming", "modifier-down")).toBe("arming");
    expect(nextHintState("showing", "modifier-down")).toBe("showing");
  });

  test("a stale timer cannot resurrect hints — hold-elapsed only promotes from arming", () => {
    expect(nextHintState("idle", "hold-elapsed")).toBe("idle");
    expect(nextHintState("showing", "hold-elapsed")).toBe("showing");
  });

  test("the hold is long enough that a normal chord never sees it", () => {
    // Not asserting the exact number — asserting the property it exists for:
    // slower than a practiced ⌘C (~150-300ms key-to-key), fast enough to
    // still read as an answer to "what can I press?".
    expect(HINT_HOLD_MS).toBeGreaterThanOrEqual(400);
    expect(HINT_HOLD_MS).toBeLessThanOrEqual(1000);
  });
});

describe("isHintModifierKey — exactly the CommandOrControl pair", () => {
  test("Meta and Control arm; Shift, Alt, and ordinary keys never do", () => {
    expect(isHintModifierKey("Meta")).toBe(true);
    expect(isHintModifierKey("Control")).toBe(true);
    expect(isHintModifierKey("Shift")).toBe(false);
    expect(isHintModifierKey("Alt")).toBe(false);
    expect(isHintModifierKey("n")).toBe(false);
  });
});

describe("formatCommandKeyHint — the label each platform reads", () => {
  test("mac wears the glyph, everything else spells Ctrl", () => {
    expect(formatCommandKeyHint("n", true)).toBe("⌘N");
    expect(formatCommandKeyHint("n", false)).toBe("Ctrl+N");
  });

  test("digits and punctuation pass through — ⌘1, ⌘,", () => {
    expect(formatCommandKeyHint("1", true)).toBe("⌘1");
    expect(formatCommandKeyHint(",", true)).toBe("⌘,");
    expect(formatCommandKeyHint(",", false)).toBe("Ctrl+,");
  });
});

describe("isMacPlatformString", () => {
  test("Mac and iOS strings are mac-like; Windows and Linux are not", () => {
    expect(isMacPlatformString("MacIntel")).toBe(true);
    expect(isMacPlatformString("iPhone")).toBe(true);
    expect(isMacPlatformString("Win32")).toBe(false);
    expect(isMacPlatformString("Linux x86_64")).toBe(false);
  });
});

// ── the jump-number map ────────────────────────────────────────────────────

const session = (id: string, createdAt: number): SidebarSession => ({
  id,
  title: id,
  project: "demo",
  createdAt,
  updatedAt: createdAt,
  costUsd: 0,
});

const NOW = 1_000_000;

describe("commandKeyJumpNumbers — id-keyed, and NEVER a second ordering", () => {
  test("numbers 1..9 follow recentSessionsForCommandKeys exactly, by construction", () => {
    const sessions = Array.from({ length: 12 }, (_, i) => session(`s${i}`, NOW - i));
    const numbers = commandKeyJumpNumbers(sessions, undefined, NOW);
    const canonical = recentSessionsForCommandKeys(sessions, undefined, NOW);
    expect(numbers.size).toBe(9);
    canonical.forEach((entry, index) => {
      expect(numbers.get(entry.id)).toBe(index + 1);
    });
  });

  test("a session beyond the ninth wears no number at all", () => {
    const sessions = Array.from({ length: 12 }, (_, i) => session(`s${i}`, NOW - i));
    const numbers = commandKeyJumpNumbers(sessions, undefined, NOW);
    expect(numbers.has("s9")).toBe(false);
    expect(numbers.has("s11")).toBe(false);
  });

  test("id-keyed lookup survives a reordered view — the reason it is not positional", () => {
    // The caller may render a filtered or re-sorted list; looking up by id
    // must return each row's TRUE global number regardless of where the row
    // happens to sit on screen.
    const sessions = [session("a", NOW - 1), session("b", NOW - 2), session("c", NOW - 3)];
    const numbers = commandKeyJumpNumbers(sessions, undefined, NOW);
    const reorderedView = ["c", "a", "b"];
    expect(reorderedView.map((id) => numbers.get(id))).toEqual([3, 1, 2]);
  });

  test("threads activeSessionId through — the pinned-survivor rule stays shared", () => {
    // An open session that aged into a shelf is pinned back into the jump
    // list by recentSessionsForCommandKeys; the map must agree rather than
    // recompute recency itself and drop it.
    const old = session("old", NOW - 30 * 24 * 60 * 60 * 1000);
    const sessions = [session("fresh", NOW - 1), old];
    const withoutActive = commandKeyJumpNumbers(sessions, undefined, NOW);
    const withActive = commandKeyJumpNumbers(sessions, "old", NOW);
    expect(withoutActive.has("old")).toBe(false);
    expect(withActive.has("old")).toBe(true);
  });

  test("empty in, empty out", () => {
    expect(commandKeyJumpNumbers([], undefined, NOW).size).toBe(0);
  });
});
