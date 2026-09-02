/**
 * The stash's four structural claims about the composer.
 *
 * Asserted as SOURCE TEXT because all four are about ordering inside one
 * `onKeyDown` and one async callback, this app has no DOM harness, and every one
 * of them is decidable by reading the file — the same reasoning as
 * `session-cockpit.test.ts` and `spool/idiom.test.ts`. They are the claims whose
 * violation is silent: a ⌘S that opens the browser's Save dialog, a stash that
 * clears the box on a write that did not land, a badge that greys the whole
 * composer. None of those fail loudly, and all four survive a refactor only if
 * something is watching the shape.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));
// Comments stripped: each decision documents itself at the call site, and a
// scan that read prose would pass on the explanation alone.
const strip = (file: string) =>
  fs
    .readFileSync(path.join(dir, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const composer = strip("composer.tsx");
const menu = strip("composer-stash-menu.tsx");

describe("⌘S is resolved before anything that could claim it", () => {
  test("above every content key, below only the IME guard", () => {
    // A modifier chord can never mean "type an s", so nothing below has a
    // claim on it — the same rule the app's command-key table encodes for
    // every other chord. Below the IME guard because a live composition means
    // the keystroke belongs to the IME, which is not this feature's to weaken.
    const composing = composer.indexOf("nativeEvent.isComposing");
    const chord = composer.indexOf("event.key.toLowerCase() === \"s\"");
    const completions = composer.indexOf("menuOpen && completions.length > 0");
    expect(composing).toBeGreaterThan(-1);
    expect(chord).toBeGreaterThan(composing);
    expect(chord).toBeLessThan(completions);
  });

  test("the browser's Save dialog can never open — no return before the prevent", () => {
    // "Usually prevented" is the same as not prevented: the one state that
    // slips through is a native dialog over the app. The file editor in the
    // right panel prevents it even while read-only for exactly this reason.
    const chord = composer.indexOf("event.key.toLowerCase() === \"s\"");
    const prevented = composer.indexOf("event.preventDefault()", chord);
    const between = composer.slice(chord, prevented);
    expect(between).not.toContain("return");
  });
});

describe("the menu can always be closed", () => {
  test("Escape is handled above the count check, not inside it", () => {
    // Found by opening the menu, deleting the last entry, and being unable to
    // dismiss the panel: the badge is not rendered at zero, so with Escape
    // gated on a non-empty list there was nothing left on screen that could
    // close it. Escape must be the one key that does not need a row.
    const open = composer.indexOf("if (stashOpen) {");
    const escape = composer.indexOf('event.key === "Escape"', open);
    const counted = composer.indexOf("stash.entries.length > 0", open);
    expect(open).toBeGreaterThan(-1);
    expect(escape).toBeGreaterThan(open);
    expect(escape).toBeLessThan(counted);
  });
});

describe("the box is cleared only by a write that landed", () => {
  test("the refusal returns before anything is taken from the composer", () => {
    // The single destructive moment in the feature. A stash that reports
    // success it did not have, followed by a clear, is a deleted paragraph.
    const stash = composer.indexOf("const doStash");
    const refused = composer.indexOf("if (!ok)", stash);
    const cleared = composer.indexOf("onDraftChange(latest.current", stash);
    expect(refused).toBeGreaterThan(stash);
    expect(cleared).toBeGreaterThan(refused);
  });

  test("what was typed during an encode is not part of what is cleared", () => {
    // Encoding pictures takes a beat and people type through it. Slicing off
    // only the captured run is what keeps those characters.
    expect(composer).toContain("latest.current.slice(draft.length)");
  });
});

describe("nothing the stash adds is ever disabled", () => {
  test("because InputGroup greys the whole composer for one disabled child", () => {
    // `has-disabled:opacity-50` on the box means a single permanently-disabled
    // descendant makes the entire composer look broken for the life of the
    // session — the trap composer.tsx already documents twice.
    const badge = composer.slice(composer.indexOf("aria-label=\"Stashed prompts\""), composer.indexOf("<LayersIcon"));
    expect(badge).not.toContain("disabled");
    expect(menu).not.toContain("disabled");
  });
});
