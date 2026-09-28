// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { GREETING } from "./greetings";

describe("the greeting", () => {
  test("reads as a sentence around the project name", () => {
    // The project is a button in the middle, so the phrase is its two halves.
    expect(`${GREETING.before}exoplanets${GREETING.after}`).toBe("What's next for exoplanets?");
  });

  test("the leading half ends in a real space, so the name is not jammed against it", () => {
    expect(GREETING.before.endsWith(" ")).toBe(true);
  });

  test("the trailing half is punctuation only — nothing that needs a space in front of it", () => {
    // `fresh-greeting.tsx` pulls this back across the trigger's padding.
    expect(GREETING.after).toMatch(/^[.,?!]?$/);
  });
});
