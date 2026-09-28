import { describe, expect, test } from "bun:test";
import { parseForgeLink, sameRepository } from "./session-links";

describe("parseForgeLink", () => {
  test("an issue or pull URL carries its kind, number and repository", () => {
    expect(parseForgeLink("https://github.com/NovarixHQ/Telar/issues/167")).toEqual({ kind: "issue", number: 167, repository: "NovarixHQ/Telar" });
    expect(parseForgeLink("https://github.com/o/r/pull/9/")).toEqual({ kind: "pull", number: 9, repository: "o/r" });
    expect(parseForgeLink("https://www.github.com/o/r/issues/3")).toMatchObject({ kind: "issue", number: 3 });
  });

  test("anything else is just a page", () => {
    // A list, a comment anchor's path suffix, another forge, a non-URL.
    expect(parseForgeLink("https://github.com/o/r/issues")).toBeUndefined();
    expect(parseForgeLink("https://github.com/o/r/issues/12/comments")).toBeUndefined();
    expect(parseForgeLink("https://gitlab.com/o/r/issues/12")).toBeUndefined();
    expect(parseForgeLink("https://github.com/o/r/pull/abc")).toBeUndefined();
    expect(parseForgeLink("not a url")).toBeUndefined();
  });
});

describe("sameRepository", () => {
  test("GitHub's case-insensitive way, and unknown never matches", () => {
    expect(sameRepository("NovarixHQ/Telar", "novarixhq/telar")).toBe(true);
    expect(sameRepository("o/r", "o/other")).toBe(false);
    expect(sameRepository(undefined, "o/r")).toBe(false);
  });
});
