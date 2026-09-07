/**
 * The link router's pure half: which URLs are "this project's issue or pull
 * request" and which are just pages. The repository comparison is here too,
 * because routing `other-org/repo#12` into a surface that queries THIS
 * project's issue 12 would show the wrong thing with full confidence.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { parseForgeLink, sameRepository } from "./session-links";

describe("parseForgeLink", () => {
  test("an issue or pull URL carries its kind, number and repository", () => {
    expect(parseForgeLink("https://github.com/Facundo-Barbera/Telar/issues/167")).toEqual({ kind: "issue", number: 167, repository: "Facundo-Barbera/Telar" });
    expect(parseForgeLink("https://github.com/o/r/pull/9/")).toEqual({ kind: "pull", number: 9, repository: "o/r" });
    expect(parseForgeLink("https://www.github.com/o/r/issues/3")).toMatchObject({ kind: "issue", number: 3 });
  });

  test("anything else is just a page", () => {
    // A list, a comment anchor's PATH suffix, another forge, a non-URL.
    expect(parseForgeLink("https://github.com/o/r/issues")).toBeUndefined();
    expect(parseForgeLink("https://github.com/o/r/issues/12/comments")).toBeUndefined();
    expect(parseForgeLink("https://gitlab.com/o/r/issues/12")).toBeUndefined();
    expect(parseForgeLink("https://github.com/o/r/pull/abc")).toBeUndefined();
    expect(parseForgeLink("not a url")).toBeUndefined();
  });
});

describe("sameRepository", () => {
  test("GitHub's case-insensitive way, and unknown never matches", () => {
    expect(sameRepository("Facundo-Barbera/Telar", "facundo-barbera/telar")).toBe(true);
    expect(sameRepository("o/r", "o/other")).toBe(false);
    expect(sameRepository(undefined, "o/r")).toBe(false);
  });
});
