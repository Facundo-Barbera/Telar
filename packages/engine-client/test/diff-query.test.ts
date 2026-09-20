/**
 * THE WIRE ENCODING OF A DIFF READ — the builder and the parser, together.
 *
 * WHY THIS FILE EXISTS. #694 shipped a working toggle whose flag never reached
 * git: the cockpit built the option, the engine parsed the parameter, and the
 * Next adapter between them enumerated parameters by hand and listed only one
 * of the two. Nothing failed — TypeScript does not check excess properties on a
 * non-literal — so the toggle flipped, the row re-read, and the same hunks came
 * back. `forgeQuery` carries a note about the identical failure in the GitHub
 * filter; this is that lesson's second bill.
 *
 * THE ROUND TRIP IS THE TEST. Asserting the string alone would pin an encoding;
 * asserting the pair pins the CONTRACT, which is the thing three layers rely on
 * meaning the same thing.
 */
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
    /**
     * THE ONE THAT CARRIES THE SCOPE SELECTOR. A layer that treated empty as
     * absent would silently ask for the session's base and return a confident,
     * plausible answer about something else — which is #690's bug arriving by
     * a different door.
     */
    expect(diffBaseQuery({ base: null })).toBe("base=");
    expect(parseDiffBaseQuery(new URLSearchParams("base="))).toEqual({ base: null });
    // ...and the two are not the same request, at either end.
    expect(diffBaseQuery({ base: null })).not.toBe(diffBaseQuery({}));
    expect(parseDiffBaseQuery(new URLSearchParams("base="))).not.toEqual(parseDiffBaseQuery(new URLSearchParams("")));
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
});
