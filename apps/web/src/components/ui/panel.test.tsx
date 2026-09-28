/**
 * A PANEL ROW DRAWS NO COLOURED RAIL. The owner wants no coloured left stripes
 * anywhere; a row that has a state says it as a word at its trailing edge.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PanelRow } from "./panel";

test("a panel row renders no rail", () => {
  const markup = renderToStaticMarkup(<PanelRow>row</PanelRow>);
  expect(markup).not.toContain("before:");
  expect(markup).not.toContain("w-[3px]");
  expect(markup).not.toContain("data-tone");
});
