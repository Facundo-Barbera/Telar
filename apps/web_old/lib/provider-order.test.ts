// The proof that the Providers list orders the way its controls claim.
//
// Three of these are regressions waiting to happen rather than hypotheticals:
// the disabled-last key has to beat the mode (otherwise "sort by name" quietly
// re-interleaves the switched-off rows), sorting by name has to read the
// DISPLAY name (otherwise a renamed row sorts under a key nobody sees), and the
// divider must not appear when there is nothing above it to divide.
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  compareAccounts,
  disabledBoundary,
  isProviderSort,
  orderAccounts,
  type OrderableAccount,
} from "@/lib/provider-order";

const acct = (p: Partial<OrderableAccount> & { name: string }): OrderableAccount => ({ ...p });

const names = (rows: readonly OrderableAccount[]): string[] => rows.map((r) => r.name);

describe("provider mode", () => {
  test("Claude before Codex, detected base login first, then key", () => {
    const rows = [
      acct({ name: "codex", provider: "codex", isMain: true }),
      acct({ name: "cc-personal", provider: "claude" }),
      acct({ name: "personal", provider: "claude", isMain: true }),
      acct({ name: "cc-ozom", provider: "claude" }),
    ];
    expect(names(orderAccounts(rows, "provider", false))).toEqual([
      "personal",
      "cc-ozom",
      "cc-personal",
      "codex",
    ]);
  });

  test("a missing provider field is Claude, not a third group", () => {
    const rows = [acct({ name: "z", provider: "codex" }), acct({ name: "a" })];
    expect(names(orderAccounts(rows, "provider", false))).toEqual(["a", "z"]);
  });
});

describe("name mode", () => {
  test("orders by the label the row shows, not the registry key", () => {
    const rows = [
      acct({ name: "cc-ozom", displayName: "Zephyr" }),
      acct({ name: "zz-last", displayName: "Amber" }),
    ];
    expect(names(orderAccounts(rows, "name", false))).toEqual(["zz-last", "cc-ozom"]);
  });

  test("falls back to the key when there is no display name, and ignores blank ones", () => {
    const rows = [acct({ name: "beta", displayName: "   " }), acct({ name: "alpha" })];
    expect(names(orderAccounts(rows, "name", false))).toEqual(["alpha", "beta"]);
  });

  test("crosses provider boundaries — that is the point of the mode", () => {
    const rows = [
      acct({ name: "b-claude", provider: "claude" }),
      acct({ name: "a-codex", provider: "codex" }),
    ];
    expect(names(orderAccounts(rows, "name", false))).toEqual(["a-codex", "b-claude"]);
  });
});

describe("status mode", () => {
  test("needs-attention first, unproven next, healthy last", () => {
    const rows = [
      acct({ name: "healthy", health: { status: "ok" } }),
      acct({ name: "unknown" }),
      acct({ name: "signed-out", health: { status: "never-logged-in" } }),
      acct({ name: "no-folder", health: { status: "missing-config-dir" } }),
    ];
    expect(names(orderAccounts(rows, "status", false))).toEqual([
      "no-folder",
      "signed-out",
      "unknown",
      "healthy",
    ]);
  });

  test("ties break by name so the order is stable between renders", () => {
    const rows = [
      acct({ name: "b", health: { status: "ok" } }),
      acct({ name: "a", health: { status: "ok" } }),
    ];
    expect(names(orderAccounts(rows, "status", false))).toEqual(["a", "b"]);
  });
});

describe("disabled last", () => {
  test("outranks the mode — a disabled 'Aaa' still sinks under an enabled 'Zzz'", () => {
    const rows = [
      acct({ name: "aaa", enabled: false }),
      acct({ name: "zzz", enabled: true }),
    ];
    expect(names(orderAccounts(rows, "name", true))).toEqual(["zzz", "aaa"]);
    // ...and with the flag off the mode gets its way again.
    expect(names(orderAccounts(rows, "name", false))).toEqual(["aaa", "zzz"]);
  });

  test("outranks status too — a broken disabled row does not lead the list", () => {
    const rows = [
      acct({ name: "off-broken", enabled: false, health: { status: "never-logged-in" } }),
      acct({ name: "on-healthy", enabled: true, health: { status: "ok" } }),
    ];
    expect(names(orderAccounts(rows, "status", true))).toEqual(["on-healthy", "off-broken"]);
  });

  test("undefined enabled counts as ON — absence is not a switched-off account", () => {
    const rows = [acct({ name: "off", enabled: false }), acct({ name: "unset" })];
    expect(names(orderAccounts(rows, "provider", true))).toEqual(["unset", "off"]);
  });

  test("the disabled group keeps the mode's order inside itself", () => {
    const rows = [
      acct({ name: "off-z", enabled: false, displayName: "Zeta" }),
      acct({ name: "off-a", enabled: false, displayName: "Alpha" }),
      acct({ name: "on", enabled: true, displayName: "Mid" }),
    ];
    expect(names(orderAccounts(rows, "name", true))).toEqual(["on", "off-a", "off-z"]);
  });
});

describe("the divider", () => {
  test("marks the first disabled row", () => {
    const ordered = [acct({ name: "on" }), acct({ name: "off", enabled: false })];
    expect(disabledBoundary(ordered, true)).toBe(1);
  });

  test("is absent when the flag is off, when nothing is disabled, and when everything is", () => {
    const mixed = [acct({ name: "on" }), acct({ name: "off", enabled: false })];
    expect(disabledBoundary(mixed, false)).toBe(-1);
    expect(disabledBoundary([acct({ name: "on" })], true)).toBe(-1);
    // All disabled: a divider at index 0 would label the list, not split it.
    expect(disabledBoundary([acct({ name: "off", enabled: false })], true)).toBe(-1);
  });
});

describe("input does not move", () => {
  test("orderAccounts sorts a copy", () => {
    const rows = [acct({ name: "b" }), acct({ name: "a" })];
    const before = names(rows);
    orderAccounts(rows, "name", true);
    expect(names(rows)).toEqual(before);
  });
});

describe("isProviderSort", () => {
  test("accepts the three modes and refuses anything else", () => {
    expect(isProviderSort("provider")).toBe(true);
    expect(isProviderSort("name")).toBe(true);
    expect(isProviderSort("status")).toBe(true);
    expect(isProviderSort("health")).toBe(false);
    expect(isProviderSort(undefined)).toBe(false);
    expect(isProviderSort(2)).toBe(false);
  });
});

describe("compareAccounts", () => {
  test("is 0 for rows that tie on every key, so sort stays stable", () => {
    const a = acct({ name: "same", provider: "claude" });
    const b = acct({ name: "same", provider: "claude" });
    expect(compareAccounts(a, b, "provider", true)).toBe(0);
  });
});
