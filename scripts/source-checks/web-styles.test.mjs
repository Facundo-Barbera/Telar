import { expect, test } from "bun:test";
import { radiusUses } from "./radius-usage.mjs";
import { STOCK_SHADOW } from "./stock-shadows.mjs";

test("stock shadows are recognised, the ladder's are not", () => {
  for (const cls of ["shadow-sm", "shadow-2xs", "shadow-xl"]) expect(STOCK_SHADOW.test(`className="${cls}"`)).toBe(true);
  for (const cls of ["shadow-1", "shadow-3", "shadow-none"]) expect(STOCK_SHADOW.test(`className="${cls}"`)).toBe(false);
});

test("a radius utility is counted as a whole class only", () => {
  expect(radiusUses("rounded-xl", ['"rounded-xl p-2"', '"rounded-xl-2 rounded-xl"'])).toBe(2);
});
