// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { sessionFilterLabel } from "./vnext-session-list";

describe("vNext application sidebar", () => {
  test("keeps the session inbox filters compact and understandable", () => {
    expect(sessionFilterLabel("recent")).toBe("Recent");
    expect(sessionFilterLabel("active")).toBe("Active");
    expect(sessionFilterLabel("all")).toBe("All");
  });
});
