// Pins ui-prefs' sanitize() — the one function that decides what an old or
// mangled localStorage payload loads as. The occasion for these tests is
// issue #65: the new-session default mode moved from the retired Claude-only
// permission vocabulary to the provider-neutral runtime-mode one, and an old
// payload's `defaultPermissionMode` must keep meaning what it meant.
//
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { DEFAULT_PREFS, sanitize } from "./ui-prefs";

describe("sanitize — the defaultRuntimeMode migration (issue #65)", () => {
  test("a modern payload passes through", () => {
    expect(sanitize({ defaultRuntimeMode: "approval-required" }).defaultRuntimeMode).toBe(
      "approval-required",
    );
    expect(sanitize({ defaultRuntimeMode: "full-access" }).defaultRuntimeMode).toBe(
      "full-access",
    );
  });

  test("each legacy value keeps its exact meaning — the same mapping the chat route applies to old chats", () => {
    expect(sanitize({ defaultPermissionMode: "default" }).defaultRuntimeMode).toBe(
      "approval-required",
    );
    expect(sanitize({ defaultPermissionMode: "acceptEdits" }).defaultRuntimeMode).toBe(
      "auto-accept-edits",
    );
    expect(sanitize({ defaultPermissionMode: "auto" }).defaultRuntimeMode).toBe("auto");
  });

  test("a modern value wins over a stale legacy one riding in the same payload", () => {
    expect(
      sanitize({ defaultRuntimeMode: "approval-required", defaultPermissionMode: "auto" })
        .defaultRuntimeMode,
    ).toBe("approval-required");
  });

  test("garbage in either field falls back to the default, never leaks through", () => {
    expect(sanitize({ defaultRuntimeMode: "bypassPermissions" }).defaultRuntimeMode).toBe(
      DEFAULT_PREFS.defaultRuntimeMode,
    );
    expect(sanitize({ defaultPermissionMode: "plan" }).defaultRuntimeMode).toBe(
      DEFAULT_PREFS.defaultRuntimeMode,
    );
    expect(sanitize(null).defaultRuntimeMode).toBe(DEFAULT_PREFS.defaultRuntimeMode);
    expect(sanitize("[]").defaultRuntimeMode).toBe(DEFAULT_PREFS.defaultRuntimeMode);
  });

  test("an empty payload loads as the complete defaults — old partial payloads must never produce a partial UiPrefs", () => {
    expect(sanitize({})).toEqual(DEFAULT_PREFS);
  });
});
