// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { refreshIncludes, type TelarRefreshDetail } from "@/lib/telar-refresh";

describe("scoped Telar refresh", () => {
  test("legacy events preserve the refresh-everything contract", () => {
    const legacy = new Event("telar:refresh");
    expect(refreshIncludes(legacy, "chats")).toBe(true);
    expect(refreshIncludes(legacy, "git")).toBe(true);
  });

  test("a chat save does not wake unrelated readers", () => {
    const event = {
      detail: { domains: ["chats", "usage"] },
    } as unknown as CustomEvent<TelarRefreshDetail>;
    expect(refreshIncludes(event, "chats")).toBe(true);
    expect(refreshIncludes(event, "usage")).toBe(true);
    expect(refreshIncludes(event, "git")).toBe(false);
    expect(refreshIncludes(event, "ultra")).toBe(false);
  });
});
