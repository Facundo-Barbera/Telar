/**
 * The greeting rotation.
 *
 * Small, and worth pinning for one reason: phrase 0 is what the SERVER renders,
 * so it has to stay the plainest line in the list. Every other phrase swaps in
 * after mount, and a joke that flickers into a different joke reads as a bug.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { GREETINGS, greetingForVisit, nextGreeting } from "./greetings";

describe("the greeting list", () => {
  test("every phrase reads as a sentence around the project name", () => {
    // The project is a BUTTON in the middle, so each entry is the two halves
    // either side of it. A phrase with neither half is not a phrase.
    for (const greeting of GREETINGS) {
      expect(`${greeting.before}${greeting.after}`.trim().length).toBeGreaterThan(0);
    }
  });

  test("the first one is the plain one, because it is what the server renders", () => {
    expect(GREETINGS[0]).toEqual({ before: "Let's work on ", after: "" });
  });
});

describe("rotation", () => {
  test("steps and wraps, so every phrase gets its turn", () => {
    // Modulo rather than random: the same three coming up all week is the
    // failure mode of picking at random from a short list.
    const seen = new Set<number>();
    let index = 0;
    for (let step = 0; step < GREETINGS.length; step += 1) {
      seen.add(index);
      index = nextGreeting(index);
    }
    expect(seen.size).toBe(GREETINGS.length);
    expect(index).toBe(0);
  });

  test("a stored counter is clamped into range rather than trusted", () => {
    // localStorage holds whatever was last written there, including something
    // another build wrote, or garbage a user typed into devtools.
    expect(greetingForVisit(0)).toBe(0);
    expect(greetingForVisit(GREETINGS.length)).toBe(0);
    expect(greetingForVisit(-3)).toBe(3 % GREETINGS.length);
    expect(greetingForVisit(2.7)).toBe(2);
    expect(greetingForVisit(Number.NaN)).toBe(0);
  });
});
