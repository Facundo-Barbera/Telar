// Pins issue #16's command keys: the shared binding table (imported from
// apps/desktop/command-keys.js — the same physical file main.js requires, so
// this test exercises the real cross-app import, not a copy of it), the
// focus rule, and what each binding id actually means.
//
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  COMMAND_KEY_BINDINGS,
  commandKeyDestination,
  isEditableTarget,
  jumpNumber,
  resolveWebCommandKeyAction,
  type CommandKeyId,
} from "./command-keys";
import {
  matchesCommandKeyEvent,
  resolveCommandKeyAction,
} from "../../desktop/command-keys.js";

const EXPECTED_IDS: CommandKeyId[] = [
  "new-session",
  "new-tab",
  "jump-1",
  "jump-2",
  "jump-3",
  "jump-4",
  "jump-5",
  "jump-6",
  "jump-7",
  "jump-8",
  "jump-9",
  "settings",
];

describe("COMMAND_KEY_BINDINGS — the one source of truth (issue #16)", () => {
  test("is the exact closed set of ids the app declares, in order", () => {
    // A CLOSED-LIST GUARD: this is the one place TypeScript's CommandKeyId
    // union is checked against the plain-JS table it is meant to describe —
    // add a binding to command-keys.js without updating both this list and
    // the CommandKeyId union in lib/command-keys.ts, and this fails.
    expect(COMMAND_KEY_BINDINGS.map((b) => b.id)).toEqual(EXPECTED_IDS);
  });

  test("every accelerator uses CommandOrControl, never a hardcoded Cmd/Ctrl", () => {
    for (const binding of COMMAND_KEY_BINDINGS) {
      expect(binding.accelerator.startsWith("CommandOrControl+")).toBe(true);
    }
  });

  test("cmd+1..cmd+9 carry the matching jump number, everything else carries none", () => {
    for (const binding of COMMAND_KEY_BINDINGS) {
      const n = jumpNumber(binding.id as CommandKeyId);
      expect(binding.jump).toBe(n);
    }
  });
});

describe("matchesCommandKeyEvent / resolveCommandKeyAction (the desktop-shared matcher)", () => {
  const newSession = COMMAND_KEY_BINDINGS.find((b) => b.id === "new-session")!;

  test("accepts either meta or ctrl as CommandOrControl", () => {
    expect(matchesCommandKeyEvent(newSession, { key: "n", metaKey: true })).toBe(true);
    expect(matchesCommandKeyEvent(newSession, { key: "n", ctrlKey: true })).toBe(true);
  });

  test("rejects a bare key with no modifier — this is the 'never steals a plain keystroke' guarantee", () => {
    expect(matchesCommandKeyEvent(newSession, { key: "n" })).toBe(false);
    expect(resolveCommandKeyAction({ key: "n" })).toBeNull();
  });

  test("rejects when Shift or Alt rides along", () => {
    expect(matchesCommandKeyEvent(newSession, { key: "n", metaKey: true, shiftKey: true })).toBe(false);
    expect(matchesCommandKeyEvent(newSession, { key: "n", metaKey: true, altKey: true })).toBe(false);
  });

  test("is case-insensitive on the key (Shift+cmd+n still types 'N' on some layouts)", () => {
    expect(matchesCommandKeyEvent(newSession, { key: "N", metaKey: true })).toBe(true);
  });

  test("resolves the right id end to end, and null for an unbound chord", () => {
    expect(resolveCommandKeyAction({ key: ",", metaKey: true })).toBe("settings");
    expect(resolveCommandKeyAction({ key: "5", ctrlKey: true })).toBe("jump-5");
    expect(resolveCommandKeyAction({ key: "k", metaKey: true })).toBeNull();
  });
});

