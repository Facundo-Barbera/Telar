/**
 * The greeting, which is now one line rather than a rotation of fourteen.
 *
 * Worth pinning for two reasons, both of which were real defects. It has to
 * stay NEUTRAL — the quips it replaced ("exoplanets is not going to fix
 * itself") sat directly over the box a person came to type into — and its
 * trailing half has to be punctuation that can HUG the project name, because
 * the name is a padded control and #355 was that padding showing.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { GREETING } from "./greetings";

describe("the greeting", () => {
  test("reads as a sentence around the project name", () => {
    // The project is a BUTTON in the middle, so the phrase is the two halves
    // either side of it.
    expect(`${GREETING.before}exoplanets${GREETING.after}`).toBe("What's next for exoplanets?");
  });

  test("the leading half ends in a real space, so the name is not jammed against it", () => {
    expect(GREETING.before.endsWith(" ")).toBe(true);
  });

  test("the trailing half is punctuation only — nothing that needs a space in front of it", () => {
    // `fresh-greeting.tsx` pulls this back across the trigger's own padding, so
    // anything wordy here would end up jammed against the name instead.
    expect(GREETING.after).toMatch(/^[.,?!]?$/);
  });
});
