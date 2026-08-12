// THE TWO THINGS THAT SILENTLY UNDO DARK MODE.
//
// Neither is caught by any other test, because neither produces an error. The
// app keeps rendering, keeps passing, and is simply the wrong colour — which is
// how both of these reached a user rather than a CI run.
//
// Written after shipping the second one. A palette change widened the `dark`
// variant to `&:is(.dark *):not(:is(.light *))` so a demo-gallery stage could
// host a light island inside the dark shell. Reading the compiled stylesheet
// said it was a no-op: nothing in the app wears a bare `light` class, so the
// `:not()` should never exclude anything. But a variant governs every `dark:`
// UTILITY, and a browser that cannot parse the selector drops the rule outright
// rather than ignoring the clause — so the tokens still flipped while every
// component-level `dark:` override disappeared. That renders as an app stuck in
// light mode, with a stylesheet that looks correct to anyone reading it.
//
// The lesson these tests encode: the theme is a contract between two files and
// one selector, and "I read it and it looked fine" is not a way to check it.
// @ts-expect-error no @types/bun in this workspace — the runtime is `bun test`
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// `import.meta.url` + fileURLToPath rather than Bun's `import.meta.dir`: the
// latter is a Bun extension that this workspace has no types for, so it was a
// type error in every checkout whose tsconfig did not exclude test files. Same
// resolution, same directory, and it is the idiom store.test.ts already uses.
const css = readFileSync(
  fileURLToPath(new URL("../app/globals.css", import.meta.url)),
  "utf8",
);

// Comments stripped, because this file EXPLAINS the selectors it must not
// contain — the first version of these tests failed on the paragraph describing
// the very clause it was written to forbid. A scan that cannot tell code from
// prose is a scan that forces you to stop writing the prose.
const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations inside a top-level `<selector> { … }` block, as a map. */
function tokensIn(selector: string): Map<string, string> {
  const open = css.indexOf(`${selector} {`);
  if (open < 0) throw new Error(`globals.css has no top-level \`${selector}\` block`);
  const close = css.indexOf("\n}", open);
  const body = css.slice(open, close);
  return new Map(
    [...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]),
  );
}

describe("the dark variant", () => {
  test("is plain — no :not(), no :is() beyond the class itself", () => {
    const m = code.match(/@custom-variant\s+dark\s+\(([^)]*(?:\([^)]*\)[^)]*)*)\)\s*;/);
    expect(m).not.toBeNull();
    const variant = m![1]!.trim();

    // The exact selector. Pinned as a literal rather than a pattern, because
    // the failure mode is a plausible-looking ADDITION and a pattern would
    // admit the next one.
    expect(variant).toBe("&:is(.dark *)");
  });

  test("no rule anywhere keys off a bare `light` class", () => {
    // The other half of the same mistake: if a stylesheet rule starts selecting
    // on `.light`, something in the app has to start wearing it, and every
    // `dark:` utility inside that subtree becomes ambiguous.
    expect(code).not.toMatch(/:is\(\.light\s/);
    expect(code).not.toMatch(/(^|[\s,{])\.light[\s,{]/m);
  });
});

describe("the two palettes", () => {
  const light = tokensIn(":root");
  const dark = tokensIn(".dark");

  test("dark overrides every colour token light defines", () => {
    // A token defined only in :root keeps its LIGHT value in dark mode and
    // nothing fails — one pale surface in an otherwise dark app. --radius and
    // --control-radius are geometry, shared by both themes on purpose.
    const geometry = new Set(["--radius", "--control-radius"]);
    const unoverridden = [...light.keys()].filter((k) => !geometry.has(k) && !dark.has(k));
    expect(unoverridden).toEqual([]);
  });

  test("dark introduces no token light has never heard of", () => {
    // The mirror failure: a token that exists only in dark resolves to nothing
    // in light mode, which reads as a transparent or black element rather than
    // an obviously broken one.
    const orphans = [...dark.keys()].filter((k) => !light.has(k));
    expect(orphans).toEqual([]);
  });

  test("both palettes are actually populated", () => {
    // Guards the parser above as much as the CSS: if a refactor moves these
    // blocks and tokensIn() starts returning empty maps, every assertion in
    // this file would pass vacuously.
    expect(light.size).toBeGreaterThan(20);
    expect(dark.size).toBeGreaterThan(20);
  });
});
