/**
 * The icon map, which is the one place a stored key becomes something drawn.
 *
 * TWO FAILURES ARE WORTH A TEST HERE AND NEITHER IS COSMETIC. A key in the
 * protocol's enum with no entry in this map renders as `undefined` and takes
 * the masthead down with it — so the enum is walked, not sampled. And an icon
 * that silently collapses to the default for every key would look tidy and
 * carry no information at all, so the glyphs are compared as rendered markup
 * rather than as identity.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RunIcon } from "@telar/engine-client";
import { DEFAULT_RUN_ICON, RUN_ICON_KEYS, RUN_ICON_LABELS, RunGlyph, runIconKey } from "./icons";

/** Through the component the surfaces actually render, not the map behind it. */
const draw = (icon: string | undefined) => renderToStaticMarkup(<RunGlyph icon={icon} className="size-3.5" />);

describe("the closed set", () => {
  test("the picker offers exactly the keys the protocol accepts", () => {
    // A key added to the wire and not here would be storable and undrawable.
    expect([...RUN_ICON_KEYS].sort()).toEqual([...RunIcon.options].sort());
    expect(RUN_ICON_KEYS[0]).toBe(DEFAULT_RUN_ICON);
  });

  test("every key names a button and draws a distinct glyph", () => {
    const drawn = new Map<string, string>();
    for (const key of RUN_ICON_KEYS) {
      expect(RUN_ICON_LABELS[key]).toBeTruthy();
      const markup = draw(key);
      expect(markup).toContain("<svg");
      drawn.set(key, markup);
    }
    expect(new Set(drawn.values()).size).toBe(RUN_ICON_KEYS.length);
  });
});

describe("what an absent icon means", () => {
  test("no icon is the default, not a blank space", () => {
    // Every configuration saved before icons existed is this case, and so is
    // one an agent saves without naming an icon.
    expect(runIconKey(undefined)).toBe(DEFAULT_RUN_ICON);
    expect(draw(undefined)).toBe(draw(DEFAULT_RUN_ICON));
  });

  test("a key this build does not know falls back rather than crashing", () => {
    // The schema refuses one at the door, but the enum and this map are two
    // files: a mismatch must degrade to `play`, not to `undefined is not a
    // function` in the masthead.
    expect(runIconKey("unicorn")).toBe(DEFAULT_RUN_ICON);
    expect(draw("unicorn")).toBe(draw(DEFAULT_RUN_ICON));
  });
});