describe("isEditableTarget — the focus rule's primitive", () => {
  test("input, textarea, and select are editable", () => {
    expect(isEditableTarget({ tagName: "INPUT" })).toBe(true);
    expect(isEditableTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isEditableTarget({ tagName: "SELECT" })).toBe(true);
  });

  test("a contenteditable region (or a descendant of one) is editable", () => {
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  test("an ordinary element, or nothing focused, is not editable", () => {
    expect(isEditableTarget({ tagName: "DIV" })).toBe(false);
    expect(isEditableTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(undefined)).toBe(false);
  });
});

describe("resolveWebCommandKeyAction — the focus rule as revised by issue #46", () => {
  // THE #46 PIN, and the test lesson that issue insisted on: the previous
  // suite asserted "an editable target suppresses the binding" and passed
  // happily while describing the defect — the composer is a TEXTAREA and
  // holds focus nearly all the time, so no chord could ever fire. This
  // suite pins the USER-VISIBLE rule instead. This exact test failed
  // against the old implementation, which is the point.
  test("a ⌘-chord fires while the composer's textarea has focus", () => {
    expect(
      resolveWebCommandKeyAction({ key: "n", metaKey: true, target: { tagName: "TEXTAREA" } }),
    ).toBe("new-session");
  });

  test("a chord fires from ANY editable surface — input, contenteditable — and with ctrl as well as meta", () => {
    expect(
      resolveWebCommandKeyAction({ key: ",", metaKey: true, target: { tagName: "INPUT" } }),
    ).toBe("settings");
    expect(
      resolveWebCommandKeyAction({
        key: "1",
        ctrlKey: true,
        target: { tagName: "SPAN", isContentEditable: true },
      }),
    ).toBe("jump-1");
  });

  test("fires from an ordinary element", () => {
    expect(
      resolveWebCommandKeyAction({ key: "n", metaKey: true, target: { tagName: "DIV" } }),
    ).toBe("new-session");
  });

  test("fires with no target at all (the desktop IPC path has none)", () => {
    expect(resolveWebCommandKeyAction({ key: "t", metaKey: true })).toBe("new-tab");
  });

  // What REMAINS of the focus rule: it guards bare keys, the case where a
  // shortcut genuinely would steal a keystroke. No bare-key binding exists
  // today (the matcher already rejects modifier-less events), so this pins
  // the contract for the first future one.
  test("a bare key over a text field never fires — the guard that remains", () => {
    expect(
      resolveWebCommandKeyAction({ key: "n", target: { tagName: "TEXTAREA" } }),
    ).toBeNull();
  });

  test("still returns null for an unbound chord even outside any field", () => {
    expect(
      resolveWebCommandKeyAction({ key: "q", metaKey: true, target: { tagName: "DIV" } }),
    ).toBeNull();
  });
});

describe("commandKeyDestination — what each id means", () => {
  const recent = ["/projects/a/sessions/1", "/projects/a/sessions/2", undefined];

  test("new-session goes to '/', the same front door the sidebar's own New Session control uses", () => {
    expect(commandKeyDestination("new-session", recent)).toEqual({ kind: "navigate", href: "/" });
  });

  test("new-tab targets the same '/', but as an open-tab — a distinct destination KIND from new-session", () => {
    expect(commandKeyDestination("new-tab", recent)).toEqual({ kind: "open-tab", href: "/" });
  });

  test("settings goes to '/settings', the sidebar footer's own link", () => {
    expect(commandKeyDestination("settings", recent)).toEqual({ kind: "navigate", href: "/settings" });
  });

  test("jump-N navigates to the Nth recent session's href", () => {
    expect(commandKeyDestination("jump-1", recent)).toEqual({
      kind: "navigate",
      href: "/projects/a/sessions/1",
    });
    expect(commandKeyDestination("jump-2", recent)).toEqual({
      kind: "navigate",
      href: "/projects/a/sessions/2",
    });
  });

  test("jump-N past the end of the list, or into a hole, is a no-op — never a broken navigation", () => {
    expect(commandKeyDestination("jump-3", recent)).toEqual({ kind: "noop" });
    expect(commandKeyDestination("jump-9", recent)).toEqual({ kind: "noop" });
  });
});
