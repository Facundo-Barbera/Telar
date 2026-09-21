// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { LooksSection } from "./looks-section";
import { BUILT_IN_LOOKS } from "@/lib/built-in-looks";

/**
 * THE SHELF HAS TO STAY INSIDE ITS CARD.
 *
 * The table shipped under AUTO layout, where every cell's content is a vote on
 * how wide its column should be — and `truncate` never gets to cast one, because
 * a span only shrinks to an ellipsis once something upstream has capped it. So
 * the Carries cell widened to hold "Tide, under a dusk gradient · violet · Geist
 * / Geist Mono" in full, the table went with it, and because the rows bleed
 * `-mx-4` to the card's edges, every hairline ran about 110px past the card.
 *
 * `table-fixed` is the fix and it is one word, which is exactly why it needs a
 * test: nothing about the rendered row looks wrong without it until a long
 * summary arrives. Read off the RENDERED markup rather than the source, because
 * what matters is the class Tailwind actually emitted onto the table.
 *
 * The section server-renders without a DOM: `useSyncExternalStore` answers
 * "this IS the host" on the server, so the host row (which fetches) is not in
 * this markup, and the built-ins are a frozen table needing no storage.
 */
const html = renderToStaticMarkup(<LooksSection onWear={() => {}} />);

test("the table is fixed-layout, so no cell can vote on its width", () => {
  expect(html).toContain('<table class="w-full table-fixed border-collapse text-left text-xs">');
});

test("two columns are sized and the third takes the remainder", () => {
  // The Look column holds a 56px thumbnail plus a name; the actions column is
  // sized to the buttons it reveals on hover. Carries is deliberately UNSIZED —
  // the one column that should absorb a narrow panel.
  expect(html).toContain('class="w-[40%] py-1.5 pr-3 pl-4 font-normal">Look<');
  expect(html).toContain('class="w-[156px] py-1.5 pr-4 font-normal"');
  expect(html).toContain('class="py-1.5 pr-3 font-normal">Carries<');
});

test("the summary truncates rather than widening its column", () => {
  expect(html).toContain('<span class="block truncate">');
  // The longest built-in summary is the one that pushed the table over the
  // edge; it must be present in full in the DOM and clipped by CSS, never
  // shortened in JS — a title attribute and a screen reader both want the whole
  // sentence.
  const dusk = BUILT_IN_LOOKS.find((look) => look.id.endsWith("dusk"));
  expect(dusk).toBeDefined();
  expect(html).toContain("Tide, under a dusk gradient");
});

test("the rename field fits its column instead of claiming 160px", () => {
  // Read as source: the field only renders once somebody has pressed Rename, so
  // it is not in the markup above. `w-40` was wider than the name ever gets in a
  // fixed Look column, and would have put the overflow back at that moment.
  const source = readFileSync(new URL("./looks-section.tsx", import.meta.url), "utf8");
  expect(source).toContain('className="h-6 min-w-0 flex-1 px-1.5 text-xs"');
  expect(source).not.toContain("h-6 w-40");
});
