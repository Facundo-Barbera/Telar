/**
 * The fallback avatar's two derivations. Both are pure so every surface that
 * draws a project mark derives the SAME hue and the same initial — the tests
 * pin stability, not particular values.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { projectHue, projectIconUrl, projectInitial } from "./project-avatar";

describe("projectHue", () => {
  test("is stable and in range — the whole contract", () => {
    expect(projectHue("Telar")).toBe(projectHue("Telar"));
    expect(projectHue("Telar")).not.toBe(projectHue("telar"));
    for (const name of ["a", "Telar", "🚀 rockets", "Ålesund"]) {
      const hue = projectHue(name);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
});

describe("projectInitial", () => {
  test("takes the first GRAPHEME, not the first code unit", () => {
    expect(projectInitial("telar")).toBe("T");
    expect(projectInitial("  spaced")).toBe("S");
    // An emoji is one grapheme across several code units; splitting it would
    // render a broken surrogate half.
    expect(projectInitial("🚀 rockets")).toBe("🚀");
    expect(projectInitial("")).toBe("?");
  });
});

describe("projectIconUrl", () => {
  test("carries the content key as ?v=, which is what makes immutable caching honest", () => {
    expect(projectIconUrl("project_1", "abc123")).toBe("/api/projects/project_1/icon?v=abc123");
  });
});
