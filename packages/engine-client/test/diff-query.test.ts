import { describe, expect, test } from "bun:test";
import { diffBaseQuery, filePatchQuery, parseDiffBaseQuery, parseFilePatchQuery } from "../src/protocol/diff-query";

const round = (query: string) => parseFilePatchQuery(new URLSearchParams(query));

describe("the base, which has three states and not two", () => {
  test("absent is 'the base you have on file'", () => {
    // What every caller meant before the scope selector existed, and what they
    // still get without asking for anything.
    expect(diffBaseQuery({})).toBe("");
    expect(parseDiffBaseQuery(new URLSearchParams(""))).toEqual({});
  });

  test("EMPTY is 'no base' — the working tree, and a question of its own", () => {
    expect(diffBaseQuery({ base: null })).toBe("base=");
    expect(parseDiffBaseQuery(new URLSearchParams("base="))).toEqual({ base: null });
    // ...and the two are not the same request, at either end.
    expect(diffBaseQuery({ base: null })).not.toBe(diffBaseQuery({}));
    expect(parseDiffBaseQuery(new URLSearchParams("base="))).not.toEqual(parseDiffBaseQuery(new URLSearchParams("")));
  });

  test("a RANGE has a right-hand side, and absent is still the working tree — issue #741", () => {
    expect(diffBaseQuery({ base: "aaa", to: "bbb" })).toBe("base=aaa&to=bbb");
    expect(parseDiffBaseQuery(new URLSearchParams("base=aaa&to=bbb"))).toEqual({ base: "aaa", to: "bbb" });

    expect(diffBaseQuery({ base: "aaa" })).toBe("base=aaa");
    expect(parseDiffBaseQuery(new URLSearchParams("base=aaa")).to).toBeUndefined();
    expect(diffBaseQuery({})).toBe("");

    // A `to` with no base is a request somebody can make: the session's own
    // base, up to that commit. So it is read whether or not a base is present.
    expect(parseDiffBaseQuery(new URLSearchParams("to=bbb"))).toEqual({ to: "bbb" });
    // ...and a blank one is not a third meaning nobody declared.
    expect(parseDiffBaseQuery(new URLSearchParams("to=%20%20")).to).toBeUndefined();
  });

  test("a ref is that ref, and survives the characters a ref name has", () => {
    expect(parseDiffBaseQuery(new URLSearchParams(diffBaseQuery({ base: "origin/main" })))).toEqual({ base: "origin/main" });
    expect(parseDiffBaseQuery(new URLSearchParams(diffBaseQuery({ base: "feature/a+b" })))).toEqual({ base: "feature/a+b" });
  });

  test("whitespace around a ref is not a ref", () => {
    // A hand-built URL or a pasted name should not ask git for " main".
    expect(parseDiffBaseQuery(new URLSearchParams("base=%20%20"))).toEqual({ base: null });
  });
});

describe("one file's patch", () => {
  test("the path always rides, and nothing else does by default", () => {
    expect(filePatchQuery("src/a.ts", {})).toBe("path=src%2Fa.ts");
    expect(round("path=src%2Fa.ts")).toEqual({ untracked: false, ignoreWhitespace: false });
  });

  test("every option round trips — the one that was dropped, and the one beside it", () => {
    const query = filePatchQuery("src/a.ts", { untracked: true, ignoreWhitespace: true, base: "origin/main" });
    expect(round(query)).toEqual({ untracked: true, ignoreWhitespace: true, base: "origin/main" });
  });

  test("the working tree's empty base survives a patch read too", () => {
    // A row's patch read against a different base from the list above it would
    // put plausible hunks under counts from another comparison.
    expect(round(filePatchQuery("src/a.ts", { base: null }))).toEqual({ untracked: false, ignoreWhitespace: false, base: null });
  });

  test("a path with a query character in it does not become two parameters", () => {
    const query = filePatchQuery("src/a&b=c.ts", { ignoreWhitespace: true });
    expect(new URLSearchParams(query).get("path")).toBe("src/a&b=c.ts");
    expect(round(query).ignoreWhitespace).toBe(true);
  });

  test("a rename carries BOTH of its paths — issue #694", () => {
    const query = filePatchQuery("dst.txt", { renamedFrom: "src.txt" });
    expect(new URLSearchParams(query).get("renamedFrom")).toBe("src.txt");
    expect(round(query)).toEqual({ untracked: false, ignoreWhitespace: false, renamedFrom: "src.txt" });
  });

  test("no rename sends no parameter, and an empty one is not a rename", () => {
    // A bare `?renamedFrom=` would reach a pathspec as the repository root,
    // which matches everything — so absent and empty must both mean "no".
    expect(filePatchQuery("dst.txt", {})).not.toContain("renamedFrom");
    expect(round("path=dst.txt&renamedFrom=").renamedFrom).toBeUndefined();
    expect(round("path=dst.txt&renamedFrom=%20%20").renamedFrom).toBeUndefined();
  });
});
