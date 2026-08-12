// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  sessionAccounts,
  sessionProviders,
} from "./account-visibility";

const rows = [
  { name: "personal", provider: "claude" as const, runtimeRouted: true },
  { name: "codex", provider: "codex" as const, enabled: false },
];

describe("account visibility contracts", () => {
  test("session choices exclude disabled accounts", () => {
    expect(sessionAccounts(rows).map((row) => row.name)).toEqual(["personal"]);
    expect(sessionProviders(rows)).toEqual(["claude"]);
  });

  test("an enabled provider becomes available to sessions", () => {
    const enabled = rows.map((row) =>
      row.name === "codex" ? { ...row, enabled: true } : row,
    );
    expect(sessionProviders(enabled)).toEqual(["claude", "codex"]);
  });

  test("a configured but locally unavailable harness is excluded from new sessions", () => {
    const unavailable = rows.map((row) =>
      row.name === "codex" ? { ...row, enabled: true, available: false } : row,
    );
    expect(sessionProviders(unavailable)).toEqual(["claude"]);
    expect(sessionAccounts(unavailable).map((row) => row.name)).toEqual(["personal"]);
  });
});
