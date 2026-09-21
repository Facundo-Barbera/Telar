/**
 * THE TILE HAS TO SAY WHICH LOOK IT IS (#904).
 *
 * The owner's screenshot showed Grove, Ember, Tide and Iris as four identical
 * grey tiles with one dark bar across each: no light half, no dark half, no
 * accent rail. THE CAUSE WAS SIZE, NOT RESOLUTION, and this file says so
 * plainly — "write a test that fails first" only means something against a bug
 * a test can hold, and neither suspected bug was there:
 *
 *   - Each `Half` already compiled ITS OWN look. What it compiles to is a base
 *     run through Telar's lightness spine, which rewrites C and H and keeps L,
 *     so a flat look's canvas lands at oklch(0.975 0.007 h) in light and
 *     oklch(0.145 0.014 h) in dark. Grove is hue 150/155 and Iris 300/295: the
 *     values genuinely differ, and always did, at a chroma nobody can see.
 *   - The accent rail already resolved the LOOK's accent rather than the
 *     window's. globals.css carries `[data-accent=…]` and `.dark
 *     [data-accent=…]` for all eight, and a rule matching the rail beats one
 *     inherited from <html>.
 *
 * What was wrong is that at 40px, with a mini panel spanning 64% × 40% of a
 * 40×22 tile, almost nothing of either canvas survived — and between two FLAT
 * looks the only element that differs visibly is a 3px rail. So the fix is a
 * 56px cell and a smaller panel, and these tests guard what that fix is for:
 * that each tile is compiled from its own look, that its two halves are its own
 * two states, and that the rail carries that look's accent. No test can judge
 * whether a tile looks right; this settles that it is wired to the right look.
 *
 * WHY THE MARKUP IS PARSED INTO THE DOM RATHER THAN MOUNTED WITH `createRoot`.
 * Every colour here is oklch, and happy-dom's CSS parser rejects oklch in the
 * `background` shorthand — through a live mount React sets the property and the
 * element reports an EMPTY background, for every look, which is the very
 * failure this file exists to detect and would have faked. Parsing rendered
 * markup keeps the style attribute intact and still gives real elements to
 * query, which is what the structural claims below need. The DOM is registered
 * here and handed back in `afterAll`, the way browser-profile-marks.test.tsx
 * does it: the suite shares a process with tests written for a world that has
 * no `window`.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderToStaticMarkup } from "react-dom/server";
import { BUILT_IN_LOOKS } from "@/lib/built-in-looks";
import { MODES } from "@/lib/composition";
import type { Look } from "@/lib/looks";
import { LookThumb } from "./look-thumb";

GlobalRegistrator.register({ url: "http://localhost/" });

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

function builtIn(id: string): Look {
  const look = BUILT_IN_LOOKS.find((entry) => entry.id.endsWith(id));
  if (!look) throw new Error(`no built-in look ${id}`);
  return look;
}

/** One tile, in the document, as the element it rendered into. */
function tileFor(id: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<LookThumb look={builtIn(id)} />);
  document.body.append(host);
  return host;
}

function one(tile: HTMLElement, selector: string): HTMLElement {
  const found = tile.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`no ${selector} in the tile`);
  return found;
}

/** What a half actually paints. The style ATTRIBUTE, for the reason the header
 *  gives: happy-dom will not hold an oklch background as a property. */
function halfBackground(tile: HTMLElement, mode: string): string {
  return one(tile, `[data-half="${mode}"]`).getAttribute("style") ?? "";
}

// Two built-ins whose bases are as far apart as this table goes — green against
// violet — and both FLAT, so there is no scene to tell them apart by and the
// halves and the rail are all the tile has.
const grove = tileFor("grove");
const iris = tileFor("iris");

test("both halves render, for both looks", () => {
  expect(MODES.length).toBe(2);
  for (const tile of [grove, iris]) {
    for (const mode of MODES) expect(halfBackground(tile, mode)).toContain("background:oklch(");
  }
});

test("two looks' halves paint different backgrounds", () => {
  // Per half, not merely per tile: a tile that compiled one state from its own
  // look and fell back for the other would pass a whole-tile comparison.
  for (const mode of MODES) {
    expect(halfBackground(grove, mode)).not.toBe(halfBackground(iris, mode));
  }
});

test("a tile's two halves are its own two states, not one colour twice", () => {
  // The seam is the thing the tile exists to show. Light lands near L 0.975 and
  // dark near L 0.145; a tile drawing one of them twice has lost the point.
  for (const tile of [grove, iris]) {
    expect(halfBackground(tile, "light")).toContain("oklch(0.975");
    expect(halfBackground(tile, "dark")).toContain("oklch(0.145");
  }
});

test("the accent rail carries the look's own accent, not the window's", () => {
  for (const [tile, id] of [
    [grove, "grove"],
    [iris, "iris"],
  ] as const) {
    const rail = one(tile, "[data-rail]");
    // The attribute is what globals.css keys on, and it is the LOOK's — <html>
    // carries whatever the window happens to be wearing.
    expect(rail.dataset.accent).toBe(builtIn(id).accent);
    expect(rail.getAttribute("style")).toBe("background:var(--primary)");
  }
  // Which is only a claim worth making because these two differ.
  expect(builtIn("grove").accent).not.toBe(builtIn("iris").accent);
});

test("the rail reads its accent in the half the panel is painted in", () => {
  // The mini panel is the DARK card, so a light window resolving the bare
  // attribute would paint the light accent (L 0.488) onto it. The `.dark` scope
  // is what makes the rail the same colour in either window.
  const panel = one(grove, "[data-rail]").parentElement;
  expect(panel).not.toBeNull();
  expect(panel!.className.split(" ")).toContain("dark");
});

test("the mini panel leaves both canvases showing around it", () => {
  // happy-dom lays nothing out, so this is the geometry rather than the pixels:
  // insets small enough to leave a band of canvas above, below and either side.
  // The values it shipped with — 18% / 30% / 40% — did not.
  const panel = one(grove, "[data-rail]").parentElement!;
  expect(panel.className).toContain("inset-x-[24%]");
  expect(panel.className).toContain("top-[34%]");
  expect(panel.className).toContain("h-[32%]");
});
