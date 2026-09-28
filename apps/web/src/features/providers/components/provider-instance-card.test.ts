/**
 * When a half-typed environment row is worth sending to the engine.
 *
 * FOUND BY PRESSING THE BUTTON. Adding a variable used to publish the empty row
 * straight away, and the card showed "provider instance environment is invalid"
 * before the user had typed a character. No test asked about it because nothing
 * about the code looked wrong.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { publishableEnv } from "./provider-instance-card";

test("a fresh empty row is not a change", () => {
  expect(publishableEnv([{ name: "", value: "", sensitive: false }])).toEqual([]);
  expect(publishableEnv([{ name: "API_KEY", value: "x", sensitive: false }, { name: "", value: "", sensitive: false }])).toEqual([
    { name: "API_KEY", value: "x", sensitive: false },
  ]);
});

test("a name being typed suspends the whole publish", () => {
  // Sending the rest would silently delete the row being edited, which is worse
  // than waiting: the user is one keystroke from a legal name.
  expect(publishableEnv([{ name: "1BAD", value: "", sensitive: false }])).toBeNull();
  expect(publishableEnv([{ name: "API_KEY", value: "x", sensitive: false }, { name: "-", value: "", sensitive: false }])).toBeNull();
});

test("a row with a value but no name is an edit in progress, not a deletion", () => {
  // The empty-row shortcut applies only to a row nobody has touched at all.
  expect(publishableEnv([{ name: "", value: "typed-first", sensitive: false }])).toBeNull();
});

test("names are trimmed, and everything else survives verbatim", () => {
  // The redacted round trip has to reach the engine unchanged, or a saved
  // secret is blanked by the next unrelated edit.
  expect(publishableEnv([{ name: "  API_KEY  ", value: "", sensitive: true, valueRedacted: true }])).toEqual([
    { name: "API_KEY", value: "", sensitive: true, valueRedacted: true },
  ]);
});
